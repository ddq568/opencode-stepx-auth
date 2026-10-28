// Canonical tool-call stream parser.
//
// Contract (fail closed):
// - only two canonical forms are recognized — everything the preamble
//   teaches, and nothing else (no fuzzy triggers, no DSML variants, no
//   bracket forms, no code-fence tolerance):
//     B (canonical):  <fn:invoke>{"name": "...", "arguments": {...}}</fn:invoke>
//     A (experimental): <fn:invoke name="..."><key>value</key>...</fn:invoke>
// - a parse failure (bad JSON / missing name / unknown tool / unterminated /
//   ambiguous / raw close-tag conflict / schema violation) emits ONE typed
//   { protocolError } event and never leaks the malformed region as content,
//   never emits a partial call;
// - the model's name must resolve through the declaration table (wire name
//   or exact original); there is no parameter-shape or "bash" guessing;
// - JSON is parsed strictly: no repair that could change shell semantics;
// - the parser is chunk-split invariant: any way of cutting the same byte
//   stream into pushes yields the same event sequence.

import { randomBytes } from 'node:crypto'
import { resolveToolName, validateJsonArguments, rawArgsToArguments } from './tools.mjs'
import { PROTOCOL } from './errors.mjs'

export const OPEN_TAG = '<fn:invoke'
export const CLOSE_TAG = '</fn:invoke>'
const OPEN_RE = /^<fn:invoke(?:[ \t]+name[ \t]*=[ \t]*("([^"]*)"|'([^']*)'))?[ \t]*>/
const RAW_BLOCK_RE = /^[ \t\r\n]*<([A-Za-z_][A-Za-z0-9_-]*)>([\s\S]*?)<\/\1>/

function snippet(s, max = 120) {
  const t = String(s).replace(/\s+/g, ' ').trim()
  return t.length > max ? t.slice(0, max) + '…' : t
}

export class ToolStreamParser {
  /**
   * @param emit sink for {content}|{toolCall}|{protocolError} events
   * @param ctx tool context from createToolContext (or null: parser unused)
   */
  constructor(emit, ctx) {
    this.emit = emit
    this.ctx = ctx
    this.buf = ''
    this.state = 'idle' // idle | opener | json | close | raw
    this.openName = null // raw-form name attribute (may be '')
    this.calls = 0
    this.errors = 0
  }

  push(chunk) {
    this.buf += chunk
    this.#run(false)
  }

  end() {
    this.#run(true)
    if (this.state === 'idle' && this.buf) {
      this.emit({ content: this.buf })
      this.buf = ''
    }
  }

  #error(code, message, detail) {
    this.errors++
    this.emit({ protocolError: { code, message, ...(detail !== undefined ? { detail } : {}) } })
    // fail closed: drop everything buffered, restart idle scanning
    this.buf = ''
    this.state = 'idle'
    this.openName = null
    this.pending = undefined
  }

  #emitCall(originalName, argsObject) {
    this.calls++
    this.emit({
      toolCall: {
        index: this.calls - 1,
        id: 'call_stepx_' + this.calls + '_' + randomBytes(6).toString('hex'),
        name: originalName,
        arguments: JSON.stringify(argsObject ?? {}),
      },
    })
  }

  #run(final) {
    for (;;) {
      if (this.state === 'idle') {
        const idx = this.buf.indexOf(OPEN_TAG)
        if (idx === -1) {
          // hold back a tail that could still become an opener
          let safe = this.buf.length
          if (!final) {
            const maxHold = OPEN_TAG.length - 1
            for (let keep = Math.min(this.buf.length, maxHold); keep > 0; keep--) {
              if (OPEN_TAG.startsWith(this.buf.slice(this.buf.length - keep))) {
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
        if (idx > 0) {
          this.emit({ content: this.buf.slice(0, idx) })
          this.buf = this.buf.slice(idx)
        }
        this.state = 'opener'
        continue
      }
      if (this.state === 'opener') {
        const m = this.buf.match(OPEN_RE)
        if (m) {
          this.buf = this.buf.slice(m[0].length)
          if (m[1] !== undefined) {
            this.openName = m[2] !== undefined ? m[2] : m[3]
            this.state = 'raw'
          } else {
            this.openName = null
            this.state = 'json'
          }
          continue
        }
        const gt = this.buf.indexOf('>')
        if (gt !== -1) {
          // starts with <fn:invoke but is not the canonical opener
          this.#error(PROTOCOL.MALFORMED_OPENER, `非规范的 <fn:invoke> 起始标记被拒绝（只支持 <fn:invoke> 或 <fn:invoke name="...">）`, snippet(this.buf.slice(0, gt + 1)))
          return
        }
        if (final) {
          this.#error(PROTOCOL.UNTERMINATED_CALL, '起始标记未闭合就到了流末尾', snippet(this.buf))
          return
        }
        if (this.buf.length > OPEN_TAG.length + 80) {
          this.#error(PROTOCOL.MALFORMED_OPENER, '<fn:invoke> 后跟了过长的非规范内容', snippet(this.buf.slice(0, 100)))
          return
        }
        return // wait for the opener to complete
      }
      if (this.state === 'json') {
        const lead = this.buf.match(/^[ \t\r\n]*/)
        const bodyStart = lead[0].length
        if (bodyStart >= this.buf.length) {
          if (final) {
            this.#error(PROTOCOL.UNTERMINATED_CALL, '<fn:invoke> 内没有 JSON 正文')
            return
          }
          return // payload not started yet
        }
        const c = this.buf[bodyStart]
        if (c !== '{') {
          this.#error(
            PROTOCOL.AMBIGUOUS_CALL,
            '<fn:invoke> 正文不是 JSON（不带 name 属性时只接受格式B JSON）；格式A 必须带 name="..." 属性',
            snippet(this.buf),
          )
          return
        }
        const obj = scanJSONObject(this.buf, bodyStart, final)
        if (obj.need) return // wait for more
        if (!obj.raw) {
          this.#error(PROTOCOL.UNTERMINATED_CALL, 'JSON 正文未闭合（不修复、不输出部分调用）')
          return
        }
        this.buf = this.buf.slice(obj.end)
        this.pending = obj.raw
        this.state = 'close'
        continue
      }
      if (this.state === 'close') {
        // expect optional whitespace then the close tag
        const trimmed = this.buf.replace(/^[ \t\r\n]+/, '')
        if (trimmed.startsWith(CLOSE_TAG)) {
          const raw = this.pending
          this.buf = trimmed.slice(CLOSE_TAG.length)
          this.pending = undefined
          this.state = 'idle'
          this.#finishJsonCall(raw)
          continue
        }
        if (!trimmed) {
          if (final) {
            this.#error(PROTOCOL.UNTERMINATED_CALL, 'JSON 之后缺少 </fn:invoke> 闭合标记（不输出部分调用）')
            return
          }
          return // only whitespace so far; close may follow
        }
        if (final) {
          this.#error(PROTOCOL.AMBIGUOUS_CALL, 'JSON 之后缺少 </fn:invoke> 闭合标记（或混入了其他内容）', snippet(trimmed))
          return
        }
        // could still be a split close tag; bound the wait
        if (trimmed.length > CLOSE_TAG.length + 32) {
          this.#error(PROTOCOL.AMBIGUOUS_CALL, 'JSON 之后出现多余内容且未见闭合标记', snippet(trimmed))
          return
        }
        return
      }
      if (this.state === 'raw') {
        const closeIdx = this.buf.indexOf(CLOSE_TAG)
        if (closeIdx === -1) {
          if (final) {
            this.#error(PROTOCOL.UNTERMINATED_CALL, '格式A 调用缺少 </fn:invoke> 闭合标记（不输出部分调用）')
            return
          }
          if (this.buf.length > 262144) {
            this.#error(PROTOCOL.UNTERMINATED_CALL, '格式A 调用正文过长且未见闭合标记')
            return
          }
          return // wait for the close tag
        }
        const body = this.buf.slice(0, closeIdx)
        this.buf = this.buf.slice(closeIdx + CLOSE_TAG.length)
        const name = this.openName
        this.state = 'idle'
        this.openName = null
        this.#finishRawCall(name, body)
        continue
      }
      return // unreachable
    }
  }

  // JSON form (format B): strict parse, strict schema validation.
  #finishJsonCall(raw) {
    let obj
    try {
      obj = JSON.parse(raw)
    } catch (e) {
      this.#error(PROTOCOL.BAD_JSON, `JSON 解析失败（不修复坏 JSON）：${e.message}`, snippet(raw))
      return
    }
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
      this.#error(PROTOCOL.BAD_JSON, '调用正文必须是 JSON object', snippet(raw))
      return
    }
    if (typeof obj.name !== 'string' || !obj.name) {
      this.#error(PROTOCOL.MISSING_NAME, 'JSON 调用缺少 "name" 字段（或不是非空字符串）', snippet(raw))
      return
    }
    const res = resolveToolName(this.ctx, obj.name)
    if (res.error) {
      this.#error(res.error, res.message, snippet(obj.name))
      return
    }
    if (obj.arguments !== undefined && obj.arguments !== null && (typeof obj.arguments !== 'object' || Array.isArray(obj.arguments))) {
      this.#error(PROTOCOL.SCHEMA_VIOLATION, `工具 ${res.name} 的 arguments 必须是 JSON object`, snippet(String(obj.arguments)))
      return
    }
    const v = validateJsonArguments(this.ctx, res.name, obj.arguments)
    if (v.error) {
      this.#error(v.code, v.error)
      return
    }
    this.#emitCall(res.name, v.args)
  }

  // Raw form (format A): name from the opener attribute only; strict
  // contiguous <key>value</key> blocks; leftover text (e.g. an embedded
  // </fn:invoke> inside a value) is an explicit conflict, never a partial call.
  #finishRawCall(name, body) {
    const attr = name
    if (!attr) {
      this.#error(
        PROTOCOL.AMBIGUOUS_CALL,
        '<fn:invoke> 开头不带 name 却是参数块（格式A 必须带 name 属性）；不做参数形状猜测路由',
        snippet(body),
      )
      return
    }
    const res = resolveToolName(this.ctx, attr)
    if (res.error) {
      this.#error(res.error, res.message, snippet(attr))
      return
    }
    const pairs = []
    let pos = 0
    for (;;) {
      const m = body.slice(pos).match(RAW_BLOCK_RE)
      if (!m) break
      pairs.push([m[1], m[2]])
      pos += m[0].length
    }
    const rest = body.slice(pos)
    if (pairs.length === 0 || rest.trim()) {
      this.#error(
        PROTOCOL.RAW_TAG_CONFLICT,
        '格式A 参数块不连续或与闭合标记冲突（例如参数原文里出现了 </fn:invoke>）：整个调用被明确拒绝，请改用 JSON 格式（格式B）',
        snippet(rest || body),
      )
      return
    }
    const v = rawArgsToArguments(this.ctx, res.name, pairs)
    if (v.error) {
      this.#error(v.code, v.error)
      return
    }
    this.#emitCall(res.name, v.args)
  }
}

/** Balanced-brace scan from `start`; string/escape aware. Returns
 * { raw, end } | { need: true } | { raw: null } (unrecoverable at final). */
function scanJSONObject(s, start, final) {
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < s.length; i++) {
    const c = s[i]
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
      if (depth === 0) return { raw: s.slice(start, i + 1), end: i + 1 }
    }
  }
  return final ? { raw: null } : { need: true }
}
