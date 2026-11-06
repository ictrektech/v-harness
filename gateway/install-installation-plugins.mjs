/**
 * Place the image's agent-side payload next to the dsh runtime.
 *
 * The payload is built into `/opt/v-harness/agent-plugins`. It used to be copied
 * into each tenant profile, which no image could keep: a profile-scoped `pnpm`
 * run (every market install) treats anything outside the profile manifest as
 * extraneous, moves it into `node_modules/.ignored`, and the market deletes that
 * directory — so the market deleted itself halfway through installing a plugin.
 * Resolution reads the installation before the profile (`resolveBundleDir` in
 * app-boot), so packages placed here are what every tenant loads and no
 * profile-scoped install can reach them.
 *
 * Two rules keep the copy safe:
 *
 * - image-owned packages (the payload manifest plus the carrier bundle)
 *   overwrite their installation copy, so an updated image reaches every
 *   tenant at the next start;
 * - every other staged package is copied only when the installation does not
 *   already resolve it, so a runtime dependency or a package another image
 *   layer placed is never shadowed by this payload.
 *
 * @module
 */
import { cpSync, existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** The built payload; a deployment may relocate it. */
const PAYLOAD = process.env.VH_AGENT_PLUGIN_DIR ?? '/opt/v-harness/agent-plugins'

/** The dsh package the runtime runs from; its `node_modules` is the shared resolution root. */
const INSTALLATION = process.env.VH_DSH_PACKAGE_DIR ?? '/usr/local/lib/node_modules/@deepseek-ai/dsh'

/** The carrier bundle, which the payload manifest does not list because it declares no rows of its own. */
const CARRIER = 'vh-agent-plugins'

/**
 * Copy the payload into the shared installation.
 * @param {object} [roots] - the two ends of the copy, for a test or a relocated deployment.
 * @param {string} [roots.payload] - directory holding `manifest.json` and `node_modules`.
 * @param {string} [roots.installation] - the dsh package directory.
 * @returns {{ placed: string[], kept: string[] }} the packages written, and the ones left to the installation.
 * @throws when the payload manifest is unreadable, or names a package the payload does not carry: such an
 * image would silently restore the failure this copy exists to prevent.
 */
export function installAgentPayload({ payload = PAYLOAD, installation = INSTALLATION } = {}) {
  const manifest = JSON.parse(readFileSync(join(payload, 'manifest.json'), 'utf8'))
  const ours = new Set([...manifest.plugins ?? [], CARRIER])
  const shared = join(installation, 'node_modules')
  const install = createRequire(join(installation, 'package.json'))
  const carried = (name) => (install.resolve.paths(name) ?? [])
    .some((path) => existsSync(join(path, name, 'package.json')))
  /** @type {{ placed: string[], kept: string[] }} */
  const report = { placed: [], kept: [] }
  /**
   * Walk one directory of the payload's `node_modules`, expanding scopes.
   * @param {string} dir - directory to walk.
   * @param {string} prefix - scope prefix for the entries, empty at the root.
   * @returns {void}
   */
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const name = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.name.startsWith('@')) {
        walk(join(dir, entry.name), name)
        continue
      }
      if (!ours.has(name) && carried(name)) {
        report.kept.push(name)
        continue
      }
      const target = join(shared, name)
      rmSync(target, { recursive: true, force: true })
      cpSync(join(dir, entry.name), target, { recursive: true })
      report.placed.push(name)
    }
  }
  walk(join(payload, 'node_modules'), '')
  const missing = [...ours].filter((name) => !existsSync(join(shared, name, 'package.json')))
  if (missing.length > 0) {
    throw new Error(`agent payload carries no ${missing.join(', ')} under ${payload}/node_modules`)
  }
  return report
}

/**
 * Run the copy for the image build and print what it did.
 * @returns {void}
 */
function main() {
  const report = installAgentPayload()
  console.log(`agent payload: placed ${String(report.placed.length)} package(s), left ${String(report.kept.length)} to the installation`)
  for (const name of report.placed) console.log(`  placed ${name}`)
  for (const name of report.kept) console.log(`  kept ${name}`)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main()
