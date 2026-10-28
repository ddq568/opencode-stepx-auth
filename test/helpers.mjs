// Offline harness: full mock transport (HTTP + WS) with REAL networking
// blocked at the global level. No test here may open a socket.
import assert from 'node:assert/strict'
import { createTransport } from '../src/transport.mjs'

// Block real network BEFORE any production module is imported by the suites.
if (!globalThis.__stepxNetBlocked) {
  globalThis.__stepxNetBlocked = true
  globalThis.fetch = function blockedFetch() {
    throw new Error('network disabled in offline tests: fetch()')
  }
  globalThis.WebSocket = function blockedWebSocket() {
    throw new Error('network disabled in offline tests: WebSocket')
  }
}

export const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms))

export async function waitFor(fn, { timeoutMs = 3000, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() > deadline) throw new Error(`waitFor timeout: ${what}`)
    await tick(5)
  }
}

/** Mock WebSocket whose lifecycle is driven by the test. */
export class MockWebSocket {
  constructor(url, opts) {
    this.url = url
    this.headers = opts?.headers ?? null
    this.readyState = 0
    this.sent = []
    this.closedByRuntime = false
    this.onopen = this.onmessage = this.onerror = this.onclose = null
    const arr = this.constructor.created ?? []
    this.constructor.created = arr
    arr.push(this)
    MockWebSocket.created.push(this)
  }
  send(data) {
    assert.equal(this.readyState, 1, 'runtime sent on a socket that is not open')
    this.sent.push(data)
  }
  close() {
    if (this.readyState === 2 || this.readyState === 3) return
    this.readyState = 3
    this.closedByRuntime = true
    const f = this.onclose
    this.onclose = this.onmessage = this.onerror = this.onopen = null
    f?.()
  }
  // test-side controls
  open() {
    this.readyState = 1
    this.onopen?.()
  }
  recv(obj) {
    assert.equal(this.readyState, 1, 'recv on closed socket')
    this.onmessage?.({ data: typeof obj === 'string' ? obj : JSON.stringify(obj) })
  }
  fail(err) {
    this.onerror?.(err ?? new Error('mock ws failure'))
  }
  frames() {
    return this.sent.map((s) => JSON.parse(s))
  }
  chatSend() {
    return this.frames().find((f) => f.type === 'chat.send') ?? null
  }
}
MockWebSocket.created = []

export function jsonResponse(obj, { status = 200, headers } = {}) {
  return new Response(JSON.stringify(obj), { status, headers })
}

/** Mock HTTP for the studio REST surface; records every call. */
export function mockHttp({ models = [{ id: 'auto', name: 'Auto', isDefault: true }], projectPrefix = 'proj', setCookieOnModels = null } = {}) {
  const calls = []
  let n = 0
  async function handler(url, init = {}) {
    const u = String(url)
    calls.push({ url: u, method: init.method ?? 'GET', headers: init.headers, body: init.body })
    if (u.endsWith('/chat-models'))
      return jsonResponse({ items: models }, setCookieOnModels ? { headers: { 'set-cookie': setCookieOnModels } } : {})
    if (/\/projects$/.test(u) && init.method === 'POST') {
      n++
      return jsonResponse({ project: { id: `${projectPrefix}-${n}` } })
    }
    if (/\/projects\/[^/]+$/.test(u) && init.method === 'DELETE') return jsonResponse({})
    if (u.endsWith('/identity/me')) return jsonResponse({ userId: 'u1', nickname: 'nick' })
    return jsonResponse({ error: 'unrouted' }, { status: 404 })
  }
  handler.calls = calls
  handler.projectCreates = () => calls.filter((c) => c.method === 'POST' && /\/projects$/.test(c.url)).length
  handler.projectDeletes = () => calls.filter((c) => c.method === 'DELETE').length
  return handler
}

export function makeTransport({ WebSocketImpl = MockWebSocket, http = mockHttp(), timers } = {}) {
  return createTransport({
    fetch: http,
    WebSocket: WebSocketImpl,
    timers: { sendDelayMs: 0, pingMs: 60000, idleMs: 4000, hardMs: 8000, apiTimeoutMs: 500, retryDelayMs: 5, projectLimitDelayMs: 10, ...(timers ?? {}) },
  })
}

/**
 * Build a fully-wired gateway session through the REAL plugin entry:
 * StepXAuthPlugin(options) -> auth.loader(getAuth) -> { fetch }.
 * wsCreated collects sockets so tests can drive the WS lifecycle.
 */
export async function makeGateway({ auth = { key: 'k=1; b=2', accountId: 'acc1' }, pluginOptions = {}, mockHttpOptions = {}, http = null } = {}) {
  const { StepXAuthPlugin } = await import('../index.mjs')
  const WebSocketImpl = class extends MockWebSocket {}
  WebSocketImpl.created = [] // per-gateway tracking (base keeps a global list)
  const httpFn = http ?? mockHttp(mockHttpOptions)
  const transport = makeTransport({ WebSocketImpl, http: httpFn })
  const plugin = await StepXAuthPlugin({ client: null }, { ...pluginOptions, transport })
  const session = await plugin.auth.loader(async () => auth)
  assert.ok(session?.fetch, 'loader must return { baseURL, fetch }')
  return {
    session,
    transport,
    http: httpFn,
    sockets: WebSocketImpl.created,
    lastSocket: () => WebSocketImpl.created.at(-1),
  }
}

/**
 * Drive one upstream turn on a mock socket: wait for chat.send, then replay
 * ack / message.append deltas / optional context.update / turn.completed.
 */
export async function driveTurn(ws, { text = 'ok', thinking = '', sessionTokens = null, failWith = null, complete = true } = {}) {
  await waitFor(() => ws.chatSend(), { what: 'chat.send frame' })
  const send = ws.chatSend()
  const tid = send.turnId
  const sid = 'sess-1'
  ws.recv({ type: 'ack', turnId: tid })
  let seq = 1
  if (thinking) ws.recv({ type: 'message.append', turnId: tid, sessionId: sid, seq: seq++, payload: { messageAppend: { kind: 'thinking', delta: thinking } } })
  const chunkSize = 7
  for (let i = 0; i < text.length; i += chunkSize) {
    ws.recv({ type: 'message.append', turnId: tid, sessionId: sid, seq: seq++, payload: { messageAppend: { kind: 'text', delta: text.slice(i, i + chunkSize) } } })
  }
  if (sessionTokens != null) {
    ws.recv({ type: 'context.update', payload: { contextUpdate: { totalTokens: sessionTokens, maxTokens: 200000 } } })
  }
  if (failWith) ws.recv({ type: 'turn.failed', turnId: tid, payload: { turnFailed: { reason: failWith } } })
  else if (complete) ws.recv({ type: 'turn.completed', turnId: tid })
  return { sid, tid, send }
}

/** Start a non-stream chat completion and drive its WS turn to completion. */
export async function runNonStream(gateway, payload, turn = {}) {
  const p = gateway.session.fetch('https://gateway.test/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
  await tick()
  const ws = gateway.lastSocket()
  assert.ok(ws, 'expected a WS connection')
  ws.open()
  const info = await driveTurn(ws, turn)
  const res = await p
  return { res, ws, info }
}

/** Parse an SSE response body into data events. */
export async function readSse(res) {
  const text = await res.text()
  return text
    .split('\n\n')
    .filter((l) => l.startsWith('data: '))
    .map((l) => {
      const raw = l.slice(6)
      try {
        return JSON.parse(raw)
      } catch {
        return raw
      }
    })
}

