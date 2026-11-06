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
import { randomUUID } from 'node:crypto'
import { cp, mkdir, readFile, readdir, readlink, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

/** Where the image puts built client plugins; a deployment may relocate both roots. */
const PLUGIN_ROOT = process.env.VH_PLUGIN_DIR ?? '/opt/v-harness/plugins'
const INSTALLATION_MODULES = process.env.VH_DSH_MODULES_DIR
  ?? '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'

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
 *
 * The registry plugins follow the carrier layer because their own
 * `dsh.bundle.patch` files mount their rows — and ds-bot's also restates the
 * `web` row's search provider. A profile patch that names another provider
 * still wins, since the tenant's patch layer applies after every bundle.
 */
const PROFILE_BUNDLES = [
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  AGENT_BUNDLE_NAME,
  'dshmarket',
  'ds-bot',
]

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
 * the profile, refresh the client bundles, stage the agent-side plugins, and
 * finish the bundle list. Called before spawn and again after a first launch
 * (which created nothing to stage before dsh's profile install could prune
 * it — with the profile pre-created here that second call is a no-op refresh).
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
  // A profile that predates a bundle must still receive it: pre-creation
  // returns early for an existing manifest, so this is the only path that
  // upgrades a tenant who already signed in.
  await mountProfileBundles(user)
}

/**
 * Replace one profile package directory with the image's build.
 *
 * The copy is staged beside the target and renamed into place. `rm` then `cp`
 * leaves the package missing for the whole copy, and any tenant process still
 * importing from that path dies on it; the rename window is a single syscall.
 * It also makes two writers converge: the loser of a rename retries instead of
 * failing the launch (`EEXIST` on the package directory).
 *
 * @param {string} source - image build of the package.
 * @param {string} target - profile copy to replace.
 * @returns {Promise<void>}
 */
async function replaceDirectory(source, target) {
  const staged = `${target}.vh-${String(process.pid)}-${randomUUID().slice(0, 8)}`
  await rm(staged, { recursive: true, force: true })
  await cp(source, staged, { recursive: true })
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rm(target, { recursive: true, force: true })
      await rename(staged, target)
      return
    } catch (error) {
      const retryable = ['EEXIST', 'ENOTEMPTY', 'EBUSY'].includes(error?.code)
      if (!retryable || attempt >= 2) {
        await rm(staged, { recursive: true, force: true }).catch(() => {})
        throw error
      }
      await new Promise(resolve => setTimeout(resolve, 50 * (attempt + 1)))
    }
  }
}

/** Suffix {@link replaceDirectory} stages under: `<target>.vh-<pid>-<8 hex>`. */
const STAGING_SUFFIX = /\.vh-[0-9]+-[0-9a-f]{8}$/

/** Age past which a staging directory cannot belong to a copy still in flight. */
const STAGING_STALE_MS = 10 * 60 * 1000

/**
 * Remove staging directories an interrupted copy left beside its targets.
 *
 * {@link replaceDirectory} copies a whole package into `<target>.vh-<pid>-<rand>`
 * and renames it into place, so a gateway that dies mid-copy — a restart, a
 * killed launch — leaves the staging directory behind and nothing ever collects
 * it. A directory younger than {@link STAGING_STALE_MS} is left alone: a second
 * launch for the same tenant may be copying into it right now.
 *
 * @param {string} root - the profile's `node_modules` directory.
 * @returns {Promise<void>}
 */
async function pruneStaleStaging(root) {
  const now = Date.now()
  const sweep = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory() || !STAGING_SUFFIX.test(entry.name)) continue
      const path = join(dir, entry.name)
      const info = await stat(path).catch(() => undefined)
      if (info === undefined || now - info.mtimeMs < STAGING_STALE_MS) continue
      await rm(path, { recursive: true, force: true }).catch(() => {})
    }
  }
  await sweep(root)
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory() && entry.name.startsWith('@')) await sweep(join(root, entry.name))
  }
}

/**
 * Copy the image's build of each deployed plugin over one profile's copy.
 *
 * The payload directory is the list: whatever the image built is what a tenant
 * gets. A hand-maintained name list drifted from the source tree once and
 * silently shipped the published copies of a forked browser plugin, so an
 * added package now only has to reach the image to reach the profiles.
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
  await pruneStaleStaging(join(user.home, '.dsh', 'profiles', 'web', 'node_modules'))
  // A deployment without the payload directory is not the image: it has nothing
  // to overlay, and failing here would keep every instance from starting.
  if (!(await exists(PLUGIN_ROOT))) return
  const deployed = (await readdir(PLUGIN_ROOT, { withFileTypes: true }).catch(() => []))
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
  // A payload that exists but carries nothing is a broken image, not a choice.
  if (deployed.length === 0) throw new Error(`plugin payload is empty: ${PLUGIN_ROOT}`)
  for (const name of MANAGED) {
    if (!deployed.includes(name)) throw new Error(`deployed plugin missing: ${name}`)
  }
  for (const name of deployed) {
    const source = join(PLUGIN_ROOT, name)
    const target = join(modules, name)
    // Default profiles resolve bundled packages from the shared installation.
    // Docker installs the matching artifacts there before any tenant starts.
    // A package the published dependency graph never carried has no profile
    // copy at all, so it is created here: the carrier bundle mounts its row and
    // the profile-scope resolution needs the directory to exist.
    if (!(await exists(join(target, 'package.json')))
        && MANAGED.includes(name)
        && !(await exists(join(INSTALLATION_MODULES, name, 'package.json')))) {
      throw new Error(`installed plugin missing: ${name}`)
    }
    try {
      await mkdir(modules, { recursive: true })
      // The profile's own install writes here later, so the scope directory
      // and its `node_modules` parent belong to the tenant, not to root.
      await chownDir(join(user.home, '.dsh', 'profiles', 'web', 'node_modules'), user.uid, user.linuxName)
      await chownDir(modules, user.uid, user.linuxName)
      await replaceDirectory(source, target)
      await chownTo(target, user.uid, user.linuxName)
    } catch (error) {
      throw new Error(`plugin sync failed: ${name}`, { cause: error })
    }
  }
}

/**
 * Verify the image's agent-side payload against one tenant's profile.
 *
 * The payload packages ride in the shared dsh installation — the image copies
 * them next to the runtime at build time — so bundle resolution finds them
 * through the installation anchor, and a profile-scoped pnpm run, which is
 * what every market install performs, can never remove them. Nothing is
 * staged into the profile any more. What remains is the repair for `link:`
 * dependencies an earlier revision left behind and the check that the payload
 * actually carries what this image promises.
 *
 * Runs after {@link ensureProfile}, so a brand-new tenant's first boot
 * resolves the carrier bundle and its plugin packages from the installation.
 *
 * @param {{
 *   home: string,
 *   linuxName: string,
 *   uid: number,
 * }} user - the tenant whose profile to update.
 * @returns {Promise<void>} resolves once the profile was checked; a failure
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
  await mkdir(modules, { recursive: true })
  await chownDir(modules, user.uid, user.linuxName)
  await materializePayloadLinks(modules, payloadModules, user)
  // A name the manifest lists but the payload lacks used to leave no trace: the
  // tenant silently booted without that plugin (no market, no bot) and nothing
  // was logged. An image whose payload was copied without these packages must
  // say so.
  for (const name of plugins) {
    if (await exists(join(payloadModules, name))) continue
    console.error(`agent plugin missing from payload: ${name} (tenant ${user.linuxName}, root ${AGENT_PLUGIN_ROOT})`)
  }
}

/**
 * Replace symlinks that point into the image payload with real directories.
 *
 * `link:` dependencies from an earlier revision left these in a profile's
 * `node_modules`. They resolve inside the container, so the "already installed"
 * check in {@link syncAgentPlugins} skips them, but the tenant's jail never
 * mounts the payload root: inside the jail every one of them is a broken import
 * ("Cannot find package …") that silently drops whichever plugin needed it.
 *
 * @param {string} modules - the profile's node_modules directory.
 * @param {string} payloadModules - the payload's node_modules directory.
 * @param {{ linuxName: string, uid: number }} user - the tenant being repaired.
 * @returns {Promise<void>}
 */
async function materializePayloadLinks(modules, payloadModules, user) {
  /** @type {string[]} */
  const candidates = []
  for (const entry of await readdir(modules, { withFileTypes: true }).catch(() => [])) {
    if (entry.name.startsWith('@')) {
      for (const child of await readdir(join(modules, entry.name)).catch(() => [])) {
        candidates.push(`${entry.name}/${child}`)
      }
    } else {
      candidates.push(entry.name)
    }
  }
  for (const relative of candidates) {
    const target = join(modules, relative)
    const link = await readlink(target).catch(() => undefined)
    if (link === undefined) continue
    const resolved = resolve(modules, link)
    const insidePayload = [PLUGIN_ROOT, AGENT_PLUGIN_ROOT].some(
      (root) => resolved === root || resolved.startsWith(`${root}/`),
    )
    if (!insidePayload) continue
    const source = join(payloadModules, relative)
    if (!await exists(join(source, 'package.json'))) continue
    try {
      await rm(target, { recursive: true, force: true })
      await replaceDirectory(source, target)
      await chownTo(target, user.uid, user.linuxName)
    } catch (error) {
      console.error(`payload link repair failed for ${relative} in ${user.linuxName}:`, error.message)
    }
  }
}

/**
 * Whether one dependency spec points at this image's plugin payload.
 * @param {unknown} spec - a manifest dependency value.
 * @returns {boolean}
 */
function isPayloadLink(spec) {
  return typeof spec === 'string'
    && spec.startsWith('link:')
    && (spec.includes(PLUGIN_ROOT) || spec.includes(AGENT_PLUGIN_ROOT))
}

/**
 * Append the bundles a profile is missing (idempotent JSON edit). A bundle
 * layer is what mounts its plugin rows; without the entry the copied packages
 * would sit in node_modules unloaded. Appended in {@link PROFILE_BUNDLES}
 * order, so a later layer still overrides an earlier one.
 * @param {string} profile - the tenant's profile directory.
 * @param {{ linuxName: string }} user - the tenant, for diagnostics.
 * @param {readonly string[]} names - bundle package names that must be listed.
 * @returns {Promise<void>}
 */
async function mountBundles(profile, user, names) {
  const manifestPath = join(profile, 'package.json')
  try {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    const bundles = manifest?.dsh?.profile?.bundles
    if (!Array.isArray(bundles)) return
    let changed = false
    for (const name of names) {
      if (bundles.includes(name)) continue
      bundles.push(name)
      changed = true
    }
    // An earlier revision declared these bundles as `link:` dependencies onto
    // this image's payload. `pnpm install` runs inside the tenant's jail, where
    // that path does not exist, so the install failed and left the profile's
    // `node_modules` incomplete — the browser bundles resolved from there then
    // failed to activate ("1 entry did not activate"). Bundles are copied into
    // the profile by this module; the manifest never needs to name them, and a
    // stale entry is removed here so an affected tenant repairs itself.
    const dependencies = manifest.dependencies ?? {}
    for (const [name, spec] of Object.entries(dependencies)) {
      if (!isPayloadLink(spec)) continue
      delete dependencies[name]
      changed = true
    }
    if (!changed) return
    if (Object.keys(dependencies).length > 0) manifest.dependencies = dependencies
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  } catch (error) {
    console.error(`bundle mount failed for ${user.linuxName}:`, error.message)
  }
}

/**
 * Ensure one tenant's profile lists every bundle this image ships.
 * @param {{
 *   home: string,
 *   linuxName: string,
 *   uid: number,
 * }} user - the tenant whose profile to update.
 * @returns {Promise<void>}
 */
async function mountProfileBundles(user) {
  await mountBundles(join(user.home, '.dsh', 'profiles', 'web'), user, PROFILE_BUNDLES)
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

/**
 * Hand one directory, not its contents, to the tenant.
 *
 * `chownTo` recurses, which fits a package copy but not `node_modules` itself:
 * that directory holds thousands of entries that already belong to the tenant,
 * and it has to stay writable so the profile's own install can add a package.
 * A root-owned `node_modules` is what turns a plugin install into EACCES for
 * the tenant, and a shared one is what lets two tenants see each other's
 * plugin store.
 *
 * @param {string} path - directory to hand over.
 * @param {number} uid - tenant uid.
 * @param {string} group - tenant group name.
 * @returns {Promise<void>}
 */
function chownDir(path, uid, group) {
  return new Promise((resolve) => {
    execFile('chown', [`${String(uid)}:${group}`, path], () => { resolve() })
  })
}
