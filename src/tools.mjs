// Tool whitelist & schema validation.
//
// Contract:
// - the wire-name <-> original-name mapping is bidirectional and built ONLY
//   from the declared tool table (never an arbitrary "strip m_" prefix);
//   names that already start with the alias prefix cannot collide, because a
//   collision-free prefix is chosen per request from fixed candidates;
// - tool_choice (none / auto / required / {function}) and
//   parallel_tool_calls=false are validated against the ACTUAL calls of a
//   turn; violations are typed protocol errors, never a fake `stop`;
// - the JSON-Schema validator covers an explicit, finite subset; schemas
//   using anything outside that subset are rejected up front (typed
//   unsupported_tool_schema) instead of being "validated" dishonestly;
// - raw-block (format A) values are typed strictly per the declared schema:
//   schema strings keep their exact whitespace, numbers/booleans must match
//   their declared type exactly.

import { createHash } from 'node:crypto'
import { httpError, protocolError, PROTOCOL } from './errors.mjs'
import { assertSchemaSupported, validateJsonArguments as validateWithAjv } from './schema.mjs'

export function functionOf(t) {
  return t?.type === 'function' ? t.function : t
}

const PREFIX_CANDIDATES = ['m_', 'm0_', 'm00_', 'mx_', 'mm_']

/**
 * Build the per-request tool context from the raw payload fields.
 * tools: undefined/null -> no tools (parser never runs, calls impossible).
 */
export function createToolContext({ tools, toolChoice, parallelToolCalls } = {}) {
  const list = tools === undefined || tools === null ? [] : Array.isArray(tools) ? tools : null
  if (list === null)
    throw httpError(400, 'tools 必须是数组', { code: PROTOCOL.INVALID_REQUEST })
  const fns = []
  const names = new Set()
  for (let i = 0; i < list.length; i++) {
    const fn = functionOf(list[i])
    if (!fn || typeof fn.name !== 'string' || !fn.name)
      throw httpError(400, `tools[${i}] 不是有效的 function 工具声明（需要 function.name）`, {
        code: PROTOCOL.INVALID_REQUEST,
      })
    if (names.has(fn.name)) throw httpError(400, `tools 里有重复的函数名：${fn.name}`, { code: PROTOCOL.INVALID_REQUEST })
    const schema = fn.parameters ?? {}
    if (typeof schema !== 'object' || Array.isArray(schema) || schema === null)
      throw httpError(400, `tools[${i}]（${fn.name}）parameters 必须是 object schema`, {
        code: PROTOCOL.INVALID_REQUEST,
      })
    names.add(fn.name)
    fns.push({ name: fn.name, description: typeof fn.description === 'string' ? fn.description : undefined, schema })
  }

  // Honest schema validation: Ajv-backed (draft-07 / 2020-12), keyword
  // allowlist + local-ref-only + resource caps; unsupported content and
  // other dialects are typed 400s at declaration time, never silent ignores.
  for (const fn of fns) assertSchemaSupported(fn.schema, `tools[${fn.name}].parameters`)

  // Wire names: one collision-free prefix for the whole request. A declared
  // name that already looks like an alias (e.g. "m_read") can never collide
  // because the prefix is only kept when prefix+n misses the declared set.
  let prefix = null
  outer: for (const cand of PREFIX_CANDIDATES) {
    for (const n of names) {
      if (cand + n === n || names.has(cand + n)) continue outer
    }
    prefix = cand
    break
  }
  if (!prefix)
    throw httpError(400, '工具名无法分配无冲突的 m_ 线上别名（声明名覆盖了所有候选前缀）', {
      code: PROTOCOL.INVALID_REQUEST,
    })
  const wireToName = new Map()
  const nameToWire = new Map()
  for (const n of names) {
    const w = prefix + n
    nameToWire.set(n, w)
    wireToName.set(w, n)
  }

  // tool_choice normalization + validation
  let choice
  if (toolChoice === 'none') choice = { mode: 'none' }
  else if (toolChoice === 'required') choice = { mode: 'required' }
  else if (toolChoice === 'auto' || toolChoice === undefined || toolChoice === null) choice = { mode: 'auto' }
  else if (
    typeof toolChoice === 'object' &&
    toolChoice?.type === 'function' &&
    typeof toolChoice.function?.name === 'string'
  ) {
    const n = toolChoice.function.name
    if (!names.has(n))
      throw httpError(400, `tool_choice.function.name "${n}" 不在 tools 声明中`, { code: PROTOCOL.INVALID_REQUEST })
    choice = { mode: 'function', name: n }
  } else
    throw httpError(
      400,
      `tool_choice 形式不受支持：${JSON.stringify(toolChoice) ?? String(toolChoice)}（支持 "auto"/"none"/"required"/{type:"function",function:{name}}）`,
      { code: PROTOCOL.INVALID_REQUEST },
    )
  if ((choice.mode === 'required' || choice.mode === 'function') && fns.length === 0)
    throw httpError(400, 'tool_choice 要求工具，但本次请求未声明 tools', { code: PROTOCOL.INVALID_REQUEST })

  const parallel = parallelToolCalls === false ? false : true
  return { fns, names, wireToName, nameToWire, prefix, choice, parallel, hasTools: fns.length > 0 }
}

/**
 * Strict name resolution from the declaration table only. Accepts the wire
 * name (what we taught) or the exact original name when unambiguous;
 * everything else is unknown_tool. No guessing of any kind.
 */
export function resolveToolName(ctx, seen) {
  if (typeof seen !== 'string' || !seen) return { error: PROTOCOL.MISSING_NAME, message: '调用缺少 name' }
  if (!ctx || !ctx.hasTools) return { error: PROTOCOL.UNKNOWN_TOOL, message: `未声明任何工具，不能调用 "${seen}"` }
  if (ctx.wireToName.has(seen)) return { name: ctx.wireToName.get(seen) }
  if (ctx.names.has(seen)) return { name: seen }
  return { error: PROTOCOL.UNKNOWN_TOOL, message: `工具 "${seen}" 不在本次声明的工具列表中（严格白名单）` }
}

export function schemaFor(ctx, originalName) {
  return ctx.fns.find((f) => f.name === originalName)?.schema ?? {}
}

export function toolsKey(ctx) {
  return createHash('sha1')
    .update(JSON.stringify({ p: ctx.prefix, f: ctx.fns.map((f) => ({ n: f.name, s: f.schema })), c: ctx.choice, pa: ctx.parallel }))
    .digest('hex')
}

// ---------------------------------------------------------------- schema subset (Ajv-backed, see src/schema.mjs)

/**
 * Validate JSON-form arguments (format B): the arguments must be a plain
 * object (OpenAI function-call contract), then strict Ajv validation against
 * the tool's declared schema. No coercion, no mutation: "001" stays a string
 * when the schema wants a string and FAILS when it wants a number. Failures
 * are typed schema_violation with deterministic Ajv error text.
 */
export function validateJsonArguments(ctx, originalName, args) {
  const schema = schemaFor(ctx, originalName)
  return validateWithAjv(schema, originalName, args)
}

const NUM_RE = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/
const INT_RE = /^-?\d+$/

function rawTypeOf(ps) {
  // The one type a raw value can express UNAMBIGUOUSLY — or null when the
  // schema is composite/nullable/undeclared (raw cannot express null, and
  // guessing string/number/boolean is forbidden: use JSON format instead).
  if (ps === true) return null
  if (typeof ps !== 'object' || Array.isArray(ps)) return null
  if ('anyOf' in ps || 'oneOf' in ps || 'allOf' in ps || 'not' in ps || '$ref' in ps || 'if' in ps) return null
  if (Array.isArray(ps.enum)) {
    if (ps.enum.length > 0 && ps.enum.every((v) => typeof v === 'string')) return 'string'
    return null // numeric/mixed enums: raw text formatting is ambiguous
  }
  const t = Array.isArray(ps.type) ? ps.type : ps.type !== undefined ? [ps.type] : []
  if (t.length !== 1) return null
  return t[0]
}

/**
 * Build typed arguments from raw-block (format A) pairs. STRICT per the
 * declared schema: a param is parsed only when the schema pins exactly one
 * raw-expressible type (string keeps EXACT text incl. whitespace;
 * number/integer/boolean must parse exactly). Composite/nullable/numeric-
 * enum/undeclared params are a typed error that directs the model to JSON
 * format — never a guess, no loose JSON repair. The assembled object is
 * then fully validated by the SAME Ajv path as format B, so e.g. pattern /
 * min-max bounds still hold.
 */
export function rawArgsToArguments(ctx, originalName, pairs) {
  const schema = schemaFor(ctx, originalName)
  const props = schema.properties ?? {}
  const addl = schema.additionalProperties
  const args = {}
  for (const [k, raw] of pairs) {
    if (k in args) return { error: `参数 ${k} 重复出现`, code: PROTOCOL.SCHEMA_VIOLATION }
    const ps = props[k]
    if (ps === false) return { error: `参数 ${k} 被 schema 禁止`, code: PROTOCOL.SCHEMA_VIOLATION }
    const t = rawTypeOf(ps)
    if (t === null) {
      const declared = ps && typeof ps === 'object' ? JSON.stringify(ps).slice(0, 60) : '未声明'
      return {
        error: `参数 ${k} 的 schema（${declared}）无法无歧义地确定原始块类型（组合/可空/未声明类型一律不猜）——请改用 JSON 格式（格式B）`,
        code: PROTOCOL.RAW_AMBIGUOUS,
      }
    }
    if (t === 'string') args[k] = raw // exact whitespace & content preserved
    else if (t === 'number') {
      if (!NUM_RE.test(raw.trim())) return { error: `参数 ${k} 应为 number，原文不是合法数字`, code: PROTOCOL.SCHEMA_VIOLATION }
      args[k] = Number(raw)
    } else if (t === 'integer') {
      if (!INT_RE.test(raw.trim())) return { error: `参数 ${k} 应为 integer，原文不是合法整数`, code: PROTOCOL.SCHEMA_VIOLATION }
      args[k] = Number(raw)
    } else if (t === 'boolean') {
      if (raw === 'true') args[k] = true
      else if (raw === 'false') args[k] = false
      else return { error: `参数 ${k} 应为 boolean，原文不是 true/false`, code: PROTOCOL.SCHEMA_VIOLATION }
    } else {
      return { error: `参数 ${k} 的类型 ${t} 无法用原始块形式表达，请改用 JSON 格式（格式B）`, code: PROTOCOL.RAW_AMBIGUOUS }
    }
  }
  for (const req of schema.required ?? []) {
    if (!(req in args)) return { error: `缺少必填参数 ${req}`, code: PROTOCOL.SCHEMA_VIOLATION }
  }
  return validateWithAjv(schema, originalName, args)
}


// ---------------------------------------------------------------- preamble

/**
 * Tool protocol declaration block (rides in the invisibleText ref block).
 * Teaches exactly two canonical forms: JSON (format B, default recommended) and the
 * raw-block form (format A, fallback only). No environment or
 * platform claims, no self-introduction script.
 */
export function toolPreamble(ctx) {
  const fns = ctx.fns
  const lines = [
    `你可以调用外部工具（函数）。工具名以 ${ctx.prefix} 前缀提供（与站点内置工具名隔离）；调用时必须使用带前缀的名字。可用工具列表（JSON Schema）：`,
    '<<<TOOLS>>>',
    ...fns.map((fn) => JSON.stringify({ name: ctx.nameToWire.get(fn.name), description: fn.description, parameters: fn.schema })),
    '<<<END_TOOLS>>>',
  ]
  if (fns.length) {
    const first = fns[0]
    lines.push(
      '（示例——上一轮你成功调用过工具）:',
      '<fn:invoke>',
      `{"name": "${ctx.nameToWire.get(first.name)}", "arguments": {}}`,
      '</fn:invoke>',
      '下一轮收到：[tool_result] 返回：ok',
      '调用已经在此会话中正常工作过。需要工具时直接发起调用，不要怀疑工具可用性。',
    )
  }
  lines.push(
    '调用规则：',
    '- 需要工具时，你的可见回复必须是工具调用块本身（不要写在代码围栏里，不要加任何解释文字）。调用格式有两种：',
    '- 格式B（JSON，默认推荐格式）：所有参数都用 JSON，引号换行按标准 JSON 转义；<fn:invoke> 开头不带 name，正文是一行 JSON：',
    '<fn:invoke>',
    '{"name": "函数名", "arguments": {参数对象}}',
    '</fn:invoke>',
    '- 格式A（原始块，实验性；仅当 JSON 转义实在写不对时的备选，不优先）：<fn:invoke> 开头必须带 name="函数名" 属性，参数用 <参数名>原文</参数名> 块：',
    '<fn:invoke name="函数名">',
    '<参数名>参数原文（原样保留，不做任何转义）</参数名>',
    '</fn:invoke>',
    '- 标记必须逐字写成 <fn:invoke> 和 </fn:invoke>；格式A 的参数原文中不能出现 </fn:invoke>，否则整个调用会被明确拒绝（此时请改用格式B）；',
    '- JSON 必须一次写对：坏 JSON 不会被修复，整个调用会被明确拒绝；',
    '- 工具调用块必须是你回复的第一个非空白内容：不要先写"我来…"、"正在…"再调用；',
    '- 只使用上方列出的函数名（带前缀）；提供全部必填参数，省略未知参数；',
    '- 一次可以连续发多个调用块（并行调用）；完全相同的调用不要重复发，除非操作可能改变了结果；',
    '- 收到 [tool_result] 结果后先评估任务状态：还有事没做完就发下一个调用，全部完成或需要用户决策时才用普通文本作答；',
    '- 严禁虚构工具执行：收到对应的 [tool_result] 之前一律视为尚未执行；工具结果过长被摘取时会标注丢失范围，需要精确内容就重新执行工具；',
    '- 不需要工具时直接用文本回答，不要输出 <fn:invoke>；',
    '- 调用结果会在下一轮以 [tool_result] 消息返回。',
  )
  if (ctx.choice.mode === 'required') lines.push('- 本次必须至少调用一个工具。')
  else if (ctx.choice.mode === 'function') lines.push(`- 本次必须调用函数 ${ctx.nameToWire.get(ctx.choice.name)}。`)
  else if (ctx.choice.mode === 'none') lines.push('- 本次禁止调用任何工具，直接文本回答。')
  return lines.join('\n')
}
