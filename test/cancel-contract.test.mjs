// Cancellation & teardown contract — blocker-fix suite B.
//
// The independent review found the queued-cancel path leaked the abort
// listener registered on the CALLER's signal (removeOuter was outside the
// try/finally wrapping acquireLock). The fix moved the pre-cancel check and
// acquireLock INSIDE the outer try/finally; these tests pin that shape with
// REAL listener counting (events.getEventListeners), not event-observation
// fakes:
// - 50 queued cancellations: listener count on each caller signal returns
//   to exactly 0 after the 499 settles, never grows, and the lock chain
//   still serves subsequent requests;
// - an abort racing the catalog GET escapes handle() as a typed 499 with
//   no project POST and no listener residue;
// - normal completion and upstream failure both leave zero listeners.
import { test } from 'node:test'
import { getEventListeners } from 'node:events'
import assert from 'node:assert/strict'
import { makeGateway, runNonStream, driveTurn, tick, waitFor } from './helpers.mjs'

const GATEWAY = 'https://gateway.test/v1/chat/completions'
const MSGS = [{ role: 'user', content: 'lock contention probe' }]

test('queued-cancel x50: caller-signal listener count is exactly 0 after each 499, never grows, lock chain survives', { timeout: 10_000 }, async () => {
  const g = await makeGateway()
  // Request A holds the conversation lock: drive to chat.send, never complete.
  const pA = g.session.fetch(GATEWAY, { method: 'POST', body: JSON.stringify({ model: 'auto', stream: false, messages: MSGS }) })
  await tick()
  const wsA = g.lastSocket()
  wsA.open()
  await waitFor(() => wsA.chatSend(), { what: 'A holds the lock (chat.send sent)' })

  for (let i = 0; i < 50; i++) {
    const ac = new AbortController()
    const pB = g.session.fetch(GATEWAY, { method: 'POST', body: JSON.stringify({ model: 'auto', stream: false, messages: MSGS }), signal: ac.signal })
    await tick()
    assert.ok(getEventListeners(ac.signal, 'abort').length >= 1, `iteration ${i}: listener attached while queued`)
    ac.abort()
    const res = await pB
    assert.equal(res.status, 499)
    const body = await res.json()
    assert.equal(body.error.type, 'request_cancelled')
    assert.equal(body.error.code, 499)
    assert.equal(getEventListeners(ac.signal, 'abort').length, 0, `iteration ${i}: listener fully removed after settle (the leak would keep 1)`)
  }
  // no HTTP side effects from any queued request, ever
  assert.equal(g.http.projectCreates(), 1, 'only A created a project; queued cancels never touched the cloud')

  // lock chain survives: complete A, then a follow-up request works
  driveTurn(wsA, { text: 'A finally answered' })
  const aBody = await (await pA).json()
  assert.equal(aBody.choices[0].finish_reason, 'stop')
  const { res: r2 } = await runNonStream(
    g,
    { model: 'auto', stream: false, messages: [...MSGS, { role: 'assistant', content: 'A finally answered' }, { role: 'user', content: 'again' }] },
    { text: 'round two' },
  )
  assert.equal((await r2.json()).choices[0].finish_reason, 'stop')
})

test('abort racing the catalog GET escapes handle() as a typed 499: no project POST, zero listener residue', { timeout: 10_000 }, async () => {
  // fetch that mirrors real AbortSignal semantics: rejects when the signal fires
  const hang = (ms) => new Promise((_, rej) => {
    const t = setTimeout(() => rej(new Error('timeout')), ms)
    t.unref?.()
  })
  const calls = []
  const http = async (url, init = {}) => {
    const u = String(url)
    calls.push({ u, method: init.method ?? 'GET' })
    if (u.endsWith('/chat-models') && init.signal) {
      return new Promise((_, rej) => {
        init.signal.addEventListener('abort', () => rej(new Error('The operation was aborted')), { once: true })
        hang(5000).catch(rej)
      })
    }
    return makeDefaultHttp(calls)(url, init)
  }
  const g = await makeGateway({ http })
  const ac = new AbortController()
  const p = g.session.fetch(GATEWAY, { method: 'POST', body: JSON.stringify({ model: 'auto', stream: false, messages: [{ role: 'user', content: 'x' }] }), signal: ac.signal })
  await tick()
  assert.ok(calls.some((c) => c.u.endsWith('/chat-models')), 'catalog GET in flight')
  ac.abort()
  const res = await p
  assert.equal(res.status, 499, 'catalog cancellation escapes as a typed response, not a crash')
  const body = await res.json()
  assert.equal(body.error.type, 'request_cancelled')
  assert.equal(body.error.code, 499)
  assert.ok(!calls.some((c) => c.method === 'POST' && c.u.endsWith('/projects')), 'no project created: cancellation must not swallow into a normal turn')
  assert.equal(getEventListeners(ac.signal, 'abort').length, 0, 'outer listener removed on the catalog-abort path')
})

test('pre-aborted request: 499 typed, zero HTTP, zero sockets, zero listeners', { timeout: 10_000 }, async () => {
  const g = await makeGateway()
  const ac = new AbortController()
  ac.abort()
  const res = await g.session.fetch(GATEWAY, { method: 'POST', body: JSON.stringify({ model: 'auto', stream: false, messages: [{ role: 'user', content: 'x' }] }), signal: ac.signal })
  assert.equal(res.status, 499)
  assert.equal(g.http.calls.length, 0)
  assert.equal(g.sockets.length, 0)
  assert.equal(getEventListeners(ac.signal, 'abort').length, 0)
})

test('listener residue after normal completion and after upstream turn.failed: exactly 0 on the caller signal', { timeout: 10_000 }, async () => {
  const g = await makeGateway()
  const ac1 = new AbortController()
  const p1 = g.session.fetch(GATEWAY, { method: 'POST', body: JSON.stringify({ model: 'auto', stream: false, messages: [{ role: 'user', content: 'ok probe' }] }), signal: ac1.signal })
  await tick()
  g.lastSocket().open()
  await driveTurn(g.lastSocket(), { text: 'done' })
  const r1 = await p1
  assert.equal(r1.status, 200)
  assert.equal(getEventListeners(ac1.signal, 'abort').length, 0, 'success path removes the outer listener')

  const ac2 = new AbortController()
  const p2 = g.session.fetch(GATEWAY, { method: 'POST', body: JSON.stringify({ model: 'auto', stream: false, messages: [{ role: 'user', content: 'fail probe' }] }), signal: ac2.signal })
  await tick()
  g.lastSocket().open()
  await driveTurn(g.lastSocket(), { text: 'partial', failWith: 'upstream blew up' })
  const r2 = await p2
  assert.equal(r2.status, 502)
  assert.equal(getEventListeners(ac2.signal, 'abort').length, 0, 'upstream-failure path removes the outer listener')
})

// default route table for the custom-http test above (kept local on purpose)
import { mockHttp } from './helpers.mjs'
function makeDefaultHttp(calls) {
  const base = mockHttp()
  return async (url, init) => {
    const r = await base(url, init)
    return r
  }
}
