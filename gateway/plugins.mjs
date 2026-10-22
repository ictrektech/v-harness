/**
 * Install the Host and browser packages built for this VOS image.
 *
 * A dsh profile installs its web bundles from the npm registry, so a panel
 * built in this repository would otherwise be replaced by the published copy
 * the first time a user signs in — and a new user would never see it at all.
 * The image carries the built plugin under `/opt/v-harness/plugins`, and this
 * module copies it over the profile's copy once dsh has finished installing.
 *
 * The copy must happen before dsh starts, not after. One client bundle is read
 * exactly once at boot — its mtime/ctime/size become the immutable `?rev=` URL
 * and its bytes stay in memory — so a copy that lands after the process started
 * is invisible until the next restart. The image also installs these artifacts
 * into the shared dsh installation, which default profiles use without a local
 * node_modules tree. Existing profile-local overrides are synchronized before
 * their web process starts.
 *
 * @module
 */
import { execFile } from 'node:child_process'
import { cp, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

/** Where the image puts built client plugins. */
const PLUGIN_ROOT = '/opt/v-harness/plugins'
const INSTALLATION_MODULES = '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'

/** Plugins shipped from this repository, by package name. */
const BUNDLED = ['dsh-client-ui-knowledge', 'dsh-client-ui-user-questions', 'dsh-client-ui-tool-cards', 'dsh-client-ui-settings-models', 'dsh-llm-pi-ai', 'dsh-api-session-controller']

/**
 * Copy the image's build of each bundled plugin over one profile's copy.
 * @param {{
 *   home: string,
 *   linuxName: string,
 *   uid: number,
 * }} user - the tenant whose profile to update.
 * @returns {Promise<void>} resolves once every present plugin was replaced;
 *   a managed-package failure prevents launching an inconsistent runtime.
 */
export async function syncClientPlugins(user) {
  const modules = join(user.home, '.dsh', 'profiles', 'web', 'node_modules', '@deepseek-ai')
  for (const name of BUNDLED) {
    const source = join(PLUGIN_ROOT, name)
    const target = join(modules, name)
    if (!(await exists(source))) {
      if (['dsh-client-ui-settings-models', 'dsh-llm-pi-ai', 'dsh-api-session-controller'].includes(name)) throw new Error(`deployed plugin missing: ${name}`)
      continue
    }
    // Default profiles resolve bundled packages from the shared installation.
    // Docker installs the matching artifacts there before any tenant starts.
    if (!(await exists(join(target, 'package.json')))) {
      if (['dsh-client-ui-settings-models', 'dsh-llm-pi-ai', 'dsh-api-session-controller'].includes(name)
          && !(await exists(join(INSTALLATION_MODULES, name, 'package.json')))) throw new Error(`installed plugin missing: ${name}`)
      continue
    }
    try {
      await rm(target, { recursive: true, force: true })
      await cp(source, target, { recursive: true })
      await chownTo(target, user.uid, user.linuxName)
    } catch (error) {
      throw new Error(`plugin sync failed: ${name}`, { cause: error })
    }
  }
}

/**
 * @param {string} path
 * @returns {Promise<boolean>} whether the path exists.
 */
async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * Hand the copied tree to the tenant; the gateway runs as root.
 * @param {string} path
 * @param {number} uid
 * @param {string} group
 * @returns {Promise<void>}
 */
function chownTo(path, uid, group) {
  return new Promise((resolve) => {
    execFile('chown', ['-R', `${String(uid)}:${group}`, path], () => { resolve() })
  })
}
