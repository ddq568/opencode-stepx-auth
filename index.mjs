#!/usr/bin/env node
/**
 * stepx-auth — Step Studio (studio.stepx.com) chat models as a magpie /
 * OpenCode provider (v0.3 contract-core rewrite, unpublished worktree).
 *
 * Architecture (src/ modules, all imported from here):
 *   errors.mjs    typed protocol/HTTP errors (no fake `stop` finishes)
 *   ledger.mjs    normalized message ledger (deterministic serialization)
 *   tools.mjs     tool whitelist, wire-alias table, JSON-Schema subset
 *   parser.mjs    canonical <fn:invoke> stream parser (fail closed)
 *   prompt.mjs    environment-neutral persona/protocol texts
 *   transport.mjs injectable HTTP/WS boundary + one-shot turn
 *   stream.mjs    SSE rendering (buffered tool calls, no fabricated usage)
 *   session.mjs   per-account runtime: pool, locks, budget, turn pipeline
 *   login.mjs     guided browser sign-in (the only login path)
 *   models.mjs    model catalog + resolution
 *
 * The npm entry exposes exactly the magpie plugin interfaces
 * (config / provider.models / auth.methods / auth.loader). Everything else
 * lives in src/ and is exercised through the offline mock-transport suite.
 *
 * The legacy v0.3.2 monolith is kept for reference at legacy/index-v0.3.2.mjs
 * and is NOT part of the published files.
 */
import { FALLBACK_MODELS, createFallbackModels, NOT_TOOL_RECOMMENDED, resolveModelId, fetchAccountModels } from './src/models.mjs'
import { createAccountRuntime } from './src/session.mjs'
import { chromeSignIn } from './src/login.mjs'
import { SITE, defaultTransport, createTransport } from './src/transport.mjs'
import { createHash } from 'node:crypto'

const PROVIDER = 'stepx'

export const StepXAuthPlugin = async (_input, options) => {
  const transport = options?.transport ?? defaultTransport // `transport` is a test/diagnostic hook for offline harnesses
  const enableStep5Tools = options?.enableStep5Tools === true
  const pluginOptions = {
    persona: options?.persona !== false,
    maxProjects: options?.maxProjects,
    maxTurnBytes: options?.maxTurnBytes,
    elideToolResults: options?.elideToolResults === true,
    enableStep5Tools,
  }
  const fallback = enableStep5Tools ? createFallbackModels({ enableStep5Tools: true }) : FALLBACK_MODELS

  // Per-plugin-instance catalog cache (never module-global: two accounts,
  // two plugin instances, two caches).
  // Per-ACCOUNT catalog caches (NOT one per plugin instance): the same
  // plugin object can serve several magpie accounts (provider.models is
  // invoked with different context.auth), and account A must never see
  // account B's catalog. Keyed by accountId, or by a hash of the cookie
  // when no accountId exists (the key itself is never stored or logged).
  const catalogCaches = new Map() // accountKey -> { at, value }
  const catalogAccountKey = (auth) => {
    if (typeof auth?.accountId === 'string' && auth.accountId) return 'id:' + auth.accountId
    const key = typeof auth?.key === 'string' ? auth.key : ''
    return key ? 'cookie:' + createHash('sha256').update(key).digest('hex') : 'anon'
  }

  const resolveReturn = (catalog) => {
    if (!enableStep5Tools || !catalog?.['step-5-preview']) return catalog
    if (catalog['step-5-preview'].tool_call === true) return catalog
    return {
      ...catalog,
      'step-5-preview': { ...catalog['step-5-preview'], tool_call: true },
    }
  }

  const accountModels = async (provider, context) => {
    const auth = context?.auth ?? (await context?.getAuth?.().catch(() => null))
    const cookie = auth?.key
    if (!cookie) return resolveReturn(provider?.models ?? fallback)
    const accountKey = catalogAccountKey(auth)
    const cached = catalogCaches.get(accountKey)
    if (cached?.value && Date.now() - cached.at < 600_000) return cached.value
    const live = await fetchAccountModels(transport, cookie, { enableStep5Tools }).catch(() => null)
    if (!live) return resolveReturn(provider?.models ?? fallback)
    for (const [id, m] of Object.entries(live)) {
      const prev = provider?.models?.[id]
      if (prev?.limit) m.limit = prev.limit
    }
    catalogCaches.set(accountKey, { at: Date.now(), value: live })
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
        models: fallback,
      }
    },

    provider: { id: PROVIDER, models: accountModels },

    auth: {
      provider: PROVIDER,
      methods: [{ type: 'oauth', label: '浏览器登录（Step Studio 账号）', authorize: browserLogin }],

      loader: async (getAuth) => {
        const auth = await getAuth()
        const initialCookie = (auth?.key ?? '').trim()
        if (!initialCookie) return {}

        // Account-scoped runtime: pool / catalog / cookie callbacks live in
        // this closure only. Cookie rotation is persisted back for THIS
        // account; rejections are contained inside the runtime.
        const client = _input?.client ?? null
        const persistCookie = (next) =>
          client?.auth?.set?.({
            path: { id: PROVIDER },
            body: {
              type: 'api',
              key: next,
              accountId: auth?.accountId,
              expires: 0,
              metadata: auth?.metadata ?? { login: 'browser' },
            },
          })

        const runtime = createAccountRuntime({
          transport,
          cookie: initialCookie,
          persistCookie,
          options: pluginOptions,
        })
        return {
          baseURL: SITE + '/v1', // placeholder; requests are proxied, not sent to an OpenAI path
          fetch: (input, init) => runtime.handle(input, init),
        }
      },
    },
  }
}

// OpenCode v1 form: with default { id, server } the host takes only
// `server` as the plugin and never iterates the module's other exports.
export default { id: PROVIDER, server: StepXAuthPlugin }

// Test surface (node --test): the offline suite drives full request loops
// through these exports with a mock transport and networking blocked.
export const _internal = {
  createTransport,
  defaultTransport,
  SITE,
  FALLBACK_MODELS,
  createFallbackModels,
  NOT_TOOL_RECOMMENDED,
  resolveModelId,
  createAccountRuntime,
  chromeSignIn,
}
