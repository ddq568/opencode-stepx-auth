// Per-account runtime: conversation pool, key locks, cookie lifecycle,
// catalog cache and the OpenAI-compatible request handler.
//
// One runtime per authenticated account/loader instance — NO module-level
// state — so two accounts can never share projects, cookies, sessions or
// catalogs. Cross-restart ownership is never guessed: only projects this
// runtime itself created (recorded in its pool / pending-cleanup queue) are
// ever reclaimed, and only when idle; deletion failures stay queued for
// retry. There is no startup sweep of `^magpie-` projects.
//
// Turn pipeline contract:
// - the whole request is budget-checked (UTF-8, JSON-escaped frame size)
//   BEFORE any HTTP call; over-limit is a typed 4xx with sizes and reduction
//   hints — the upstream ceiling is not a known precise number;
// - continuity is decided from the COMPLETED turn's structured ledger
//   entries plus the tool_call ids this runtime actually delivered ( echoed
//   back by the client as real message structure, never via string scan);
//   anything uncertain creates a NEW session state (never blind-share);
// - after an interrupted / failed / protocol-violating turn the cloud state
//   is marked unusable and never continued;
// - ALL tool_calls are buffered until end-of-turn whitelist / schema /
//   tool_choice / parallel validation completes — nothing executable is
//   ever sent to the client and then "taken back";
// - cancellation propagates through one AbortController chain (request →
//   turn → transport), every derived promise rejection is handled, all
//   listeners/timers are torn down, and the key gate is released on every
//   exit path.

import { randomUUID } from 'node:crypto'
import { httpError, protocolError, errorResponse, PROTOCOL } from './errors.mjs'
import { buildLedger, conversationKey, utf8Len, TOOL_ELIDE_HEAD, TOOL_ELIDE_TAIL } from './ledger.mjs'
import { createToolContext, toolsKey, toolPreamble } from './tools.mjs'
import { ToolStreamParser } from './parser.mjs'
import { composeTurnText, buildContinuationDelta } from './prompt.mjs'
import { serializeLedger } from './ledger.mjs'
import { chatTurn, createProject, setProjectModel, deleteProject, defaultTransport, requestFrameBytes } from './transport.mjs'
import { FALLBACK_MODELS, createFallbackModels, resolveModelId, fetchAccountModels } from './models.mjs'
import { sseResponse } from './stream.mjs'

export const DEFAULT_MAX_TURN_BYTES = 768 * 1024 // conservative, configurable; NOT a claim about the upstream limit
export const DEFAULT_MAX_PROJECTS = 8
const BUDGET_HEADROOM_BYTES = 2048 // WS envelope, reminder/recency seams, id-length slack

function cancelError(msg = '请求已取消') {
  return httpError(499, msg)
}

/** Structural equality of two ledger entries (continuity evidence). */
function entryEq(a, b) {
  if (a.role !== b.role || (a.name ?? null) !== (b.name ?? null)) return false
  if ((a.toolCallId ?? null) !== (b.toolCallId ?? null)) return false
  if ((a.content ?? null) !== (b.content ?? null)) return false
  const ac = a.toolCalls ?? []
  const bc = b.toolCalls ?? []
  if (ac.length !== bc.length) return false
  for (let i = 0; i < ac.length; i++) {
    if (ac[i].id !== bc[i].id || ac[i].name !== bc[i].name || ac[i].arguments !== bc[i].arguments) return false
  }
  return true
}

/**
 * Create one account-scoped runtime.
 * @param {object} deps
 *  - transport: injectable {fetch, WebSocket, timers} (tests pass a mock;
 *    the offline suite runs with networking blocked)
 *  - cookie: initial cookie header for this account
 *  - persistCookie(next): invoked when the site rotates the cookie so the
 *    host can persist it. Sync throws AND returned-promise rejections are
 *    contained; this callback belongs to THIS runtime only.
 *  - options: { persona, maxProjects, maxTurnBytes, elideToolResults }
 */
export function createAccountRuntime({ transport = defaultTransport, cookie, persistCookie = () => {}, options = {} } = {}) {
  const persona = options.persona !== false
  const maxProjects = Number(options.maxProjects) > 0 ? Number(options.maxProjects) : DEFAULT_MAX_PROJECTS
  const maxTurnBytes = Number(options.maxTurnBytes) > 0 ? Number(options.maxTurnBytes) : DEFAULT_MAX_TURN_BYTES
  const elideToolResults = options.elideToolResults === true
  const enableStep5Tools = options.enableStep5Tools === true

  let liveCookie = String(cookie ?? '')
  const refreshCookie = (next) => {
    liveCookie = next
    try {
      const r = persistCookie(next)
      if (r && typeof r.catch === 'function') r.catch(() => {}) // never an unhandled rejection
    } catch {}
  }

  // conversation key -> array of session states. An array (not one slot) is
  // deliberate: conversations sharing a head must not blindly share one
  // Studio session; ambiguous candidate matching creates a NEW state.
  const pool = new Map()
  const chains = new Map() // key -> tail promise (per-key turn lock)
  const pendingCleanup = [] // runtime-owned projects whose delete failed

  let catalogCache = { at: 0, value: null }
  async function modelCatalog(signal) {
    if (catalogCache.value && Date.now() - catalogCache.at < 600_000) return catalogCache.value
    let live = null
    try {
      live = await fetchAccountModels(transport, liveCookie, { signal, onCookieRefresh: refreshCookie, enableStep5Tools })
    } catch (e) {
      if (signal?.aborted) throw cancelError() // never swallow cancellation and keep going
      live = null
    }
    const fallback = enableStep5Tools ? createFallbackModels({ enableStep5Tools: true }) : FALLBACK_MODELS
    const merged = { ...fallback, ...(live ?? {}) }
    catalogCache = { at: Date.now(), value: merged }
    return merged
  }

  function allStates() {
    const out = []
    for (const arr of pool.values()) for (const s of arr) out.push(s)
    return out
  }

  function removeState(st) {
    for (const [k, arr] of pool) {
      const i = arr.indexOf(st)
      if (i >= 0) {
        arr.splice(i, 1)
        if (!arr.length) pool.delete(k)
        return
      }
    }
  }

  function dropProject(projectId) {
    // Best-effort reclaim of a project THIS runtime created; a failed delete
    // stays in pendingCleanup and is retried on later trims. Nothing outside
    // the pool is ever deleted (user projects untouched, no startup sweep).
    deleteProject(transport, liveCookie, projectId)
      .then(() => {
        const i = pendingCleanup.findIndex((p) => p.projectId === projectId)
        if (i >= 0) pendingCleanup.splice(i, 1)
      })
      .catch(() => {
        if (!pendingCleanup.some((p) => p.projectId === projectId)) pendingCleanup.push({ projectId, at: Date.now() })
      })
  }

  function retryPendingCleanup() {
    for (const p of [...pendingCleanup]) dropProject(p.projectId)
  }

  /** LRU over idle, runtime-owned states only. Busy (in-turn or freshly
   * created) sessions are never reclaimed; if everything is busy, skip. */
  function trimPool() {
    retryPendingCleanup()
    let excess = allStates().length - maxProjects
    while (excess > 0) {
      let oldest = null
      for (const s of allStates()) {
        if (s.busy > 0) continue
        if (!oldest || s.lastUsed < oldest.lastUsed) oldest = s
      }
      if (!oldest) break
      removeState(oldest)
      dropProject(oldest.projectId)
      excess--
    }
  }

  /**
   * Per-key turn lock. The chain entry is created SYNCHRONOUSLY (before any
   * await) so concurrent requests on the same conversation serialize from
   * the first one. Waiting is abortable: a cancelled queued request removes
   * its listener, releases the gate and throws — without sending anything.
   * Returns the release function; callers MUST release exactly once.
   */
  function acquireLock(key, signal) {
    if (signal?.aborted) return Promise.reject(cancelError())
    const prev = (chains.get(key) ?? Promise.resolve()).catch(() => {})
    let release
    const gate = new Promise((r) => {
      release = r
    })
    chains.set(key, prev.then(() => gate))
    let onAbort = null
    const waitAbort = new Promise((_, rej) => {
      if (signal) {
        onAbort = () => rej(cancelError())
        signal.addEventListener('abort', onAbort, { once: true })
      }
    })
    waitAbort.catch(() => {}) // handled: racing it is optional
    const detach = () => {
      if (signal && onAbort) {
        try {
          signal.removeEventListener('abort', onAbort)
        } catch {}
        onAbort = null
      }
    }
    return Promise.race([prev, waitAbort]).then(
      () => {
        detach()
        return release
      },
      (e) => {
        detach()
        release() // gate must be released on every exit path
        throw e
      },
    )
  }

  /**
   * Continuity contract (verified-echo): a request may continue a session
   * only when ALL of the following hold against the COMPLETED turn's
   * structured state:
   * 1. the request strictly extends the session's previous request entries
   *    (structural prefix equality — replaying the identical request is NOT
   *    a continuation: nothing new to verify, never blind-share);
   * 2. the extension OPENS with the structured echo of the reply this
   *    runtime actually delivered — content exactly equal (null/'' are
   *    canonical) and every tool_call identical in id/name/arguments, in
   *    order. Tampered body/args/name (even with a matching id) fails here;
   * 3. tool receipts for exactly the delivered ids — each once, order free
   *    (same-name parallel receipts stay precisely associated by id), no
   *    receipts for unknown ids; empty receipts stay receipts;
   * 4. everything after the receipts is new user-side content — a SECOND
   *    assistant entry in the extension is a tamper/replay signal.
   * Reasoning content is deliberately not part of the ledger and never a
   * matching input; ids are never matched by scanning message text.
   * Anything uncertain -> null -> a NEW session (conservative).
   * Returns the delta entries (receipts + new user entries; the echo the
   * upstream session already contains is stripped) or null.
   */
  function matchContinuation(st, entries) {
    if (st.unusable || st.exhausted || st.busy > 0) return null
    if (entries.length <= st.entries.length) return null
    for (let i = 0; i < st.entries.length; i++) {
      if (!entryEq(entries[i], st.entries[i])) return null
    }
    const ext = entries.slice(st.entries.length)
    if (!replyMatches(ext[0], st.lastReply)) return null
    let i = 1
    const seen = new Set()
    for (; i < ext.length; i++) {
      const e = ext[i]
      if (e.role !== 'tool') break
      if (!st.emittedCallIds.includes(e.toolCallId) || seen.has(e.toolCallId)) return null
      seen.add(e.toolCallId)
    }
    if (seen.size !== st.emittedCallIds.length) return null
    for (; i < ext.length; i++) {
      if (ext[i].role === 'assistant') return null
    }
    return ext.slice(1)
  }

  /** The structured echo of a delivered reply: content canonicalized
   * (null/'' equal) and every tool_call exactly id/name/arguments. */
  function replyMatches(e, lastReply) {
    if (!e || e.role !== 'assistant') return false
    if ((e.content ?? '') !== lastReply.content) return false
    const tc = e.toolCalls ?? []
    if (tc.length !== lastReply.toolCalls.length) return false
    for (let i = 0; i < tc.length; i++) {
      if (tc[i].id !== lastReply.toolCalls[i].id) return false
      if (tc[i].name !== lastReply.toolCalls[i].name) return false
      if (tc[i].arguments !== lastReply.toolCalls[i].arguments) return false
    }
    return true
  }

  /** Candidates are scoped by model id and by this runtime's pool (account
   * isolation is structural: one runtime per account, no shared maps). */
  function candidates(key, askedModel, entries) {
    const out = []
    for (const s of pool.get(key) ?? []) {
      if (s.model !== askedModel) continue
      const deltaEntries = matchContinuation(s, entries)
      if (deltaEntries) out.push({ st: s, deltaEntries })
    }
    return out
  }

  function markUnusable(st) {
    st.unusable = true // interrupted/failed turn: cloud state can't be trusted for continuation
    st.emittedCallIds = []
  }

  // ------------------------------------------------------------ request

  async function buildBody(input, init) {
    const i = init ?? {}
    if (i.body !== undefined) {
      if (typeof i.body === 'string') return i.body
      if (i.body instanceof Uint8Array) return new TextDecoder().decode(i.body)
      if (i.body instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(i.body))
      return await new Response(i.body).text()
    }
    if (typeof Request !== 'undefined' && input instanceof Request) return await input.text()
    return ''
  }

  /** Two call forms are honored: fetch(Request) and fetch(url, init); the
   * caller's signal (init or Request) is preserved end-to-end. */
  async function handle(input, init) {
    let signal = null
    try {
      const isReq = typeof Request !== 'undefined' && input instanceof Request
      signal = init?.signal ?? (isReq ? input.signal : null) ?? null
      if (signal?.aborted) return errorResponse(cancelError('请求在开始前已取消'))
      const bodyText = await buildBody(input, init)
      let payload
      try {
        payload = JSON.parse(bodyText)
      } catch {
        return errorResponse(httpError(400, '请求体不是合法 JSON', { code: PROTOCOL.INVALID_REQUEST }))
      }
      return await handleChat(payload, signal)
    } catch (e) {
      return errorResponse(e)
    }
  }

  async function handleChat(payload, signal) {
    const id = `chatcmpl-stepx-${randomUUID().replaceAll('-', '').slice(0, 24)}`
    const created = Math.floor(Date.now() / 1000)
    if (!Array.isArray(payload?.messages) || payload.messages.length === 0)
      return errorResponse(httpError(400, 'messages 必须是非空数组', { code: PROTOCOL.INVALID_REQUEST }))

    let ctx
    try {
      ctx = createToolContext({ tools: payload.tools, toolChoice: payload.tool_choice, parallelToolCalls: payload.parallel_tool_calls })
    } catch (e) {
      return errorResponse(e)
    }

    let ledger
    try {
      ledger = buildLedger(payload.messages, {
        elideToolResults: elideToolResults ? { head: TOOL_ELIDE_HEAD, tail: TOOL_ELIDE_TAIL } : null,
      })
    } catch (e) {
      return errorResponse(e)
    }
    const flat = ledger.text
    if (!flat) return errorResponse(httpError(400, 'messages 为空', { code: PROTOCOL.INVALID_REQUEST }))

    // Whole-request budget on the SERIALIZED frame (JSON escaping and the
    // WS envelope included), checked BEFORE any HTTP call — including the
    // catalog GET and, in particular, before any project creation. The
    // first-turn composition (full ledger + preamble + tool block) is the
    // strict upper bound of any turn's payload.
    const worstInvisible = composeTurnText({
      firstTurn: true,
      persona,
      toolBlock: ctx.hasTools ? toolPreamble(ctx) : '',
      toolsPresent: ctx.hasTools,
      deltaText: flat,
      prefix: ctx.prefix,
    })
    const estimate = requestFrameBytes(worstInvisible.invisible, worstInvisible.text, String(payload.model || 'auto')) + BUDGET_HEADROOM_BYTES
    if (estimate > maxTurnBytes) {
      return errorResponse(
        protocolError(
          PROTOCOL.BUDGET_EXCEEDED,
          `本轮请求序列化后约 ${estimate} UTF-8 字节，超过保守限额 ${maxTurnBytes} 字节（站点审核上限并非精确已知值，默认限额取保守值；可通过 options.maxTurnBytes 调整）。请缩短历史、精简工具 schema，或开启 options.elideToolResults 摘取过长的工具结果。`,
          { limitBytes: maxTurnBytes, estimatedBytes: estimate, ledgerBytes: utf8Len(flat) },
        ),
      )
    }

    // Catalog (abort-aware) -> model -> conversation key.
    const catalog = await modelCatalog(signal)
    const askedModel = resolveModelId(payload.model, catalog)
    const servedName = payload.model || askedModel
    const stream = payload.stream !== false
    const wantUsage = payload?.stream_options?.include_usage === true
    // Optional explicit conversation id: namespaced ("cid:") inside this
    // account runtime and guarded by the same per-key lock.
    const explicitCid =
      typeof payload?.metadata?.conversation_id === 'string' && payload.metadata.conversation_id
        ? 'cid:' + payload.metadata.conversation_id
        : null
    const key = explicitCid ?? conversationKey(ledger.entries, askedModel)

    const abortCtl = new AbortController()
    const onOuterAbort = () => {
      try {
        abortCtl.abort()
      } catch {}
    }
    if (signal) {
      if (signal.aborted) abortCtl.abort()
      else signal.addEventListener('abort', onOuterAbort, { once: true })
    }
    const removeOuter = () => {
      if (signal) {
        try {
          signal.removeEventListener('abort', onOuterAbort)
        } catch {}
      }
    }

    const run = turnGenerator({ ctx, ledger, flat, key, askedModel, signal: abortCtl.signal, removeOuter })

    if (!stream) {
      let text = ''
      let thinking = ''
      const toolCalls = []
      let diagnostics = null
      try {
        for await (const ev of run) {
          if (ev.content) text += ev.content
          else if (ev.reasoning) thinking += ev.reasoning
          else if (ev.toolCall) toolCalls.push(ev.toolCall)
          else if (ev.diagnostics) diagnostics = ev.diagnostics
        }
      } catch (e) {
        return errorResponse(e)
      }
      const message = { role: 'assistant', content: text || (toolCalls.length ? null : '') }
      if (thinking) message.reasoning_content = thinking
      if (toolCalls.length)
        message.tool_calls = toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } }))
      const body = {
        id,
        object: 'chat.completion',
        created,
        model: servedName,
        choices: [{ index: 0, message, finish_reason: toolCalls.length ? 'tool_calls' : 'stop' }],
      }
      // No fabricated usage: context.update totals are diagnostics only.
      if (diagnostics) body.stepx_diagnostics = diagnostics
      return Response.json(body)
    }

    return sseResponse({
      id,
      created,
      model: servedName,
      events: run,
      wantUsage,
      onCancel: () => abortCtl.abort(),
    })
  }

  // ------------------------------------------------------------ turn pipeline

  function turnGenerator({ ctx, ledger, flat, key, askedModel, signal, removeOuter }) {
    const parseCalls = ctx.hasTools // tools declared -> parse & enforce (also for tool_choice:none)
    async function* run() {
      // The OUTER try/finally wraps the pre-cancel check AND the lock
      // acquisition, so removeOuter() runs on every exit path (including
      // pre-abort and queued-cancel) — the abort listener registered on the
      // caller's signal can never outlive the request.
      let release = null
      try {
        if (signal?.aborted) throw cancelError('请求在开始前已取消') // pre-cancelled: no HTTP, no lock, no project
        release = await acquireLock(key, signal) // lock created before first await; throws 499 if cancelled while queued
        let st = null
        let ownsBusy = false
        try {
        const matches = candidates(key, askedModel, ledger.entries)
        let deltaEntries = null
        if (matches.length === 1) {
          st = matches[0].st
          deltaEntries = matches[0].deltaEntries
        } else {
          // uncertain (0 or >1 candidates): a NEW session state — never blind-share
          st = {
            projectId: null,
            sessionId: null,
            model: askedModel,
            entries: [],
            lastFull: '',
            lastReply: { content: '', toolCalls: [] },
            lastReplyWire: { content: '', toolCalls: [] },
            lastUsed: 0,
            exhausted: false,
            unusable: false,
            busy: 0,
            toolsKey: null,
            emittedCallIds: [],
          }
        }
        st.lastUsed = Date.now()
        if (st.projectId === null) {
          const label = `magpie-${askedModel}-${key.slice(0, 8)}`
          const projectId = await createProject(transport, liveCookie, askedModel, label, {
            signal,
            onCookieRefresh: refreshCookie,
          })
          st.projectId = projectId
          st.busy = 1 // mark busy BEFORE the state becomes trimmable
          ownsBusy = true
          const arr = pool.get(key) ?? []
          arr.push(st)
          pool.set(key, arr)
          trimPool() // skips busy states: the fresh one can't be reclaimed
        } else {
          if (st.model !== askedModel) {
            await setProjectModel(transport, liveCookie, st.projectId, askedModel, { signal, onCookieRefresh: refreshCookie })
            st.model = askedModel
          }
          st.busy++
          ownsBusy = true
        }

        try {
          const firstTurn = st.entries.length === 0
          const tKey = toolsKey(ctx)
          let toolBlock = ''
          if (ctx.hasTools && (firstTurn || st.toolsKey !== tKey)) {
            toolBlock = (firstTurn ? '' : '【工具列表更新】\n') + toolPreamble(ctx)
          }
          // Verified continuation: receipts + genuinely new entries only —
          // the assistant body the upstream session already produced is not
          // repeated; local call ids ride in the association note instead.
          // The note uses the WIRE names the upstream session actually wrote.
          // (deltaEntries is always set here: firstTurn === st.entries.length === 0
          // is false only on the single matched-continuation path.)
          const deltaText = firstTurn
            ? flat
            : buildContinuationDelta(st.lastReplyWire, deltaEntries, serializeLedger)
          const send = composeTurnText({
            firstTurn,
            persona,
            toolBlock,
            toolsPresent: ctx.hasTools,
            deltaText,
            prefix: ctx.prefix,
          })

          // One turn; an accepted generation is never resent automatically.
          const turnResult = yield* oneTurn({ st, send, askedModel, parseCalls })

          // End-of-turn validation BEFORE any tool call reaches the client:
          // violations are typed protocol errors, never a disguised `stop`.
          const allCalls = turnResult.allCalls
          let violation = null
          if (ctx.choice.mode === 'none' && allCalls.length > 0)
            violation = protocolError(PROTOCOL.TOOL_CALL_NOT_ALLOWED, 'tool_choice=none 禁止工具调用，但本轮出现了工具调用（不伪装 stop）')
          else if (ctx.choice.mode === 'required' && allCalls.length === 0)
            violation = protocolError(PROTOCOL.TOOL_CHOICE_UNSATISFIED, 'tool_choice=required 但本轮没有发出任何工具调用（不伪装 stop）')
          else if (ctx.choice.mode === 'function' && !(allCalls.length === 1 && allCalls[0].name === ctx.choice.name))
            violation = protocolError(
              PROTOCOL.TOOL_CHOICE_MISMATCH,
              `tool_choice 指定函数 ${ctx.choice.name}，实际${allCalls.length === 0 ? '没有调用' : `调用了 ${allCalls.map((c) => c.name).join('、')}`}`,
            )
          else if (!ctx.parallel && allCalls.length > 1)
            violation = protocolError(
              PROTOCOL.PARALLEL_VIOLATED,
              `parallel_tool_calls=false 但本轮出现了 ${allCalls.length} 个工具调用（不伪装 stop）`,
            )
          if (violation) {
            markUnusable(st) // session text contains calls the client never received
            throw violation
          }

          // Deliver the buffered calls only after validation passed.
          for (const c of allCalls) yield { toolCall: c }

          // Advance session state ONLY after a fully validated turn.
          st.entries = ledger.entries
          st.lastFull = flat
          st.emittedCallIds = allCalls.map((c) => c.id)
          // The structured reply the client must echo back for the NEXT turn
          // to count as a continuation (content exactly as delivered, incl.
          // empty; tool_calls exactly id/name/arguments; reasoning excluded).
          // lastReplyWire is the same reply with WIRE names for the upstream
          // association note (usable even if the next request omits tools).
          st.lastReply = {
            content: turnResult.deliveredText,
            toolCalls: allCalls.map((c) => ({ id: c.id, name: c.name, arguments: c.arguments })),
          }
          st.lastReplyWire = {
            content: turnResult.deliveredText,
            toolCalls: allCalls.map((c) => ({ id: c.id, name: ctx.nameToWire.get(c.name) ?? c.name, arguments: c.arguments })),
          }
          st.sessionId = turnResult.result.sessionId ?? st.sessionId
          st.model = askedModel
          st.toolsKey = tKey
          st.exhausted = st.exhausted || turnResult.result.ctxFull === true
          if (turnResult.result.sessionTokens) {
            yield { diagnostics: { session_context_tokens: turnResult.result.sessionTokens } }
          }
        } catch (e) {
          markUnusable(st)
          throw e
        }
        } finally {
          if (ownsBusy) {
            st.busy--
            ownsBusy = false
          }
          trimPool()
        }
      } finally {
        if (release) release() // released exactly once, only after the lock was acquired (guard covers pre-abort / queued-cancel exits)
        removeOuter() // always: pre-abort, queued-cancel, upstream failure, success — the caller-signal listener never outlives the request
      }
    }

    /** One upstream turn through the canonical parser. Text/reasoning is
     * yielded live; tool calls are buffered. Aborts bridge through one
     * controller; every derived rejection is handled; listeners removed. */
    async function* oneTurn({ st, send, askedModel, parseCalls }) {
      const turnCtl = new AbortController()
      const fwdAbort = () => {
        try {
          turnCtl.abort()
        } catch {}
      }
      if (signal?.aborted) turnCtl.abort()
      else signal?.addEventListener('abort', fwdAbort, { once: true })

      const out = []
      let wake = null
      let closed = false
      let pumpErr = null
      let protoErr = null
      const put = (ev) => {
        if (ev.protocolError) {
          // fail closed: interrupt upstream, surface the typed error once
          if (!protoErr) {
            protoErr = ev.protocolError
            fwdAbort()
          }
          return
        }
        out.push(ev)
        wake?.()
        wake = null
      }
      const parser = parseCalls ? new ToolStreamParser(put, ctx) : null
      const turn = chatTurn(transport, {
        cookie: liveCookie,
        projectId: st.projectId,
        sessionId: st.sessionId ?? undefined,
        text: send.text,
        invisible: send.invisible,
        modelId: askedModel,
        signal: turnCtl.signal,
      })
      const pump = (async () => {
        try {
          for await (const ev of turn.events) {
            if (parser && ev.content !== undefined) parser.push(ev.content)
            else put(ev)
          }
          parser?.end()
        } catch (e) {
          pumpErr = e
        } finally {
          closed = true
          wake?.()
          wake = null
        }
      })()
      pump.catch(() => {}) // derived rejection handled; real error rethrown below

      try {
        const allCalls = []
        let deliveredText = '' // exact post-parse content the client will echo back
        for (;;) {
          while (out.length) {
            const ev = out.shift()
            if (ev.toolCall) {
              allCalls.push(ev.toolCall) // buffered: client sees nothing before full-turn validation
              continue
            }
            if (ev.content) deliveredText += ev.content
            yield ev
          }
          if (closed) break
          await new Promise((r) => {
            wake = r
          })
        }
        await pump.catch(() => {})
        if (protoErr) throw protocolError(protoErr.code, protoErr.message, protoErr.detail)
        if (pumpErr) throw pumpErr
        const result = await turn.done // upstream failure rejects here; no fake success
        return { result, allCalls, deliveredText }
      } finally {
        if (signal) {
          try {
            signal.removeEventListener('abort', fwdAbort)
          } catch {}
        }
      }
    }
    return run() // start the generator; callers iterate it directly
  }

  return {
    handle,
    // diagnostic surface for offline tests (no behavior)
    _pool: pool,
    _pendingCleanup: pendingCleanup,
    _cookie: () => liveCookie,
    _options: { persona, maxProjects, maxTurnBytes, elideToolResults },
  }
}
