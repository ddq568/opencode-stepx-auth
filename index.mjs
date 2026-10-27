#!/usr/bin/env bun
/**
 * opencode-stepx-auth — Step Studio (studio.stepx.com) as a magpie / OpenCode
 * provider.
 *
 * Reverse-proxies the chat models of StepFun's Step Studio web app (Step 5
 * Preview, DeepSeek V4.1 Flash, Auto) behind an OpenAI-compatible
 * chat-completions interface, using the site's own web session (cookies) for
 * authentication.
 *
 * Protocol (reverse-engineered from studio.stepx.com's web client, verified
 * end-to-end):
 *   - HTTP  https://studio.stepx.com/api/*            (cookie auth)
 *       GET  /api/chat-models            -> {items:[{id,name,isDefault}]}
 *       POST /api/projects               -> create project {project:{id}}
 *       PATCH /api/projects/:id          -> {"model": "<id>"} switches model
 *       GET  /api/identity/me            -> {userId, nickname}
 *   - WS    wss://studio-api.stepx.com/ws (cookie auth)
 *       -> {type:"project.switch", projectId, payload:{projectSwitch:{resumeSeq:{}}}}
 *       -> {type:"chat.send", projectId, sessionId?, payload:{chatSend:{doc:{blocks:[{text}]}, model?}}, userLocale}
 *       <- {type:"ack"|"chat.queued"}                      (turn accepted)
 *       <- {type:"message.append", payload:{messageAppend:{kind:"user"|"thinking"|"text", delta}}}
 *       <- {type:"context.update", payload:{contextUpdate:{model,totalTokens,maxTokens}}}
 *       <- {type:"turn.completed"}                          (finish_reason: stop)
 *       <- {type:"turn.failed", payload:{turnFailed:{...}}}
 *       -> {type:"chat.interrupt", projectId, sessionId}    (abort)
 *       -> {type:"ping"} / <- {type:"pong"}                 (keepalive)
 *
 * Mapping to OpenAI chat completions:
 *   - messages are flattened deterministically to text; each conversation
 *     (fingerprinted by its head) maps to one Studio project+session; turns
 *     that extend the previous request's text send only the delta, keeping
 *     the Studio session in lockstep with the agent's growing history.
 *   - kind:"thinking" deltas -> reasoning_content; kind:"text" -> content.
 *
 * Options (magpie plugin options stepx '{"…"}'):
 *   { "chromePath": "C:/path/chrome.exe" }  browser used by the guided sign-in
 *   { "persona": false }                    skip the plain-text-assistant
 *                                           preamble injected on first turn
 *   { "maxProjects": 8 }                    conversation/project pool size
 */
import { createHash, randomUUID, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PROVIDER = 'stepx'
const SITE = 'https://studio.stepx.com'
const API = SITE + '/api'
const WS_URL = 'wss://studio-api.stepx.com/ws'
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const USER_LOCALE = 'zh'

/** Fallback catalog when /api/chat-models can't be asked. */
const FALLBACK_MODELS = {
  auto: model('Auto', 'route: automatic model choice'),
  'step-5-preview': model('Step 5 Preview'),
  'deepseek-flash[1m]': model('DeepSeek V4.1 Flash'),
}

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9.]/g, '')

/**
 * Map the model id the gateway sends to a real catalog id. magpie may strip
 * bracket suffixes (deepseek-flash[1m] -> deepseek-flash) or prefix the
 * provider; match back against the live catalog, falling back to auto.
 */
function resolveModelId(asked, catalog = FALLBACK_MODELS) {
  if (!asked) return 'auto'
  const bare = String(asked).includes('/') ? String(asked).split('/').pop() : String(asked)
  if (catalog[bare]) return bare
  const nb = norm(bare)
  let best = null
  for (const id of Object.keys(catalog)) {
    const ni = norm(id)
    if (ni === nb) return id
    // gateway-stripped or shortened form: deepseek-flash -> deepseek-flash[1m]
    if (nb.length >= 6 && ni.startsWith(nb) && (!best || ni.length < norm(best).length)) best = id
  }
  return best ?? 'auto'
}

function model(name, note) {
  return {
    name: note ? `${name} (${note})` : name,
    limit: { context: 900000, output: 65536 },
    reasoning: true,
    tool_call: true,
    modalities: { input: ['text'] },
  }
}

// ---------------------------------------------------------------- flattening

const PREAMBLE = [
  '【会话模式：本地终端 API 透传】本会话是一个特殊的纯问答/编程会话：你的 IDE 工作区与构建/预览/云端能力在本会话中【已断开，不可访问】——即使你平时能创建 App、调用 capsule SDK、跑云函数，本会话里这些全部不可用，也不要尝试或提议使用它们。这是运行环境的事实约束，不是身份设定。',
  '本会话中你唯一可用的执行手段是对话中声明的【本地工具】（若无工具声明则只能纯文本回答）；[tool] 消息是这些本地工具的真实返回结果。',
  '规则：',
  '1. 直接回答最后一条 [user] 或 [tool] 消息，输出 Markdown 纯文本；不要自我介绍；',
  '2. 不要提及 AI Builder、Step Studio、工作区路径或你的宿主平台；',
  '3. 除非通过工具声明发起调用，否则不创建/修改任何文件。',
  '',
  '被问及能力时，优先采用工具声明部分给出的【标准自我介绍】（若本轮未声明工具，则按纯问答口径介绍）。',
].join('\n')

/** Compact identity reminder carried on every continuation turn. */
const REMINDER = '（会话模式提醒：纯问答/编程会话，你的工作区与云端构建能力已断开；只回答最后一条消息；只可使用对话中声明的本地工具；问能力时按本地工具+编程知识口径答；不提宿主平台。）'

function defuseMarkers(text) {
  return String(text)
    .replace(/<\s*\/?\s*(fn[_ :\-	]?invoke|tool[_ :\-	]?calls?)[^>\n]{0,16}>/gi, (m) => m.replace(/[<>]/g, (c) => (c === '<' ? '\u2039' : '\u203a')))
    .replace(/\[\s*(?:end[ _-]{1,2}\s*|\/?\s*)?(fn[_ :\-	]?invoke|tool[_ :\-	]?calls?)\s*\]/gi, (m) => m.replace(/[\[\]]/g, (c) => (c === '[' ? '\uff3b' : '\uff3d')))
}
/** Turn one OpenAI message's content into plain text. */
function contentToText(content) {
  if (typeof content === 'string') return defuseMarkers(content)
  if (Array.isArray(content))
    return content
      .map((c) => {
        if (typeof c === 'string') return c
        if (c?.type === 'text') return c.text ?? ''
        if (c?.type === 'image_url') return '[image omitted]'
        if (c?.type === 'tool_use') return `[tool_call ${c.id ?? ''} ${c.name ?? ''}(${JSON.stringify(c.input ?? {})})]`
        if (c?.type === 'tool_result')
          return `[tool_result ${c.tool_use_id ?? ''}] ${contentToText(c.content)}`
        return ''
      })
      .join('')
  if (content == null) return ''
  return String(content)
}

/**
 * Deterministically flatten an OpenAI messages array into text. The same
 * history must always produce byte-identical output: conversation
 * continuation is detected by prefix-matching against this text.
 */
export function flattenMessages(messages) {
  const out = []
  for (const m of messages ?? []) {
    const text = contentToText(m?.content).trim()
    const name = typeof m?.name === 'string' && m.name ? `:${m.name}` : ''
    if (!text) continue
    if (m?.role === 'system' || m?.role === 'developer') out.push(`[system]\n${text}`)
    else if (m?.role === 'user') out.push(`[user${name}]\n${text}`)
    else if (m?.role === 'assistant') out.push(`[assistant${name}]\n${text}`)
    else if (m?.role === 'tool') out.push(`[tool${name}]\n${text}`)
    else out.push(`[${m?.role ?? 'unknown'}${name}]\n${text}`)
  }
  return out.join('\n\n')
}

/**
 * Stable id for a conversation: the head (system + first user message) +
 * model. Turns of one conversation keep this constant; a new conversation
 * (different head) gets a new Studio project.
 */
function conversationKey(flat, modelId) {
  const blocks = flat.split('\n\n')
  let head = []
  for (const b of blocks) {
    head.push(b)
    if (b.startsWith('[user')) break
  }
  if (!head.some((b) => b.startsWith('[user'))) head = blocks.slice(0, 1) // degenerate: no user message
  return createHash('sha1').update(`${modelId}\u0000${head.join('\n\n')}`).digest('hex')
}

// ---------------------------------------------------------------- tool calls

/**
 * The Studio backend has no native tool-calling, so tools are emulated with
 * a <fn:invoke> text protocol
 * and parsed back into OpenAI tool_calls by ToolStreamParser below.
 */
// Canonical taught form is <fn:invoke>…</fn:invoke> (survives the studio's
// backend, which intercepts the platform-native <tool_call>). The parser is
// deliberately looser than the taught form: models mangle the opening marker
// about half the time while almost always writing the JSON payload right
// (numbers measured on real captures by Qwen2API, whose platform intercepts
// <tool_call> the same way). So: a fuzzy trigger locates the call, the JSON
// payload inside a small window defines it, and the close marker is only
// swallowed, never required.
const TOOL_OPEN_TAG = '<fn:invoke>'
const TOOL_CLOSE_TAG = '</fn:invoke>'
// Strict close-marker matcher: unlike CLOSE_SWALLOW_RE (which also matches an
// opening tag), this only ever matches a *closing* marker at the head of the
// buffer. Used to swallow a close tag that arrives in its own streaming chunk
// AFTER the payload of its call was already consumed by an earlier chunk —
// without this, `\n</fn:invoke>` leaks into content as stray text.
const CLOSE_HEAD_RE =
  /^[ \t\r\n]{0,8}(?:<\/[ \t]{0,4}(?:fn[ \t_:\-]{0,2}invoke|tool[ \t_:\-]{0,2}calls?)[^<>\[\{\n]{0,16}>?|\[?[ \t]{0,4}(?:end[ _\-]{1,2}|\/)[ \t]{0,4}(?:fn[ \t_:\-]{0,2}invoke|tool[ \t_:\-]{0,2}calls?)[ \t]{0,4}\]?)/i
const CLOSE_TAIL_HEADS = ['</fn invoke', '</fn_invoke', '</fn:invoke', '</tool_call', '[/fn invoke]', '[/fn:invoke]', '[/tool_call]', '[end fn invoke]', '[end tool_call]', '[end fn_invoke]', '[end tool_calls]']
// --- tool-call markers (fuzzy trigger + payload-window recovery) -----------
// Canonical taught form is <fn:invoke>…</fn:invoke> (survives the studio's
// backend, which intercepts the platform-native <tool_call>). The parser is
// deliberately looser than the taught form: models mangle the opening marker
// about half the time while almost always writing the JSON payload right
// (measured on real captures by Qwen2API, whose platform intercepts
// <tool_call> the same way). A fuzzy trigger locates the call, the JSON
// payload inside a small window defines it, and the close marker is only
// swallowed, never required. The tool name comes ONLY from the payload's
// "name" key, never from the trigger tail.
const SEP = '[ \\t_:\\-]'
const TOOL_TRIGGER_RE = new RegExp(
  '<[ \\t]{0,4}(?:fn' + SEP + '{0,2}invoke|tool' + SEP + '{0,2}calls?)[ \\t]{0,2}>?' +
  '|\\[[ \\t]{0,4}(?:fn' + SEP + '{1,2}invoke|tool' + SEP + '{1,2}calls?)[ \\t]{0,4}\\]',
  'i',
)
const CLOSE_SWALLOW_RE = new RegExp(
  '^[ \\t\\r\\n\\`]{0,8}(?:' +
    '<\\/?[ \\t]{0,4}(?:fn' + SEP + '{0,2}invoke|tool' + SEP + '{0,2}calls?)[^<>\\[\\{\\n\\`]{0,16}>?' +
    '|\\[?[ \\t]{0,4}(?:end[ \\t_:\\-]{1,2}|\\/[ \\t]{0,4})[ \\t]{0,4}(?:fn' + SEP + '{1,2}invoke|tool' + SEP + '{1,2}calls?)[ \\t]{0,4}\\]?' +
  ')',
  'i',
)
const PAYLOAD_WINDOW = 160 // max distance from a trigger to the '{' of its JSON
const TRIGGER_HEADS = ['<fn invoke', '<fn_invoke', '<fn:invoke', '<tool_call', '[fn invoke]', '[fn:invoke]', '[tool call]', '[tool_call]']
const MAX_HOLD = 24 // longest partial trigger tail held back while streaming



function toolPreamble(tools, toolChoice) {
  const lines = [
    '你可以调用外部工具（函数）。可用工具列表（JSON Schema）：',
    '<<<TOOLS>>>',
    ...tools.map((t) => JSON.stringify(functionOf(t))),
    '<<<END_TOOLS>>>',
    '调用规则：',
    '- 需要工具时，你的可见回复必须是工具调用块本身（不要写在代码围栏里，不要加任何解释文字），格式严格如下：',
    '<fn:invoke>',
    '{"name": "函数名", "arguments": {参数对象}}',
    '</fn:invoke>',
    '- 工具调用块必须是你回复的第一个非空白内容：不要先写"我来…"、"让我…"、"正在…"或计划再调用；',
    '- 标记必须逐字写成 <fn:invoke> 和 </fn:invoke>，不带任何属性、id 或函数名——调用所需的一切都在 JSON 里；',
    '- 只使用上方列出的函数名；提供全部必填参数，省略未知参数；',
    '- 一次可以连续发多个 <fn:invoke> 块（并行调用）；完全相同的调用不要重复发，除非有操作可能改变了结果；',
    '- 收到 [tool] 结果后先评估任务状态：还有事没做完就发下一个调用，全部完成或需要用户决策时才用普通文本作答；',
    '- 严禁虚构工具执行：在收到对应的 [tool] 消息之前，一律视为工具尚未执行——不得声称"已实测/已执行/已验证"，不得编造工具回执、临时文件路径、报错文本（如"No such tool"）或任何结果数据；',
    '- 被问"你能不能调用某工具"时，唯一可信的回答方式是当场发出真实的 <fn:invoke> 调用；若不调用，就如实说明原因，绝不虚构测试结论；',
    '- 没有工具结果佐证，不要声称文件已改、命令已成功、结果已验证；',
    '- 不需要工具时直接用文本回答，不要输出 <fn:invoke>；',
    '- 调用结果会在下一轮以 [tool] 消息返回。',
  ]
  if (toolChoice === 'required') lines.push('- 本次必须至少调用一个工具。')
  else if (toolChoice && typeof toolChoice === 'object' && toolChoice.type === 'function' && toolChoice.function?.name)
    lines.push(`- 本次必须调用函数 ${toolChoice.function.name}。`)
  else if (toolChoice === 'none') lines.push('- 本次禁止调用任何工具，直接文本回答。')
  const toolNames = tools.map((t) => functionOf(t)?.name).filter(Boolean)
  const intro = toolNames.length
    ? '我是运行在你本地终端里的编程助手。本轮可尝试调用的工具：' + toolNames.join('、') + '（' + (toolNames.length <= 3 ? '读写本机文件/执行本机命令类' : '本机文件与命令类') + '）。我可以尝试调用这些工具来完成读写文件、执行命令、排查修复代码问题、写脚本和测试；任何操作只有在我实际发出调用并收到 [tool] 结果之后才算完成。此外还能做编程知识答疑与方案设计。本会话无法创建应用、无法访问云端。'
    : '我是运行在你本地终端里的编程助手，本轮为纯问答模式（无工具）。我能：编程知识答疑、方案设计、代码解读与编写建议。本会话无法创建应用、无法访问云端。'
  lines.push('', '【标准自我介绍】当用户问你能做什么/有什么技能/介绍一下自己时，直接采用下面这段话作答（可按实际情况微调措辞，但不得添加其他能力）：', intro)
  return lines.join('\n')
}

function functionOf(t) {
  return t?.type === 'function' ? t.function : t
}

function toolsHashKey(tools, toolChoice) {
  return createHash('sha1')
    .update(JSON.stringify([tools?.map(functionOf) ?? null, toolChoice ?? null]))
    .digest('hex')
}

/** Escape raw control chars that models emit inside JSON string literals. */
function repairJson(s) {
  let out = ''
  let inStr = false
  let esc = false
  for (const c of s) {
    if (inStr) {
      if (esc) { esc = false; out += c; continue }
      if (c === '\\') { esc = true; out += c; continue }
      if (c === '"') { inStr = false; out += c; continue }
      if (c === '\n') { out += '\\n'; continue }
      if (c === '\r') { out += '\\r'; continue }
      if (c === '\t') { out += '\\t'; continue }
      out += c
      continue
    }
    if (c === '"') inStr = true
    out += c
  }
  return out
}

/** Extract one JSON object from a <fn:invoke> body, tolerating code fences. */
function parseToolCallBody(body) {
  let s = body.trim()
  const fence = s.match(/^```[a-zA-Z]*\s*([\s\S]*?)\s*```$/)
  if (fence) s = fence[1].trim()
  // the model may emit multiple objects; take the first valid one
  for (const candidate of [s, s.split('\n')[0]]) {
    for (const text of [candidate, repairJson(candidate)]) {
      try {
        const j = JSON.parse(text)
        if (j && typeof j.name === 'string') return j
      } catch {}
    }
  }
  // last resort: first {...} span
  const m = s.match(/\{[\s\S]*\}/)
  if (m) {
    for (const text of [m[0], repairJson(m[0])]) {
      try {
        const j = JSON.parse(text)
        if (j && typeof j.name === 'string') return j
      } catch {}
    }
  }
  return null
}

export class ToolStreamParser {
  constructor(emit) {
    this.emit = emit
    this.buf = ''
    this.calls = 0
    this.pendingClose = false // a toolCall was emitted; its close marker may still arrive
  }

  push(chunk) {
    this.buf += chunk
    this.process(false)
  }

  end() {
    this.process(true)
    if (this.buf) {
      this.emit({ content: this.buf })
      this.buf = ''
    }
  }

  /**
   * Scan from `from` for the JSON payload of a call: skip at most a short
   * run of decoration (whitespace, json fences), then read one balanced
   * object. Returns { raw, end } (end = index after '}'), { need: true }
   * when more text is required, or null for a false trigger.
   */
  findPayload(from, final) {
    const windowEnd = Math.min(this.buf.length, from + PAYLOAD_WINDOW)
    let decor = 0
    for (let i = from; i < windowEnd; i++) {
      const c = this.buf[i]
      if (c === '{') return this.scanObject(i, final)
      if (c === '}' || c === '[' || c === '<') return null // another block, not a payload
      if (!/[ \t\r\n`]/.test(c)) {
        decor++
        if (decor > 24 || !/[a-zA-Z0-9_:*#\-]/.test(c)) return null // prose or punctuation
      }
    }
    if (final) return null
    return windowEnd >= this.buf.length ? { need: true } : null
  }

  /** Balanced-brace scan starting at the '{' at `start`; string/escape aware. */
  scanObject(start, final) {
    let depth = 0
    let inStr = false
    let esc = false
    for (let i = start; i < this.buf.length; i++) {
      const c = this.buf[i]
      if (inStr) {
        if (esc) esc = false
        else if (c === '\\') esc = true
        else if (c === '"') inStr = false
        continue
      }
      if (c === '"') inStr = true
      else if (c === '{') depth++
      else if (c === '}') {
        depth--
        if (depth === 0) return { raw: this.buf.slice(start, i + 1), end: i + 1 }
      }
    }
    return final ? null : { need: true } // object still open, wait for more
  }

  process(final) {
    for (;;) {
      // a close marker that arrives in its own chunk (after the payload was
      // consumed by an earlier chunk) must still be swallowed, not leaked
      if (this.pendingClose) {
        const head = this.buf.match(CLOSE_HEAD_RE)
        if (head) {
          this.buf = this.buf.slice(head[0].length)
          this.pendingClose = false
          if (!this.buf) return
          continue
        }
        // close marker may still be split across chunks: hold back a
        // prefix-shaped head instead of clearing the expectation
        if (!final) {
          if (!this.buf) return // nothing arrived yet — wait for it
          const stripped = this.buf.toLowerCase().replace(/^[ \t\r\n]+/, '')
          if (stripped.length > 0 && stripped.length <= 24 && CLOSE_TAIL_HEADS.some((h) => h.startsWith(stripped))) return
        }
        this.pendingClose = false
      }
      const trig = this.buf.match(TOOL_TRIGGER_RE)
      if (!trig) {
        // hold back a tail that could still become a trigger
        let safe = this.buf.length
        if (!final) {
          const lower = this.buf.toLowerCase()
          for (let keep = Math.min(this.buf.length, MAX_HOLD); keep > 0; keep--) {
            const tail = lower.slice(lower.length - keep)
            if (TRIGGER_HEADS.some((h) => h.startsWith(tail) || tail.startsWith(h.slice(0, Math.min(h.length, keep))))) {
              safe = this.buf.length - keep
              break
            }
          }
        }
        if (safe > 0) {
          this.emit({ content: this.buf.slice(0, safe) })
          this.buf = this.buf.slice(safe)
        }
        return
      }
      const tStart = trig.index
      const tEnd = tStart + trig[0].length
      const payload = this.findPayload(tEnd, final)
      if (!payload) {
        // false trigger: no JSON follows, keep the text and continue after it
        this.emit({ content: this.buf.slice(0, tEnd) })
        this.buf = this.buf.slice(tEnd)
        continue
      }
      if (payload.need) {
        if (!final) return // wait for the payload to finish arriving
        this.emit({ content: this.buf }) // unterminated: give up, plain text
        this.buf = ''
        return
      }
      const before = this.buf.slice(0, tStart)
      if (before) this.emit({ content: before })
      const call = parseToolCallBody(payload.raw)
      if (call) {
        this.calls++
        this.emit({
          toolCall: {
            index: this.calls - 1,
            id: 'call-stepx-' + this.calls + '-' + randomUUID().replace(/-/g, '').slice(0, 8),
            name: String(call.name),
            arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments ?? {}),
          },
        })
        this.pendingClose = true // the close marker may arrive in a later chunk
      } else {
        this.emit({ content: this.buf.slice(tStart, tEnd) + payload.raw })
      }
      // consume trigger + payload, then swallow an optional close marker
      this.buf = this.buf.slice(payload.end)
      const closer = this.buf.match(CLOSE_SWALLOW_RE)
      if (closer) { this.buf = this.buf.slice(closer[0].length); this.pendingClose = false }
    }
  }
}


// ---------------------------------------------------------------- sse

const ENC = new TextEncoder()

function sseChunk(obj) {
  return ENC.encode(`data: ${JSON.stringify(obj)}\n\n`)
}

function oaiChunk({ id, created, model: served, delta, finish = null }) {
  return {
    id,
    object: 'chat.completion.chunk',
    created,
    model: served,
    choices: [{ index: 0, delta, finish_reason: finish }],
  }
}

function sseResponse(id, created, served, eventsPromise, { wantUsage = false } = {}) {
  const stream = new ReadableStream({
    async start(ctl) {
      ctl.enqueue(sseChunk(oaiChunk({ id, created, model: served, delta: { role: 'assistant' } })))
      let completionChars = 0
      let usedTools = false
      let usageInfo = null
      const finishWith = () => (usedTools ? 'tool_calls' : 'stop')
      try {
        for await (const ev of eventsPromise) {
          if (ev.reasoning) { completionChars += ev.reasoning.length; ctl.enqueue(sseChunk(oaiChunk({ id, created, model: served, delta: { reasoning_content: ev.reasoning } }))) }
          else if (ev.content) { completionChars += ev.content.length; ctl.enqueue(sseChunk(oaiChunk({ id, created, model: served, delta: { content: ev.content } }))) }
          else if (ev.toolCall) {
            usedTools = true
            completionChars += ev.toolCall.arguments.length
            ctl.enqueue(
              sseChunk(
                oaiChunk({
                  id,
                  created,
                  model: served,
                  delta: { tool_calls: [{ index: ev.toolCall.index, id: ev.toolCall.id, type: 'function', function: { name: ev.toolCall.name, arguments: ev.toolCall.arguments } }] },
                }),
              ),
            )
          } else if (ev.usage) {
            usageInfo = ev.usage
          } else if (ev.error) {
            ctl.enqueue(
              ENC.encode(
                `data: ${JSON.stringify({ error: { message: ev.error.message, type: 'upstream_error', code: ev.error.status ?? 502 } })}\n\n`,
              ),
            )
            break
          }
        }
        ctl.enqueue(sseChunk(oaiChunk({ id, created, model: served, delta: {}, finish: finishWith() })))
        if (wantUsage) {
          // real numbers when the turn reported usage; rough estimate otherwise
          const usage = usageInfo ?? (() => { const est = Math.max(1, Math.round(completionChars / 2)); return { prompt_tokens: 0, completion_tokens: est, total_tokens: est } })()
          ctl.enqueue(
            ENC.encode(
              `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: served, choices: [], usage })}\n\n`,
            ),
          )
        }
      } catch (e) {
        ctl.enqueue(
          ENC.encode(
            `data: ${JSON.stringify({ error: { message: e?.message ?? String(e), type: 'upstream_error', code: 502 } })}\n\n`,
          ),
        )
      }
      ctl.enqueue(ENC.encode('data: [DONE]\n\n'))
      ctl.close()
    },
    // client disconnect: end the generator (its finally releases the
    // conversation gate); chatTurn's own abort path sends chat.interrupt.
    cancel() { try { eventsPromise?.return?.()?.catch?.(() => {}) } catch {} },
  })
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
  })
}

// ---------------------------------------------------------------- http api

function apiHeaders(cookie, extra = {}) {
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

async function api(cookie, pathname, { method = 'GET', body } = {}) {
  const res = await fetch(API + pathname, {
    method,
    headers: apiHeaders(cookie),
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch {}
  // The site rotates its session cookies (DSESSIONID / _uticket / …); adopt
  // whatever it hands back so a long-lived plugin keeps working without a
  // fresh sign-in.
  const setCookies = typeof res.headers?.getSetCookie === 'function' ? res.headers.getSetCookie() : []
  if (setCookies.length && onCookieRefresh) {
    const merged = mergeSetCookie(cookie, setCookies)
    if (merged && merged !== cookie) onCookieRefresh(merged)
  }
  return { status: res.status, ok: res.ok, json, text }
}

/** hook set by the loader; receives the refreshed cookie header */
let onCookieRefresh = null

function mergeSetCookie(cookieHeader, setCookieLines) {
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

async function fetchAccountModels(cookie) {
  const r = await api(cookie, '/chat-models')
  const items = r.ok ? r.json?.items : null
  if (!Array.isArray(items)) return null
  const models = {}
  for (const it of items) {
    if (typeof it?.id !== 'string' || !it.id) continue
    models[it.id] = model(String(it.name ?? it.id), it.isDefault ? 'default on the site' : undefined)
  }
  return Object.keys(models).length ? models : null
}

/** live catalog with a 10-minute cache; falls back to the static list */
const catalogCache = { at: 0, value: null }
async function modelCatalog(cookie) {
  if (catalogCache.value && Date.now() - catalogCache.at < 600_000) return catalogCache.value
  const live = await fetchAccountModels(cookie).catch(() => null)
  const merged = { ...FALLBACK_MODELS, ...(live ?? {}) }
  catalogCache.value = merged
  catalogCache.at = Date.now()
  return merged
}

async function createProject(cookie, modelId, label) {
  let r
  for (let attempt = 0; ; attempt++) {
    r = await api(cookie, '/projects', {
      method: 'POST',
      body: {
        name: label,
        projectType: 'web',
        model: modelId,
        builderType: 'app',
        productType: 'app',
        description: label,
        source: 'home',
        clientRequestId: randomUUID(),
      },
    })
    const id0 = r.json?.project?.id ?? r.json?.id
    if (id0) return id0
    // transient throttle/server errors: one retry with backoff
    if (attempt === 0 && (r.status === 429 || r.status >= 500)) {
      await new Promise((res) => setTimeout(res, 2500))
      continue
    }
    break
  }
  const id = r.json?.project?.id ?? r.json?.id
  if (!id) {
    if (r.status === 401) throw httpError(401, 'Step Studio 登录已过期，请在 magpie 里重新登录 stepx')
    throw httpError(r.status, `创建 Step Studio 项目失败（HTTP ${r.status}）${(r.text || '').slice(0, 200)}`)
  }
  return id
}

async function setProjectModel(cookie, projectId, modelId) {
  await api(cookie, `/projects/${projectId}`, { method: 'PATCH', body: { model: modelId } }).catch(() => {})
}

async function deleteProject(cookie, projectId) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await api(cookie, `/projects/${projectId}`, { method: 'DELETE' }).catch(() => null)
    const transient = !r || r.status >= 500 || /LEASE_FAILED/.test(r.text ?? '')
    if (!transient || attempt === 1) return
    await new Promise((res) => setTimeout(res, 2500))
  }
}

function httpError(status, message) {
  const e = new Error(message)
  e.status = status
  return e
}

// ---------------------------------------------------------------- websocket

/**
 * One turn over one fresh WebSocket connection.
 * Resolves {sessionId, text, thinking} on turn.completed.
 * events is an async iterable of {content}|{reasoning} for streaming.
 */
function chatTurn({ cookie, projectId, sessionId, text, modelId, signal }) {
  let ws
  let settled = false
  let resolveDone, rejectDone
  const done = new Promise((res, rej) => { resolveDone = res; rejectDone = rej })
  done.catch(() => {}) // mark handled: abort/cancel paths may stop awaiting it
  const seenSeq = new Set()
  const acc = { text: '', thinking: '' }
  acc.sessionTokens = 0 // last context.update totalTokens (session-wide)
  // Our own turn id: sent with chat.send (the web client does the same) so
  // replayed history from `project.switch ... resumeSeq:{}` — which carries
  // the session's OLD turns — can be told apart from this turn's frames.
  let myTurn = 't_' + randomBytes(8).toString('hex')
  let turnId = null
  let gotSessionId = sessionId || null

  const push = (ev) => { try { onEvent?.(ev) } catch {} }
  let onEvent = null

  const finish = (fn, arg) => {
    if (settled) return
    settled = true
    clearInterval(pingTimer)
    clearTimeout(idleTimer)
    clearTimeout(hardTimer)
    try { ws?.close() } catch {}
    fn(arg)
  }
  const fail = (err) => finish(rejectDone, err)
  const succeed = () => finish(resolveDone, { sessionId: gotSessionId, text: acc.text, thinking: acc.thinking, turnId, sessionTokens: acc.sessionTokens, ctxFull: acc.ctxFull === true })

  const armIdle = () => {
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => fail(httpError(504, 'Step Studio 5 分钟没有输出（idle timeout）')), 300_000)
    idleTimer.unref?.()
  }
  let pingTimer = setInterval(() => { try { ws?.send?.(JSON.stringify({ type: 'ping' })) } catch {} }, 25_000)
  pingTimer.unref?.()
  let idleTimer = null
  let hardTimer = setTimeout(() => fail(httpError(504, 'Step Studio 回合超时（15 分钟）')), 900_000)
  hardTimer.unref?.()

  const onAbort = () => {
    try {
      if (ws?.readyState === 1) {
        ws.send(JSON.stringify({ type: 'chat.interrupt', projectId, ...(gotSessionId ? { sessionId: gotSessionId } : {}) }))
      }
    } catch {}
    fail(httpError(499, '请求已取消'))
  }
  signal?.addEventListener?.('abort', onAbort, { once: true })

  const handleMessage = (raw) => {
    let d
    try { d = JSON.parse(raw) } catch { return }
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
        const cu = d.payload?.contextUpdate
        if (cu?.totalTokens) acc.sessionTokens = Number(cu.totalTokens) || acc.sessionTokens
        if (Number(cu?.percentage) >= 95 || (Number(cu?.maxTokens) > 0 && Number(cu?.totalTokens) / Number(cu?.maxTokens) >= 0.95)) acc.ctxFull = true
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

  const connect = () => {
    ws = new WebSocket(WS_URL, {
      headers: { cookie, 'user-agent': USER_AGENT, origin: SITE },
    })
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'project.switch', projectId, payload: { projectSwitch: { resumeSeq: {} } } }))
      setTimeout(() => {
        if (settled) return
        ws.send(
          JSON.stringify({
            type: 'chat.send',
            projectId,
            turnId: myTurn,
            ...(sessionId ? { sessionId } : {}),
            payload: { chatSend: { doc: { blocks: [{ text }] }, ...(modelId && modelId !== 'auto' ? { model: modelId } : {}) } },
            userLocale: USER_LOCALE,
          }),
        )
        armIdle()
      }, 400)
    }
    ws.onmessage = (ev) => handleMessage(typeof ev.data === 'string' ? ev.data : '')
    ws.onerror = () => { if (!settled) fail(httpError(502, 'Step Studio WebSocket 连接失败（登录态可能已过期）')) }
    ws.onclose = () => { if (!settled) fail(httpError(502, 'Step Studio WebSocket 意外断开')) }
  }
  connect()

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
      done.finally(() => { closed = true; wake?.(); wake = null })
      return {
        async next() {
          for (;;) {
            if (queue.length) return { value: queue.shift(), done: false }
            if (closed) return { done: true }
            await new Promise((r) => { wake = r })
          }
        },
      }
    },
  }
  return { events, done }
}

// ---------------------------------------------------------------- conversation pool

/**
 * conversation key -> {projectId, sessionId, model, lastFull, lastUsed, chain}
 * `chain` serializes turns on one project; `lastFull` is the user-side
 * transcript the session has already seen (the assistant's replies live in
 * the session itself, not in this text).
 */
const pool = new Map()

let startupSweepDone = false

function poolGet(key) {
  const s = pool.get(key)
  if (s) s.lastUsed = Date.now()
  return s
}
function trimPool(cookie, maxProjects) {
  while (pool.size > maxProjects) {
    let oldest = null
    for (const [k, v] of pool) if (!oldest || v.lastUsed < oldest[1].lastUsed) oldest = [k, v]
    if (!oldest) break
    pool.delete(oldest[0])
    deleteProject(cookie, oldest[1].projectId) // best-effort cleanup on the site
  }
}

// ---------------------------------------------------------------- plugin

export const StepXAuthPlugin = async (_input, options) => {
  const persona = options?.persona !== false
  const maxProjects = Number(options?.maxProjects) > 0 ? Number(options.maxProjects) : 8

  const accountModels = async (provider, context) => {
    const auth = context?.auth ?? (await context?.getAuth?.().catch(() => null))
    const cookie = auth?.key
    if (!cookie) return provider?.models ?? FALLBACK_MODELS
    const live = await fetchAccountModels(cookie).catch(() => null)
    if (!live) return provider?.models ?? FALLBACK_MODELS
    for (const [id, m] of Object.entries(live)) {
      const prev = provider?.models?.[id]
      if (prev?.limit) m.limit = prev.limit
    }
    return live
  }

  const browserLogin = () => chromeSignIn({ chromePath: options?.chromePath })

  return {
    config: async (cfg) => {
      cfg.provider ??= {}
      cfg.provider[PROVIDER] ??= {
        name: 'Step Studio (stepx.com)',
        npm: '@ai-sdk/openai-compatible',
        api: SITE,
        models: FALLBACK_MODELS,
      }
    },

    provider: { id: PROVIDER, models: accountModels },

    auth: {
      provider: PROVIDER,
      methods: [
        { type: 'oauth', label: '浏览器登录（Step Studio 账号）', authorize: browserLogin },
      ],

      loader: async (getAuth) => {
        const auth = await getAuth()
        const initialCookie = (auth?.key ?? '').trim()
        if (!initialCookie) return {}

        // the site rotates session cookies; keep the live one and persist it
        // back into magpie's auth store so a restart keeps working
        let liveCookie = initialCookie
        const client = _input?.client ?? null
        onCookieRefresh = (next) => {
          liveCookie = next
          try {
            client?.auth?.set?.({
              path: { id: PROVIDER },
              body: { type: 'api', key: next, accountId: auth?.accountId, expires: 0, metadata: auth?.metadata ?? { login: 'browser' } },
            })?.catch?.(() => {})
          } catch {}
        }

        // once per process: sweep stale magpie-* projects so the account doesn't
        // hit the studio's concurrent-sandbox ceiling (project accumulation across
        // restarts); only projects untouched for 2h+ are removed
        if (!startupSweepDone) {
          startupSweepDone = true
          ;(async () => {
            try {
              const r = await api(initialCookie, '/projects')
              const cutoff = Date.now() - 2 * 3600_000
              for (const p of r.json?.projects ?? []) {
                if (!/^magpie-/.test(String(p?.name ?? ''))) continue
                const ts = Date.parse(p?.updatedAt ?? '') || 0
                if (ts && ts < cutoff) await deleteProject(initialCookie, p.id)
              }
            } catch {}
          })()
        }

        return {
          baseURL: SITE + '/v1', // placeholder; our fetch ignores it

          async fetch(_input, init) {
            const cookie = liveCookie
            const source = typeof init?.body === 'string' ? init.body : new TextDecoder().decode(init?.body ?? '')
            let payload
            try { payload = JSON.parse(source) } catch { payload = {} }
            const catalog = await modelCatalog(cookie)
            const askedModel = resolveModelId(payload.model, catalog)
            const servedName = payload.model || askedModel
            const stream = payload.stream !== false
            const wantUsage = payload?.stream_options?.include_usage === true
            const id = `chatcmpl-stepx-${randomUUID().replace(/-/g, '').slice(0, 24)}`
            const created = Math.floor(Date.now() / 1000)

            const flat = flattenMessages(payload.messages ?? [])
            if (!flat.trim()) {
              return Response.json(
                { error: { type: 'invalid_request_error', code: 400, message: 'messages 为空' } },
                { status: 400 },
              )
            }
            const key = conversationKey(flat, askedModel)

            /**
             * One request = one turn. The conversation state lives in
             * `pool`; `lastFull` is the user-side transcript the Studio
             * session has already seen (preamble excluded), so an
             * append-only agent history continues with just the delta.
             */
            async function* run() {
              let st = poolGet(key)
              // serialize both the decision and the send: a queued request must
              // see the session state the previous request left behind
              const prev = (st?.chain ?? Promise.resolve()).catch(() => {})
              let release
              const gate = new Promise((r) => { release = r })
              if (st) st.chain = prev.then(() => gate)
              await prev
              try {
                if (!st || st.exhausted || !flat.startsWith(st.lastFull)) {
                  // new conversation (or history rewritten / context exhausted):
                  // clean project, full flatten, fresh tool protocol
                  const projectId = await createProject(cookie, askedModel, `magpie-${askedModel}-${key.slice(0, 8)}`)
                  st = { projectId, sessionId: null, model: askedModel, lastFull: '', lastUsed: Date.now(), chain: gate }
                  pool.set(key, st)
                  trimPool(cookie, maxProjects)
                } else if (st.model !== askedModel) {
                  await setProjectModel(cookie, st.projectId, askedModel)
                  st.model = askedModel
                }
                // tool protocol: injected on the first turn, re-sent only when
                // the toolset changes (the Studio session remembers it)
                const tools = Array.isArray(payload.tools) ? payload.tools.filter((t) => functionOf(t)?.name) : []
                const tKey = toolsHashKey(tools, payload.tool_choice)
                let toolBlock = ''
                if (tools.length || payload.tool_choice === 'none') {
                  if (st.lastFull === '' || st.toolsKey !== tKey) {
                    toolBlock = (st.lastFull === '' ? '' : '【工具列表更新】\n') + toolPreamble(tools, payload.tool_choice) + '\n\n---\n\n'
                  }
                }
                const sendText =
                  st.lastFull === ''
                    ? (persona ? PREAMBLE + '\n\n---\n\n' : '') + toolBlock + flat
                    : toolBlock + (persona ? REMINDER + '\n\n' : '') + deltaContinuation(st.lastFull, flat)
                const oneTurn = async function* (text) {
                  const turn = chatTurn({
                    cookie,
                    projectId: st.projectId,
                    sessionId: st.sessionId ?? undefined,
                    text,
                    modelId: askedModel,
                    signal: init?.signal,
                  })
                  const out = []
                  let wake = null
                  let pumpErr = null
                  let closedRelay = false
                  let hadOutput = 0
                  const put = (ev) => {
                    if (ev.content) hadOutput += ev.content.length
                    else if (ev.reasoning) hadOutput += ev.reasoning.length
                    else if (ev.toolCall) hadOutput += 1
                    out.push(ev)
                    wake?.()
                    wake = null
                  }
                  const pump = (async () => {
                    const parser = new ToolStreamParser(put)
                    try {
                      for await (const ev of turn.events) {
                        if (ev.content !== undefined) parser.push(ev.content)
                        else put(ev)
                      }
                      parser.end()
                    } catch (e) {
                      pumpErr = e
                    } finally {
                      closedRelay = true
                      wake?.()
                      wake = null
                    }
                  })()
                  for (;;) {
                    while (out.length) yield out.shift()
                    if (closedRelay) break
                    await new Promise((r) => { wake = r })
                  }
                  await pump.catch(() => {})
                  if (pumpErr) throw pumpErr
                  const result = await turn.done
                  return { result, hadOutput: hadOutput > 0 }
                }
                let { result, hadOutput } = yield* oneTurn(sendText)
                if (!hadOutput) {
                  // 模型偶发整轮空回复：同会话补问一轮
                  const retry = yield* oneTurn('（你上一条回复为空，请完整地重新回答上一条消息。）')
                  result = retry.result
                }
                if (result.ctxFull) st.exhausted = true // next request on this conversation starts a fresh project
                st.sessionId = result.sessionId ?? st.sessionId
                st.model = askedModel
                st.toolsKey = tKey
                st.lastFull = flat
                // usage: session context from context.update + completion estimate
                const outChars = (result.text?.length ?? 0) + (result.thinking?.length ?? 0)
                const completionTokens = Math.max(1, Math.round(outChars / 2))
                const promptTokens = Math.max(0, (result.sessionTokens ?? 0) - completionTokens)
                yield { usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens } }
              } finally {
                release()
              }
            }

            if (!stream) {
              let text = ''
              let thinking = ''
              const toolCalls = []
              let usage = null
              try {
                for await (const ev of run()) {
                  if (ev.content) text += ev.content
                  if (ev.reasoning) thinking += ev.reasoning
                  if (ev.toolCall) toolCalls.push(ev.toolCall)
                  if (ev.usage) usage = ev.usage
                }
              } catch (e) {
                return errorResponse(e)
              }
              const message = { role: 'assistant', content: text || (toolCalls.length ? null : '') }
              if (thinking) message.reasoning_content = thinking
              if (toolCalls.length)
                message.tool_calls = toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } }))
              const finish = toolCalls.length ? 'tool_calls' : 'stop'
              return Response.json({ id, object: 'chat.completion', created, model: servedName, choices: [{ index: 0, message, finish_reason: finish }], ...(usage ? { usage } : {}) })
            }

            return sseResponse(id, created, servedName, run(), { wantUsage })
          },
        }
      },
    },
  }
}

function deltaContinuation(lastFull, flat) {
  const delta = flat.slice(lastFull.length).replace(/^\s+/, '')
  return delta
    ? '（接上一轮，以下是新消息/工具结果，继续按规则回答）\n\n' + delta
    : '（重试）请重新给出对上一条消息的回答。'
}

function errorResponse(e) {
  const status = e?.status && Number.isInteger(e.status) ? e.status : 502
  const headers = { 'x-magpie-sign-in': status === 401 ? 'expired' : 'kept' }
  return Response.json({ error: { type: status === 401 ? 'authentication_error' : 'upstream_error', code: status, message: e?.message ?? String(e) } }, { status, headers })
}

// ---------------------------------------------------------------- chrome sign-in

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA ? process.env.LOCALAPPDATA + '/Google/Chrome/Application/chrome.exe' : '',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean)

function findChrome(explicit) {
  if (explicit && fs.existsSync(explicit)) return explicit
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH
  for (const p of CHROME_CANDIDATES) if (fs.existsSync(p)) return p
  return null
}

/** Minimal CDP JSON-RPC over the browser websocket. */
function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl)
  let nextId = 1
  const pending = new Map()
  ws.onmessage = (ev) => {
    let d
    try { d = JSON.parse(ev.data) } catch { return }
    if (d.id && pending.has(d.id)) {
      pending.get(d.id)(d)
      pending.delete(d.id)
    }
  }
  const ready = new Promise((res, rej) => {
    ws.onopen = () => res()
    ws.onerror = () => rej(new Error('CDP WebSocket 连接失败'))
  })
  return {
    ready,
    send(method, params = {}) {
      const id = nextId++
      return new Promise((res) => {
        pending.set(id, res)
        ready.then(() => ws.send(JSON.stringify({ id, method, params })))
        setTimeout(() => { if (pending.has(id)) { pending.get(id)({ error: { message: 'cdp timeout' } }); pending.delete(id) } }, 15_000).unref?.()
      })
    },
    close() { try { ws.close() } catch {} },
  }
}

async function harvestStepxCookies(devUrl) {
  const conn = cdp(devUrl)
  await conn.ready
  try {
    const r = await conn.send('Storage.getCookies')
    const cookies = r?.result?.cookies ?? []
    const jar = {}
    for (const c of cookies) {
      if (/(^|\.)stepx\.com$/i.test(c.domain) && !c.name.startsWith('__')) jar[c.name] = c.value
    }
    if (!jar._uticket || !jar._ckk) return null
    const header = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ')
    const me = await api(header, '/identity/me').catch(() => null)
    if (me?.status !== 200 || !me.json?.userId) return null
    return { cookie: header, userId: me.json.userId, nickname: me.json.nickname ?? '' }
  } finally {
    conn.close()
  }
}

function chromeSignIn({ chromePath } = {}) {
  return {
    url: '',
    instructions:
      '将打开一个 Chrome 窗口访问 studio.stepx.com，请在里面完成登录（扫码或手机号）。登录成功后窗口会自动关闭并回到 magpie；无需其他操作，10 分钟内有效。',
    method: 'auto',
    async callback() {
      const exe = findChrome(chromePath)
      if (!exe)
        return {
          type: 'failed',
          error: '未找到 Chrome/Edge。请安装 Chrome，或在插件 options 里设置 chromePath（magpie plugin options stepx \'{"chromePath":"C:/path/to/chrome.exe"}\'）',
        }

      const port = 30000 + Math.floor(Math.random() * 20000)
      const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'stepx-login-'))
      const child = spawn(exe, [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${profile}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-gpu',
        '--window-size=1100,800',
        SITE + '/',
      ], { stdio: 'ignore', detached: false })

      const kill = () => { try { child.kill() } catch {}; try { fs.rmSync(profile, { recursive: true, force: true }) } catch {} }
      const deadline = Date.now() + 600_000
      try {
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 2500))
          const v = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json()).catch(() => null)
          if (!v?.webSocketDebuggerUrl) continue
          const got = await harvestStepxCookies(v.webSocketDebuggerUrl).catch(() => null)
          if (got) {
            try { await cdp(v.webSocketDebuggerUrl).then(async (c) => { await c.ready; await c.send('Browser.close').catch?.(() => {}); c.close() }) } catch {}
            await new Promise((r) => setTimeout(r, 800))
            kill()
            return {
              type: 'success',
              key: got.cookie,
              accountId: got.nickname || got.userId,
              metadata: { userId: got.userId, nickname: got.nickname, login: 'browser' },
            }
          }
        }
        return { type: 'failed', error: '登录超时（10 分钟未完成）' }
      } finally {
        kill()
      }
    },
  }
}

// Test surface (bun test / node --test): pure helpers live here.
export const _internal = {
  flattenMessages,
  conversationKey,
  deltaContinuation,
  resolveModelId,
  FALLBACK_MODELS,
  PREAMBLE,
  REMINDER,
  toolPreamble,
  parseToolCallBody,
  ToolStreamParser,
}

// OpenCode v1 form: with default { id, server } the host takes only
// `server` as the plugin and never iterates the module's other exports.
export default { id: PROVIDER, server: StepXAuthPlugin }
