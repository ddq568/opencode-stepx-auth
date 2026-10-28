// Independent fault/contract suite (architecture-contract layer).
//
// Scope: this file is written by a REVIEW child. It adds tests only — every
// production module is treated as read-only. It drives the REAL entry
// (StepXAuthPlugin -> auth.loader -> runtime.handle) over the REAL
// src/transport | src/session pipeline with mock HTTP + mock WebSocket only;
// global fetch/WebSocket are replaced with throwing functions by
// ../helpers.mjs BEFORE any production import, so a real network attempt
// fails loudly instead of leaking.
//
// 12 groups, each mapping to a named contract:
//   g01 entry surface: fetch(Request) / fetch(url, init) / abort signal,
//       pre-abort = 499 with zero HTTP + zero sockets, empty-auth loader
//   g02 same-name tools x2: distinct ids, out-of-order receipts, empty
//       stdout receipt preserved verbatim, call-id association intact
//   g03 declared name already shaped like an alias ("m_read") cannot
//       collide with the wire-prefix table
//   g04 tool_choice / parallel enforcement + undeclared / missing /
//       ambiguous names + unsupported schema keywords: typed 4xx, zero
//       executable calls delivered, violating session never continued
//   g05 raw format (A): exact whitespace/quotes preserved per schema,
//       numeric-string vs typed number, boolean, null-type rejection,
//       close-tag conflict rejection — through the full gateway, not units
//   g06 chunk-split invariance END-TO-END: same SSE event sequence for any
//       WS message.append fragmentation, incl. 2-call ordering
//   g07 cross-account isolation with cookie rotation: two runtimes, same
//       conversation key by pure hash, still zero shared state
//   g08 same-head divergence + first-turn concurrency + ambiguous
//       continuation: serialized, never blind-shared
//   g09 busy sessions are never reclaimed: maxProjects=1, DELETE only after
//       idle, exactly the LRU victim
//   g10 cancellation & failure paths: abort while queued on the lock,
//       SSE reader.cancel, upstream turn.failed, WS network error — typed
//       errors, teardown, no deadlock, retry always gets a fresh project
//   g11 UTF-8 budget: over-limit = 413 BEFORE any HTTP; under-limit = full
//       skill/system content preserved byte-exact in the wire frame
//   g12 context.update is diagnostics, never billing usage; synthetic
//       SKILL.md protocol loop (nonce) with a client-side read-tool mock:
//       skill preserved upstream, tool result returns under its call id.
//       PROTOCOL-LAYER ONLY: no real pi/WSL skill execution is claimed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { makeGateway, runNonStream, driveTurn, readSse, tick, waitFor } from '../helpers.mjs'
import { buildLedger, conversationKey } from '../../src/ledger.mjs'
import { PREAMBLE } from '../../src/prompt.mjs'

const GATEWAY = 'https://gateway.test/v1/chat/completions'

const READ_TOOL = {
  type: 'function',
  function: {
    name: 'read',
    description: 'read a local file',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
  },
}

function post(g, payload, init) {
  return g.session.fetch(GATEWAY, { method: 'POST', body: JSON.stringify(payload), ...init })
}

/** Drive an upstream turn with ARBITRARY message.append fragmentation. */
async function runSse(g, payload, deltas) {
  const p = g.session.fetch(GATEWAY, { method: 'POST', body: JSON.stringify(payload) })
  await tick()
  const ws = g.lastSocket()
  ws.open()
  await waitFor(() => ws.chatSend(), { what: 'chat.send frame' })
  const send = ws.chatSend()
  ws.recv({ type: 'ack', turnId: send.turnId })
  let seq = 1
  for (const d of deltas) {
    ws.recv({ type: 'message.append', turnId: send.turnId, sessionId: 'sess-fix', seq: seq++, payload: { messageAppend: { kind: 'text', delta: d } } })
  }
  ws.recv({ type: 'turn.completed', turnId: send.turnId })
  const res = await p
  return { res, ws, events: await readSse(res), send }
}

/** Visible text of the last doc block of a chat.send frame. */
const visibleText = (send) => send.payload.chatSend.doc.blocks.at(-1).text
/** Invisible (persona/tool preamble) ref block, when present. */
const invisibleText = (send) => send.payload.chatSend.doc.blocks[0]?.ref?.text ?? ''

// ---------------------------------------------------------------- g01

test('g01 entry: pre-aborted Request signal -> 499, zero HTTP, zero sockets; empty auth -> loader returns {}', { timeout: 10_000 }, async () => {
  const g = await makeGateway()
  const ac = new AbortController()
  ac.abort()
  const req = new Request(GATEWAY, {
    method: 'POST',
    body: JSON.stringify({ model: 'auto', stream: false, messages: [{ role: 'user', content: 'never sent' }] }),
    signal: ac.signal,
  })
  const res = await g.session.fetch(req)
  assert.equal(res.status, 499)
  const body = await res.json()
  assert.equal(body.error.type, 'request_cancelled')
  assert.equal(g.http.calls.length, 0, 'pre-abort must not touch HTTP (not even the catalog GET)')
  assert.equal(g.sockets.length, 0, 'pre-abort must not open any socket')
})

test('g01 entry: init.signal aborted mid-turn -> chat.interrupt, socket torn down, 499; loader contract holds', { timeout: 10_000 }, async () => {
  const g = await makeGateway()
  assert.equal(g.session.baseURL, 'https://studio.stepx.com/v1', 'loader exposes baseURL')
  const ctl = new AbortController()
  const p = post(g, { model: 'auto', stream: true, messages: [{ role: 'user', content: 'cancel me' }] }, { signal: ctl.signal })
  await tick()
  const ws = g.lastSocket()
  ws.open()
  await waitFor(() => ws.chatSend(), { what: 'chat.send before cancel' })
  ctl.abort()
  const res = await p
  assert.equal(res.status, 200, 'SSE responses are always 200; cancellation surfaces in-band')
  const events = await readSse(res)
  assert.equal(events.at(-1), '[DONE]', 'stream still terminates cleanly')
  const errChunk = events.find((e) => e.error)
  assert.equal(errChunk.error.code, 499)
  assert.equal(errChunk.error.type, 'request_cancelled')
  assert.ok(!events.some((e) => e.choices?.[0]?.finish_reason === 'stop'), 'cancelled stream has no fake stop finish')
  assert.ok(ws.frames().some((f) => f.type === 'chat.interrupt'), 'upstream turn interrupted on abort')
  assert.ok(ws.closedByRuntime, 'socket torn down on abort')
  // loader with no usable auth key must not build a runtime at all
  const { StepXAuthPlugin } = await import('../../index.mjs')
  const plugin = await StepXAuthPlugin({ client: null }, { transport: g.transport })
  const empty = await plugin.auth.loader(async () => ({ key: '   ' }))
  assert.deepEqual(empty, {}, 'empty cookie -> no runtime object')
})

// ---------------------------------------------------------------- g02

test('g02 same-name tool x2: distinct call ids, out-of-order receipts, empty stdout receipt preserved, ids re-associate', { timeout: 10_000 }, async () => {
  const g = await makeGateway()
  const twoCalls = '<fn:invoke>{"name": "m_read", "arguments": {"path": "/x"}}</fn:invoke>and<fn:invoke>{"name": "m_read", "arguments": {"path": "/y"}}</fn:invoke>'
  const { res } = await runNonStream(g, { model: 'auto', stream: false, messages: [{ role: 'user', content: 'read both' }], tools: [READ_TOOL] }, { text: twoCalls })
  const body = await res.json()
  const calls = body.choices[0].message.tool_calls
  assert.equal(calls.length, 2, 'two parallel calls to the SAME tool both delivered')
  assert.equal(calls[0].function.name, 'read')
  assert.equal(calls[1].function.name, 'read')
  assert.notEqual(calls[0].id, calls[1].id, 'ids must be distinct even for same-name calls')
  const [idX, idY] = [calls[0].id, calls[1].id]

  // Receipts come back OUT OF ORDER (y before x); y has EMPTY stdout. The
  // assistant echo carries the EXACT delivered reply — including the text
  // chunk 'and' between the two calls (verified-echo contract: the echo is
  // checked structurally against what was delivered, so a null content where
  // the reply had text would NOT be a continuation).
  const messages = [
    { role: 'user', content: 'read both' },
    {
      role: 'assistant',
      content: 'and',
      tool_calls: [
        { id: idX, type: 'function', function: { name: 'read', arguments: '{"path":"/x"}' } },
        { id: idY, type: 'function', function: { name: 'read', arguments: '{"path":"/y"}' } },
      ],
    },
    { role: 'tool', tool_call_id: idY, content: '' },
    { role: 'tool', tool_call_id: idX, content: 'X-stdout' },
  ]
  const p2 = post(g, { model: 'auto', stream: false, messages, tools: [READ_TOOL] })
  await tick()
  const ws2 = g.lastSocket()
  ws2.open()
  const info = await driveTurn(ws2, { text: 'both read' })
  const res2 = await p2
  const body2 = await res2.json()
  assert.equal(body2.choices[0].finish_reason, 'stop')
  assert.equal(g.http.projectCreates(), 1, 'out-of-order receipts are still valid continuity evidence (same project)')
  const sendText = visibleText(info.send)
  const iY = sendText.indexOf(`[tool_result id=${idY}]`)
  const iX = sendText.indexOf(`[tool_result id=${idX}]`)
  assert.ok(iY !== -1 && iX !== -1, 'both receipt ids present')
  assert.ok(iY < iX, 'receipts stay in client order, not reordered')
  assert.ok(sendText.includes(`[tool_result id=${idY}]`), 'empty receipt rendered as its bare id header')
  assert.ok(
    sendText.includes(`[tool_result id=${idY}]\n\n[tool_result id=${idX}]\nX-stdout`),
    'empty stdout stays empty (no embellishment) and X stdout stays attached to idX',
  )
})

// ---------------------------------------------------------------- g03

test('g03 declared "m_read" cannot collide with the m_ alias table: collision-free prefix, both tools callable', { timeout: 10_000 }, async () => {
  const g = await makeGateway()
  const M_TOOL = {
    type: 'function',
    function: { name: 'm_read', description: 'already alias-shaped name', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  }
  const both = '<fn:invoke>{"name": "m0_read", "arguments": {"path": "/a"}}</fn:invoke><fn:invoke name="m0_m_read"><path>/b</path></fn:invoke>'
  const { res, ws } = await runNonStream(
    g,
    { model: 'auto', stream: false, messages: [{ role: 'user', content: 'collision probe' }], tools: [READ_TOOL, M_TOOL] },
    { text: both },
  )
  const body = await res.json()
  assert.equal(body.choices[0].finish_reason, 'tool_calls')
  const calls = body.choices[0].message.tool_calls
  assert.deepEqual(
    calls.map((c) => [c.function.name, JSON.parse(c.function.arguments).path]),
    [['read', '/a'], ['m_read', '/b']],
    'wire m0_read -> read, m0_m_read -> m_read, no ambiguity',
  )
  const inv = invisibleText(ws.chatSend())
  assert.ok(inv.includes('m0_'), 'a collision-free prefix was chosen')
  assert.ok(inv.includes('"m0_read"') && inv.includes('"m0_m_read"'), 'both wire names taught verbatim')
  assert.ok(!inv.includes('"m_read"'), 'the un-prefixed alias form is never taught as a wire name')
})

// ---------------------------------------------------------------- g04

test('g04 enforcement: undeclared / missing-name / ambiguous calls -> typed 422, no executable call delivered', { timeout: 10_000 }, async () => {
  // (a) undeclared tool name
  const g = await makeGateway()
  const bad = '<fn:invoke>{"name": "m_hack", "arguments": {}}</fn:invoke>'
  const { res } = await runNonStream(g, { model: 'auto', stream: false, messages: [{ role: 'user', content: 'undecl' }], tools: [READ_TOOL] }, { text: bad })
  assert.equal(res.status, 422)
  const body = await res.json()
  assert.equal(body.error.code, 'unknown_tool')
  assert.equal(body.choices, undefined, 'no choices: nothing executable ever reaches the client')

  // (a2) violating session is marked unusable -> identical retry gets a FRESH project
  const retry = await runNonStream(g, { model: 'auto', stream: false, messages: [{ role: 'user', content: 'undecl' }], tools: [READ_TOOL] }, { text: bad })
  assert.equal(retry.res.status, 422)
  await retry.res.text()
  assert.equal(g.http.projectCreates(), 2, 'poisoned session never continued')

  // (b) JSON body without "name" -> missing_name
  const g2 = await makeGateway()
  const { res: r2 } = await runNonStream(g2, { model: 'auto', stream: false, messages: [{ role: 'user', content: 'noname' }], tools: [READ_TOOL] }, { text: '<fn:invoke>{"arguments": {"path": "/x"}}</fn:invoke>' })
  assert.equal((await r2.json()).error.code, 'missing_name')

  // (c) raw-block shape WITHOUT the name attribute -> ambiguous_call (no shape guessing)
  const { res: r3 } = await runNonStream(g2, { model: 'auto', stream: false, messages: [{ role: 'user', content: 'noattr' }], tools: [READ_TOOL] }, { text: '<fn:invoke><path>/x</path></fn:invoke>' })
  assert.equal((await r3.json()).error.code, 'ambiguous_call')
})

test('g04 enforcement: none / required / forced-function / parallel=false violations are typed 4xx, never fake stop', { timeout: 10_000 }, async () => {
  const mk = () => makeGateway()
  const call = (tool) => `<fn:invoke>{"name": "${tool}", "arguments": {"path": "/p"}}</fn:invoke>`
  const WRITE_TOOL = {
    type: 'function',
    function: { name: 'write', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  }

  // tool_choice:"none" but the model emitted a call anyway
  const gN = await mk()
  const { res: rN } = await runNonStream(gN, { model: 'auto', stream: false, tool_choice: 'none', messages: [{ role: 'user', content: 'n' }], tools: [READ_TOOL] }, { text: call('m_read') })
  assert.equal((await rN.json()).error.code, 'tool_call_not_allowed')

  // tool_choice:"required" but the model answered with pure text
  const gR = await mk()
  const { res: rR } = await runNonStream(gR, { model: 'auto', stream: false, tool_choice: 'required', messages: [{ role: 'user', content: 'r' }], tools: [READ_TOOL] }, { text: 'plain answer, no tools' })
  assert.equal((await rR.json()).error.code, 'tool_choice_unsatisfied')

  // tool_choice forced to read, model called the other declared tool
  const gF = await mk()
  const { res: rF } = await runNonStream(
    gF,
    { model: 'auto', stream: false, tool_choice: { type: 'function', function: { name: 'read' } }, messages: [{ role: 'user', content: 'f' }], tools: [READ_TOOL, WRITE_TOOL] },
    { text: call('m_write') },
  )
  assert.equal((await rF.json()).error.code, 'tool_choice_mismatch')

  // positive control: the forced call is exactly the forced function -> delivered
  const gOk = await mk()
  const { res: rOk } = await runNonStream(
    gOk,
    { model: 'auto', stream: false, tool_choice: { type: 'function', function: { name: 'read' } }, messages: [{ role: 'user', content: 'ok' }], tools: [READ_TOOL, WRITE_TOOL] },
    { text: call('m_read') },
  )
  const okBody = await rOk.json()
  assert.equal(okBody.choices[0].finish_reason, 'tool_calls')
  assert.equal(okBody.choices[0].message.tool_calls[0].function.name, 'read')

  // anyOf is SUPPORTED now (Ajv-backed; feature addition — the old
  // anyOf-must-be-rejected assertion described a limitation, not a contract).
  // Legal nullable-union passes end-to-end; an ILLEGAL anyOf value is a typed
  // 422 at tool-call validation; truly unknown keywords are still rejected
  // at declaration time with zero upstream connections.
  const NULLABLE = {
    type: 'function',
    function: {
      name: 'x',
      parameters: { type: 'object', properties: { v: { anyOf: [{ type: 'string' }, { type: 'null' }] } }, required: ['v'], additionalProperties: false },
    },
  }
  const gAny = await mk()
  const { res: rAny } = await runNonStream(
    gAny,
    { model: 'auto', stream: false, messages: [{ role: 'user', content: 'any-of-ok' }], tools: [NULLABLE] },
    { text: '<fn:invoke>{"name": "m_x", "arguments": {"v": "hello"}}</fn:invoke>' },
  )
  const anyBody = await rAny.json()
  assert.equal(anyBody.choices[0].finish_reason, 'tool_calls', 'anyOf schema declares fine and the JSON value validates')
  assert.deepEqual(JSON.parse(anyBody.choices[0].message.tool_calls[0].function.arguments), { v: 'hello' })

  const gBadAny = await mk()
  const { res: rBadAny } = await runNonStream(
    gBadAny,
    { model: 'auto', stream: false, messages: [{ role: 'user', content: 'any-of-bad' }], tools: [NULLABLE] },
    { text: '<fn:invoke>{"name": "m_x", "arguments": {"v": 5}}</fn:invoke>' },
  )
  assert.equal(rBadAny.status, 422)
  assert.equal((await rBadAny.json()).error.code, 'schema_violation', 'anyOf illegal value = typed validation failure')

  const gS = await mk()
  const UNKNOWN_KW = {
    type: 'function',
    function: { name: 'u', parameters: { type: 'object', properties: { p: { type: 'string', hasMagicNullable: true } } } },
  }
  const rS = await post(gS, { model: 'auto', stream: false, messages: [{ role: 'user', content: 's' }], tools: [UNKNOWN_KW] })
  assert.equal(rS.status, 400)
  const sBody = await rS.json()
  assert.equal(sBody.error.code, 'unsupported_tool_schema', 'unknown validation keywords stay a typed declaration-time rejection')
  assert.equal(gS.sockets.length, 0, 'declaration rejection happens before any upstream connection')
})

test('g04 enforcement over SSE: parallel_tool_calls=false with 2 calls -> one typed error chunk + DONE, zero tool_call deltas, no stop finish', { timeout: 10_000 }, async () => {
  const g = await makeGateway()
  const two = '<fn:invoke>{"name": "m_read", "arguments": {"path": "/1"}}</fn:invoke><fn:invoke>{"name": "m_read", "arguments": {"path": "/2"}}</fn:invoke>'
  const { res, events } = await runSse(
    g,
    { model: 'auto', stream: true, parallel_tool_calls: false, messages: [{ role: 'user', content: 'sse-parallel' }], tools: [READ_TOOL] },
    [two.slice(0, 60), two.slice(60)],
  )
  assert.equal(res.status, 200)
  assert.ok(!events.some((e) => e.choices?.[0]?.delta?.tool_calls), 'no tool_call delta may reach the client on violation')
  assert.ok(!events.some((e) => e.choices?.[0]?.finish_reason === 'stop'), 'violation must not masquerade as stop')
  const errChunk = events.find((e) => e.error)
  assert.equal(errChunk.error.code, 'parallel_tool_calls_violated')
  assert.equal(errChunk.error.type, 'tool_protocol_error')
  assert.equal(events.at(-1), '[DONE]')
})

// ---------------------------------------------------------------- g05

test('g05 raw format A via gateway: quotes/newlines/leading+trailing spaces exact, number/boolean typed, numeric-string stays string', { timeout: 10_000 }, async () => {
  const g = await makeGateway()
  const RUN_TOOL = {
    type: 'function',
    function: {
      name: 'run',
      parameters: {
        type: 'object',
        properties: { script: { type: 'string' }, n: { type: 'integer' }, flag: { type: 'boolean' }, s: { type: 'string' } },
        required: ['script'],
      },
    },
  }
  const script = 'echo "a && b"\n  indented "line"\n trailing  '
  const raw = `<fn:invoke name="m_run">\n<script>${script}</script><n>42</n><flag>true</flag><s>42</s></fn:invoke>`
  const { res } = await runNonStream(g, { model: 'auto', stream: false, messages: [{ role: 'user', content: 'raw probe' }], tools: [RUN_TOOL] }, { text: raw })
  const body = await res.json()
  assert.equal(body.choices[0].finish_reason, 'tool_calls')
  const args = JSON.parse(body.choices[0].message.tool_calls[0].function.arguments)
  assert.equal(args.script, script, 'schema string keeps quotes, newlines, leading+trailing whitespace byte-exact')
  assert.equal(args.n, 42)
  assert.equal(typeof args.n, 'number', 'raw digits typed per schema')
  assert.equal(args.flag, true)
  assert.equal(args.s, '42', 'same digits under a string property stay a string')
})

test('g05 raw format A conflicts: embedded </fn:invoke> in a value -> raw_tag_conflict; null-typed raw block -> raw_form_ambiguous (JSON guidance)', { timeout: 10_000 }, async () => {
  const g = await makeGateway()
  const RUN_TOOL = {
    type: 'function',
    function: { name: 'run', parameters: { type: 'object', properties: { script: { type: 'string' } }, required: ['script'] } },
  }
  const conflict = '<fn:invoke name="m_run"><script>grep -v "</fn:invoke> not-a-close</script></fn:invoke>'
  const { res } = await runNonStream(g, { model: 'auto', stream: false, messages: [{ role: 'user', content: 'conflict probe' }], tools: [RUN_TOOL] }, { text: conflict })
  assert.equal(res.status, 422)
  const body = await res.json()
  assert.equal(body.error.code, 'raw_tag_conflict', 'close-tag inside a raw value rejects the WHOLE call, no partial call')
  assert.equal(body.choices, undefined)

  const NULL_TOOL = {
    type: 'function',
    function: { name: 'nullt', parameters: { type: 'object', properties: { v: { type: 'null' } }, required: ['v'] } },
  }
  const { res: r2 } = await runNonStream(g, { model: 'auto', stream: false, messages: [{ role: 'user', content: 'null probe 2' }], tools: [NULL_TOOL] }, { text: '<fn:invoke name="m_nullt"><v>x</v></fn:invoke>' })
  assert.equal((await r2.json()).error.code, 'raw_form_ambiguous', 'null type cannot be expressed raw — typed error directs to format B, never a guess')
})

// ---------------------------------------------------------------- g06

test('g06 end-to-end chunk-split invariance: any message.append fragmentation yields the identical SSE event sequence (2-call order stable)', { timeout: 10_000 }, async () => {
  const modelText =
    'A<fn:invoke>{"name": "m_read", "arguments": {"path": "/x"}}</fn:invoke>MID<fn:invoke>{"name": "m_read", "arguments": {"path": "/y"}}</fn:invoke>B'
  const cuts = [
    [modelText], // single chunk
    [modelText.slice(0, 2), modelText.slice(2)],
    [modelText.slice(0, 8), modelText.slice(8)], // inside "<fn:invo"
    [modelText.slice(0, 30), modelText.slice(30)], // inside first call JSON
    [modelText.slice(0, 70), modelText.slice(70)], // between the two calls
    [modelText.slice(0, modelText.length - 8), modelText.slice(-8)], // inside the last close tag
  ]
  const normalize = (events) =>
    JSON.stringify(
      events
        .filter((e) => e !== '[DONE]')
        .flatMap((e) => {
          const d = e.choices?.[0]?.delta
          if (!d) return []
          if (d.tool_calls) return d.tool_calls.map((tc) => ({ tc: { name: tc.function.name, args: tc.function.arguments } }))
          if (d.content) return [{ c: d.content }]
          return []
        }),
    )
  let reference = null
  let variant = 0
  for (const deltas of cuts) {
    const g = await makeGateway() // fresh runtime per variant: no session reuse interference
    const { events } = await runSse(g, { model: 'auto', stream: true, messages: [{ role: 'user', content: `split v${variant++}` }], tools: [READ_TOOL] }, deltas)
    const norm = normalize(events)
    if (reference === null) {
      reference = norm
      const tcs = JSON.parse(norm).filter((x) => x.tc)
      assert.equal(tcs.length, 2, 'both calls streamed')
      assert.deepEqual(tcs.map((t) => t.tc.name), ['read', 'read'], 'same-name calls keep emission order')
      assert.notEqual(tcs[0], undefined)
    } else {
      assert.equal(norm, reference, `fragmentation variant produced a different event sequence: ${JSON.stringify(deltas.map((d) => d.length))}`)
    }
    const finish = events.find((e) => e.choices?.[0]?.finish_reason)
    assert.equal(finish?.choices?.[0]?.finish_reason, 'tool_calls')
  }
})

// ---------------------------------------------------------------- g07

test('g07 cross-account isolation under cookie rotation: identical heads share only the pure key, never projects/cookies', { timeout: 10_000 }, async () => {
  const sharedMessages = [{ role: 'system', content: 'shared sys' }, { role: 'user', content: 'same head both accounts' }]
  // pure hash identity is EXPECTED (same input); it must not imply shared state
  const keyA = conversationKey(buildLedger(sharedMessages).entries, 'auto')
  const keyB = conversationKey(buildLedger(JSON.parse(JSON.stringify(sharedMessages))).entries, 'auto')
  assert.equal(keyA, keyB, 'same-parameter hash identity by construction')

  const gA = await makeGateway({
    auth: { key: 'a=1; b=2', accountId: 'accA' },
    mockHttpOptions: { setCookieOnModels: 'sid=NEWA; Path=/' }, // account A gets its session cookie rotated on the catalog GET
  })
  const gB = await makeGateway({ auth: { key: 'b=1; c=2', accountId: 'accB' } })

  const { res: resA, ws: wsA } = await runNonStream(gA, { model: 'auto', stream: false, messages: sharedMessages }, { text: 'A reply' })
  const { res: resB, ws: wsB } = await runNonStream(gB, { model: 'auto', stream: false, messages: sharedMessages }, { text: 'B reply' })
  assert.equal((await resA.json()).choices[0].message.content, 'A reply')
  assert.equal((await resB.json()).choices[0].message.content, 'B reply')

  assert.equal(wsA.headers.cookie, 'a=1; b=2; sid=NEWA', 'A rotated cookie merged into A jar, carried on WS')
  assert.equal(wsB.headers.cookie, 'b=1; c=2', 'B jar untouched by A rotation')
  assert.ok(!JSON.stringify(gB.http.calls).includes('sid=NEWA'), 'no A cookie ever reaches B transport')
  assert.ok(!JSON.stringify(gA.http.calls).includes('b=1'), 'no B cookie ever reaches A transport')
  assert.equal(gA.http.projectCreates(), 1)
  assert.equal(gB.http.projectCreates(), 1, 'same key still means one project PER RUNTIME, not shared')
})

// ---------------------------------------------------------------- g08

test('g08 same-head divergence + first-turn concurrency + ambiguous continuation: serialized, never blind-shared', { timeout: 10_000 }, async () => {
  const g = await makeGateway()
  // (1) plain first turn
  const { res: r1, ws: ws1 } = await runNonStream(g, { model: 'auto', stream: false, messages: [{ role: 'user', content: 'q1' }] }, { text: 'answer1' })
  await r1.json()
  assert.equal(g.http.projectCreates(), 1)
  // (2) strict structural extension -> SAME project + sessionId carried
  const p2 = post(g, { model: 'auto', stream: false, messages: [{ role: 'user', content: 'q1' }, { role: 'assistant', content: 'answer1' }, { role: 'user', content: 'q2' }] })
  await tick()
  const ws2 = g.lastSocket()
  ws2.open()
  const info2 = await driveTurn(ws2, { text: 'answer2' })
  await (await p2).json()
  assert.equal(g.http.projectCreates(), 1, 'continuation reuses the project')
  assert.equal(info2.send.projectId, ws1.chatSend().projectId, 'same upstream project')
  assert.equal(info2.send.sessionId, 'sess-1', 'upstream sessionId carried into continuation')

  // (3) same head, DIVERGENT second user message -> different conversation -> NEW project
  const { res: r3 } = await runNonStream(
    g,
    { model: 'auto', stream: false, messages: [{ role: 'user', content: 'q1' }, { role: 'assistant', content: 'answer1' }, { role: 'user', content: 'q2-DIVERGENT' }] },
    { text: 'answer3' },
  )
  await r3.json()
  assert.equal(g.http.projectCreates(), 2, 'divergence must not blind-share the session')

  // (4) two CONCURRENT identical first turns: both issued before either completes
  const payload = { model: 'auto', stream: false, messages: [{ role: 'user', content: 'race head' }] }
  const pC = post(g, payload)
  const pD = post(g, payload)
  await tick()
  const wsC = g.lastSocket()
  wsC.open()
  const iC = await driveTurn(wsC, { text: 'c reply' })
  const resC = await pC
  await waitFor(() => g.sockets.length >= 5, { what: 'second concurrent request got its turn (lock released)' })
  const wsD = g.sockets[4]
  wsD.open()
  await driveTurn(wsD, { text: 'd reply' })
  const resD = await pD
  assert.equal(resC.status, 200)
  assert.equal(resD.status, 200)
  assert.notEqual(iC.send.projectId, wsD.chatSend().projectId, 'concurrent twins each own a project')
  assert.equal(g.http.projectCreates(), 4, 'twin first turns -> two states, lock serialized them')

  // (5) extension of the twins — STRONGER semantics than the old draft: the
  // reply echo ('c reply' matches only C's delivered reply) now resolves the
  // candidates UNAMBIGUOUSLY, so the extension continues C. No blind pick:
  // a twin extension whose echo matched BOTH replies would still go fresh.
  const twinExt = { model: 'auto', stream: false, messages: [{ role: 'user', content: 'race head' }, { role: 'assistant', content: 'c reply' }, { role: 'user', content: 'extend?' }] }
  const { res: r5, ws: ws5 } = await runNonStream(g, twinExt, { text: 'extended' })
  await r5.json()
  assert.equal(g.http.projectCreates(), 4, 'reply echo resolves the twins deterministically -> continues C, no new state')
  assert.equal(ws5.chatSend().projectId, iC.send.projectId, 'continuation is C itself')
  // and a twin extension with a NON-delivered echo is refused a continuation
  const { res: r5b, ws: ws5b } = await runNonStream(g, { ...twinExt, messages: [{ role: 'user', content: 'race head' }, { role: 'assistant', content: 'something neither twin said' }, { role: 'user', content: 'extend?' }] }, { text: 'x' })
  await r5b.json()
  assert.equal(g.http.projectCreates(), 5, 'non-delivered echo -> fresh state')
  assert.notEqual(ws5b.chatSend().projectId, iC.send.projectId)
  assert.notEqual(ws5b.chatSend().projectId, wsD.chatSend().projectId)
})

// ---------------------------------------------------------------- g09

test('g09 busy sessions are never reclaimed: maxProjects=1 keeps the in-flight project, evicts only the idle LRU victim', { timeout: 10_000 }, async () => {
  const g = await makeGateway({ pluginOptions: { maxProjects: 1 } })
  // A: stream, held open (busy)
  const pA = post(g, { model: 'auto', stream: true, messages: [{ role: 'user', content: 'holder A' }] })
  await tick()
  const wsA = g.lastSocket()
  wsA.open()
  await waitFor(() => wsA.chatSend(), { what: 'A chat.send' })
  wsA.recv({ type: 'ack', turnId: wsA.chatSend().turnId }) // hold: no completion

  // B: different head -> second state while A is still busy
  const pB = post(g, { model: 'auto', stream: false, messages: [{ role: 'user', content: 'other B' }] })
  await tick()
  const wsB = g.lastSocket()
  assert.notEqual(wsB, wsA)
  wsB.open()
  await waitFor(() => g.http.projectCreates() === 2, { what: 'B project created while A busy' })
  assert.equal(g.http.projectDeletes(), 0, 'NOTHING deleted while both states are busy')

  // B completes -> its own state is now the idle LRU victim; A (busy) must survive
  const infoB = await driveTurn(wsB, { text: 'B done' })
  await (await pB).json()
  assert.equal(g.http.projectDeletes(), 1, 'exactly one reclaim after B went idle')
  assert.ok(g.http.calls.some((c) => c.method === 'DELETE' && c.url.endsWith(`/${infoB.send.projectId}`)), 'the deleted project is the idle one (B), never the busy one (A)')
  assert.ok(wsA.chatSend(), 'A socket still alive')

  // A completes -> pool back under the cap, nothing else reclaimed
  await driveTurn(wsA, { text: 'A done' })
  const resA = await pA
  await resA.text()
  assert.equal(g.http.projectDeletes(), 1, 'A itself is never reclaimed while/after being the only state')
})

// ---------------------------------------------------------------- g10

test('g10 cancel while queued on the conversation lock: 499, zero HTTP from the queued request, lock chain survives', { timeout: 10_000 }, async () => {
  const g = await makeGateway()
  const msgs = [{ role: 'user', content: 'lockq' }]
  // A holds the lock: stream, ack, never completes
  const pA = post(g, { model: 'auto', stream: true, messages: msgs })
  await tick()
  const wsA = g.lastSocket()
  wsA.open()
  await waitFor(() => wsA.chatSend(), { what: 'A chat.send' })
  wsA.recv({ type: 'ack', turnId: wsA.chatSend().turnId })

  // B queues behind A on the SAME key, then is aborted while queued
  const ctl = new AbortController()
  const pB = post(g, { model: 'auto', stream: false, messages: msgs }, { signal: ctl.signal })
  await tick(30)
  const callsBeforeAbort = g.http.calls.length
  ctl.abort()
  const resB = await pB
  assert.equal(resB.status, 499)
  assert.equal((await resB.json()).error.type, 'request_cancelled')
  assert.equal(g.http.calls.length, callsBeforeAbort, 'queued request made no HTTP while waiting and none on cancel')
  assert.equal(g.sockets.length, 1, 'no socket ever opened for the queued request')

  // A still completes normally
  await driveTurn(wsA, { text: 'A done' })
  const resA = await pA
  assert.equal(resA.status, 200)
  await resA.text()

  // C extends A -> lock chain intact, continuation on the same project
  const { res: resC, ws: wsC } = await runNonStream(
    g,
    { model: 'auto', stream: false, messages: [{ role: 'user', content: 'lockq' }, { role: 'assistant', content: 'A done' }, { role: 'user', content: 'next?' }] },
    { text: 'C done' },
  )
  await resC.json()
  assert.equal(g.http.projectCreates(), 1, 'chain survived the queued-cancel; C continued A project')
  assert.equal(wsC.chatSend().projectId, wsA.chatSend().projectId)
})

test('g10 failure paths: SSE reader.cancel interrupts upstream; turn.failed and WS network error are typed 502 with fresh-project retry', { timeout: 10_000 }, async () => {
  // (a) client reader.cancel mid-stream
  const g = await makeGateway()
  const p = post(g, { model: 'auto', stream: true, messages: [{ role: 'user', content: 'drop me' }] })
  await tick()
  const ws = g.lastSocket()
  ws.open()
  await waitFor(() => ws.chatSend(), { what: 'chat.send' })
  const res = await p
  const reader = res.body.getReader()
  await reader.read()
  await reader.cancel()
  await waitFor(() => ws.frames().some((f) => f.type === 'chat.interrupt'), { what: 'chat.interrupt after reader.cancel' })
  assert.ok(ws.closedByRuntime, 'socket torn down after reader.cancel')

  // (b) upstream turn.failed -> typed 502, retry gets a fresh project (not the failed one)
  const failed = await runNonStream(g, { model: 'auto', stream: false, messages: [{ role: 'user', content: 'failer' }] }, { failWith: 'capacity' })
  assert.equal(failed.res.status, 502)
  const failedProjectId = failed.info.send.projectId
  const failBody = await failed.res.json()
  assert.equal(failBody.error.type, 'upstream_error')
  assert.ok(JSON.stringify(failBody).includes('capacity'))
  const retry = await runNonStream(g, { model: 'auto', stream: false, messages: [{ role: 'user', content: 'failer' }] }, { text: 'recovered' })
  assert.equal(retry.res.status, 200)
  await retry.res.json()
  assert.notEqual(retry.info.send.projectId, failedProjectId, 'failed turn never continued; retry = fresh project')
  assert.equal(g.http.projectCreates(), 3, 'cancel-turn + failed-turn + retry each owned one project')

  // (c) WS network error mid-turn -> typed 502, no hang
  const g2 = await makeGateway()
  const p2 = post(g2, { model: 'auto', stream: false, messages: [{ role: 'user', content: 'netfail' }] })
  await tick()
  const ws2 = g2.lastSocket()
  ws2.open()
  await waitFor(() => ws2.chatSend(), { what: 'chat.send before ws error' })
  ws2.fail(new Error('mock ws reset'))
  const res2 = await p2
  assert.equal(res2.status, 502)
  assert.equal((await res2.json()).error.type, 'upstream_error')
  assert.ok(ws2.closedByRuntime, 'errored socket torn down')
})

// ---------------------------------------------------------------- g11

test('g11 UTF-8 budget: oversized system -> 413 budget_exceeded BEFORE any HTTP; detail carries byte accounting', { timeout: 10_000 }, async () => {
  const g = await makeGateway()
  const res = await post(g, { model: 'auto', stream: false, messages: [{ role: 'system', content: 'a'.repeat(900_000) }, { role: 'user', content: 'hi' }] })
  assert.equal(res.status, 413)
  const body = await res.json()
  assert.equal(body.error.code, 'budget_exceeded')
  assert.ok(body.error.detail.limitBytes > 0 && body.error.detail.estimatedBytes > body.error.detail.limitBytes, 'byte accounting present and consistent')
  assert.ok(body.error.detail.ledgerBytes > 0)
  assert.equal(g.http.calls.length, 0, 'over-budget = zero HTTP calls (not even the catalog)')
  assert.equal(g.sockets.length, 0)
})

test('g11 UTF-8 budget: large synthetic SKILL.md under the limit is preserved BYTE-EXACT in the wire frame (invisible=preamble, text=ledger)', { timeout: 10_000 }, async () => {
  const g = await makeGateway()
  const nonce = randomBytes(12).toString('hex')
  const skill = `# SKILL.md (synthetic, nonce ${nonce})\n\n` + '步骤说明。'.repeat(30_000) + '\nEND-OF-SKILL ' + nonce
  const messages = [{ role: 'system', content: skill }, { role: 'user', content: 'ack the skill' }]
  const { res, ws } = await runNonStream(g, { model: 'auto', stream: false, messages }, { text: 'skill acked' })
  assert.equal(res.status, 200, 'well under the default 768KiB conservative budget')
  await (await res).json()
  const send = ws.chatSend()
  const blocks = send.payload.chatSend.doc.blocks
  assert.deepEqual(blocks[0].ref, { kind: 'invisibleText', text: PREAMBLE }, 'persona rides the invisible ref block, untouched')
  assert.equal(blocks.at(-1).text, buildLedger(messages).text, 'ledger serialization byte-exact over ~200KB multibyte content')
  assert.ok(blocks.at(-1).text.includes('END-OF-SKILL ' + nonce), 'skill tail (nonce) survives intact')
  assert.equal(ws.frames().length >= 1, true)
})

// ---------------------------------------------------------------- g12

test('g12 context.update is diagnostics only: no usage field anywhere (non-stream + include_usage SSE); ctx-full session not continued', { timeout: 10_000 }, async () => {
  const g = await makeGateway()
  const { res } = await runNonStream(g, { model: 'auto', stream: false, messages: [{ role: 'user', content: 'tokens please' }] }, { text: 'ok', sessionTokens: 123456 })
  const body = await res.json()
  assert.ok(!('usage' in body), 'no fabricated usage on non-stream responses')
  assert.equal(body.stepx_diagnostics.session_context_tokens, 123456, 'context totals exposed as diagnostics only')

  const g2 = await makeGateway()
  const { events } = await runSse(g2, { model: 'auto', stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: 'sse usage' }] }, ['hi', ' there'])
  for (const chunk of events) {
    if (chunk === '[DONE]') continue
    assert.ok(!('usage' in chunk), `no usage field in SSE chunks: ${JSON.stringify(chunk).slice(0, 80)}`)
  }
  const diag = events.filter((e) => e.stepx_diagnostics)
  // this run carried no context.update, so exactly zero diagnostics chunks without fabrication
  assert.equal(diag.length, 0, 'no context.update upstream -> no diagnostics fabricated')

  // ctx-full (>=95%) marks the session exhausted -> next request starts a NEW project
  const g3 = await makeGateway()
  const p = post(g3, { model: 'auto', stream: false, messages: [{ role: 'user', content: 'ctx full' }] })
  await tick()
  const ws3 = g3.lastSocket()
  ws3.open()
  await waitFor(() => ws3.chatSend(), { what: 'chat.send' })
  const send3 = ws3.chatSend()
  ws3.recv({ type: 'ack', turnId: send3.turnId })
  ws3.recv({ type: 'message.append', turnId: send3.turnId, sessionId: 'sess-1', seq: 1, payload: { messageAppend: { kind: 'text', delta: 'partial' } } })
  ws3.recv({ type: 'context.update', payload: { contextUpdate: { totalTokens: 195000, maxTokens: 200000 } } })
  ws3.recv({ type: 'turn.completed', turnId: send3.turnId })
  await (await p).json()
  const { res: r2, ws: ws4 } = await runNonStream(
    g3,
    { model: 'auto', stream: false, messages: [{ role: 'user', content: 'ctx full' }, { role: 'assistant', content: 'partial' }, { role: 'user', content: 'more' }] },
    { text: 'fresh session' },
  )
  assert.equal(r2.status, 200)
  await r2.json()
  assert.equal(g3.http.projectCreates(), 2, 'exhausted (ctx-full) cloud session is never continued')
  assert.notEqual(ws4.chatSend().projectId, send3.projectId)
})

test('g12 PROTOCOL-ONLY synthetic SKILL.md loop: nonce reaches the wire frame, local read-tool mock result returns under its exact call id', { timeout: 10_000 }, async () => {
  const g = await makeGateway()
  const nonce = randomBytes(10).toString('hex')
  const token = `TOK-${nonce}`
  const skill = `# SKILL.md (synthetic protocol fixture)\nnonce: ${nonce}\nInstruction: call the local read tool on /skill/data.txt, then report the file's token verbatim.`
  // Turn 1: skill in system + declared local read tool; mock model makes the call
  const { res, ws } = await runNonStream(
    g,
    { model: 'auto', stream: false, messages: [{ role: 'system', content: skill }, { role: 'user', content: 'follow the skill' }], tools: [READ_TOOL] },
    { text: '<fn:invoke>{"name": "m_read", "arguments": {"path": "/skill/data.txt"}}</fn:invoke>' },
  )
  const body = await res.json()
  const call = body.choices[0].message.tool_calls?.[0]
  assert.ok(call, 'tool call delivered')
  assert.equal(call.function.name, 'read')
  assert.equal(JSON.parse(call.function.arguments).path, '/skill/data.txt')
  assert.ok(visibleText(ws.chatSend()).includes(nonce), 'SKILL.md nonce preserved in the upstream frame (no truncation)')
  const callId = call.id

  // Client-side restricted read "tool" returns the nonce token; receipt goes back under the SAME call id.
  const messages = [
    { role: 'system', content: skill },
    { role: 'user', content: 'follow the skill' },
    { role: 'assistant', content: null, tool_calls: [{ id: callId, type: 'function', function: { name: 'read', arguments: '{"path":"/skill/data.txt"}' } }] },
    { role: 'tool', tool_call_id: callId, content: `data-token: ${token}` },
  ]
  const p2 = post(g, { model: 'auto', stream: false, messages, tools: [READ_TOOL] })
  await tick()
  const ws2 = g.lastSocket()
  ws2.open()
  const info2 = await driveTurn(ws2, { text: `The token is ${token}.` })
  const res2 = await p2
  const body2 = await res2.json()
  assert.equal(body2.choices[0].finish_reason, 'stop')
  assert.ok(body2.choices[0].message.content.includes(token), 'mock tool result round-trips to the final answer')
  const sendText = visibleText(info2.send)
  assert.ok(sendText.includes(`[tool_result id=${callId}]`), 'receipt carries the EXACT call id — call id never lost on return')
  assert.ok(sendText.includes(token), 'tool result content rides the receipt')
  assert.equal(g.http.projectCreates(), 1, 'same session continued (structured evidence: the emitted call id)')
})
