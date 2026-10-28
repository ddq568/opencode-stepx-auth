// Schema validation contract (Ajv v8-backed) — blocker-fix suite A.
//
// Feature-addition note: the OLD suite asserted `anyOf` must be rejected.
// That described the hand-rolled allowlist's limitation, not a contract.
// This suite REPLACES that expectation: draft-07/2020-12 via Ajv 8.20.0
// with local $defs/$ref, combinators and unknown-keyword typed rejection.
// Nothing was loosened to pass tests: unknown validation keywords, foreign
// dialects, external refs and resource-cap overruns are still typed 400s,
// and coercion/mutation stay off ("001" never silently becomes 1).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createToolContext, validateJsonArguments, rawArgsToArguments } from '../src/tools.mjs'
import { assertSchemaSupported, getValidator, validatorCacheSize } from '../src/schema.mjs'

function ctxOf(schema) {
  return createToolContext({ tools: [{ type: 'function', function: { name: 'f', parameters: schema } }] })
}
const ok = (r) => assert.equal(r.error, undefined, `expected success, got ${JSON.stringify(r)}`)
const errCode = (r) => {
  assert.ok(r.error, 'expected a validation error')
  return r.code
}

test('local refs: $defs + definitions resolve document-wide; dangling local ref is a typed 400', () => {
  const defs = {
    type: 'object',
    properties: { a: { $ref: '#/$defs/s' }, b: { $ref: '#/definitions/s' } },
    required: ['a'],
    additionalProperties: false,
    $defs: { s: { type: 'string', minLength: 2 } },
    definitions: { s: { type: 'string', minLength: 2 } },
  }
  const ctx = ctxOf(defs)
  ok(validateJsonArguments(ctx, 'f', { a: 'xy', b: 'zz' }))
  assert.equal(validateJsonArguments(ctx, 'f', { a: 3 }).code, 'schema_violation')
  try {
    assertSchemaSupported({ type: 'object', properties: { z: { $ref: '#/$defs/nope' } } }, 'dangling')
    assert.fail('dangling local ref must be a declaration-time 400')
  } catch (e) {
    assert.equal(e.code, 'unsupported_tool_schema')
    assert.equal(e.status, 400)
  }
})

test('anyOf nullable unions (the MCP/Pydantic shape) validate exactly', () => {
  const nullable = { type: 'object', properties: { v: { anyOf: [{ type: 'string' }, { type: 'null' }] } }, required: ['v'] }
  const ctx = ctxOf(nullable)
  ok(validateJsonArguments(ctx, 'f', { v: null }))
  ok(validateJsonArguments(ctx, 'f', { v: 'txt' }))
  assert.equal(validateJsonArguments(ctx, 'f', { v: 1 }).code, 'schema_violation')
})

test('oneOf with an ambiguous value fails; a matching value passes', () => {
  const amb = {
    type: 'object',
    properties: { v: { oneOf: [{ type: 'string', maxLength: 3 }, { type: 'string', minLength: 2 }] } },
  }
  const ctx = ctxOf(amb)
  assert.equal(validateJsonArguments(ctx, 'f', { v: 'ab' }).code, 'schema_violation', 'matches both branches -> oneOf fails')
  ok(validateJsonArguments(ctx, 'f', { v: 'abcdef' })) // only minLength branch matches
})

test('allOf / not / if-then-else compose correctly', () => {
  const ctx = ctxOf({
    type: 'object',
    properties: {
      p: { allOf: [{ type: 'string' }, { pattern: '^a' }] },
      q: { not: { type: 'string' } },
      m: { if: { type: 'string' }, then: { maxLength: 2 }, else: { type: 'integer' } },
    },
    required: ['p', 'q'],
  })
  ok(validateJsonArguments(ctx, 'f', { p: 'abc', q: 1, m: 7 }))
  assert.equal(validateJsonArguments(ctx, 'f', { p: 'xbc', q: 1 }).code, 'schema_violation')
  assert.equal(validateJsonArguments(ctx, 'f', { p: 'abc', q: 1, m: 'abc' }).code, 'schema_violation')
})

test("no coercion: string '001' stays a string; type number rejects it (no silent type juggling)", () => {
  const s = ctxOf({ type: 'object', properties: { n: { type: 'string' } }, required: ['n'] })
  ok(validateJsonArguments(s, 'f', { n: '001' }))
  const num = ctxOf({ type: 'object', properties: { n: { type: 'number' } }, required: ['n'] })
  assert.equal(validateJsonArguments(num, 'f', { n: '001' }).code, 'schema_violation')
  ok(validateJsonArguments(num, 'f', { n: 1 }))
})

test('additionalProperties:false, pattern and numeric bounds enforce strictly', () => {
  const s = ctxOf({
    type: 'object',
    properties: { cmd: { type: 'string', pattern: '^[a-z]+' }, port: { type: 'integer', minimum: 1, maximum: 65535 } },
    required: ['cmd'],
    additionalProperties: false,
  })
  ok(validateJsonArguments(s, 'f', { cmd: 'ls -la', port: 8080 }))
  assert.equal(validateJsonArguments(s, 'f', { cmd: 'ls', extra: 1 }).code, 'schema_violation')
  assert.equal(validateJsonArguments(s, 'f', { cmd: 'LS' }).code, 'schema_violation')
  assert.equal(validateJsonArguments(s, 'f', { cmd: 'ls', port: 99999 }).code, 'schema_violation')
})

test('foreign dialects and unknown validation keywords are typed 400s, never silent ignores', () => {
  for (const bad of [
    { $schema: 'http://json-schema.org/draft-04/schema#', type: 'object' },
    { $schema: 'https://json-schema.org/draft/2019-09/schema', type: 'object' },
    { type: 'object', properties: { p: { type: 'string', nullable: true } } }, // OpenAPI-ism, not JSON Schema
    { type: 'object', properties: { p: { type: 'string', hasSecretFlag: true } } },
    { type: 'object', properties: { a: { $ref: 'http://evil.example/x.json' } } },
    { type: 'object', properties: { a: { $ref: '../relative.json' } } },
  ]) {
    try {
      assertSchemaSupported(bad, 'bad')
      assert.fail(`should have rejected: ${JSON.stringify(bad).slice(0, 60)}`)
    } catch (e) {
      assert.equal(e.code, 'unsupported_tool_schema')
      assert.equal(e.status, 400)
    }
  }
})

test('2020-12 dialect: prefixItems/tuple validate; draft-07 rejects prefixItems as unknown', () => {
  assertSchemaSupported(
    {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: { t: { prefixItems: [{ type: 'string' }, { type: 'integer' }], minItems: 2, maxItems: 2 } },
    },
    '2020',
  )
  const v = getValidator({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'array',
    prefixItems: [{ type: 'string' }, { type: 'integer' }],
    items: false,
  })
  assert.ok(v(['a', 1]))
  assert.ok(!v(['a', 'b']))
  try {
    assertSchemaSupported({ type: 'object', properties: { t: { prefixItems: [{ type: 'string' }] } } }, 'd07-prefix')
    assert.fail('draft-07 prefixItems must be unknown')
  } catch (e) {
    assert.equal(e.code, 'unsupported_tool_schema')
  }
})

test('resource bounds: extreme recursion depth, oversized schema, huge pattern -> typed 400', () => {
  let d = { type: 'object' }
  for (let i = 0; i < 60; i++) d = { type: 'object', properties: { n: d } }
  assert.throws(() => assertSchemaSupported(d, 'deep'), (e) => e.code === 'unsupported_tool_schema' && /深度超过|depth/.test(e.message))
  assert.throws(() => assertSchemaSupported({ type: 'object', properties: { p: { type: 'string', pattern: 'a'.repeat(300) } } }, 'huge-pattern'), (e) => e.code === 'unsupported_tool_schema')
  const big = { type: 'object', properties: {} }
  for (let i = 0; i < 4000; i++) big.properties['k' + i] = { type: 'string', description: 'x'.repeat(20) }
  assert.throws(() => assertSchemaSupported(big, 'big'), (e) => e.code === 'unsupported_tool_schema')
})

test('schemas are never mutated (deep-frozen input validates unchanged) and args are not coerced in place', () => {
  const schema = JSON.parse(JSON.stringify({
    type: 'object',
    properties: { v: { anyOf: [{ type: 'string' }, { type: 'integer' }] } },
    required: ['v'],
    $defs: { x: { type: 'string' } },
    definitions: { x: { type: 'string' } },
  }))
  const freeze = (o) => {
    Object.freeze(o)
    for (const v of Object.values(o)) if (v && typeof v === 'object') freeze(v)
    return o
  }
  freeze(schema)
  const ctx = ctxOf(schema)
  const args = JSON.parse('{ "v": "keep" }')
  Object.freeze(args); Object.freeze(args)
  ok(validateJsonArguments(ctx, 'f', args))
  assert.equal(JSON.stringify(schema).includes('anyOf'), true, 'schema content unchanged after compile+validate')
})

test('validator cache is identity-keyed and size-bounded', () => {
  const a = ctxOf({ type: 'object', properties: { z: { type: 'string' } } })
  const before = validatorCacheSize()
  ok(validateJsonArguments(a, 'f', { z: '1' }))
  const mid = validatorCacheSize()
  ok(validateJsonArguments(a, 'f', { z: '2' })) // same schema identity: cache hit, no growth
  assert.equal(validatorCacheSize(), mid)
  for (let i = 0; i < 70; i++) {
    const c = ctxOf({ type: 'object', properties: { u: { type: 'string', description: 'u' + i } }, required: ['u'] })
    ok(validateJsonArguments(c, 'f', { u: 'v' }))
  }
  assert.ok(validatorCacheSize() <= 64, `cache must stay bounded, got ${validatorCacheSize()}`)
  assert.ok(validatorCacheSize() >= before)
})

test('raw format only parses unambiguous types; composite/nullable/undeclared -> raw_form_ambiguous with JSON guidance', () => {
  const s = ctxOf({
    type: 'object',
    properties: {
      cmd: { type: 'string' },
      n: { type: 'integer' },
      flag: { type: 'boolean' },
      maybe: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      pick: { enum: [1, 2, 3] },
    },
    required: ['cmd'],
  })
  ok(rawArgsToArguments(s, 'f', [['cmd', '  keep  \n']] )) // exact whitespace kept
  assert.equal(JSON.parse(rawArgsToArguments(s, 'f', [['cmd', 'x'], ['n', '7'], ['flag', 'true']]).args.flag), true)
  for (const pairs of [[['maybe', 'x']], [['pick', '1']], [['ghost', 'v']]]) {
    const r = rawArgsToArguments(s, 'f', pairs)
    assert.ok(r.error, `raw must refuse ambiguous: ${JSON.stringify(pairs)}`)
    assert.ok(r.error.includes('JSON'), 'error must direct the model to JSON format')
    assert.equal(r.code, 'raw_form_ambiguous')
  }
  assert.equal(rawArgsToArguments(s, 'f', [['cmd', 'x'], ['n', 'abc']]).code, 'schema_violation', 'non-numeric raw for integer type = plain schema violation')
})

// ---- hardening round: root $id resource semantics + traversal gap fixes ----

test('root $id: legal URI passes to Ajv, " <$id>#..." self-refs resolve, nested $id is a typed 400 (never silent root scope)', () => {
  const root = {
    $id: 'https://tools.example/x/schema',
    type: 'object',
    properties: {
      a: { $ref: '#/$defs/s' },
      b: { $ref: 'https://tools.example/x/schema#/$defs/s' }, // absolute self-reference: spec-legal, Ajv resolves it
    },
    required: ['a'],
    additionalProperties: false,
    $defs: { s: { type: 'string', minLength: 2 } },
  }
  const ctx = ctxOf(root)
  ok(validateJsonArguments(ctx, 'f', { a: 'xy' }))
  ok(validateJsonArguments(ctx, 'f', { a: 'xy', b: 'zz' }))
  assert.equal(validateJsonArguments(ctx, 'f', { a: 'xy', b: 'z' }).code, 'schema_violation', 'self-ref resolves to the real sub-schema, not a lax root scope')

  const nested = { type: 'object', properties: { a: { $id: 'https://x.test/other', $ref: '#/$defs/s' } }, $defs: { s: { type: 'string' } } }
  try {
    assertSchemaSupported(nested, 'nested-id')
    assert.fail('nested $id must be rejected (it changes the base-URI scope)')
  } catch (e) {
    assert.equal(e.code, 'unsupported_tool_schema')
    assert.ok(/嵌套 \$id|resource scope|\$id/.test(e.message))
  }
  try {
    assertSchemaSupported({ type: 'object', properties: { a: { $ref: 'https://tools.example/x/schema' } }, $id: 'https://tools.example/x/schema' }, 'bare-self')
    assert.fail('bare resource-URI self-ref (2020 form without #) is not resolvable here')
  } catch (e) {
    assert.equal(e.code, 'unsupported_tool_schema')
  }
  // draft-04 legacy lowercase "id" is NOT the same keyword and stays unknown
  try {
    assertSchemaSupported({ id: 'https://x.test/legacy', type: 'object' }, 'legacy-id')
    assert.fail('legacy draft-04 id must stay unknown')
  } catch (e) {
    assert.equal(e.code, 'unsupported_tool_schema')
  }
})

test('same $id with different schema bodies never share a cache entry; dialect spellings are matched to the real meta-resolver', () => {
  const s1 = { $id: 'https://same.test/s', type: 'object', properties: { a: { type: 'string' } }, required: ['a'] }
  const s2 = { $id: 'https://same.test/s', type: 'object', properties: { a: { type: 'integer' } }, required: ['a'] }
  const c1 = ctxOf(s1)
  const c2 = ctxOf(s2)
  ok(validateJsonArguments(c1, 'f', { a: 'text' }))
  assert.equal(validateJsonArguments(c2, 'f', { a: 'text' }).code, 'schema_violation', 'identical $id but different body: no cache cross-talk')
  ok(validateJsonArguments(c2, 'f', { a: 3 }))
  // https spelling of draft-07 cannot pass the bundled meta-resolver: typed 400, not allow-then-compile-explode
  for (const bad of ['https://json-schema.org/draft-07/schema#', 'http://json-schema.org/draft/2020-12/schema', 'http://json-schema.org/draft-07/schema']) {
    try {
      assertSchemaSupported({ $schema: bad, type: 'object' }, 'spelling')
      assert.fail(`$schema ${bad} should be typed-rejected (Ajv cannot resolve this spelling)`)
    } catch (e) {
      assert.equal(e.code, 'unsupported_tool_schema')
    }
  }
  assertSchemaSupported({ $schema: 'http://json-schema.org/draft-07/schema#', type: 'object' }, 'd07-exact')
  assertSchemaSupported({ $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object' }, '2020-exact')
})

test('traversal gaps closed: draft-07 tuple items children, dependencies schema children, null subschemas are all checked', () => {
  // tuple children were previously skipped entirely
  try {
    assertSchemaSupported({ type: 'array', items: [{ type: 'string' }, { type: 'object', hasSecretFlag: true }] }, 'tuple-gap')
    assert.fail('tuple child with unknown keyword must be found')
  } catch (e) {
    assert.equal(e.code, 'unsupported_tool_schema')
    assert.ok(/items\[1\]/.test(e.message), 'the offending tuple CHILD is reported')
  }
  try {
    assertSchemaSupported({ type: 'array', items: [{ type: 'string' }, { $ref: 'http://evil.test/x' }] }, 'tuple-ref')
    assert.fail('tuple child external ref must be found')
  } catch (e) {
    assert.equal(e.code, 'unsupported_tool_schema')
    assert.ok(/items\[1\]/.test(e.message))
  }
  // dependencies schema-form children
  try {
    assertSchemaSupported({ type: 'object', properties: { a: { type: 'string' } }, dependencies: { a: { properties: { b: { type: 'object', secretDep: 1 } } } } }, 'dep-gap')
    assert.fail('dependencies schema child must be walked')
  } catch (e) {
    assert.equal(e.code, 'unsupported_tool_schema')
    assert.ok(/dependencies/.test(e.message))
  }
  assertSchemaSupported({ type: 'object', properties: { a: { type: 'string' } }, dependencies: { a: ['b'] } }, 'dep-list-ok')
  // null is not a legal schema
  try {
    assertSchemaSupported({ type: 'object', properties: { a: null } }, 'null-schema')
    assert.fail('null subschema must be typed-rejected, not a raw Ajv compile error')
  } catch (e) {
    assert.equal(e.code, 'unsupported_tool_schema')
    assert.ok(/null/.test(e.message))
  }
  // boolean subschemas stay legal (true/false)
  assertSchemaSupported({ type: 'object', properties: { open: true, closed: false } }, 'bool-ok')
})
