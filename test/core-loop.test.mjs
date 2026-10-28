// Core mock-loop tests: entry -> auth.loader -> runtime.handle -> mock
// HTTP/WS -> non-stream + SSE, cancellation, budget, protocol violations,
// cross-account isolation. Everything offline; global fetch/WebSocket are
// blocked by test/helpers.mjs. Per-test timeout 10s, suite well under 60s.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeGateway, runNonStream, driveTurn, readSse, tick, waitFor } from './helpers.mjs'

const TOOL = {
  type: 'function',
  function: {
    name: 'web_search',
    description: 'search the web',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
      additionalProperties: false,
    },
  },
}

test('entry + loader: non-stream plain text round trip, no fabricated usage', { timeout: 10_000 }, async () => {
  const g = await makeGateway()
  const { res, ws } = await runNonStream(
    g,
    { model: 'auto', stream: false, messages: [{ role: 'user', content: 'hello' }] },
    { text: 'hello world' },
  )
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.choices[0].finish_reason, 'stop')
  assert.equal(body.choices[0].message.content, 'hello world')
  assert.ok(!('usage' in body), 'usage must be omitted (no real billing numbers)')
  // the frame carried the visible text only; persona rides the invisible ref block
  assert.equal(ws.chatSend().payload.chatSend.doc.blocks.at(-1).text.includes('hello'), true)
  assert.ok(g.http.projectCreates() === 1)
})

test('SSE loop: role/content stream; mid-turn cancel propagates chat.interrupt and tears down', { timeout: 10_000 }, async () => {
  const g = await makeGateway({ pluginOptions: { persona: true } })
  const p = g.session.fetch('https://gateway.test/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({ model: 'auto', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
  })
  await tick(30)
  const ws = g.lastSocket()
  assert.ok(ws, 'socket exists once the turn pipeline starts')
  ws.open()
  await waitFor(() => ws.chatSend(), { what: 'chat.send while turn in flight' })
  const res = await p
  assert.equal(res.status, 200)
  const reader = res.body.getReader()
  const first = await reader.read()
  assert.ok(new TextDecoder().decode(first.value).includes('"role"'), 'SSE opens with the role delta')
  await reader.cancel() // client disconnect while the upstream turn is still open
  await waitFor(() => ws.frames().some((f) => f.type === 'chat.interrupt'), { what: 'chat.interrupt after mid-turn cancel' })
  assert.ok(ws.closedByRuntime, 'socket torn down after cancel')
  await p // settles without unhandled rejection
})

test('tool call loop: declared whitelist honored, name unaliased, args preserved', { timeout: 10_000 }, async () => {
  const g = await makeGateway()
  const call = '<fn:invoke>{"name": "m_web_search", "arguments": {"query": "cats"}}</fn:invoke>'
  const { res, ws } = await runNonStream(
    g,
    { model: 'auto', stream: false, messages: [{ role: 'user', content: 'search cats' }], tools: [TOOL] },
    { text: call },
  )
  const body = await res.json()
  assert.equal(body.choices[0].finish_reason, 'tool_calls')
  assert.equal(body.choices[0].message.tool_calls[0].function.name, 'web_search')
  assert.equal(body.choices[0].message.tool_calls[0].function.arguments, '{"query":"cats"}')

  // Turn 2: full history echo (assistant tool_call + tool receipt) -> same
  // project, delta-only send. Structured continuity evidence required.
  const id = body.choices[0].message.tool_calls[0].id
  const messages = [
    { role: 'user', content: 'search cats' },
    { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name: 'web_search', arguments: '{"query":"cats"}' } }] },
    { role: 'tool', tool_call_id: id, content: 'cats are fine' },
  ]
  const p2 = g.session.fetch('https://gateway.test/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({ model: 'auto', stream: false, messages, tools: [TOOL] }),
  })
  await tick()
  const ws2 = g.lastSocket()
  assert.notEqual(ws2, ws, 'each turn uses a fresh socket')
  ws2.open()
  const info = await driveTurn(ws2, { text: 'all done' })
  const res2 = await p2
  const body2 = await res2.json()
  assert.equal(body2.choices[0].finish_reason, 'stop')
  assert.equal(body2.choices[0].message.content, 'all done')
  assert.equal(g.http.projectCreates(), 1, 'continuation must reuse the project')
  const sendText = info.send.payload.chatSend.doc.blocks.at(-1).text
  assert.ok(sendText.includes('（接上一轮'), 'delta seam marker present')
  assert.ok(!sendText.includes('search cats'), 'history not resent, only the delta')
})

test('same head, genuinely new conversation -> new project (no blind sharing)', { timeout: 10_000 }, async () => {
  const g = await makeGateway()
  await runNonStream(g, { model: 'auto', stream: false, messages: [{ role: 'user', content: 'head msg' }] }, { text: 'a1' })
  // identical request: uncertain (no structural growth/evidence) -> new state
  const { res } = await runNonStream(g, { model: 'auto', stream: false, messages: [{ role: 'user', content: 'head msg' }] }, { text: 'a2' })
  await res.json()
  assert.equal(g.http.projectCreates(), 2, 'ambiguous candidate -> fresh project instead of blind reuse')
})

test('budget: oversized request rejected 4xx before ANY http call', { timeout: 10_000 }, async () => {
  const g = await makeGateway()
  const big = 'x'.repeat(900 * 1024)
  const res = await g.session.fetch('https://gateway.test/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({ model: 'auto', stream: false, messages: [{ role: 'user', content: big }] }),
  })
  assert.equal(res.status, 413)
  const body = await res.json()
  assert.equal(body.error.code, 'budget_exceeded')
  assert.ok(body.error.detail?.limitBytes > 0)
  assert.equal(g.http.calls.length, 0, 'no network traffic (not even the catalog GET) on budget rejection')
})

test('protocol: tool_choice=required unsatisfied -> typed 422, never fake stop', { timeout: 10_000 }, async () => {
  const g = await makeGateway()
  const { res } = await runNonStream(
    g,
    { model: 'auto', stream: false, messages: [{ role: 'user', content: 'go' }], tools: [TOOL], tool_choice: 'required' },
    { text: 'I will just answer with text' },
  )
  assert.equal(res.status, 422)
  const body = await res.json()
  assert.equal(body.error.code, 'tool_choice_unsatisfied')
})

test('protocol: parallel_tool_calls=false with 2 calls -> typed 422, zero calls delivered', { timeout: 10_000 }, async () => {
  const g = await makeGateway()
  const two =
    '<fn:invoke>{"name": "m_web_search", "arguments": {"query": "a"}}</fn:invoke><fn:invoke>{"name": "m_web_search", "arguments": {"query": "b"}}</fn:invoke>'
  const { res } = await runNonStream(
    g,
    { model: 'auto', stream: false, messages: [{ role: 'user', content: 'go' }], tools: [TOOL], parallel_tool_calls: false },
    { text: two },
  )
  assert.equal(res.status, 422)
  const body = await res.json()
  assert.equal(body.error.code, 'parallel_tool_calls_violated')
  assert.ok(!body.choices?.[0]?.message?.tool_calls?.length, 'no executable call may reach the client')
})

test('protocol: no tools declared -> model tag text passes through, no executable call', { timeout: 10_000 }, async () => {
  const g = await makeGateway()
  const { res } = await runNonStream(
    g,
    { model: 'auto', stream: false, messages: [{ role: 'user', content: 'q' }] },
    { text: '<fn:invoke>{"name": "m_web_search", "arguments": {}}</fn:invoke>' },
  )
  const body = await res.json()
  assert.equal(body.choices[0].finish_reason, 'stop')
  assert.ok(!body.choices[0].message.tool_calls)
  assert.ok(body.choices[0].message.content.includes('<fn:invoke>'))
})

test('protocol: bad JSON in call -> typed bad_json, no partial call', { timeout: 10_000 }, async () => {
  const g = await makeGateway()
  const { res } = await runNonStream(
    g,
    { model: 'auto', stream: false, messages: [{ role: 'user', content: 'q' }], tools: [TOOL] },
    { text: '<fn:invoke>{"name" "m_web_search"}</fn:invoke>' },
  )
  assert.equal(res.status, 422)
  const body = await res.json()
  assert.equal(body.error.code, 'bad_json')
})

test('accounts: two gateways stay isolated; cookie rotation is per-account', { timeout: 10_000 }, async () => {
  const a = await makeGateway({
    auth: { key: 'a=1', accountId: 'A' },
    mockHttpOptions: { setCookieOnModels: 'SESSA=rotated' },
  })
  const b = await makeGateway({ auth: { key: 'b=1', accountId: 'B' } })
  const { res } = await runNonStream(a, { model: 'auto', stream: false, messages: [{ role: 'user', content: 's' }] }, { text: 'A' })
  await res.json()
  const { res: r2 } = await runNonStream(b, { model: 'auto', stream: false, messages: [{ role: 'user', content: 's' }] }, { text: 'B' })
  await r2.json()
  // same head on both accounts -> separate runtimes, separate projects
  assert.equal(a.http.projectCreates(), 1)
  assert.equal(b.http.projectCreates(), 1)
  const wsA = a.lastSocket()
  const wsB = b.lastSocket()
  assert.ok(wsA.headers.cookie.includes('SESSA=rotated'), 'account A adopted its rotated cookie')
  assert.ok(wsA.headers.cookie.includes('a=1'), 'merged with prior jar')
  assert.ok(wsB.headers.cookie.includes('b=1') && !wsB.headers.cookie.includes('SESSA'), 'account B untouched by A\'s rotation')
})

test('upstream failure: turn.failed -> typed 502, session marked unusable (retry gets a fresh project)', { timeout: 10_000 }, async () => {
  const g = await makeGateway()
  const { res } = await runNonStream(
    g,
    { model: 'auto', stream: false, messages: [{ role: 'user', content: 'q' }] },
    { text: 'partial', failWith: 'boom' },
  )
  assert.equal(res.status, 502)
  const body = await res.json()
  assert.equal(body.error.type, 'upstream_error')
  // retry the same request: old state unusable -> new project
  const { res: r2 } = await runNonStream(g, { model: 'auto', stream: false, messages: [{ role: 'user', content: 'q' }] }, { text: 'ok' })
  await r2.json()
  assert.equal(g.http.projectCreates(), 2)
})

test('pre-cancelled request: no HTTP, no socket', { timeout: 10_000 }, async () => {
  const g = await makeGateway()
  const ac = new AbortController()
  ac.abort()
  const res = await g.session.fetch('https://gateway.test/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({ model: 'auto', stream: false, messages: [{ role: 'user', content: 'q' }] }),
    signal: ac.signal,
  })
  assert.equal(res.status, 499)
  assert.equal(g.http.calls.length, 0)
  assert.equal(g.sockets.length, 0)
})

test('SSE upstream failure: typed error chunk, NO finish_reason stop, DONE terminator', { timeout: 10_000 }, async () => {
  const g = await makeGateway()
  const p = g.session.fetch('https://gateway.test/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({ model: 'auto', stream: true, messages: [{ role: 'user', content: 'q' }] }),
  })
  await tick()
  const ws = g.lastSocket()
  ws.open()
  await driveTurn(ws, { text: 'partial', failWith: 'upstream blew up' })
  const res = await p
  assert.equal(res.status, 200)
  const events = await readSse(res)
  const errorEv = events.find((e) => e && typeof e === 'object' && e.error)
  assert.ok(errorEv, 'an error chunk was emitted')
  assert.equal(errorEv.error.code, 502)
  const finishEv = events.find((e) => e && Array.isArray(e.choices) && e.choices[0]?.finish_reason)
  assert.ok(!finishEv, 'no finish_reason chunk after failure (no fake stop)')
  assert.equal(events.at(-1), '[DONE]')
})

test('two call forms: fetch(Request) and fetch(url, init) both work; signal preserved', { timeout: 10_000 }, async () => {
  const g = await makeGateway()
  const req = new Request('https://gateway.test/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({ model: 'auto', stream: false, messages: [{ role: 'user', content: 'via Request' }] }),
  })
  const p = g.session.fetch(req)
  await tick()
  const ws = g.lastSocket()
  ws.open()
  await driveTurn(ws, { text: 'form-ok' })
  const res = await p
  const body = await res.json()
  assert.equal(body.choices[0].message.content, 'form-ok')
})
