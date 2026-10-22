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
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Where the image puts built client plugins. */
const PLUGIN_ROOT = '/opt/v-harness/plugins'
const INSTALLATION_MODULES = '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'

/** Where the image puts the built agent-side tool plugins and their carrier. */
const AGENT_PLUGIN_ROOT = process.env.VH_AGENT_PLUGIN_DIR ?? '/opt/v-harness/agent-plugins'

/** The carrier bundle that mounts the agent-side plugin rows. */
const AGENT_BUNDLE_NAME = 'vh-agent-plugins'

/**
 * Pre-created profile manifest fields. dsh initializes the same content on
 * first use (packages/boot/app-boot profile.ts); creating it here lets the
 * FIRST boot already resolve the carrier bundle and its plugin packages, so
 * a tenant's first login ships the full tool surface instead of a degraded
 * one. dsh never overwrites existing profile files, so pre-creation wins.
 */
const PROFILE_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', AGENT_BUNDLE_NAME]

/** Mirrors dsh's profile user-patch template. */
const PROFILE_PATCH_TEMPLATE = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
[]
`

/** Mirrors dsh's profile pnpm settings: hoisted, peers resolved at runtime. */
const PROFILE_PNPM_WORKSPACE = `packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
`

/** Plugins shipped from this repository, by package name. */
const MANAGED = ['dsh-client-ui-settings-models', 'dsh-llm-pi-ai', 'dsh-api-session-controller', 'dsh-api-remotes']
const BUNDLED = ['dsh-client-ui-knowledge', 'dsh-client-ui-user-questions', 'dsh-client-ui-tool-cards', ...MANAGED]

/**
 * Create the tenant's profile directory before dsh's first boot when it does
 * not exist yet, with the same manifest, user patch, and pnpm settings dsh's
 * own initialization writes — plus the carrier bundle in the layer list. The
 * staged packages ride along below, so the first boot resolves every plugin
 * row without a degraded first session. Every file stays absent-proof:
 * existing profile files are never touched.
 * @param {{
 *   home: string,
 *   linuxName: string,
 *   uid: number,
 * }} user - the tenant whose profile to initialize.
 * @returns {Promise<string>} the profile directory.
 */
async function ensureProfile(user) {
  const profile = join(user.home, '.dsh', 'profiles', 'web')
  const manifestPath = join(profile, 'package.json')
  if (await exists(manifestPath)) return profile
  await mkdir(profile, { recursive: true, mode: 0o700 })
  const manifest = {
    name: 'dsh-profile-web',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: [...PROFILE_BUNDLES] } },
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`)
  await writeFile(join(profile, 'cordis.patch.yml'), PROFILE_PATCH_TEMPLATE)
  await writeFile(join(profile, 'pnpm-workspace.yaml'), PROFILE_PNPM_WORKSPACE)
  // mkdir ran as root: hand the created .dsh chain to the tenant, whose dsh
  // process writes sessions and credentials under it.
  await chownTo(join(user.home, '.dsh'), user.uid, user.linuxName)
  return profile
}

/**
 * One entry point for everything plugin-related a launch needs: pre-create
 * the profile, refresh the client bundles, and stage the agent-side plugins.
 * Called before spawn and again after a first launch (which created nothing
 * to stage before dsh's profile install could prune it — with the profile
 * pre-created here that second call is a plain no-op refresh).
 * @param {{
 *   home: string,
 *   linuxName: string,
 *   uid: number,
 * }} user - the tenant whose profile to update.
 * @returns {Promise<void>} resolves once the profile was updated; a failure
 *   is logged and never breaks the launch.
 */
export async function syncPlugins(user) {
  try {
    await ensureProfile(user)
  } catch (error) {
    console.error(`profile pre-creation failed for ${user.linuxName}:`, error.message)
  }
  await syncClientPlugins(user)
  await syncAgentPlugins(user)
}

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
      if (MANAGED.includes(name)) throw new Error(`deployed plugin missing: ${name}`)
      continue
    }
    // Default profiles resolve bundled packages from the shared installation.
    // Docker installs the matching artifacts there before any tenant starts.
    if (!(await exists(join(target, 'package.json')))) {
      if (MANAGED.includes(name)
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
 * Copy the image's agent-side tool plugins into one tenant's profile and
 * mount the carrier bundle.
 *
 * The profile installs its harness packages from the npm registry, and these
 * plugins are unpublished, so dsh would skip their rows on every start. Two
 * rules keep the copy safe:
 *
 * - the plugin packages and the carrier overwrite whatever the profile holds
 *   (a broken earlier hand-install must not survive, and an updated image
 *   must reach existing tenants);
 * - every other staged package is copied only when missing, so a published
 *   or runtime-resolved dependency is never shadowed by this payload.
 *
 * Runs after {@link ensureProfile}, so a brand-new tenant's first boot
 * already resolves the carrier bundle and its plugin packages.
 *
 * @param {{
 *   home: string,
 *   linuxName: string,
 *   uid: number,
 * }} user - the tenant whose profile to update.
 * @returns {Promise<void>} resolves once the profile was updated; a failure
 *   is logged and never breaks the launch.
 */
async function syncAgentPlugins(user) {
  let manifest
  try {
    manifest = JSON.parse(await readFile(join(AGENT_PLUGIN_ROOT, 'manifest.json'), 'utf8'))
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      console.error('agent plugin sync skipped: cannot read manifest:', error.message)
    }
    return
  }
  const profile = join(user.home, '.dsh', 'profiles', 'web')
  const plugins = new Set(manifest.plugins ?? [])
  const payloadModules = join(AGENT_PLUGIN_ROOT, 'node_modules')
  const modules = join(profile, 'node_modules')
  for (const relative of await stagedPackagePaths(payloadModules)) {
    const parts = relative.split('/')
    const name = relative.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
    // The carrier must refresh on every start so an updated image's rows
    // reach existing tenants.
    const overwrite = plugins.has(name) || name === AGENT_BUNDLE_NAME
    const target = join(modules, relative)
    if (overwrite || !(await exists(join(target, 'package.json')))) {
      try {
        await rm(target, { recursive: true, force: true })
        await cp(join(payloadModules, relative), target, { recursive: true })
        await chownTo(target, user.uid, user.linuxName)
      } catch (error) {
        console.error(`agent plugin sync failed for ${name} in ${user.linuxName}:`, error.message)
      }
    }
  }
  await mountAgentBundle(profile, user)
}

/**
 * Staged payload package paths: top-level entries, with @scopes expanded.
 * @param {string} root - the payload's node_modules directory.
 * @returns {Promise<string[]>} package paths relative to the modules root,
 *   sorted.
 */
async function stagedPackagePaths(root) {
  const paths = []
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return paths
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (entry.name.startsWith('@')) {
      for (const child of await readdir(join(root, entry.name), { withFileTypes: true })) {
        if (child.isDirectory()) paths.push(`${entry.name}/${child.name}`)
      }
    } else {
      paths.push(entry.name)
    }
  }
  return paths.sort()
}

/**
 * Append the carrier bundle to the profile's bundle list (idempotent JSON
 * edit). The bundle layer it adds is what mounts the plugin rows; without it
 * the copied packages would sit in node_modules unloaded.
 * @param {string} profile - the tenant's profile directory.
 * @param {{ linuxName: string }} user - the tenant, for diagnostics.
 * @returns {Promise<void>}
 */
async function mountAgentBundle(profile, user) {
  const manifestPath = join(profile, 'package.json')
  try {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    const bundles = manifest?.dsh?.profile?.bundles
    if (!Array.isArray(bundles) || bundles.includes(AGENT_BUNDLE_NAME)) return
    bundles.push(AGENT_BUNDLE_NAME)
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  } catch (error) {
    console.error(`agent bundle mount failed for ${user.linuxName}:`, error.message)
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
