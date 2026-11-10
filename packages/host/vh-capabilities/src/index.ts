/**
 * Tenant capability transport for v-harness.
 *
 * In a v-harness deployment each dsh runs as its own Linux account and the
 * gateway owns the capability sockets those skills call. This plugin moves the
 * socket into the tenant's process without changing the path or the wire
 * protocol: the gateway writes a contract into `DSH_HOME`, the plugin listens
 * for the capabilities that contract names, and every request is forwarded back
 * through `/__vh/egress/*` where the gateway still applies the route table and
 * injects the tenant's VOS token.
 *
 * Without a contract the plugin does nothing, which is what keeps an old
 * gateway (or a rollback) working unchanged.
 * @module @deepseek-ai/dsh-host-vh-capabilities
 */

import { join } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

import { CONTRACT_FILE_NAME, readCapabilityContract } from './contract.ts'
import { startCapabilityServers } from './servers.ts'

export { CAPABILITY_SOCKETS, CONTRACT_FILE_NAME, CONTRACT_VERSION, readCapabilityContract } from './contract.ts'
export type { CapabilityContract, CapabilityName } from './contract.ts'
export { startCapabilityServers } from './servers.ts'
export type { CapabilityServerOptions, CapabilityServers } from './servers.ts'

/** Cordis plugin name. */
export const name = 'vh-capabilities'

/** Where this deployment's dsh keeps its homes and sockets. */
export interface Config {
  /** dsh home holding the contract and sockets. @default process.env.DSH_HOME, then $HOME/.dsh */
  readonly dshHome?: string
  /** Gateway origin. @default http://127.0.0.1:$VH_GATEWAY_PORT */
  readonly gatewayUrl?: string
  /** Idle budget for one forwarded request, in milliseconds. @default 600000 */
  readonly timeoutMs?: number
}

/** Validated capability-transport configuration. */
export const Config: Schema<Config> = Schema.object({
  dshHome: Schema.string(),
  gatewayUrl: Schema.string(),
  timeoutMs: Schema.number().default(10 * 60 * 1_000),
})

/**
 * Mount the tenant capability sockets when the gateway delegated them.
 *
 * The listeners are an effect: unloading the plugin (or restarting dsh) closes
 * them, which is the only point at which the gateway may take the paths back.
 * @param ctx - cordis context owning the effect.
 * @param config - DSH_HOME and gateway origin overrides.
 */
export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  const dshHome = config.dshHome ?? process.env.DSH_HOME ?? join(process.env.HOME ?? '', '.dsh')
  const contract = readCapabilityContract(join(dshHome, CONTRACT_FILE_NAME))
  if (contract === undefined) return
  const gatewayUrl = config.gatewayUrl ?? defaultGatewayUrl()
  await ctx.effect(async () => {
    const servers = await startCapabilityServers({
      directory: dshHome,
      capabilities: contract.capabilities,
      gatewayUrl,
      key: contract.key,
      timeoutMs: config.timeoutMs,
    })
    return () => servers.close()
  }, 'vh-capabilities: tenant capability sockets')
}

/**
 * Gateway origin as this deployment exposes it to tenant processes.
 * @param env - environment carrying the gateway port.
 * @returns the loopback origin for capability egress.
 */
export function defaultGatewayUrl(env: NodeJS.ProcessEnv = process.env): string {
  return `http://127.0.0.1:${env.VH_GATEWAY_PORT ?? '8080'}`
}
