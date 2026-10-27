// Unit tests for the pure helpers exported via `_internal` in index.mjs.
// Run: cd magpie-plugin-stepx && node --test index.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'

const m = await import('./index.mjs')
const { flattenMessages, conversationKey, deltaContinuation, FALLBACK_MODELS, PREAMBLE, REMINDER, TOOL_RECENCY } = m._internal
const { alias, unalias, toolPreamble, ToolStreamParser, composeTurnText, parseRawBlocks } = m._internal

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

// ---------------------------------------------------------------- v0.2.7 alias / unalias

test('alias/unalias: 前缀映射与容错还原', () => {
  assert.equal(alias('read'), 'm_read')
  assert.equal(alias('bash'), 'm_bash')
  assert.equal(alias('skill_manage'), 'm_skill_manage')
  assert.equal(unalias('m_read'), 'read')
  assert.equal(unalias('read'), 'read') // 容错：模型发明文名（历史里是原始名）原样通过
  assert.equal(unalias('m_skill_manage'), 'skill_manage')
  assert.equal(unalias(''), '')
})

test('unalias: 只剥一层 m_ 前缀', () => {
  assert.equal(unalias('m_m_foo'), 'm_foo')
  assert.equal(unalias('mm_foo'), 'mm_foo')
})

// ---------------------------------------------------------------- v0.2.7 ToolStreamParser 别名还原

function parseToolCalls(text) {
  const events = []
  const p = new ToolStreamParser((ev) => events.push(ev))
  p.push(text)
  p.end()
  return events.filter((e) => e.toolCall).map((e) => e.toolCall)
}

test('ToolStreamParser: 模型发 m_read 前缀名 → 还原为 read', () => {
  const calls = parseToolCalls('<fn:invoke>\n{"name": "m_read", "arguments": {"path": "a.txt"}}\n</fn:invoke>')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].name, 'read')
  assert.equal(calls[0].arguments, '{"path":"a.txt"}')
})

test('ToolStreamParser: 模型发明文 read（历史里是原始名）→ 仍为 read', () => {
  const calls = parseToolCalls('<fn:invoke>\n{"name": "read", "arguments": {"path": "a.txt"}}\n</fn:invoke>')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].name, 'read')
})

test('ToolStreamParser: 未声明过的 m_ 前缀名也一律剥前缀（始终归一化）', () => {
  const calls = parseToolCalls('<fn:invoke>\n{"name": "m_delete_everything", "arguments": {}}\n</fn:invoke>')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].name, 'delete_everything')
})

test('ToolStreamParser: 流式分片到达的 m_ 前缀调用同样还原，标记不泄漏', () => {
  const events = []
  const p = new ToolStreamParser((ev) => events.push(ev))
  p.push('前言 <fn:invoke>\n{"name": "m_b')
  p.push('ash", "arguments": {"command": "ls"}}\n</fn')
  p.push(':invoke> 后记')
  p.end()
  const calls = events.filter((e) => e.toolCall).map((e) => e.toolCall)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].name, 'bash')
  assert.equal(calls[0].arguments, '{"command":"ls"}')
  const text = events.filter((e) => e.content).map((e) => e.content).join('')
  assert.ok(text.includes('前言'), `应保留正文: ${JSON.stringify(text)}`)
  assert.ok(!text.includes('fn:invoke'), `标记不应泄漏: ${JSON.stringify(text)}`)
})

// ---------------------------------------------------------------- v0.2.7 toolPreamble

const TOOLS = [
  { type: 'function', function: { name: 'bash', description: 'run a command', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } },
  { type: 'function', function: { name: 'read', description: 'read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } },
]

test('toolPreamble: 工具名以 m_ 前缀呈现，含成功前例，不含 "No such tool"', () => {
  const p = toolPreamble(TOOLS, undefined)
  assert.ok(p.includes('m_read'))
  assert.ok(p.includes('"m_bash"'), '工具 Schema 的 name 应为 m_bash')
  assert.ok(!p.includes('"name": "bash"'))
  assert.ok(!p.includes('"name":"bash"'))
  assert.ok(p.includes('m_ 前缀提供'), '应解释 m_ 前缀含义')
  assert.ok(p.includes('与宿主环境的其他工具系统无关'), '应声明与宿主工具通道无关')
  // 成功前例
  assert.ok(p.includes('（示例——上一轮你成功调用过工具）'))
  assert.ok(p.includes('<fn:invoke>'))
  assert.ok(p.includes('"m_bash"'))
  assert.ok(p.includes('调用已经在此会话中正常工作过'))
  // 反幻觉：不得出现示例报错文案
  assert.ok(!p.includes('No such tool'), '不得枚举示例错误字符串')
})

test('toolPreamble: 无 bash 时前例退回到第一个工具的别名', () => {
  const p = toolPreamble([{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }], undefined)
  assert.ok(p.includes('"m_read"'))
  assert.ok(p.includes('（示例——上一轮你成功调用过工具）'))
  assert.ok(p.includes('<fn:invoke>'))
  assert.ok(p.includes('调用已经在此会话中正常工作过'))
})

test('toolPreamble: tool_choice 指定函数名时也以别名呈现', () => {
  const p = toolPreamble(TOOLS, { type: 'function', function: { name: 'read' } })
  assert.ok(p.includes('本次必须调用函数 m_read'))
})

test('toolPreamble: tool_choice=none 且无工具时不注入前例与 m_ 说明', () => {
  const p = toolPreamble([], 'none')
  assert.ok(!p.includes('（示例——上一轮你成功调用过工具）'))
  assert.ok(!p.includes('m_ 前缀提供'))
  assert.ok(p.includes('禁止调用任何工具'))
})

// ---------------------------------------------------------------- v0.3 composeTurnText（invisible 通道）

test('composeTurnText: 首轮带工具时 invisible 含前例（经 toolPreamble），text 为纯 transcript', () => {
  const toolBlock = toolPreamble(TOOLS, undefined)
  const { text, invisible } = composeTurnText({ firstTurn: true, persona: true, toolBlock, toolsPresent: true, deltaText: '[user]\n问题' })
  assert.ok(invisible.includes('（示例——上一轮你成功调用过工具）'), '首轮 invisible 应包含成功前例')
  assert.ok(invisible.includes(PREAMBLE.slice(0, 20)), 'persona 开启时首轮 invisible 应有 PREAMBLE，且在 toolBlock 前')
  assert.ok(invisible.indexOf(PREAMBLE.slice(0, 20)) < invisible.indexOf('（示例'), 'PREAMBLE 应在 toolBlock 之前')
  assert.ok(!invisible.includes(TOOL_RECENCY), '首轮不应带逐轮提醒')
  assert.equal(text, '[user]\n问题', 'text 应为纯 transcript，不含 preamble/toolBlock')
})

test('composeTurnText: 首轮 persona:false 无 PREAMBLE 但 invisible 仍带工具前例', () => {
  const toolBlock = toolPreamble(TOOLS, undefined)
  const { text, invisible } = composeTurnText({ firstTurn: true, persona: false, toolBlock, toolsPresent: true, deltaText: 'flat' })
  assert.ok(!invisible.includes(PREAMBLE.slice(0, 20)))
  assert.ok(invisible.includes('（示例——上一轮你成功调用过工具）'))
  assert.equal(text, 'flat')
})

test('composeTurnText: 续轮且有工具时 invisible 带一行格式提醒（persona:false 也生效）', () => {
  const { text, invisible } = composeTurnText({ firstTurn: false, persona: false, toolBlock: '', toolsPresent: true, deltaText: '[tool:read]\n结果' })
  assert.ok(invisible.includes(TOOL_RECENCY), '续轮应带格式提醒且不受 persona 开关影响')
  assert.ok(!invisible.includes(REMINDER))
  assert.equal(text, '[tool:read]\n结果')
})

test('composeTurnText: 续轮无工具时 invisible 为 undefined；有 persona 时带 REMINDER', () => {
  const withPersona = composeTurnText({ firstTurn: false, persona: true, toolBlock: '', toolsPresent: false, deltaText: '续问' })
  assert.ok(!withPersona.invisible?.includes(TOOL_RECENCY))
  assert.ok(withPersona.invisible.includes(REMINDER))
  const noPersona = composeTurnText({ firstTurn: false, persona: false, toolBlock: '', toolsPresent: false, deltaText: '续问' })
  assert.equal(noPersona.invisible, undefined, '无 preamble/工具时不应注入 invisible 块')
})

test('composeTurnText: 续轮且工具集更新时 invisible 顺序为 toolBlock → REMINDER → 提醒', () => {
  const toolBlock = '【工具列表更新】\n' + toolPreamble(TOOLS, undefined)
  const { text, invisible } = composeTurnText({ firstTurn: false, persona: true, toolBlock, toolsPresent: true, deltaText: '增量' })
  assert.ok(invisible.startsWith('【工具列表更新】'))
  const iBlock = invisible.indexOf('【工具列表更新】')
  const iRem = invisible.indexOf(REMINDER)
  const iRec = invisible.indexOf(TOOL_RECENCY)
  assert.ok(iBlock >= 0 && iRem > iBlock && iRec > iRem, '顺序应为 toolBlock → REMINDER → 提醒')
  assert.equal(text, '增量')
})

// ---------------------------------------------------------------- v0.3 parseRawBlocks

test('parseRawBlocks: 多参数块按序提取，数值/布尔还原类型，其余保留字符串', () => {
  const { args, consumed } = parseRawBlocks('<timeout>300</timeout>\n<force>true</force>\n<command>python3 - <<\'EOF\'\nprint("hi","你好")\nEOF\n</command>')
  assert.ok(consumed > 0, '应消耗全部参数块')
  assert.equal(args.timeout, 300)
  assert.equal(args.force, true)
  assert.equal(args.command, "python3 - <<'EOF'\nprint(\"hi\",\"你好\")\nEOF", 'heredoc 原文零转义保留（尾随换行被 close 标签吞掉属已知行为）')
})

test('parseRawBlocks: 空输入返回空 args；尾部非块内容不计入 consumed', () => {
  assert.deepEqual(parseRawBlocks(''), { args: {}, consumed: 0 })
  const { args, consumed } = parseRawBlocks('<a>1</a>垃圾尾巴')
  assert.equal(args.a, 1)
  assert.equal(consumed, 8)
})

test('ToolStreamParser: raw-block 属性形式调用（含 heredoc/引号）零转义解析', () => {
  const p = new ToolStreamParser(() => {})
  const out = []
  p.emit = (e) => out.push(e)
  p.push('<fn:invoke name="m_bash"><timeout>300</timeout><command>python3 - <<\'EOF\'\nprint("hi","你好")\nEOF\n</command></fn:invoke>')
  p.end()
  const call = out.find((e) => e.toolCall)?.toolCall
  assert.ok(call, '应发射 toolCall')
  assert.equal(call.name, 'bash', 'm_ 前缀应还原')
  const args = JSON.parse(call.arguments)
  assert.equal(args.timeout, 300)
  assert.equal(args.command, "python3 - <<'EOF'\nprint(\"hi\",\"你好\")\nEOF")
  assert.ok(!out.some((e) => e.content?.includes('<fn:invoke')), '标记不应泄漏到正文')
})

test('ToolStreamParser: raw-block 跨 chunk 分片到达同样解析，close 标记不泄漏', () => {
  const out = []
  const p = new ToolStreamParser((e) => out.push(e))
  const full = '<fn:invoke name="m_read"><path>/tmp/a b/c.txt</path></fn:invoke>'
  for (let i = 0; i < full.length; i += 7) p.push(full.slice(i, i + 7))
  p.end()
  const call = out.find((e) => e.toolCall)?.toolCall
  assert.ok(call)
  assert.equal(call.name, 'read')
  assert.deepEqual(JSON.parse(call.arguments), { path: '/tmp/a b/c.txt' })
  assert.ok(!out.some((e) => e.content && /<\/?fn:?_? ?invoke/.test(e.content)), 'open/close 标记都不应泄漏')
})

test('ToolStreamParser: 属性形式起始标记后跟 JSON 负载仍走原 JSON 路径', () => {
  const out = []
  const p = new ToolStreamParser((e) => out.push(e))
  p.push('<fn:invoke name="m_bash">{"name": "m_bash", "arguments": {"command": "ls"}}</fn:invoke>')
  p.end()
  const call = out.find((e) => e.toolCall)?.toolCall
  assert.ok(call)
  assert.equal(call.name, 'bash')
  assert.deepEqual(JSON.parse(call.arguments), { command: 'ls' })
})

test('ToolStreamParser: raw-block 内容含孤立 </fn:invoke> 字样时不误切（改走 fallback 透传）', () => {
  const out = []
  const p = new ToolStreamParser((e) => out.push(e))
  // taught rule forbids </fn:invoke> inside raw bodies; a close look-alike in
  // the middle makes the first close end the body early — the tail then has
  // no name attribute and falls back to text passthrough without crashing
  p.push('<fn:invoke name="m_write"><text>提到 </fn:invoke> 的话就完不成</text></fn:invoke>')
  p.end()
  const call = out.find((e) => e.toolCall)?.toolCall
  if (call) {
    assert.equal(call.name, 'write')
  } else {
    assert.ok(out.some((e) => e.content?.includes('<fn:invoke')), '无法路由时应回退透传原文')
  }
})

// ---------------- v0.3.2 混搭格式（无 name 开头 + raw 参数块）不再泄漏 ----------------

const MIXED_BLOCK = '<fn:invoke>\n<command>cd ~ && python3 check_circle_now.png</command>\n</fn:invoke>'

test('ToolStreamParser: 混搭格式（无 name + <command> 块）经 toolKeys 超集匹配路由为 m_bash', () => {
  const out = []
  const p = new ToolStreamParser((e) => out.push(e), { m_bash: ['command', 'timeout'] })
  p.push(MIXED_BLOCK)
  p.end()
  const call = out.find((e) => e.toolCall)?.toolCall
  assert.ok(call, '不应按正文泄漏，应产出 toolCall')
  assert.equal(call.name, 'bash', 'm_bash 应还原为 bash')
  assert.equal(JSON.parse(call.arguments).command, 'cd ~ && python3 check_circle_now.png')
  assert.ok(call.note, '推断的调用应带 note 标记')
  assert.ok(!out.some((e) => e.content?.includes('<fn:invoke>')), '标记不应泄漏到正文')
})

test('ToolStreamParser: 混搭格式 key 集合完全相等时精确匹配 toolKeys', () => {
  const out = []
  const p = new ToolStreamParser((e) => out.push(e), { m_write: ['path', 'content'], m_bash: ['command', 'timeout'] })
  p.push('<fn:invoke><path>/tmp/a.txt</path><content>hello</content></fn:invoke>')
  p.end()
  const call = out.find((e) => e.toolCall)?.toolCall
  assert.ok(call)
  assert.equal(call.name, 'write', '两个工具都可作超集时应选重叠最大者')
  assert.deepEqual(JSON.parse(call.arguments), { path: '/tmp/a.txt', content: 'hello' })
  assert.ok(call.note)
})

test('ToolStreamParser: 混搭格式无 toolKeys 时 bash fallback（command/cmd）', () => {
  const out = []
  const p = new ToolStreamParser((e) => out.push(e))
  p.push(MIXED_BLOCK)
  p.end()
  const call = out.find((e) => e.toolCall)?.toolCall
  assert.ok(call, '无 toolKeys 也应产出 fallback 名 toolCall')
  assert.equal(call.name, 'bash')
  assert.ok(call.note)
})

test('ToolStreamParser: 混搭格式无法路由（无 toolKeys、无 command/cmd）仍按现状透传', () => {
  const out = []
  const p = new ToolStreamParser((e) => out.push(e))
  const block = '<fn:invoke><path>/tmp/a.txt</path></fn:invoke>'
  p.push(block)
  p.end()
  assert.ok(!out.some((e) => e.toolCall))
  assert.equal(out.filter((e) => e.content !== undefined).map((e) => e.content).join(''), block, '原文透传')
})

test('ToolStreamParser: 混搭格式跨 chunk 分片同样解析', () => {
  const out = []
  const p = new ToolStreamParser((e) => out.push(e), { m_bash: ['command', 'timeout'] })
  for (let i = 0; i < MIXED_BLOCK.length; i += 5) p.push(MIXED_BLOCK.slice(i, i + 5))
  p.end()
  const call = out.find((e) => e.toolCall)?.toolCall
  assert.ok(call)
  assert.equal(call.name, 'bash')
  assert.equal(JSON.parse(call.arguments).command, 'cd ~ && python3 check_circle_now.png')
  assert.ok(!out.some((e) => e.content?.includes('<fn:invoke>')))
})

test('toolPreamble: 格式A 必须带 name 属性 + 混搭反例提示', () => {
  const p = toolPreamble(TOOLS, undefined)
  assert.ok(p.includes('【必须】带 name="函数名" 属性'), '格式A 应强制 name 属性')
  assert.ok(p.includes('混写'), '应包含混搭反例提示')
  assert.ok(p.includes('m_ 前缀提供'), 'm_ 别名机制不变')
})
