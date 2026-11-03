/**
 * The gateway faces the browser with JSON only: the list under `/__vh/services`
 * and two state-changing actions. Nothing here names the session — the browser
 * carries the portal cookie, and the gateway resolves the tenant from it.
 */

/** One registered service, as `GET /__vh/services` returns it. */
export interface ServiceEntry {
  readonly port: number
  readonly name: string
  readonly running: boolean
  readonly basePath: string | undefined
  /** Last heartbeat, epoch milliseconds. */
  readonly lastSeen: number
  readonly restartable: boolean
}

/**
 * @returns the tenant's own services, newest heartbeat order kept by the gateway.
 */
export async function fetchServices(): Promise<ServiceEntry[]> {
  const response = await fetch('/__vh/services', { credentials: 'same-origin', cache: 'no-store' })
  if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
  const body = await response.json() as { services?: readonly ServiceEntry[] }
  return Array.isArray(body?.services) ? [...body.services] : []
}

/**
 * Restart or stop one service.
 * @param port - the service's registered loopback port.
 * @param action - which state change to ask for.
 */
export async function serviceAction(port: number, action: 'restart' | 'stop'): Promise<void> {
  const response = await fetch(`/__vh/services/${String(port)}/${action}`, {
    method: 'POST',
    credentials: 'same-origin',
  })
  if (!response.ok) {
    const body = await response.json().catch(() => undefined) as { message?: string } | undefined
    throw new Error(typeof body?.message === 'string' ? body.message : `HTTP ${String(response.status)}`)
  }
}

/**
 * The address a browser opens the service at: the gateway proxies
 * `/__vh/svc/<port>/<rest>` to `127.0.0.1:<port>` for the owning session.
 * @param port - the service's registered loopback port.
 * @param basePath - path prefix the app expects, when it declared one.
 */
export function serviceUrlFor(port: number, basePath: string | undefined): string {
  return `/__vh/svc/${String(port)}${basePath ?? '/'}`
}
