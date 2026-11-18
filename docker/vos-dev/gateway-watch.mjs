/**
 * Live-debug gateway launcher.
 *
 * `node --watch` restarts the gateway whenever a file it imported changes,
 * including the bind-mounted gateway sources. The container supervisor remains
 * PID 1, so a restart leaves every tenant dsh process running and the next
 * gateway adopts it from the persistent instance registry.
 */
import { spawn } from 'node:child_process'

const ENTRY = '/opt/v-harness/gateway/server.mjs'

const child = spawn(process.execPath, ['--watch', '--watch-preserve-output', ENTRY], { stdio: 'inherit' })

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => { child.kill(signal) })
}

child.on('exit', (code, signal) => {
  process.exit(signal === null ? code ?? 0 : 0)
})
