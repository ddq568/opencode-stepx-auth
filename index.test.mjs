// Unit tests for the pure helpers exported via `_internal` in index.mjs.
// Run: cd magpie-plugin-stepx && node --test index.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'

const m = await import('./index.mjs')
const { flattenMessages, conversationKey, deltaContinuation, FALLBACK_MODELS, PREAMBLE } = m._internal

// ---------------------------------------------------------------- flattenMessages

test('flattenMessages: string content, role 标记映射', () => {
  const flat = flattenMessages([
    { role: 'system', content: '系统提示' },
    { role: 'developer', content: '开发者提示' },
    { role: 'user', content: '用户问题' },
    { role: 'assistant', content: '助手回答' },
    { role: 'assistant', name: 'alice', content: '带名字的回答' },
    { role: 'tool', content: '工具输出' },
  ])
  assert.ok(flat.includes('[system]\n系统提示'))
  assert.ok(flat.includes('[system]\n开发者提示'))
  assert.ok(flat.includes('[user]\n用户问题'))
  assert.ok(flat.includes('[assistant]\n助手回答'))
  assert.ok(flat.includes('[assistant:alice]\n带名字的回答'))
  assert.ok(flat.includes('[tool]\n工具输出'))
})

test('flattenMessages: array content（text/image_url/tool_use/tool_result 混合）不抛错且包含各文本', () => {
  const flat = flattenMessages([
    {
      role: 'user',
      content: [
        { type: 'text', text: '看下这个文件' },
        { type: 'image_url', image_url: { url: 'http://x/y.png' } },
        { type: 'tool_use', id: 'call_1', name: 'read', input: { path: 'a.txt' } },
        { type: 'tool_result', tool_use_id: 'call_1', content: '文件内容' },
      ],
    },
    {
      role: 'tool',
      content: [{ type: 'tool_result', tool_use_id: 'call_2', content: [{ type: 'text', text: '嵌套结果' }] }],
    },
  ])
  assert.ok(flat.includes('看下这个文件'))
  assert.ok(flat.includes('[image omitted]'))
  assert.ok(flat.includes('[tool_call call_1 read({"path":"a.txt"})]'))
  assert.ok(flat.includes('[tool_result call_1] 文件内容'))
  assert.ok(flat.includes('[tool_result call_2] 嵌套结果'))
})

test('flattenMessages: 空消息数组、null/undefined、空内容均安全返回', () => {
  assert.equal(flattenMessages([]), '')
  assert.equal(flattenMessages(null), '')
  assert.equal(flattenMessages(undefined), '')
  // 空/空白内容的消息被跳过，null content 不抛错
  assert.equal(
    flattenMessages([
      { role: 'user', content: '' },
      { role: 'user', content: '   ' },
      { role: 'user', content: null },
      { role: 'user', content: undefined },
    ]),
    '',
  )
})

test('flattenMessages: 确定性——同一输入两次调用结果全等', () => {
  const input = [
    { role: 'system', content: '你是助手' },
    {
      role: 'user',
      content: [
        { type: 'text', text: '问题' },
        { type: 'tool_use', id: 'c1', name: 'grep', input: { pattern: 'foo' } },
      ],
    },
    { role: 'assistant', name: 'bot', content: '回答' },
  ]
  assert.strictEqual(flattenMessages(input), flattenMessages(input))
})

// ---------------------------------------------------------------- conversationKey

test('conversationKey: 同会话追加消息后 key 不变', () => {
  const head = [
    { role: 'system', content: '你是助手' },
    { role: 'user', content: '第一问' },
  ]
  const k1 = conversationKey(flattenMessages(head), 'auto')
  const k2 = conversationKey(
    flattenMessages([...head, { role: 'assistant', content: '第一答' }, { role: 'user', content: '第二问' }]),
    'auto',
  )
  assert.equal(k1, k2)
})

test('conversationKey: 首条 user 消息不同则 key 不同', () => {
  const k1 = conversationKey(flattenMessages([{ role: 'user', content: '问题 A' }]), 'auto')
  const k2 = conversationKey(flattenMessages([{ role: 'user', content: '问题 B' }]), 'auto')
  assert.notEqual(k1, k2)
})

test('conversationKey: model 不同则 key 不同', () => {
  const flat = flattenMessages([{ role: 'user', content: '同样的问题' }])
  assert.notEqual(conversationKey(flat, 'auto'), conversationKey(flat, 'step-5-preview'))
})

// ---------------------------------------------------------------- deltaContinuation

test('deltaContinuation: 前缀扩展时返回「接上一轮」并带上新增文本', () => {
  const lastFull = flattenMessages([{ role: 'user', content: '问题一' }])
  const flat = flattenMessages([
    { role: 'user', content: '问题一' },
    { role: 'tool', name: 'read', content: '工具结果内容' },
  ])
  const out = deltaContinuation(lastFull, flat)
  assert.ok(out.includes('接上一轮'))
  assert.ok(out.includes('[tool:read]\n工具结果内容'))
})

test('deltaContinuation: 完全相同（重试）时返回「重试」提示', () => {
  const lastFull = flattenMessages([{ role: 'user', content: '问题一' }])
  const out = deltaContinuation(lastFull, lastFull)
  assert.ok(out.includes('重试'))
})

test('deltaContinuation: delta 开头无空白字符', () => {
  const lastFull = flattenMessages([{ role: 'user', content: '问题一' }])
  const flatWs = lastFull + '   \n\n[tool:read]\n新结果'
  const out = deltaContinuation(lastFull, flatWs)
  const marker = '继续按规则回答）\n\n'
  const idx = out.indexOf(marker)
  assert.ok(idx >= 0)
  const body = out.slice(idx + marker.length)
  assert.ok(!/^\s/.test(body), `delta 开头不应有空白字符: ${JSON.stringify(body.slice(0, 10))}`)
  assert.ok(body.startsWith('[tool:read]'))
})

// ---------------------------------------------------------------- FALLBACK_MODELS / PREAMBLE

test('FALLBACK_MODELS: 包含 auto、step-5-preview、deepseek-flash[1m]，各有 limit.context 与 name', () => {
  for (const id of ['auto', 'step-5-preview', 'deepseek-flash[1m]']) {
    const spec = FALLBACK_MODELS[id]
    assert.ok(spec, `缺少模型 ${id}`)
    assert.equal(typeof spec.name, 'string')
    assert.ok(spec.name.length > 0)
    assert.ok(spec.limit && typeof spec.limit.context === 'number' && spec.limit.context > 0)
  }
})

test('PREAMBLE: 是非空字符串', () => {
  assert.equal(typeof PREAMBLE, 'string')
  assert.ok(PREAMBLE.length > 0)
})
