// Normalized message ledger: the only place OpenAI chat messages are turned
// into the deterministic transcript the Studio session sees.
//
// Contract (README「消息 ledger」节):
// - structure comes ONLY from message fields (role / content / tool_calls /
//   tool_call_id); nothing is inferred by scanning text for special tags;
// - content is preserved verbatim: no trim, no marker rewriting — code
//   indentation and whitespace survive byte-for-byte;
// - assistant tool_calls keep their ids and the ORIGINAL arguments JSON
//   string; tool receipts keep their tool_call_id, so same-name parallel
//   calls and out-of-order receipts stay precisely associated; empty
//   receipts stay empty (never dropped, never embellished);
// - content that is not text (images etc.) is a typed 400, never a silently
//   degraded "[image omitted]";
// - serialization is deterministic: identical history -> identical bytes.
import { createHash } from 'node:crypto'
import { httpError, PROTOCOL } from './errors.mjs'

const ROLES = new Set(['system', 'developer', 'user', 'assistant', 'tool'])

// Header fields must stay on one line; content itself is never rewritten.
const HDR = (s) => String(s).replace(/\s+/g, ' ')

function textParts(content, role, index) {
  if (typeof content === 'string') return content
  if (content === null) return ''
  if (Array.isArray(content)) {
    let out = ''
    for (let i = 0; i < content.length; i++) {
      const part = content[i]
      if (part && part.type === 'text' && typeof part.text === 'string') out += part.text
      else
        throw httpError(
          400,
          `messages[${index}]（role=${role}）第 ${i} 个 content part 不是文本：本插件只支持 {"type":"text"}，不支持图片/音频等非文本输入`,
          { code: PROTOCOL.UNSUPPORTED_CONTENT },
        )
    }
    return out
  }
  throw httpError(400, `messages[${index}]（role=${role}）content 类型不受支持（需要 string / null / text part 数组）`, {
    code: PROTOCOL.INVALID_REQUEST,
  })
}

export const TOOL_ELIDE_HEAD = 16_000 // chars kept from the head of one tool result
export const TOOL_ELIDE_TAIL = 4_000 // chars kept from the tail
export const ELIDE_HEADROOM = 4_096 // only elide when over head+tail by this much

/**
 * Unicode-safe middle elision for oversized tool results. Only used when the
 * account opted in via options.elideToolResults; the marker states the exact
 * lost character range. Cuts land on code-point boundaries (never inside a
 * surrogate pair). system/user/assistant/skill content is never elided.
 */
export function elideMiddle(text, { head = TOOL_ELIDE_HEAD, tail = TOOL_ELIDE_TAIL } = {}) {
  if (text.length <= head + tail + ELIDE_HEADROOM) return text
  // UTF-16 code-unit cuts that never split a surrogate pair: a pair spans
  // [high, low]; a cut between them is moved so the pair stays whole.
  const isHigh = (u) => u >= 0xd800 && u <= 0xdbff
  const isLow = (u) => u >= 0xdc00 && u <= 0xdfff
  let headCut = head
  if (headCut > 0 && headCut < text.length && isHigh(text.charCodeAt(headCut - 1)) && isLow(text.charCodeAt(headCut))) headCut--
  let tailStart = text.length - tail
  if (tailStart > headCut && tailStart < text.length && isHigh(text.charCodeAt(tailStart - 1)) && isLow(text.charCodeAt(tailStart))) tailStart++
  const omitted = tailStart - headCut
  return (
    text.slice(0, headCut) +
    `\n…[stepx: 工具结果过长已摘取，丢失第 ${headCut}–${tailStart} 字符（共 ${omitted} 字符）；需要完整内容请重新执行该工具获取]…\n` +
    text.slice(tailStart)
  )
}

/**
 * messages -> ledger entries. Throws typed 400s for unsupported shapes.
 * elideToolResults (opt-in) elides only role=tool entries, preserving the
 * receipt id and empty values.
 */
export function normalizeMessages(messages, { elideToolResults = null } = {}) {
  const entries = []
  const arr = Array.isArray(messages) ? messages : []
  for (let i = 0; i < arr.length; i++) {
    const m = arr[i]
    const role = m?.role
    if (!ROLES.has(role))
      throw httpError(400, `messages[${i}] role 不受支持：${String(role)}（支持 system/developer/user/assistant/tool）`, {
        code: PROTOCOL.INVALID_REQUEST,
      })
    const name = typeof m?.name === 'string' && m.name ? m.name : undefined
    if (role === 'assistant') {
      const content = m?.content == null ? '' : textParts(m.content, role, i)
      if (m?.tool_calls !== undefined && !Array.isArray(m.tool_calls))
        throw httpError(400, `messages[${i}] tool_calls 必须是数组`, { code: PROTOCOL.INVALID_REQUEST })
      const calls = []
      for (const tc of m?.tool_calls ?? []) {
        const id = tc?.id
        const fn = tc?.type === 'function' ? tc.function : null
        if (typeof id !== 'string' || !id)
          throw httpError(400, `messages[${i}].tool_calls[n] 缺少 string id — 工具调用必须带 id 才能与结果精确关联`, {
            code: PROTOCOL.INVALID_REQUEST,
          })
        if (!fn || typeof fn.name !== 'string' || !fn.name)
          throw httpError(400, `messages[${i}].tool_calls[id=${id}] 缺少 function.name`, {
            code: PROTOCOL.INVALID_REQUEST,
          })
        let args
        if (typeof fn.arguments === 'string') args = fn.arguments
        else if (fn.arguments === undefined || fn.arguments === null) args = ''
        else if (typeof fn.arguments === 'object') args = JSON.stringify(fn.arguments)
        else
          throw httpError(400, `messages[${i}].tool_calls[id=${id}] arguments 类型不受支持`, {
            code: PROTOCOL.INVALID_REQUEST,
          })
        calls.push({ id, name: fn.name, arguments: args })
      }
      entries.push({ role, name, content, toolCalls: calls })
    } else if (role === 'tool') {
      const id = m?.tool_call_id
      if (typeof id !== 'string' || !id)
        throw httpError(400, `messages[${i}] role=tool 缺少 tool_call_id — 结果必须回指调用 id`, {
          code: PROTOCOL.INVALID_REQUEST,
        })
      let content = m?.content == null ? '' : textParts(m.content, role, i)
      if (elideToolResults) content = elideMiddle(content, elideToolResults)
      entries.push({ role, toolCallId: id, name, content })
    } else {
      const content = m?.content == null ? '' : textParts(m.content, role, i)
      entries.push({ role, name, content })
    }
  }
  return entries
}

/** Deterministic serialization. Empty content renders as a bare header line
 * (preserving emptiness); assistant tool calls get their own blocks with the
 * original arguments JSON verbatim. */
export function serializeLedger(entries) {
  const blocks = []
  for (const e of entries) {
    const who =
      e.role === 'system'
        ? '[system]'
        : e.role === 'developer'
          ? '[developer]'
          : e.role === 'user'
            ? `[user${e.name ? ' name=' + HDR(e.name) : ''}]`
            : e.role === 'assistant'
              ? `[assistant${e.name ? ' name=' + HDR(e.name) : ''}]`
              : `[tool_result id=${HDR(e.toolCallId)}]`
    const body = e.content ?? ''
    blocks.push(body ? `${who}\n${body}` : who)
    if (e.role === 'assistant') {
      for (const c of e.toolCalls ?? []) {
        const h = `[tool_call id=${HDR(c.id)} name=${HDR(c.name)}]`
        blocks.push(c.arguments ? `${h}\n${c.arguments}` : h)
      }
    }
  }
  return blocks.join('\n\n')
}

export function buildLedger(messages, opts) {
  const entries = normalizeMessages(messages, opts)
  return { entries, text: serializeLedger(entries) }
}

export function utf8Len(s) {
  return Buffer.byteLength(String(s), 'utf8')
}

/**
 * Conversation fingerprint (pure): model id + the structured head entries
 * (system/developer blocks up to and including the first user message).
 * Operates on ledger ENTRIES, so content containing "\n\n" cannot collide
 * with block boundaries. Same input -> same key; account isolation lives in
 * the per-account runtime, not in this pure hash.
 */
export function conversationKey(entries, modelId) {
  const head = []
  let closed = false
  for (const e of entries) {
    head.push(e)
    if (e.role === 'user') {
      closed = true
      break
    }
  }
  const fp = JSON.stringify([
    modelId ?? '',
    head.map((e) => ({
      r: e.role,
      n: e.name ?? null,
      c: e.content ?? null,
      t: e.toolCallId ?? null,
      tc: e.toolCalls ?? null,
    })),
  ])
  return createHash('sha1').update(fp).digest('hex')
}
