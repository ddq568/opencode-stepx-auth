// Network boundary: HTTP api + one-shot WS turn, fully injectable so the
// offline test suite can drive the entire lifecycle with a mock transport
// and zero real network. No module-level state: every account runtime owns
// its transport calls, its cookie and its callbacks.
//
// Turn contract (cancellation & teardown):
// - a signal aborted BEFORE connect produces no request at all;
// - abort anywhere (queued / open / streaming) sends chat.interrupt, fails
//   the done promise exactly once, tears down all listeners and timers and
//   closes the socket;
// - the events iterator is closed via done.then(onOk, onFail) so the derived
//   promise can never be an unhandled rejection;
// - nothing here ever retries an accepted generation.

import { randomUUID, randomBytes } from 'node:crypto'
import { httpError } from './errors.mjs'

export const SITE = 'https://studio.stepx.com'
export const API = SITE + '/api'
export const WS_URL = 'wss://studio-api.stepx.com/ws'
// Browser UA header for the site's own HTTP/WS endpoints (a wire protocol
// detail — not an agent-platform declaration).
export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
export const USER_LOCALE = 'zh'

export function createTransport(overrides = {}) {
  return {
    fetch: overrides.fetch ?? ((url, init) => fetch(url, init)),
    WebSocket: overrides.WebSocket ?? globalThis.WebSocket,
    timers: {
      apiTimeoutMs: 30_000,
      sendDelayMs: 400,
      pingMs: 25_000,
      idleMs: 300_000,
      hardMs: 900_000,
      retryDelayMs: 2_500,
      projectLimitDelayMs: 65_000,
      ...(overrides.timers ?? {}),
    },
  }
}

export const defaultTransport = createTransport()

export function apiHeaders(cookie, extra = {}) {
  return {
    'content-type': 'application/json',
    'user-agent': USER_AGENT,
    origin: SITE,
    referer: SITE + '/',
    'zy-client-lang': USER_LOCALE,
    cookie,
    ...extra,
  }
}

export function mergeSetCookie(cookieHeader, setCookieLines) {
  const jar = new Map()
  for (const part of String(cookieHeader || '').split(';')) {
    const p = part.trim()
    if (p && p.includes('=')) jar.set(p.split('=')[0], p)
  }
  for (const line of setCookieLines) {
    const m = String(line).match(/^([^=;\s]+)=([^;]*)/)
    if (m) jar.set(m[1], `${m[1]}=${m[2]}`)
  }
  return [...jar.values()].join('; ')
}

export async function api(tr, cookie, pathname, { method = 'GET', body, signal, onCookieRefresh } = {}) {
  const res = await tr.fetch(API + pathname, {
    method,
    headers: apiHeaders(cookie),
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: signal ?? AbortSignal.timeout(tr.timers.apiTimeoutMs),
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {}
  // The site rotates its session cookies; adopt whatever it hands back via
  // the account runtime's own callback (never a module global).
  const setCookies = typeof res.headers?.getSetCookie === 'function' ? res.headers.getSetCookie() : []
  if (setCookies.length && onCookieRefresh) {
    const merged = mergeSetCookie(cookie, setCookies)
    if (merged && merged !== cookie) onCookieRefresh(merged)
  }
  return { status: res.status, ok: res.ok, json, text, headers: res.headers }
}

function delay(ms, signal) {
  return new Promise((res, rej) => {
    if (signal?.aborted) return rej(httpError(499, '请求已取消'))
    let onAbort
    const t = setTimeout(() => {
      if (onAbort && signal) signal.removeEventListener('abort', onAbort)
      res()
    }, ms)
    t.unref?.()
    if (signal) {
      onAbort = () => {
        clearTimeout(t)
        signal.removeEventListener('abort', onAbort)
        rej(httpError(499, '请求已取消'))
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}

/**
 * Create a project. Bounded retry: exactly one retry on creation rate limit
 * (response containing "Global project creation limit" or "[Limit]") with a
 * 65-second backoff, or on 429/5xx with generic backoff, reusing the SAME
 * idempotent clientRequestId (at most 2 attempts total). The response is
 * validated (project id must exist) — no blind resend of an accepted creation.
 * If retry still fails, throws an error carrying the original upstream text.
 */
export async function createProject(tr, cookie, modelId, label, { signal, onCookieRefresh } = {}) {
  if (signal?.aborted) throw httpError(499, '请求已取消')
  const clientRequestId = randomUUID()
  let r
  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) throw httpError(499, '请求已取消')
    r = await api(tr, cookie, '/projects', {
      method: 'POST',
      signal,
      onCookieRefresh,
      body: {
        name: label,
        projectType: 'web',
        model: modelId,
        builderType: 'app',
        productType: 'app',
        description: label,
        source: 'home',
        clientRequestId,
      },
    })
    const id0 = r.json?.project?.id ?? r.json?.id
    if (id0) return String(id0)
    if (attempt === 0) {
      const bodyText = typeof r.text === 'string' ? r.text : JSON.stringify(r.json ?? '')
      const isLimit = bodyText.includes('Global project creation limit') || bodyText.includes('[Limit]')
      if (isLimit) {
        const ms = Number.isFinite(tr.timers?.projectLimitDelayMs) ? Math.max(0, tr.timers.projectLimitDelayMs) : 65_000
        await delay(ms, signal)
        continue
      }
      if (r.status === 429 || r.status >= 500) {
        const ra = Number(r.headers?.get?.('retry-after'))
        const ms = Number.isFinite(ra) && ra >= 0 ? Math.min(30_000, Math.max(250, ra * 1000)) : tr.timers.retryDelayMs
        await delay(ms, signal)
        continue
      }
    }
    break
  }
  if (r.status === 401) throw httpError(401, 'Step Studio 登录已过期，请在 magpie 里重新登录 stepx')
  throw httpError(r.status >= 400 ? r.status : 502, `创建 Step Studio 项目失败（HTTP ${r.status}）${(r.text || '').slice(0, 500)}`)
}

/**
 * UTF-8 byte size of the serialized chat.send frame (JSON escaping and the
 * WS envelope included) — the unit the whole-request budget is measured in.
 * Placeholder ids keep the estimate deterministic; a separate headroom slack
 * in the budget check covers id-length variance.
 */
export function requestFrameBytes(invisible, text, modelName) {
  const frame = {
    type: 'chat.send',
    projectId: 'p'.repeat(24),
    turnId: 't_' + '0'.repeat(16),
    payload: {
      chatSend: {
        doc: { blocks: [...(invisible ? [{ ref: { kind: 'invisibleText', text: invisible } }] : []), { text }] },
        ...(modelName && modelName !== 'auto' ? { model: modelName } : {}),
      },
    },
    userLocale: USER_LOCALE,
  }
  return Buffer.byteLength(JSON.stringify(frame), 'utf8')
}

export async function setProjectModel(tr, cookie, projectId, modelId, opts = {}) {
  await api(tr, cookie, `/projects/${projectId}`, { method: 'PATCH', body: { model: modelId }, ...opts }).catch(() => {})
}

export async function deleteProject(tr, cookie, projectId, opts = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await api(tr, cookie, `/projects/${projectId}`, { method: 'DELETE', ...opts }).catch(() => null)
    const transient = !r || r.status >= 500 || /LEASE_FAILED/.test(r.text ?? '')
    if (!transient || attempt === 1) return
    await delay(tr.timers.retryDelayMs, undefined).catch(() => {})
  }
}

/**
 * One turn over one fresh WebSocket connection.
 * Resolves {sessionId, text, thinking, turnId, sessionTokens, ctxFull} on
 * turn.completed; rejects with a typed httpError otherwise.
 */
export function chatTurn(tr, { cookie, projectId, sessionId, text, invisible, modelId, signal }) {
  let ws
  let settled = false
  let resolveDone, rejectDone
  let pingTimer = null
  let idleTimer = null
  let hardTimer = null
  let sendTimer = null
  const done = new Promise((res, rej) => {
    resolveDone = res
    rejectDone = rej
  })
  done.catch(() => {}) // done itself is always marked handled; consumers get the rejection through await or the events iterator
  const seenSeq = new Set()
  const acc = { text: '', thinking: '', sessionTokens: 0, ctxFull: false }
  // Our own turn id: sent with chat.send (the web client does the same) so
  // replayed history from `project.switch ... resumeSeq:{}` — which carries
  // the session's OLD turns — can be told apart from this turn's frames.
  let myTurn = 't_' + randomBytes(8).toString('hex')
  let turnId = null
  let gotSessionId = sessionId || null
  let onEvent = null

  const clearTimers = () => {
    clearInterval(pingTimer)
    clearTimeout(idleTimer)
    clearTimeout(hardTimer)
    clearTimeout(sendTimer)
    pingTimer = idleTimer = hardTimer = sendTimer = null
  }
  function onAbort() {
    try {
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'chat.interrupt', projectId, ...(gotSessionId ? { sessionId: gotSessionId } : {}) }))
      }
    } catch {}
    fail(httpError(499, '请求已取消'))
  }
  const finish = (fn, arg) => {
    if (settled) return
    settled = true
    clearTimers()
    try {
      signal?.removeEventListener?.('abort', onAbort)
    } catch {}
    try {
      if (ws) {
        ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null
        ws.close?.()
      }
    } catch {}
    fn(arg)
  }
  const fail = (err) => finish(rejectDone, err)
  const succeed = () =>
    finish(resolveDone, {
      sessionId: gotSessionId,
      text: acc.text,
      thinking: acc.thinking,
      turnId,
      sessionTokens: acc.sessionTokens,
      ctxFull: acc.ctxFull,
    })

  const armIdle = () => {
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => fail(httpError(504, 'Step Studio 5 分钟没有输出（idle timeout）')), tr.timers.idleMs)
    idleTimer.unref?.()
  }

  function handleMessage(raw) {
    let d
    try {
      d = JSON.parse(raw)
    } catch {
      return
    }
    if (d.sessionId) gotSessionId ??= d.sessionId
    switch (d.type) {
      case 'pong':
        armIdle()
        return
      case 'ack':
        if (d.turnId) {
          if (d.turnId !== myTurn) myTurn = d.turnId // server assigned its own
          turnId ??= myTurn
        }
        armIdle()
        return
      case 'chat.queued':
      case 'project.lifecycle.changed':
      case 'project.profile.changed':
      case 'preview.config.changed':
      case 'preview.ready':
      case 'compact.status':
      case 'task.update':
      case 'turn.progress':
        armIdle()
        return
      case 'context.update': {
        // Session-context diagnostic ONLY — never presented as billing usage.
        const cu = d.payload?.contextUpdate
        if (cu?.totalTokens) acc.sessionTokens = Number(cu.totalTokens) || acc.sessionTokens
        if (
          Number(cu?.percentage) >= 95 ||
          (Number(cu?.maxTokens) > 0 && Number(cu?.totalTokens) / Number(cu?.maxTokens) >= 0.95)
        )
          acc.ctxFull = true
        armIdle()
        return
      }
      case 'message.append': {
        armIdle()
        if (d.turnId !== undefined && d.turnId !== myTurn) return // replayed or foreign turn
        // Frames may be delivered twice; the web client dedupes on
        // (sessionId, seq) and so do we.
        if (d.seq !== undefined && d.sessionId) {
          const k = `${d.sessionId}:${d.seq}`
          if (seenSeq.has(k)) return
          seenSeq.add(k)
        }
        const ma = d.payload?.messageAppend ?? {}
        const delta = typeof ma.delta === 'string' ? ma.delta : ''
        if (ma.kind === 'thinking') {
          acc.thinking += delta
          if (delta) push({ reasoning: delta })
        } else if (ma.kind === 'text') {
          acc.text += delta
          if (delta) push({ content: delta })
        } // 'user' = our own echo; builder/tool kinds are suppressed
        return
      }
      case 'turn.completed':
        if (d.turnId !== undefined && d.turnId !== myTurn) return
        succeed()
        return
      case 'turn.failed': {
        if (d.turnId !== undefined && d.turnId !== myTurn) return
        const why = d.payload?.turnFailed
        fail(httpError(502, `Step Studio 回合失败：${why?.reason ?? why?.message ?? JSON.stringify(why ?? {}).slice(0, 200)}`))
        return
      }
      case 'error':
        fail(httpError(502, `Step Studio 错误：${JSON.stringify(d.payload ?? d).slice(0, 300)}`))
        return
      case 'user.banned':
        fail(httpError(403, '该 Step Studio 账号已被封禁'))
        return
      default:
        armIdle()
    }
  }

  const push = (ev) => {
    try {
      onEvent?.(ev)
    } catch {}
  }

  // Pre-aborted: fail before any socket or timer exists.
  if (signal?.aborted) {
    fail(httpError(499, '请求在开始前已取消'))
  } else {
    signal?.addEventListener?.('abort', onAbort, { once: true })
    pingTimer = setInterval(() => {
      try {
        ws?.send?.(JSON.stringify({ type: 'ping' }))
      } catch {}
    }, tr.timers.pingMs)
    pingTimer.unref?.()
    hardTimer = setTimeout(() => fail(httpError(504, 'Step Studio 回合超时')), tr.timers.hardMs)
    hardTimer.unref?.()
    connect()
  }

  function connect() {
    ws = new tr.WebSocket(WS_URL, { headers: { cookie, 'user-agent': USER_AGENT, origin: SITE } })
    ws.onopen = () => {
      try {
        ws.send(JSON.stringify({ type: 'project.switch', projectId, payload: { projectSwitch: { resumeSeq: {} } } }))
      } catch (e) {
        fail(httpError(502, 'project.switch 发送失败：' + e.message))
        return
      }
      sendTimer = setTimeout(() => {
        if (settled) return
        try {
          ws.send(
            JSON.stringify({
              type: 'chat.send',
              projectId,
              turnId: myTurn,
              ...(sessionId ? { sessionId } : {}),
              payload: {
                chatSend: {
                  doc: {
                    blocks: [
                      ...(invisible ? [{ ref: { kind: 'invisibleText', text: invisible } }] : []),
                      { text },
                    ],
                  },
                  ...(modelId && modelId !== 'auto' ? { model: modelId } : {}),
                },
              },
              userLocale: USER_LOCALE,
            }),
          )
        } catch (e) {
          fail(httpError(502, 'chat.send 发送失败：' + e.message))
          return
        }
        armIdle()
      }, tr.timers.sendDelayMs)
      sendTimer.unref?.()
    }
    ws.onmessage = (ev) => handleMessage(typeof ev.data === 'string' ? ev.data : '')
    ws.onerror = () => {
      if (!settled) fail(httpError(502, 'Step Studio WebSocket 连接失败（登录态可能已过期）'))
    }
    ws.onclose = () => {
      if (!settled) fail(httpError(502, 'Step Studio WebSocket 意外断开'))
    }
  }

  const events = {
    [Symbol.asyncIterator]() {
      const queue = []
      let wake = null
      let closed = false
      onEvent = (ev) => {
        queue.push(ev)
        wake?.()
        wake = null
      }
      // BOTH settle paths are handled here: the derived promise always
      // resolves, so a rejected done can never surface as unhandledRejection.
      const closeIter = () => {
        closed = true
        wake?.()
        wake = null
      }
      done.then(closeIter, closeIter)
      return {
        async next() {
          for (;;) {
            if (queue.length) return { value: queue.shift(), done: false }
            if (closed) return { done: true }
            await new Promise((r) => {
              wake = r
            })
          }
        },
      }
    },
  }
  return { events, done }
}
