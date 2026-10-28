// OpenAI-compatible SSE rendering of one turn's event stream.
//
// Contract:
// - an upstream or protocol failure NEVER renders as a normal
//   finish_reason:"stop": it renders one typed error chunk, then [DONE],
//   with no success finish chunk;
// - usage is NEVER fabricated (no real billing numbers exist upstream):
//   `usage` is omitted entirely; when the client asked for usage and the
//   turn reported a session-context diagnostic, that diagnostic is emitted
//   as a non-standard `stepx_diagnostics` field instead;
// - client disconnect (cancel) is forwarded through onCancel so the caller
//   aborts the upstream turn.

import { errorBody } from './errors.mjs'

const ENC = new TextEncoder()

function sseChunk(obj) {
  return ENC.encode(`data: ${JSON.stringify(obj)}\n\n`)
}

function oaiChunk({ id, created, model, delta, finish = null }) {
  return {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  }
}

export function sseResponse({ id, created, model, events, wantUsage = false, onCancel }) {
  const stream = new ReadableStream({
    async start(ctl) {
      const safeEnqueue = (chunk) => {
        try {
          ctl.enqueue(chunk)
        } catch {}
      }
      safeEnqueue(sseChunk(oaiChunk({ id, created, model, delta: { role: 'assistant' } })))
      let usedTools = false
      let diagnostics = null
      try {
        for await (const ev of events) {
          if (ev.reasoning) safeEnqueue(sseChunk(oaiChunk({ id, created, model, delta: { reasoning_content: ev.reasoning } })))
          else if (ev.content) safeEnqueue(sseChunk(oaiChunk({ id, created, model, delta: { content: ev.content } })))
          else if (ev.toolCall) {
            usedTools = true
            safeEnqueue(
              sseChunk(
                oaiChunk({
                  id,
                  created,
                  model,
                  delta: {
                    tool_calls: [
                      {
                        index: ev.toolCall.index,
                        id: ev.toolCall.id,
                        type: 'function',
                        function: { name: ev.toolCall.name, arguments: ev.toolCall.arguments },
                      },
                    ],
                  },
                }),
              ),
            )
          } else if (ev.diagnostics) {
            diagnostics = ev.diagnostics
          }
        }
        safeEnqueue(sseChunk(oaiChunk({ id, created, model, delta: {}, finish: usedTools ? 'tool_calls' : 'stop' })))
        if (wantUsage && diagnostics) {
          safeEnqueue(
            ENC.encode(
              `data: ${JSON.stringify({
                id,
                object: 'chat.completion.chunk',
                created,
                model,
                choices: [],
                stepx_diagnostics: diagnostics,
              })}\n\n`,
            ),
          )
        }
      } catch (e) {
        safeEnqueue(ENC.encode(`data: ${JSON.stringify({ error: errorBody(e) })}\n\n`))
        // no finish_reason chunk: an error must not masquerade as `stop`
      }
      safeEnqueue(ENC.encode('data: [DONE]\n\n'))
      try {
        ctl.close()
      } catch {}
    },
    cancel() {
      try {
        onCancel?.()
      } catch {}
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
  })
}
