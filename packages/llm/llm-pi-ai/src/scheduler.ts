/** VOS deployment adapter over the tenant's inference-only gateway capability. */
import type { Context } from '@deepseek-ai/cordis'
import { LlmError, resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm'
import type { LlmModelInfo, LlmResolvedModelInfo, PreparedAdapterCall } from '@deepseek-ai/dsh-llm'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { PiAiAdapter } from './adapter.ts'
import { authContextFrom, credentialStoreFrom } from './auth.ts'
import { resolveProfiles } from './config.ts'
import type { PiAiModelProfile } from './config.ts'

const ROUTES = [
  ['v-scheduler', 'openai-completions', '/v1'],
  ['v-scheduler-responses', 'openai-responses', '/v1'],
  ['v-scheduler-messages', 'anthropic-messages', ''],
  ['v-scheduler-completion', 'text-completions', '/text/v1'],
] as const

/**
 * Register managed discovery when the VOS gateway supplies an inference capability.
 * @param ctx - Host context owning the adapter registration.
 * @returns whether the VOS-managed adapter replaced standalone configuration.
 */
export function applyScheduler(ctx: Context): boolean {
  const environment = launchEnvironmentOf(ctx)
  const base = environment.get('VH_SCHEDULER_URL')?.value
  if (!base) return false
  const key = environment.get('VH_SCHEDULER_KEY')?.value
  if (!key) throw new LlmError('V-Scheduler inference capability is missing', 'MISSING_CREDENTIAL')
  let profiles: ReturnType<typeof resolveProfiles> = new Map()
  let loaded = false
  let pending: Promise<void> | undefined
  const refresh = (): Promise<void> => {
    if (pending) return pending
    pending = (async () => {
      const response = await fetch(`${base}/v1/models`, {
        headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15000),
      })
      if (!response.ok) throw new LlmError(`V-Scheduler model discovery: HTTP ${response.status}`, 'MODEL_DISCOVERY_FAILED')
      const payload: unknown = await response.json()
      if (!payload || typeof payload !== 'object' || !('data' in payload) || !Array.isArray(payload.data)) {
        throw new LlmError('Invalid V-Scheduler model catalog', 'MODEL_DISCOVERY_FAILED')
      }
      const models = new Map<string, PiAiModelProfile[]>()
      for (const row of payload.data) {
        if (!row || typeof row !== 'object' || typeof row.id !== 'string' || typeof row.api !== 'string'
          || !ROUTES.some(([, api]) => api === row.api) || !Array.isArray(row.input) || !row.input.every((item: unknown) => item === 'text' || item === 'image')) {
          throw new LlmError('Invalid V-Scheduler model descriptor', 'MODEL_DISCOVERY_FAILED')
        }
        const group = models.get(row.api) ?? []
        group.push({ id: row.id, name: typeof row.name === 'string' ? row.name : row.id, input: row.input })
        models.set(row.api, group)
      }
      profiles = resolveProfiles(Object.fromEntries(ROUTES.flatMap(([provider, api, suffix]) => models.get(api)?.length ? [[provider, {
        displayName: 'V-Scheduler', api: api === 'text-completions' ? 'openai-completions' : api,
        baseURL: `${base}${suffix}`, apiKeyEnv: 'VH_SCHEDULER_KEY', models: models.get(api) ?? [],
        ...api === 'openai-completions' || api === 'text-completions' ? { compat: { supportsStore: false } } : {},
      }]] : [])))
      loaded = true
    })().finally(() => { pending = undefined })
    return pending
  }
  class SchedulerAdapter extends PiAiAdapter {
    override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
      await refresh()
      return profiles.has(provider) ? super.listModels(provider) : []
    }
    override async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
      if (!loaded) await refresh()
      return super.resolveModel(provider, model, signal)
    }
    override async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
      await refresh()
      return super.prepareCall(provider, model, signal)
    }
  }
  const adapter = new SchedulerAdapter({
    profiles: () => profiles,
    resolveApiKey: async () => key,
    auth: { credentials: credentialStoreFrom(ctx), authContext: authContextFrom(ctx) },
    resolveAttachments: () => ctx.get('attachments'),
    resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(
      attachments, path => ctx.get('fs')?.processPathFromHostPath(path), ref,
    ),
  })
  ctx.llm.registerAdapter(ROUTES.map(([provider]) => provider), adapter)
  return true
}
