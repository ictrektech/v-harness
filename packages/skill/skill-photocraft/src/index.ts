/** Natural-language photo editing over the per-tenant PhotoCraft capability. */

import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { FileBridge, McpClient } from './client.ts'
import { PREVIEW_SIDE_MAX, PREVIEW_SIDE_MIN, registerPhotocraftTools } from './tools.ts'

const DEFAULT_PREVIEW_SIDE = 768
const DEFAULT_TIMEOUT_MS = 300_000

/** Where the capability endpoint lives and how big iteration previews are. */
export interface Config {
  /**
   * `unix:/path/to/photocraft.sock` on a deployed tenant, or the VOS endpoint
   * `http://<vos-host>:1182/app/com.ictrek.photocraft/storage` when running
   * against a development VOS — the same port v-office is reached on, with the
   * app's own prefix instead of a hand-mapped host port.
   */
  endpoint?: string
  /** Long edge of the preview image handed to the model while iterating. */
  previewSide?: number
  /** Per-call deadline for the capability. */
  requestTimeoutMs?: number
}

/** Validated runtime configuration. */
export const Config: z<Config> = z.object({
  endpoint: z.string().min(1),
  previewSide: z.natural().min(PREVIEW_SIDE_MIN).max(PREVIEW_SIDE_MAX),
  requestTimeoutMs: z.natural().min(1000),
})

/** Cordis plugin identity. */
export const name = 'skill-photocraft'

/**
 * Resolve one endpoint, preferring explicit configuration over the environment.
 * @param configured - the plugin config value.
 * @param environment - the variable a deployment may set instead.
 * @param fallback - the socket path under the tenant home.
 * @returns the endpoint description.
 */
export function endpointOf(configured: string | undefined, environment: string | undefined, fallback: string): string {
  const value = configured ?? environment
  if (value === undefined || value === '') return `unix:${fallback}`
  return value
}

/**
 * Register the PhotoCraft tools.
 *
 * The capability itself is provided by the gateway (`gateway/photocraft.mjs`),
 * which holds the tenant's VOS token; this plugin never sees a credential and
 * only ever connects to a socket the tenant owns.
 * @param ctx - Context carrying the tool registry and the attachment store.
 * @param config - Optional endpoint and preview overrides.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const home = process.env.HOME ?? homedir()
  const timeoutMs = config.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS
  const endpoint = { url: endpointOf(config.endpoint, process.env.VH_PHOTOCRAFT_ENDPOINT, join(home, '.dsh', 'photocraft.sock')) }
  const runtime = {
    mcp: new McpClient(endpoint, timeoutMs),
    bridge: new FileBridge(endpoint, timeoutMs),
    previewSide: config.previewSide ?? DEFAULT_PREVIEW_SIDE,
  }
  ctx.inject(['tools', 'attachments', 'workingDirectory'], (toolCtx) => {
    registerPhotocraftTools(toolCtx, runtime)
  })
}
