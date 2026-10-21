/**
 * Keep the browser plugins this image builds ahead of the published ones.
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
 * is invisible until the next restart. {@link syncClientPlugins} is therefore
 * called before spawn, and again afterwards only for a profile this launch
 * created (no tree existed earlier); that tenant sees the build from the next
 * start on.
 *
 * @module
 */
import { execFile } from 'node:child_process'
import { cp, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

/** Where the image puts built client plugins. */
const PLUGIN_ROOT = '/opt/v-harness/plugins'

/** Plugins shipped from this repository, by package name. */
const BUNDLED = ['dsh-client-ui-knowledge', 'dsh-client-ui-user-questions', 'dsh-client-ui-tool-cards']

/**
 * Copy the image's build of each bundled plugin over one profile's copy.
 * @param {{
 *   home: string,
 *   linuxName: string,
 *   uid: number,
 * }} user - the tenant whose profile to update.
 * @returns {Promise<void>} resolves once every present plugin was replaced;
 *   a failure is logged and never breaks the launch.
 */
export async function syncClientPlugins(user) {
  const modules = join(user.home, '.dsh', 'profiles', 'web', 'node_modules', '@deepseek-ai')
  for (const name of BUNDLED) {
    const source = join(PLUGIN_ROOT, name)
    const target = join(modules, name)
    if (!(await exists(source)) || !(await exists(join(target, 'package.json')))) continue
    try {
      await rm(target, { recursive: true, force: true })
      await cp(source, target, { recursive: true })
      await chownTo(target, user.uid, user.linuxName)
    } catch (error) {
      console.error(`plugin sync failed for ${name} in ${user.linuxName}:`, error.message)
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
