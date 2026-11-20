/**
 * Which shipped product skills each tenant keeps in the Agent's catalog.
 *
 * The bundled root is read-only inside a tenant jail, so a toggle cannot be
 * expressed by editing or renaming a skill directory the way a user-owned skill
 * can. The gateway therefore owns one authoritative list per tenant and hands
 * the instance a copy to watch: the provider drops those names from the next
 * catalog read, and nothing restarts.
 */

import { chmodSync } from 'node:fs'
import { chown, mkdir, open, readdir, readFile, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'

/** The skill names the Agent addresses by; anything else is not a toggle. */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Skills that front a VOS application, grouped apart from authoring tools. */
const SERVICE_SKILLS = new Set(['voffice', 'weknora', 'album', 'image-studio', 'photocraft'])

/** The bundled skill root the image ships, overridable for a relocated deployment. */
function bundledSkillDir() {
  return process.env.BUNDLED_SKILL_DIR ?? '/opt/v-harness/skills'
}

/**
 * The file holding each tenant's disabled list.
 * @returns {string} the authoritative JSON path, overridable for tests.
 */
export function skillTogglesFile() {
  return process.env.SKILL_TOGGLES_FILE ?? join(process.env.STATE_ROOT ?? '/data/.vh', 'skill-toggles.json')
}

/**
 * The tenant copy the instance watches.
 * @param {string} home - absolute tenant home as the gateway sees it.
 * @returns {string} the JSON path inside the tenant's own `.dsh`.
 */
export function tenantTogglesPath(home) {
  return join(home, '.dsh', 'skill-toggles.json')
}

/**
 * Read the authoritative map, dropping entries that cannot be a skill name.
 * @returns {Promise<Record<string, string[]>>} one list per tenant namespace.
 */
async function readToggles() {
  const text = await readFile(skillTogglesFile(), 'utf8').catch(() => undefined)
  if (text === undefined) return {}
  try {
    const parsed = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    /** @type {Record<string, string[]>} */
    const map = {}
    for (const [namespace, names] of Object.entries(parsed)) {
      if (!Array.isArray(names)) continue
      map[namespace] = names.filter((name) => typeof name === 'string' && SKILL_NAME.test(name))
    }
    return map
  } catch (error) {
    // A record this process cannot read means "nothing disabled". Refusing to
    // launch or serve the panel over a stale file would hide the real cause.
    console.error('skill toggles unreadable, treating every skill as enabled:', error?.message ?? error)
    return {}
  }
}

/**
 * Write one `0600` file atomically, handing it to the tenant when asked.
 * @param {string} path - destination.
 * @param {string} text - contents.
 * @param {{ uid?: number }} [owner] - tenant hand-over, uid doubling as gid.
 * @returns {Promise<void>}
 */
async function writeAtomic(path, text, owner = {}) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.${String(process.pid)}.${randomBytes(6).toString('hex')}.tmp`
  const handle = await open(tmp, 'wx', 0o600)
  try {
    await handle.writeFile(text, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  chmodSync(tmp, 0o600)
  if (process.getuid?.() === 0 && owner.uid !== undefined) await chown(tmp, owner.uid, owner.uid)
  await rename(tmp, path)
  chmodSync(path, 0o600)
  if (process.getuid?.() === 0 && owner.uid !== undefined) await chown(path, owner.uid, owner.uid)
}

/**
 * Replace the authoritative map atomically, so a crash never leaves half a file.
 * @param {Record<string, string[]>} map - the whole map to record.
 * @returns {Promise<void>}
 */
async function writeToggles(map) {
  await writeAtomic(skillTogglesFile(), `${JSON.stringify(map, undefined, 2)}\n`)
}

/**
 * The skills this tenant disabled.
 * @param {string} namespace - the tenant's namespace.
 * @returns {Promise<string[]>} the disabled names, empty when nothing is off.
 */
export async function readSkillToggles(namespace) {
  const map = await readToggles()
  return map[namespace] ?? []
}

/**
 * Replace one tenant's disabled list.
 * @param {string} namespace - the tenant's namespace.
 * @param {string[]} disabled - skill names to hide from the Agent.
 * @returns {Promise<string[]>} the list as recorded: deduplicated and validated.
 */
export async function saveSkillToggles(namespace, disabled) {
  const map = await readToggles()
  const unique = [...new Set(disabled.filter((name) => typeof name === 'string' && SKILL_NAME.test(name)))]
  // An empty list is stored as absence: "default on" then has one spelling, and
  // a tenant who re-enables everything leaves no trace to keep interpreting.
  if (unique.length === 0) delete map[namespace]
  else map[namespace] = unique
  await writeToggles(map)
  return unique
}

/**
 * Hand the instance the list it watches. Called before every launch and after
 * every change, so a toggle survives a restart and applies without one.
 * @param {{ home: string, namespace: string, uid?: number }} options - tenant identity and physical home.
 * @returns {Promise<string[]>} the disabled names written.
 */
export async function syncTenantSkillToggles(options) {
  const { home, namespace, uid } = options
  const disabled = await readSkillToggles(namespace)
  await writeAtomic(tenantTogglesPath(home), `${JSON.stringify({ exclude: disabled }, undefined, 2)}\n`, { uid })
  return disabled
}

/**
 * The shipped skills a tenant may toggle, grouped for the settings panel.
 * @returns {Promise<Array<{ name: string, service: boolean }>>} sorted names with their group.
 */
export async function listShippedSkills() {
  const entries = await readdir(bundledSkillDir(), { withFileTypes: true }).catch(() => [])
  return entries
    .filter((entry) => entry.isDirectory() && SKILL_NAME.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .map((name) => ({ name, service: SERVICE_SKILLS.has(name) }))
}
