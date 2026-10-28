// Model catalog helpers (pure resolution + one live fetch; caching lives in
// the per-account runtime, never at module level).

import { api } from './transport.mjs'

export const NOT_TOOL_RECOMMENDED = new Set(['step-5-preview'])
export const NOT_TOOL_RECOMMENDED_SUFFIX = '（不推荐工具任务：实测存在工具可用性幻觉与转义错误，仅适合纯问答）'

export function createFallbackModels({ enableStep5Tools = false } = {}) {
  return {
    auto: model('auto', 'Auto', 'route: automatic model choice', { enableStep5Tools }),
    'step-5-preview': model('step-5-preview', 'Step 5 Preview', undefined, { enableStep5Tools }),
    'deepseek-flash[1m]': model('deepseek-flash[1m]', 'DeepSeek V4.1 Flash', undefined, { enableStep5Tools }),
  }
}

/** Fallback catalog when /api/chat-models can't be asked. */
export const FALLBACK_MODELS = createFallbackModels()

function model(id, name, note, { enableStep5Tools = false } = {}) {
  const notRec = NOT_TOOL_RECOMMENDED.has(id)
  let displayName = note ? `${name} (${note})` : name
  if (notRec && !displayName.includes(NOT_TOOL_RECOMMENDED_SUFFIX)) {
    displayName += NOT_TOOL_RECOMMENDED_SUFFIX
  }
  return {
    name: displayName,
    limit: { context: 900000, output: 65536 },
    reasoning: true,
    tool_call: notRec ? enableStep5Tools === true : true,
    modalities: { input: ['text'] },
  }
}

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9.]/g, '')

const warnedUnknown = new Set()

/**
 * Map the model id the gateway sends to a real catalog id. magpie may strip
 * bracket suffixes (deepseek-flash[1m] -> deepseek-flash) or prefix the
 * provider; match back against the catalog, falling back to auto.
 */
export function resolveModelId(asked, catalog = FALLBACK_MODELS) {
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
  if (!best) {
    if (!warnedUnknown.has(asked)) {
      warnedUnknown.add(asked)
      console.warn(`[models] 未知模型 "${asked}"，回退到 "auto"`)
    }
    return 'auto'
  }
  return best
}

export async function fetchAccountModels(tr, cookie, { signal, onCookieRefresh, enableStep5Tools = false } = {}) {
  const r = await api(tr, cookie, '/chat-models', { signal, onCookieRefresh })
  const items = r.ok ? r.json?.items : null
  if (!Array.isArray(items)) return null
  const models = {}
  for (const it of items) {
    if (typeof it?.id !== 'string' || !it.id) continue
    models[it.id] = model(it.id, String(it.name ?? it.id), it.isDefault ? 'default on the site' : undefined, { enableStep5Tools })
  }
  return Object.keys(models).length ? models : null
}
