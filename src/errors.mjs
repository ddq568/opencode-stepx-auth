// Typed error surface shared by every contract-core module.
//
// - httpError: request-shaped / upstream failures carrying an HTTP status.
// - protocolError: violations of the emulated tool protocol. These must be
//   surfaced to the client as typed errors — never masked as a normal
//   `stop` finish.
// - errorResponse: the single OpenAI-style JSON error mapping (also keeps
//   the x-magpie-sign-in header magpie uses for re-login hints).

export const PROTOCOL = {
  INVALID_REQUEST: 'invalid_request',
  UNSUPPORTED_CONTENT: 'unsupported_content_type',
  UNSUPPORTED_TOOL_SCHEMA: 'unsupported_tool_schema',
  BUDGET_EXCEEDED: 'budget_exceeded',
  TOOL_CALL_NOT_ALLOWED: 'tool_call_not_allowed',
  UNKNOWN_TOOL: 'unknown_tool',
  MISSING_NAME: 'missing_name',
  BAD_JSON: 'bad_json',
  UNTERMINATED_CALL: 'unterminated_call',
  AMBIGUOUS_CALL: 'ambiguous_call',
  MALFORMED_OPENER: 'malformed_opener',
  RAW_TAG_CONFLICT: 'raw_tag_conflict',
  SCHEMA_VIOLATION: 'schema_violation',
  RAW_AMBIGUOUS: 'raw_form_ambiguous',
  TOOL_CHOICE_UNSATISFIED: 'tool_choice_unsatisfied',
  TOOL_CHOICE_MISMATCH: 'tool_choice_mismatch',
  PARALLEL_VIOLATED: 'parallel_tool_calls_violated',
}

const PROTOCOL_STATUS = {
  [PROTOCOL.INVALID_REQUEST]: 400,
  [PROTOCOL.UNSUPPORTED_CONTENT]: 400,
  [PROTOCOL.UNSUPPORTED_TOOL_SCHEMA]: 400,
  [PROTOCOL.RAW_AMBIGUOUS]: 422,
  [PROTOCOL.BUDGET_EXCEEDED]: 413,
}

export function protocolError(code, message, detail) {
  const e = new Error(message)
  e.protocol = true
  e.type = 'tool_protocol_error'
  e.code = code
  e.status = PROTOCOL_STATUS[code] ?? 422
  if (detail !== undefined) e.detail = detail
  return e
}

export function httpError(status, message, { type, code, headers } = {}) {
  const e = new Error(message)
  e.status = status
  e.type =
    type ??
    (status === 401
      ? 'authentication_error'
      : status === 499
        ? 'request_cancelled'
        : status >= 400 && status < 500
          ? 'invalid_request_error'
          : 'upstream_error')
  e.code = code ?? status
  if (headers) e.headers = headers
  return e
}

export function errorResponse(e) {
  const status = Number.isInteger(e?.status) ? e.status : 502
  const type = e?.type ?? (status >= 400 && status < 500 ? 'invalid_request_error' : 'upstream_error')
  const body = { error: { type, code: e?.code ?? status, message: e?.message ?? String(e) } }
  if (e?.detail !== undefined) body.error.detail = e.detail
  const headers = { 'x-magpie-sign-in': status === 401 ? 'expired' : 'kept' }
  if (e?.headers) Object.assign(headers, e.headers)
  return Response.json(body, { status, headers })
}

/** Error payload for in-band SSE error chunks. */
export function errorBody(e) {
  return {
    message: e?.message ?? String(e),
    type: e?.type ?? (e?.protocol ? 'tool_protocol_error' : 'upstream_error'),
    code: e?.code ?? e?.status ?? 502,
    ...(e?.detail !== undefined ? { detail: e.detail } : {}),
  }
}
