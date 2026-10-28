import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TOOL_RECENCY, composeTurnText, PREAMBLE, REMINDER, toolPreamble } from '../src/prompt.mjs'
import { createToolContext } from '../src/tools.mjs'
import {
  resolveModelId,
  FALLBACK_MODELS,
  createFallbackModels,
  NOT_TOOL_RECOMMENDED,
  NOT_TOOL_RECOMMENDED_SUFFIX,
  fetchAccountModels,
} from '../src/models.mjs'
import { StepXAuthPlugin } from '../index.mjs'
import { mockHttp, makeTransport } from './helpers.mjs'

test('TOOL_RECENCY: dynamic prefix from ctx and fallback without ctx', () => {
  // With ctx containing prefix
  const withPrefixObj = TOOL_RECENCY({ prefix: 'm0_' })
  assert.equal(
    withPrefixObj,
    '（工具调用格式提醒：需要工具时，回复以 <fn:invoke> {"name": "m0_函数名", "arguments": {...}} </fn:invoke> 开头。）',
  )
  assert.ok(!withPrefixObj.includes('工具可用且已成功使用过'), '断言已删除')

  // With string prefix
  const withPrefixStr = TOOL_RECENCY('m_')
  assert.equal(
    withPrefixStr,
    '（工具调用格式提醒：需要工具时，回复以 <fn:invoke> {"name": "m_函数名", "arguments": {...}} </fn:invoke> 开头。）',
  )
  assert.ok(!withPrefixStr.includes('工具可用且已成功使用过'), '断言已删除')

  // Without ctx (fallback)
  const noCtx = TOOL_RECENCY()
  assert.equal(
    noCtx,
    '（工具调用格式提醒：需要工具时，回复以 <fn:invoke> {"name": "函数名", "arguments": {...}} </fn:invoke> 开头。）',
  )
  assert.ok(!noCtx.includes('工具可用且已成功使用过'), '断言已删除')

  // Null / empty ctx
  assert.equal(TOOL_RECENCY(null), noCtx)
  assert.equal(TOOL_RECENCY({}), noCtx)
})

test('composeTurnText: integration with dynamic prefix and continuation turns', () => {
  // First turn with tools
  const t1 = composeTurnText({
    firstTurn: true,
    persona: true,
    toolBlock: 'TOOLS_HERE',
    toolsPresent: true,
    deltaText: 'question',
    prefix: 'm0_',
  })
  assert.ok(t1.invisible.includes(PREAMBLE))
  assert.ok(t1.invisible.includes('TOOLS_HERE'))
  assert.ok(!t1.invisible.includes('工具调用格式提醒'), '首轮不带逐轮提醒')

  // Continuation turn with tools and prefix
  const t2 = composeTurnText({
    firstTurn: false,
    persona: true,
    toolBlock: '',
    toolsPresent: true,
    deltaText: 'delta',
    prefix: 'm0_',
  })
  assert.ok(t2.invisible.includes(REMINDER))
  assert.ok(t2.invisible.includes('m0_函数名'))
  assert.ok(!t2.invisible.includes('工具可用且已成功使用过'))

  // Continuation turn with tools but no prefix
  const t3 = composeTurnText({
    firstTurn: false,
    persona: false,
    toolBlock: '',
    toolsPresent: true,
    deltaText: 'delta',
  })
  assert.ok(t3.invisible.includes('函数名'))
  assert.ok(!t3.invisible.includes('m_函数名'))

  // Continuation turn without tools
  const t4 = composeTurnText({
    firstTurn: false,
    persona: true,
    toolBlock: '',
    toolsPresent: false,
    deltaText: 'delta',
    prefix: 'm0_',
  })
  assert.equal(t4.invisible, REMINDER)
})

test('resolveModelId: warns on fallback for unknown models, throttled per argument', () => {
  const originalWarn = console.warn
  const warnings = []
  console.warn = (...args) => warnings.push(args.join(' '))

  try {
    // Known models: should NOT warn
    const known1 = resolveModelId('deepseek-flash', FALLBACK_MODELS)
    assert.equal(known1, 'deepseek-flash[1m]')
    assert.equal(warnings.length, 0)

    const known2 = resolveModelId('auto', FALLBACK_MODELS)
    assert.equal(known2, 'auto')
    assert.equal(warnings.length, 0)

    // Unknown model 1: should warn once
    const unknown1 = resolveModelId('test-unknown-model-xyz', FALLBACK_MODELS)
    assert.equal(unknown1, 'auto')
    assert.equal(warnings.length, 1)
    assert.ok(warnings[0].includes('test-unknown-model-xyz'), 'warning must contain original model name')
    assert.ok(warnings[0].includes('auto'), 'warning must contain fallback result')

    // Calling same unknown model again: should NOT warn again (throttled)
    const unknown1Repeat = resolveModelId('test-unknown-model-xyz', FALLBACK_MODELS)
    assert.equal(unknown1Repeat, 'auto')
    assert.equal(warnings.length, 1, 'throttled: should not warn again for same argument')

    // Different unknown model: should warn once
    const unknown2 = resolveModelId('another-unknown-model-abc', FALLBACK_MODELS)
    assert.equal(unknown2, 'auto')
    assert.equal(warnings.length, 2)
    assert.ok(warnings[1].includes('another-unknown-model-abc'))
    assert.ok(warnings[1].includes('auto'))
  } finally {
    console.warn = originalWarn
  }
})

test('FALLBACK_MODELS: NOT_TOOL_RECOMMENDED 标记 step-5-preview tool_call:false 且带后缀，其他模型正常', () => {
  assert.ok(NOT_TOOL_RECOMMENDED.has('step-5-preview'))
  assert.equal(FALLBACK_MODELS['step-5-preview'].tool_call, false)
  assert.ok(FALLBACK_MODELS['step-5-preview'].name.endsWith(NOT_TOOL_RECOMMENDED_SUFFIX))
  assert.equal(
    FALLBACK_MODELS['step-5-preview'].name,
    'Step 5 Preview' + NOT_TOOL_RECOMMENDED_SUFFIX,
  )
  assert.equal(FALLBACK_MODELS['deepseek-flash[1m]'].tool_call, true)
  assert.ok(!FALLBACK_MODELS['deepseek-flash[1m]'].name.includes(NOT_TOOL_RECOMMENDED_SUFFIX))
  assert.equal(FALLBACK_MODELS['auto'].tool_call, true)
  assert.ok(!FALLBACK_MODELS['auto'].name.includes(NOT_TOOL_RECOMMENDED_SUFFIX))
})

test('createFallbackModels: enableStep5Tools=true 时恢复 tool_call:true', () => {
  const fbEnabled = createFallbackModels({ enableStep5Tools: true })
  assert.equal(fbEnabled['step-5-preview'].tool_call, true)
  assert.ok(fbEnabled['step-5-preview'].name.endsWith(NOT_TOOL_RECOMMENDED_SUFFIX))
  assert.equal(fbEnabled['deepseek-flash[1m]'].tool_call, true)

  const fbDisabled = createFallbackModels({ enableStep5Tools: false })
  assert.equal(fbDisabled['step-5-preview'].tool_call, false)
  assert.ok(fbDisabled['step-5-preview'].name.endsWith(NOT_TOOL_RECOMMENDED_SUFFIX))
})

test('fetchAccountModels: 命中 NOT_TOOL_RECOMMENDED 时加后缀并设 tool_call:false，enableStep5Tools=true 恢复', async () => {
  const http = mockHttp({
    models: [
      { id: 'step-5-preview', name: 'Step 5 Preview' },
      { id: 'deepseek-flash[1m]', name: 'DeepSeek V4.1 Flash' },
    ],
  })
  const tr = makeTransport({ http })

  // 默认 (enableStep5Tools=false)
  const mDefault = await fetchAccountModels(tr, 'k=1')
  assert.equal(mDefault['step-5-preview'].tool_call, false)
  assert.ok(mDefault['step-5-preview'].name.endsWith(NOT_TOOL_RECOMMENDED_SUFFIX))
  assert.equal(mDefault['deepseek-flash[1m]'].tool_call, true)
  assert.ok(!mDefault['deepseek-flash[1m]'].name.includes(NOT_TOOL_RECOMMENDED_SUFFIX))

  // enableStep5Tools=true
  const mEnabled = await fetchAccountModels(tr, 'k=1', { enableStep5Tools: true })
  assert.equal(mEnabled['step-5-preview'].tool_call, true)
  assert.ok(mEnabled['step-5-preview'].name.endsWith(NOT_TOOL_RECOMMENDED_SUFFIX))
  assert.equal(mEnabled['deepseek-flash[1m]'].tool_call, true)
})

test('StepXAuthPlugin: options.enableStep5Tools 对 provider.models 的 live 与 fallback 路径生效', async () => {
  const http = mockHttp({
    models: [
      { id: 'step-5-preview', name: 'Step 5 Preview' },
      { id: 'deepseek-flash[1m]', name: 'DeepSeek V4.1 Flash' },
    ],
  })
  const tr = makeTransport({ http })

  // 默认插件选项
  const pluginDefault = await StepXAuthPlugin(null, { transport: tr })
  // 1) live 路径
  const liveDefault = await pluginDefault.provider.models(null, { auth: { key: 'c=1', accountId: 'acc-def' } })
  assert.equal(liveDefault['step-5-preview'].tool_call, false)
  assert.ok(liveDefault['step-5-preview'].name.endsWith(NOT_TOOL_RECOMMENDED_SUFFIX))
  // 2) fallback 路径 (无 cookie)
  const fbDefault = await pluginDefault.provider.models(null, { auth: null })
  assert.equal(fbDefault['step-5-preview'].tool_call, false)
  assert.ok(fbDefault['step-5-preview'].name.endsWith(NOT_TOOL_RECOMMENDED_SUFFIX))

  // 开启 enableStep5Tools
  const pluginEnabled = await StepXAuthPlugin(null, { transport: tr, enableStep5Tools: true })
  // 1) live 路径
  const liveEnabled = await pluginEnabled.provider.models(null, { auth: { key: 'c=1', accountId: 'acc-en' } })
  assert.equal(liveEnabled['step-5-preview'].tool_call, true)
  assert.ok(liveEnabled['step-5-preview'].name.endsWith(NOT_TOOL_RECOMMENDED_SUFFIX))
  // 2) fallback 路径 (无 cookie)
  const fbEnabled = await pluginEnabled.provider.models(null, { auth: null })
  assert.equal(fbEnabled['step-5-preview'].tool_call, true)
  assert.ok(fbEnabled['step-5-preview'].name.endsWith(NOT_TOOL_RECOMMENDED_SUFFIX))
})

test('toolPreamble: 格式B 为默认推荐格式，格式A 为备选，不再含"优先"指向格式A', () => {
  const ctx = createToolContext(
    [
      {
        type: 'function',
        function: {
          name: 'read_file',
          description: 'read file contents',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
            additionalProperties: false,
          },
        },
      },
    ],
    undefined,
    'm_',
  )
  const preamble = toolPreamble(ctx)

  // 格式B 为默认推荐格式
  assert.ok(
    preamble.includes('格式B（JSON，默认推荐格式）：所有参数都用 JSON，引号换行按标准 JSON 转义'),
    '格式B 应声明为默认推荐格式，提示所有参数用 JSON 且按标准 JSON 转义',
  )

  // 格式A 降级为备选，不优先
  assert.ok(
    preamble.includes('格式A（原始块，实验性；仅当 JSON 转义实在写不对时的备选，不优先）'),
    '格式A 应降级为仅当 JSON 转义写不对时的备选，明确标注不优先',
  )

  // 不再包含旧版将格式A视为优先的表述
  assert.ok(!preamble.includes('参数含长命令/脚本时优先'), '文本不再含"参数含长命令/脚本时优先"')
  assert.ok(!preamble.includes('参数含长命令/脚本/多行文本时使用'), '旧版提示语已更新')
  assert.ok(!preamble.includes('长命令/脚本/多行文本时优先'), '不得有任何表述指引格式A优先')

  // 校验"优先"字样绝不以肯定语义指向格式A
  assert.ok(!/格式A[^\n]*?(?<!不)优先/.test(preamble), '格式A 描述行不得出现指向其优先的表述')
})

test('PREAMBLE & REMINDER: 环境锚点事实注入，含用户本机与 uname -s 探测示例，不含任何具体 OS 名作为声明', () => {
  // PREAMBLE 包含两条关键事实锚点
  assert.ok(PREAMBLE.includes('用户本机'), 'PREAMBLE 应含"用户本机"')
  assert.ok(PREAMBLE.includes('uname -s'), 'PREAMBLE 应含探测示例"uname -s"')
  assert.ok(PREAMBLE.includes('pwd'), 'PREAMBLE 应含探测示例"pwd"')
  assert.ok(PREAMBLE.includes('不要假设任何特定操作系统'), 'PREAMBLE 保留环境中立原则')

  // 不含任何具体 OS 名作为声明（uname 探测示例本身不算；OS 名仅在跨平台可能性枚举中出现）
  assert.ok(!/在\s*(?:Windows|Linux|macOS|WSL)\s*(?:下|环境|的\s*bash|上)/.test(PREAMBLE), '不包含任何具体 OS 宿主声明')
  assert.ok(!/(?:环境是|当前环境|系统是|运行在)\s*(?:Windows|Linux|macOS)/.test(PREAMBLE), '不包含确定性 OS 断言')
  assert.ok(!PREAMBLE.includes('在 Windows 的 bash'), '不得含旧版硬编码 Windows 宿主')
  assert.ok(!PREAMBLE.includes('在 Linux 容器'), '不得假定 Linux 容器宿主')

  // 移去跨平台并列可能性枚举（可能是 Windows、WSL、Linux 或 macOS）后，PREAMBLE 其余文本绝无 OS 名出现
  const nonEnumPreamble = PREAMBLE.replace('（可能是 Windows、WSL、Linux 或 macOS）', '')
  assert.ok(!/windows|linux|macos|darwin|ubuntu/i.test(nonEnumPreamble), '除跨平台可能性枚举外，PREAMBLE 不含任何具体 OS 名')

  // REMINDER 同步包含精简版环境锚点
  assert.ok(REMINDER.includes('用户本机'), 'REMINDER 应含"用户本机"')
  assert.ok(
    REMINDER.includes('（工具在用户本机执行，不在你的云端环境；用户路径直接用，不确定先探测。）'),
    'REMINDER 应含精简版环境与路径探测锚点',
  )
})


