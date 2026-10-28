// JSON-Schema validation contract, backed by Ajv v8 (pinned 8.20.0).
//
// Supported, honestly documented (README mirrors this):
// - dialects: draft-07 (default when $schema is absent) and 2020-12,
//   selected from the schema's own $schema declaration; any other dialect
//   (draft-04/06, 2019-09, OpenAPI-style "nullable", ...) is a typed 400.
// - validation keywords: type (+arrays incl. "null"), enum, const,
//   numbers (minimum/maximum/exclusive*/multipleOf), strings
//   (minLength/maxLength/pattern), arrays (items/prefixItems per dialect,
//   additionalItems draft-07, minItems/maxItems/uniqueItems/contains
//   (+min/maxContains 2020-12)), objects (properties, required,
//   additionalProperties (bool|schema), patternProperties, propertyNames,
//   min/maxProperties, unevaluated* 2020-12), combinators (allOf/anyOf/
//   oneOf/not, if/then/else), $ref restricted to LOCAL pointers ("#..."),
//   $defs / definitions containers.
// - annotations only (NOT validated): title, description, default,
//   examples, deprecated, readOnly, writeOnly, $comment, format — Ajv runs
//   with strict:false so unknown "format" names stay annotations; this
//   module never claims format was checked (no ajv-formats dependency).
// - everything else is an unknown validation keyword -> typed 400
//   unsupported_tool_schema (never silently ignored).
//
// Safety/behavior contract:
// - coercion / defaults application / additional-property removal are ALL
//   disabled: neither the schema nor the arguments are ever modified;
// - no compileAsync, no remote/external schema loading; $ref must be a
//   local pointer inside the same schema ("#..." / "#/$defs/...").
// - resource bounds: per-schema JSON size, nesting depth and pattern
//   length are capped; exceeding them is a typed 400 (bounded regex and
//   compile cost), and the compiled-validator cache is keyed by the
//   schema's exact JSON identity with a hard size bound.
import Ajv from 'ajv'
import Ajv2020 from 'ajv/dist/2020.js' // ajv ships no exports map; Node ESM needs the real file path
import { protocolError, PROTOCOL } from './errors.mjs'

export const AJV_VERSION = '8.20.0'

const DIALECT_2020 = 'https://json-schema.org/draft/2020-12/schema'
const DIALECT_07 = 'http://json-schema.org/draft-07/schema#'
// Empirically verified against the bundled Ajv meta-resolvers (see
// test/schema-contract.test.mjs): the ONLY spellings Ajv actually accepts
// are the canonical ones above — draft-07 https:// or fragment-less forms
// and 2020-12 http:// throw inside Ajv ("no schema with key or ref ...").
// We type-reject those instead of allow-then-explode.

const ANNOTATIONS = new Set([
  'title', 'description', 'default', 'examples', 'deprecated', 'readOnly', 'writeOnly',
  '$comment', '$schema', 'format', // format: annotation-only, never validated (documented)
])

const VALIDATION_DRAFT07 = new Set([
  'type', 'enum', 'const', 'multipleOf', 'maximum', 'exclusiveMaximum', 'minimum', 'exclusiveMinimum',
  'maxLength', 'minLength', 'pattern', 'additionalItems', 'items', 'maxItems', 'minItems', 'uniqueItems',
  'contains', 'maxProperties', 'minProperties', 'required', 'properties', 'patternProperties',
  'additionalProperties', 'propertyNames', 'dependencies', 'if', 'then', 'else',
  'allOf', 'anyOf', 'oneOf', 'not', '$ref', '$defs', 'definitions', // $defs works as a container in both dialects (Ajv resolves refs document-wide)
])

const VALIDATION_2020 = new Set([
  'type', 'enum', 'const', 'multipleOf', 'maximum', 'exclusiveMaximum', 'minimum', 'exclusiveMinimum',
  'maxLength', 'minLength', 'pattern', 'prefixItems', 'items', 'contains', 'maxContains', 'minContains',
  'maxItems', 'minItems', 'uniqueItems', 'maxProperties', 'minProperties', 'required', 'properties',
  'patternProperties', 'additionalProperties', 'propertyNames', 'dependentRequired', 'dependentSchemas',
  'if', 'then', 'else', 'allOf', 'anyOf', 'oneOf', 'not', '$ref', '$defs', 'definitions',
  'unevaluatedItems', 'unevaluatedProperties',
])

// Resource bounds (documented; exceeding -> typed 400, not a hang).
export const MAX_SCHEMA_JSON_BYTES = 64 * 1024
export const MAX_SCHEMA_DEPTH = 48
export const MAX_PATTERN_LENGTH = 256
const MAX_VALIDATOR_CACHE = 64 // compiled validators kept; oldest evicted beyond this

const validatorCache = new Map() // dialect + '\u0000' + exact schema JSON -> compiled validator

function unsupported(message, detail) {
  return protocolError(PROTOCOL.UNSUPPORTED_TOOL_SCHEMA, message, detail)
}

function dialectOf(schema) {
  const s = schema?.$schema
  if (s === undefined || s === null) return 'draft-07'
  if (s === DIALECT_07) return 'draft-07'
  if (s === DIALECT_2020) return '2020-12'
  return null
}

function walkUnsupported(schema, path, dialect, out, depth, rootId) {
  if (depth > MAX_SCHEMA_DEPTH) {
    out.push({ path, keyword: `(schema 嵌套深度超过 ${MAX_SCHEMA_DEPTH})` })
    return
  }
  if (schema === true || schema === false) return // boolean schemas: valid, nothing inside
  if (schema === null) {
    out.push({ path, keyword: '(null 不是合法 schema)' })
    return
  }
  if (typeof schema !== 'object' || Array.isArray(schema)) {
    out.push({ path, keyword: '(schema 不是 object)' })
    return
  }
  const allowed = dialect === '2020-12' ? VALIDATION_2020 : VALIDATION_DRAFT07
  for (const [k, v] of Object.entries(schema)) {
    if (ANNOTATIONS.has(k)) continue // annotations never affect validation
    if (k === '$id') {
      // $id is a resource identifier, NOT an annotation: a nested $id changes
      // the base-URI scope. Only the ROOT $id (depth 0, pre-validated in
      // assertSchemaSupported) is allowed; nested ones are a typed rejection,
      // never a silent root-scope fallback.
      if (depth > 0) {
        out.push({ path, keyword: '$id(嵌套 $id 会改变资源作用域：仅支持顶层 $id)' })
      }
      continue
    }
    if (k === '$ref') {
      if (typeof v !== 'string') {
        out.push({ path, keyword: '$ref(非法)' })
      } else if (v.startsWith('#')) {
        // local pointer: fine
      } else if (rootId && v.startsWith(rootId + '#')) {
        // self-reference via the schema's own root $id: resolvable, allowed
      } else {
        out.push({
          path,
          keyword:
            '$ref(仅支持 "#..." 本地指针，或带顶层 $id 的 "<$id>#..." 自引用；外部/跨文档/裸资源 URI 引用拒绝)',
        })
      }
      continue
    }
    if (!allowed.has(k)) {
      out.push({
        path,
        keyword: `${k}（${dialect} 校验器不支持的关键字）`,
      })
      continue
    }
    if (k === 'pattern' || k === 'patternProperties') {
      if (k === 'pattern') {
        if (typeof v !== 'string') out.push({ path, keyword: 'pattern(非法)' })
        else if (v.length > MAX_PATTERN_LENGTH) out.push({ path, keyword: `pattern(超过 ${MAX_PATTERN_LENGTH} 字符上限)` })
        else {
          try {
            new RegExp(v)
          } catch {
            out.push({ path, keyword: 'pattern(无法编译)' })
          }
        }
        continue
      }
      for (const [pat, sub] of Object.entries(v ?? {})) {
        if (typeof pat !== 'string' || pat.length > MAX_PATTERN_LENGTH) {
          out.push({ path: `${path}.patternProperties`, keyword: 'pattern(超过长度上限或非法)' })
          continue
        }
        try {
          new RegExp(pat)
        } catch {
          out.push({ path: `${path}.patternProperties`, keyword: 'pattern(无法编译)' })
          continue
        }
        walkUnsupported(sub, `${path}.patternProperties[${pat}]`, dialect, out, depth + 1, rootId)
      }
      continue
    }
    // recurse into the structural places schemas nest
    if (k === 'type' && Array.isArray(v)) {
      for (const t of v) {
        if (!['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(t))
          out.push({ path, keyword: `type:${String(t)}` })
      }
      continue
    }
    if (k === 'items') {
      if (Array.isArray(v)) {
        if (dialect === '2020-12') {
          out.push({ path, keyword: 'items(2020-12 不支持元组形式，请用 prefixItems)' })
          continue
        }
        // draft-07 tuple: EVERY child schema must pass the same checks (gap fix:
        // children used to be skipped entirely)
        v.forEach((s, i) => walkUnsupported(s, `${path}.items[${i}]`, dialect, out, depth + 1, rootId))
        continue
      }
      walkUnsupported(v, `${path}.items`, dialect, out, depth + 1, rootId)
      continue
    }
    if (k === 'dependencies') {
      // draft-07 only: values are either property-name lists (no schema) or
      // schemas — the schema form must be walked too.
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        for (const [p, s] of Object.entries(v)) {
          if (s && typeof s === 'object' && !Array.isArray(s))
            walkUnsupported(s, `${path}.dependencies.${p}`, dialect, out, depth + 1, rootId)
        }
      }
      continue
    }
    if ((k === 'properties' || k === '$defs' || k === 'definitions' || k === 'dependentSchemas' || k === 'patternProperties') && v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [p, s] of Object.entries(v)) walkUnsupported(s, `${path}.${k}.${p}`, dialect, out, depth + 1, rootId)
      continue
    }
    if (
      (k === 'additionalItems' || k === 'additionalProperties' || k === 'contains' || k === 'propertyNames' || k === 'not' || k === 'if' || k === 'then' || k === 'else' || k === 'unevaluatedItems' || k === 'unevaluatedProperties') &&
      v !== undefined &&
      typeof v !== 'boolean'
    ) {
      if (v && typeof v === 'object' && !Array.isArray(v)) walkUnsupported(v, `${path}.${k}`, dialect, out, depth + 1, rootId)
      continue
    }
    if ((k === 'allOf' || k === 'anyOf' || k === 'oneOf' || k === 'prefixItems') && Array.isArray(v)) {
      v.forEach((s, i) => walkUnsupported(s, `${path}.${k}[${i}]`, dialect, out, depth + 1, rootId))
      continue
    }
  }
}

/**
 * Declaration-time gate: dialect, keyword allowlist, local-ref-only,
 * resource caps, and an actual Ajv compile (so a dangling local $ref or
 * otherwise uncompilable schema fails here with a typed 400 — never at
 * tool-call time). Never mutates the schema.
 */
export function assertSchemaSupported(schema, label) {
  const json = JSON.stringify(schema)
  if (Buffer.byteLength(json, 'utf8') > MAX_SCHEMA_JSON_BYTES)
    throw unsupported(`${label}: schema 序列化后超过 ${MAX_SCHEMA_JSON_BYTES} 字节资源上限（明确拒绝，保证校验开销有界）`, { label, limit: MAX_SCHEMA_JSON_BYTES })
  // Root $id is a legal resource identifier and is passed to Ajv as-is (it
  // participates in local ref resolution: "<$id>#..." self-references are
  // accepted by the $ref rules below). It is NOT an annotation, and it does
  // NOT enable draft-04 legacy "id". Nested $id is rejected in the walk.
  let rootId = ''
  if (schema?.$id !== undefined) {
    if (typeof schema.$id !== 'string' || !schema.$id)
      throw unsupported(`${label}: 顶层 $id 必须是非空字符串 URI`, { label })
    rootId = schema.$id
  }
  const dialect = dialectOf(schema)
  if (dialect === null)
    throw unsupported(
      `${label}: 不支持的 schema 方言 $schema=${JSON.stringify(schema?.$schema)}（按实际校验器支持，仅接受 "${DIALECT_07}" 与 "${DIALECT_2020}"；其他拼写会无法通过 meta 校验，一律明确拒绝而非 allow 后编译炸）`,
      { label, dialect: schema?.$schema },
    )
  const out = []
  walkUnsupported(schema, label, dialect, out, 0, rootId)
  if (out.length)
    throw unsupported(
      `${label}: schema 含本插件校验器不支持的内容（明确拒绝，不假校验）：${out.map((u) => `${u.path}#${u.keyword}`).join('、')}`,
      { unsupported: out, dialect },
    )
  getValidator(schema, label) // compile now: dangling local $ref etc. surface at declaration time
  return dialect
}

function compile(dialect, schema, label) {
  const AjvCls = dialect === '2020-12' ? Ajv2020 : Ajv
  const ajv = new AjvCls({
    strict: false, // annotations like unknown "format" stay annotations; keyword honesty is enforced by the allowlist above
    coerceTypes: false, // never mutate/loosen the arguments ("001" stays a string)
    useDefaults: false,
    removeAdditional: false,
    allErrors: false,
    addUsedSchema: false, // keep schemas standalone: no global registry, no $id-based pollution
  })
  try {
    return ajv.compile(schema)
  } catch (e) {
    throw unsupported(
      `${label}: schema 无法编译（例如悬空的本地 $ref）：${e.message}`,
      { label, reason: 'compile_failed' },
    )
  }
}

/**
 * Compiled validator for one schema, cached by the schema's EXACT JSON
 * identity (byte-for-byte) + dialect, with a hard bound on cache size.
 * The compiled validator never mutates the data (all mutation options off).
 */
export function getValidator(schema, label = 'schema') {
  const dialect = dialectOf(schema)
  if (dialect === null) throw unsupported(`${label}: 不支持的 schema 方言`, { label, dialect: schema?.$schema })
  const key = dialect + '\u0000' + JSON.stringify(schema)
  let v = validatorCache.get(key)
  if (!v) {
    if (validatorCache.size >= MAX_VALIDATOR_CACHE) {
      const oldest = validatorCache.keys().next().value
      validatorCache.delete(oldest)
    }
    v = compile(dialect, schema, label)
    validatorCache.set(key, v)
  }
  return v
}

export function validatorCacheSize() {
  return validatorCache.size
}

/**
 * Validate JSON-form arguments against a supported schema. The arguments
 * must be a plain object (OpenAI function-call contract); validation is
 * strict Ajv (no coercion). Returns {args} on success, or a typed
 * schema_violation with a deterministic Ajv error string.
 */
export function validateJsonArguments(schema, originalName, args) {
  if (args === undefined || args === null) args = {}
  if (typeof args !== 'object' || Array.isArray(args) || args === null)
    return { error: `工具 ${originalName} 的 arguments 必须是 JSON object`, code: PROTOCOL.SCHEMA_VIOLATION }
  const validate = getValidator(schema, `tools[${originalName}].parameters`)
  const ok = validate(args)
  if (!ok) {
    const text = (validate.errors ?? [])
      .map((e) => `${e.instancePath || '/'} ${e.message}`)
      .join('；')
    return { error: `工具 ${originalName} 参数校验失败：${text}`, code: PROTOCOL.SCHEMA_VIOLATION }
  }
  return { args }
}
