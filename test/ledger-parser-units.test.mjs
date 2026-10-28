// Focused unit tests: ledger determinism + UTF-16-safe elision; parser
// chunk-split invariance (every legal and illegal stream must produce the
// same events regardless of how the bytes are sharded).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildLedger, conversationKey, elideMiddle } from '../src/ledger.mjs'
import { createToolContext } from '../src/tools.mjs'
import { ToolStreamParser } from '../src/parser.mjs'

const TOOL = {
  type: 'function',
  function: {
    name: 'run',
    parameters: { type: 'object', properties: { cmd: { type: 'string' }, n: { type: 'integer' } }, required: ['cmd'] },
  },
}

test('ledger: deterministic serialization; verbatim whitespace, ids, empty receipts', () => {
  const messages = [
    { role: 'system', content: 'sys  prompt' },
    { role: 'user', content: 'line1\n\n  indented()' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'run', arguments: '{"cmd": "ls  -la"}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: '' },
    { role: 'tool', tool_call_id: 'c2', content: 'later receipt' },
  ]
  const a = buildLedger(messages).text
  const b = buildLedger(JSON.parse(JSON.stringify(messages))).text
  assert.equal(a, b, 'identical history -> identical bytes')
  assert.ok(a.includes('[tool_call id=c1 name=run]\n{"cmd": "ls  -la"}'), 'original arguments JSON verbatim')
  assert.ok(a.includes('[tool_result id=c1]'), 'receipt header keeps the id')
  assert.ok(a.includes('[tool_result id=c2]\nlater receipt'), 'out-of-order receipt keeps its own id')
  assert.ok(a.includes('  indented()'), 'code whitespace not trimmed')
  const key1 = conversationKey(buildLedger(messages).entries, 'auto')
  const key2 = conversationKey(buildLedger(messages).entries, 'auto')
  assert.equal(key1, key2, 'pure conversation key is stable')
})

test('elideMiddle: never splits a surrogate pair; marks the lost range', () => {
  const head = 'h'.repeat(300) + '😀' + 'h'.repeat(98)
  const tail = 't'.repeat(200)
  const text = head + 'x'.repeat(4300) + tail
  const out = elideMiddle(text, { head: 400, tail: 200 })
  assert.ok(out.includes('丢失第'), 'lost range is labeled')
  for (let i = 0; i < out.length - 1; i++) {
    const u = out.charCodeAt(i)
    if (u >= 0xd800 && u <= 0xdbff) {
      assert.ok(out.charCodeAt(i + 1) >= 0xdc00 && out.charCodeAt(i + 1) <= 0xdfff, `lone high surrogate at ${i}`)
    }
  }
  // the emoji pair survives intact in the kept head
  assert.ok(out.includes('😀'))
})

function collect(parser, chunks, { final = true } = {}) {
  const events = []
  const p = new ToolStreamParser((ev) => events.push(ev), parser)
  for (const c of chunks) p.push(c)
  if (final) p.end()
  return events
}

function allSplits(s) {
  const out = []
  for (let i = 1; i < s.length; i++) out.push([s.slice(0, i), s.slice(i)])
  return out
}

function canonical(events) {
  const merged = []
  for (const e of events) {
    if (e.toolCall) merged.push({ toolCall: { name: e.toolCall.name, arguments: e.toolCall.arguments } })
    else if (e.protocolError) merged.push({ protocolError: e.protocolError.code })
    else if (merged.length && typeof merged[merged.length - 1].content === 'string') merged[merged.length - 1].content += e.content ?? ''
    else merged.push({ content: e.content ?? '' })
  }
  return JSON.stringify(merged)
}

test('parser chunk-split invariance: legal JSON call identical at every split', () => {
  const ctx = createToolContext({ tools: [TOOL] })
  const s = 'before <fn:invoke>{"name": "m_run", "arguments": {"cmd": "ls -la", "n": 3}}</fn:invoke> after'
  const whole = canonical(collect(ctx, [s]))
  for (const chunks of allSplits(s)) {
    assert.equal(canonical(collect(ctx, chunks)), whole, `split at ${chunks[0].length}`)
  }
  const events = collect(ctx, [s])
  assert.deepEqual(events.filter((e) => e.toolCall).map((e) => [e.toolCall.name, e.toolCall.arguments]), [
    ['run', '{"cmd":"ls -la","n":3}'],
  ])
})

test('parser chunk-split invariance: illegal stream (unterminated) fails closed at every split', () => {
  const ctx = createToolContext({ tools: [TOOL] })
  const s = 'text <fn:invoke>{"name": "m_run", "arguments": {"cmd": "x"}}'
  const whole = canonical(collect(ctx, [s]))
  assert.ok(whole.includes('unterminated_call'))
  for (const chunks of allSplits(s)) {
    assert.equal(canonical(collect(ctx, chunks)), whole, `illegal split at ${chunks[0].length}`)
  }
})

test('parser raw form: exact whitespace preserved per schema; close-tag conflict rejected', () => {
  const ctx = createToolContext({ tools: [TOOL] })
  const good = 'X<fn:invoke name="m_run"><cmd>  keep\n  spacing  </cmd><n>7</n></fn:invoke>Y'
  const events = collect(ctx, [good])
  const call = events.find((e) => e.toolCall)?.toolCall
  assert.ok(call, 'raw call parsed')
  assert.equal(JSON.parse(call.arguments).cmd, '  keep\n  spacing  ', 'schema string keeps exact whitespace')
  assert.equal(JSON.parse(call.arguments).n, 7, 'schema integer typed')

  const conflict = '<fn:invoke name="m_run"><cmd>grep -v "</cmd-mid></fn:invoke>'
  const bad = collect(ctx, [conflict.replace('</cmd-mid>', '</fn:invoke> not real </cmd>')])
  const err = bad.find((e) => e.protocolError)?.protocolError
  assert.equal(err?.code, 'raw_tag_conflict', 'embedded close tag -> explicit reject')
  assert.ok(!bad.some((e) => e.toolCall), 'no partial call on conflict')
})
