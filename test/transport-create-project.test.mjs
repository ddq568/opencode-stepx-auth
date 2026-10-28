import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { createProject, createTransport, defaultTransport } from '../src/transport.mjs'

test('createTransport: 默认 timers 包含 projectLimitDelayMs 为 65000', () => {
  const tr = createTransport()
  assert.equal(tr.timers.projectLimitDelayMs, 65_000)
  assert.equal(defaultTransport.timers.projectLimitDelayMs, 65_000)
})

test('createProject: 命中 "[Limit] Global project creation limit" 场景等待并用同一 clientRequestId 重试一次成功路径', async () => {
  const calls = []
  let callCount = 0
  const fetchMock = async (url, init) => {
    callCount++
    const body = JSON.parse(init.body)
    calls.push({ url: String(url), method: init.method, body })
    if (callCount === 1) {
      return new Response(
        JSON.stringify({
          error: {
            type: 'upstream_error',
            code: 502,
            message: '[Limit] Global project creation limit (2) reached',
          },
        }),
        { status: 502, headers: { 'content-type': 'application/json' } },
      )
    }
    return new Response(
      JSON.stringify({
        project: { id: 'p_success_42' },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }

  const tr = createTransport({
    fetch: fetchMock,
    timers: { projectLimitDelayMs: 25 },
  })

  const t0 = Date.now()
  const id = await createProject(tr, 'test-cookie', 'deepseek-flash[1m]', 'my-app')
  const elapsed = Date.now() - t0

  assert.equal(id, 'p_success_42', '重试成功返回项目 id')
  assert.equal(calls.length, 2, '总共发起 2 次 POST /projects 调用')
  assert.equal(calls[0].body.clientRequestId, calls[1].body.clientRequestId, '重试必须复用同一个 clientRequestId')
  assert.ok(elapsed >= 20, `必须等待限流退避延迟 (耗时: ${elapsed}ms)`)
})

test('createProject: 命中 "[Limit]" 场景等待并用同一 clientRequestId 重试一次成功路径', async () => {
  const calls = []
  let callCount = 0
  const fetchMock = async (url, init) => {
    callCount++
    calls.push(JSON.parse(init.body))
    if (callCount === 1) {
      return new Response('[Limit] Account project limit exceeded', { status: 429 })
    }
    return new Response(JSON.stringify({ id: 'p_recovered_99' }), { status: 200 })
  }

  const tr = createTransport({
    fetch: fetchMock,
    timers: { projectLimitDelayMs: 15 },
  })

  const id = await createProject(tr, 'test-cookie', 'auto', 'app')
  assert.equal(id, 'p_recovered_99')
  assert.equal(calls.length, 2)
  assert.equal(calls[0].clientRequestId, calls[1].clientRequestId)
})

test('createProject: 命中 "[Limit] Global project creation limit" 重试一次仍失败，抛带原文的错误（最多2次尝试，不无限等）', async () => {
  let callCount = 0
  const fetchMock = async () => {
    callCount++
    return new Response(
      JSON.stringify({
        error: {
          type: 'upstream_error',
          code: 502,
          message: '[Limit] Global project creation limit (2) reached',
        },
      }),
      { status: 502, headers: { 'content-type': 'application/json' } },
    )
  }

  const tr = createTransport({
    fetch: fetchMock,
    timers: { projectLimitDelayMs: 15 },
  })

  await assert.rejects(
    async () => {
      await createProject(tr, 'test-cookie', 'deepseek-flash[1m]', 'my-app')
    },
    (err) => {
      assert.equal(err.status, 502)
      assert.ok(
        err.message.includes('[Limit] Global project creation limit (2) reached'),
        '二次失败错误必须携带原文信息',
      )
      assert.ok(err.message.includes('创建 Step Studio 项目失败（HTTP 502）'))
      return true
    },
  )

  assert.equal(callCount, 2, '最多尝试 2 次，二次失败后不再重试（不无限等待）')
})

test('createProject: 等待限流退避时被 signal 取消，清理等待定时器并抛 499，零残留 listener', async () => {
  let callCount = 0
  const fetchMock = async () => {
    callCount++
    return new Response(
      JSON.stringify({ error: { message: '[Limit] Global project creation limit' } }),
      { status: 502 },
    )
  }

  // 故意设置较长的退避时间，验证 abort 能立即中断而不是等到 10 秒后
  const tr = createTransport({
    fetch: fetchMock,
    timers: { projectLimitDelayMs: 10_000 },
  })

  const ac = new AbortController()
  const t0 = Date.now()
  const p = createProject(tr, 'test-cookie', 'auto', 'label', { signal: ac.signal })

  // 让其执行完第 1 次 fetch 并进入 delay 等待
  await new Promise((r) => setTimeout(r, 20))
  assert.ok(getEventListeners(ac.signal, 'abort').length >= 1, '等待退避期间应注册了 abort 监听器')

  ac.abort()

  await assert.rejects(
    p,
    (err) => {
      assert.equal(err.status, 499)
      assert.equal(err.message, '请求已取消')
      return true
    },
  )

  const elapsed = Date.now() - t0
  assert.ok(elapsed < 1000, `取消必须立即清理等待返回，不能等待 10s (实际耗时: ${elapsed}ms)`)
  assert.equal(callCount, 1, '第 1 次被限流等待期间取消，不应发起第 2 次重试')
  assert.equal(getEventListeners(ac.signal, 'abort').length, 0, '取消后必须清理 signal 监听器，零残留')
})

test('createProject: 预先取消的 signal 调用时立即拒绝 499 且清理', async () => {
  const ac = new AbortController()
  ac.abort()
  const fetchMock = async () => new Response(JSON.stringify({ project: { id: 'p_1' } }), { status: 200 })
  const tr = createTransport({ fetch: fetchMock })
  await assert.rejects(
    createProject(tr, 'test-cookie', 'auto', 'label', { signal: ac.signal }),
    (err) => {
      assert.equal(err.status, 499)
      return true
    },
  )
  assert.equal(getEventListeners(ac.signal, 'abort').length, 0)
})

test('createProject: 正常完成时 signal 的 abort 监听器被正确移除，零残留', async () => {
  const fetchMock = async () => new Response(JSON.stringify({ project: { id: 'p_clean_1' } }), { status: 200 })
  const tr = createTransport({ fetch: fetchMock })
  const ac = new AbortController()
  const id = await createProject(tr, 'test-cookie', 'auto', 'label', { signal: ac.signal })
  assert.equal(id, 'p_clean_1')
  assert.equal(getEventListeners(ac.signal, 'abort').length, 0, '正常完成后 signal 无残留监听器')
})

test('createProject: 命中普通 500 时走常规 retryDelayMs 重试一次且复用同一 clientRequestId', async () => {
  const calls = []
  let callCount = 0
  const fetchMock = async (url, init) => {
    callCount++
    calls.push(JSON.parse(init.body))
    if (callCount === 1) {
      return new Response('internal error', { status: 500 })
    }
    return new Response(JSON.stringify({ project: { id: 'p_normal_retry' } }), { status: 200 })
  }

  const tr = createTransport({
    fetch: fetchMock,
    timers: { retryDelayMs: 10 },
  })

  const id = await createProject(tr, 'cookie', 'model', 'label')
  assert.equal(id, 'p_normal_retry')
  assert.equal(calls.length, 2)
  assert.equal(calls[0].clientRequestId, calls[1].clientRequestId)
})

