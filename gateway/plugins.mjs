/**
 * Install the Host and browser packages built for this VOS image.
 *
 * A dsh profile installs its web bundles from the npm registry, so a panel
 * built in this repository would otherwise be replaced by the published copy
 * the first time a user signs in — and a new user would never see it at all.
 * The image carries the built plugin under `/opt/v-harness/plugins`, and this
 * module stages it before the tenant's web process starts.
 *
 * Two rules, and they cover every package the image ships:
 *
 * - a published plugin is a declared dependency of the profile, so `pnpm`
 *   installs it, keeps it, and repairs it on every run;
 * - everything else — the unpublished carrier and the browser builds whose
 *   package the registry does not carry — goes into the shared layer
 *   `<home>/.dsh/profiles/node_modules`, which dsh resolves from the profile
 *   but a profile-scoped `pnpm` run never manages. A copy inside the profile
 *   instead is what deleted itself on the next install.
 *
 * The copy must happen before dsh starts, not after. One client bundle is read
 * exactly once at boot — its mtime/ctime/size become the immutable `?rev=` URL
 * and its bytes stay in memory — so a copy that lands after the process started
 * is invisible until the next restart.
 *
 * @module
 */
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Where the image puts built client plugins; a deployment may relocate both roots. */
const PLUGIN_ROOT = process.env.VH_PLUGIN_DIR ?? '/opt/v-harness/plugins'

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
  '@xmanrui/dsh-im',
  'dsh-mcp-connector',
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

/**
 * Pin one profile's pnpm store to the path the tenant sees.
 *
 * The same home has two names inside the container: root and the gateway see
 * `<home>`, the tenant's jail sees `/home/<account>`. `pnpm` records the store's
 * absolute path in `node_modules/.modules.yaml` and refuses every later install
 * with `ERR_PNPM_UNEXPECTED_STORE` once the recorded path and the resolved one
 * differ — which happens the first time a copy is built outside the jail. The
 * setting makes both views resolve the same store, and a profile that already
 * recorded another one has its `node_modules` rebuilt, the only way to clear it.
 * @param {{ home: string, linuxName: string, uid: number }} user - the tenant.
 * @returns {Promise<void>} resolves once the profile agrees on one store.
 */
async function alignProfileStore(user) {
  const profile = join(user.home, '.dsh', 'profiles', 'web')
  const workspace = join(profile, 'pnpm-workspace.yaml')
  const current = await readFile(workspace, 'utf8').catch(() => undefined)
  if (current === undefined) return
  const storeDir = `/home/${user.linuxName}/.local/share/pnpm/store`
  if (current.includes(`storeDir: ${storeDir}`)) return
  const next = /^storeDir:.*$/mu.test(current)
    ? current.replace(/^storeDir:.*$/mu, `storeDir: ${storeDir}`)
    : `${current.trimEnd()}\nstoreDir: ${storeDir}\n`
  await writeFile(workspace, next)
  await rm(join(profile, 'node_modules'), { recursive: true, force: true }).catch(() => {})
}

/** Plugins shipped from this repository, by package name. */
const MANAGED = ['dsh-client-ui-settings-models', 'dsh-llm-pi-ai', 'dsh-api-session-controller', 'dsh-api-remotes']

/**
 * Payload plugins that are published, so a profile declares them like any other
 * dependency. `@xmanrui/dsh-im` is the IM bridge (WeCom/Feishu/DingTalk/QQ/
 * Telegram/...), a third-party registry package staged like the market and the
 * bot: its version is read from the payload, never pinned here.
 * `dsh-mcp-connector` is the MCP connection manager, staged the same way.
 */
const PROFILE_PLUGINS = ['dshmarket', 'ds-bot', '@xmanrui/dsh-im', 'dsh-mcp-connector']

/**
 * The dependencies every tenant profile declares: the published payload
 * plugins, pinned to the version this image was built and tested with.
 *
 * Declaring them is what makes them survive. `pnpm` treats a package the
 * manifest does not name as extraneous and moves it into `node_modules/.ignored`
 * on the next install; every market install runs one, so an undeclared market
 * deleted itself — and the bot, the carrier and the client panels — halfway
 * through installing a plugin. A declared package is never extraneous, whatever
 * pnpm version answers.
 * @returns {Promise<Record<string, string>>} package name → exact version.
 */
async function profileDependencies() {
  /** @type {Record<string, string>} */
  const dependencies = {}
  for (const name of PROFILE_PLUGINS) {
    try {
      const manifest = JSON.parse(await readFile(join(AGENT_PLUGIN_ROOT, 'node_modules', name, 'package.json'), 'utf8'))
      if (typeof manifest.version === 'string') dependencies[name] = manifest.version
    } catch (_error) {
      // Not the image, or a payload without that plugin: nothing to declare.
      // The bundle list still says what the image intends.
    }
  }
  return dependencies
}

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
    dependencies: await profileDependencies(),
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
  await alignProfileStore(user)
  await syncClientPlugins(user)
  await syncAgentPlugins(user)
  // A profile that predates a bundle must still receive it: pre-creation
  // returns early for an existing manifest, so this is the only path that
  // upgrades a tenant who already signed in.
  await mountProfileBundles(user)
}

/**
 * Fingerprint a source tree without copying it.
 *
 * A restart used to recopy the whole payload — 83 MB across 4400 files — for
 * every tenant boot, which is most of the twenty seconds a restart took. File
 * count, total bytes and the newest mtime move on any image rebuild and stay
 * put otherwise, so the copy can be skipped when the fingerprint matches what
 * the target was built from.
 *
 * @param {string} root - source directory.
 * @returns {Promise<string>} a comparable stamp.
 */
async function treeStamp(root) {
  let count = 0
  let bytes = 0
  let newest = 0
  /** @param {string} dir */
  const walk = async (dir) => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(path)
        continue
      }
      const info = await stat(path).catch(() => undefined)
      if (info === undefined) continue
      count += 1
      bytes += info.size
      if (info.mtimeMs > newest) newest = info.mtimeMs
    }
  }
  await walk(root)
  return `${String(count)}:${String(bytes)}:${String(Math.trunc(newest))}`
}

/**
 * Read the stamp ledger that records which source build each target holds.
 * @param {string} path
 * @returns {Promise<Record<string, string>>}
 */
async function readStamps(path) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
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

/**
 * The `node_modules` shared by every profile under one home.
 *
 * A row whose package no manifest declares is resolved by Node's ancestor
 * lookup from the profile directory, and this is the last position below the
 * tenant home. It is also the one position a profile-scoped `pnpm` run never
 * manages: pnpm prunes its own `node_modules` against the manifest, so a copy
 * staged there is deleted by the next install — every market install is one.
 * @param {string} home - the tenant home.
 * @returns {string} the shared layer directory.
 */
function profileLayer(home) {
  return join(home, '.dsh', 'profiles', 'node_modules')
}

/**
 * Remove a copy an earlier revision staged inside the profile itself.
 *
 * Such a copy sits below the layer, so it answers first and then disappears on
 * the tenant's next install. A package the profile declares is left alone:
 * `pnpm` installs, owns, and repairs that one.
 * @param {string} profile - the tenant's profile directory.
 * @param {string} relative - package name relative to `node_modules`.
 * @returns {Promise<void>}
 */
async function clearLegacyCopy(profile, relative) {
  const declared = await readProfileDependencies(profile)
  if (Object.hasOwn(declared, relative)) return
  await rm(join(profile, 'node_modules', relative), { recursive: true, force: true }).catch(() => {})
}

/**
 * The dependencies one profile declares.
 * @param {string} profile - the profile directory.
 * @returns {Promise<Record<string, unknown>>} declared dependencies, empty when unreadable.
 */
async function readProfileDependencies(profile) {
  try {
    const manifest = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))
    const dependencies = manifest?.dependencies
    return dependencies !== null && typeof dependencies === 'object' ? dependencies : {}
  } catch (_error) {
    // A profile dsh has not created yet declares nothing; nothing is protected.
    return {}
  }
}

/**
 * Stage the image's build of each deployed browser plugin into the shared layer.
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
 * @returns {Promise<void>} resolves once every present plugin was staged;
 *   a managed-package failure prevents launching an inconsistent runtime.
 */
export async function syncClientPlugins(user) {
  const profile = join(user.home, '.dsh', 'profiles', 'web')
  const layer = profileLayer(user.home)
  const modules = join(layer, '@deepseek-ai')
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
  try {
    await mkdir(modules, { recursive: true })
    // The tenant's own dsh process reads under this directory; root must not
    // keep it.
    await chownDir(layer, user.uid, user.linuxName)
    await chownDir(modules, user.uid, user.linuxName)
  } catch (error) {
    throw new Error('plugin layer is not writable', { cause: error })
  }
  const stampPath = join(modules, '.vh-sync.json')
  const stamps = await readStamps(stampPath)
  for (const name of deployed) {
    const target = join(modules, name)
    const source = join(PLUGIN_ROOT, name)
    const stamp = await treeStamp(source)
    if (stamps[name] === stamp && (await exists(join(target, 'package.json')))) {
      await clearLegacyCopy(profile, `@deepseek-ai/${name}`)
      continue
    }
    try {
      await replaceDirectory(source, target)
      await chownTo(target, user.uid, user.linuxName)
    } catch (error) {
      throw new Error(`plugin sync failed: ${name}`, { cause: error })
    }
    stamps[name] = stamp
    await writeFile(stampPath, JSON.stringify(stamps), { mode: 0o600 }).catch(() => {})
    await clearLegacyCopy(profile, `@deepseek-ai/${name}`)
  }
}

/**
 * Stage the image's agent-side payload for one tenant.
 *
 * A published payload plugin is a declared profile dependency and lands in the
 * profile's own `node_modules`, where `pnpm` owns it. Everything else lands in
 * the shared layer (see {@link profileLayer}): those packages are not on the
 * registry, so no manifest can declare them, and a copy inside the profile is
 * extraneous to the next install. Two rules keep the copy safe:
 *
 * - the unpublished plugins and the carrier overwrite whatever the profile
 *   holds (a broken earlier hand-install must not survive, and an updated image
 *   must reach existing tenants);
 * - every other staged package is copied only when missing, so a published or
 *   runtime-resolved dependency is never shadowed by this payload.
 *
 * A published payload plugin (see {@link PROFILE_PLUGINS}) is staged *and*
 * declared: the copy makes the first boot work without a registry install, the
 * declaration is what stops the next `pnpm` run from deleting that copy.
 *
 * Runs after {@link ensureProfile}, so a brand-new tenant's first boot already
 * resolves the carrier bundle and its plugin packages.
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
  const profileModules = join(profile, 'node_modules')
  const layer = profileLayer(user.home)
  await mkdir(layer, { recursive: true })
  await mkdir(profileModules, { recursive: true })
  await chownDir(layer, user.uid, user.linuxName)
  await chownDir(profileModules, user.uid, user.linuxName)
  const agentStampPath = join(profile, '.vh-agent-sync.json')
  const stamps = await readStamps(agentStampPath)
  for (const relative of await stagedPackagePaths(payloadModules)) {
    const parts = relative.split('/')
    const name = relative.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
    // A published plugin is a declared dependency: pnpm installs and keeps it,
    // and the profile copy is the one it reconciles. Everything else is staged
    // into the shared layer, the only place no profile-scoped install reaches.
    const declared = PROFILE_PLUGINS.includes(name)
    const root = declared ? profileModules : layer
    const target = join(root, relative)
    // The carrier and every manifest plugin are refreshed when the image's
    // build moved — the stamp records which build the copy came from, so an
    // unchanged image costs a stat walk instead of a copy on every boot.
    const stamp = await treeStamp(join(payloadModules, relative))
    const stale = stamps[relative] !== stamp || !(await exists(join(target, 'package.json')))
    if (stale) {
      try {
        await replaceDirectory(join(payloadModules, relative), target)
        await chownTo(target, user.uid, user.linuxName)
        stamps[relative] = stamp
        await writeFile(agentStampPath, JSON.stringify(stamps), { mode: 0o600 }).catch(() => {})
      } catch (error) {
        console.error(`agent plugin sync failed for ${name} in ${user.linuxName}:`, error.message)
      }
    }
    if (!declared) await clearLegacyCopy(profile, relative)
  }
  // A name the manifest lists but the payload lacks used to leave no trace: the
  // loop above only walks packages that are present, so the tenant silently
  // booted without that plugin (no market, no bot) and nothing was logged. An
  // image whose payload was copied without these packages must say so.
  for (const name of plugins) {
    if (await exists(join(payloadModules, name))) continue
    console.error(`agent plugin missing from payload: ${name} (tenant ${user.linuxName}, root ${AGENT_PLUGIN_ROOT})`)
  }
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
 * Append the bundles and dependencies a profile is missing (idempotent JSON
 * edit), and drop the ones an earlier revision got wrong.
 *
 * A bundle layer is what mounts its plugin rows, so a profile that predates the
 * carrier still has to receive it. A dependency is what keeps a plugin out of
 * `pnpm`'s extraneous sweep, so a profile created before this image declared the
 * market and the bot has to receive those too — otherwise its next install
 * deletes them. `link:` specs onto this image's payload are the opposite case:
 * `pnpm install` runs inside the tenant's jail, where that path does not exist,
 * so the install failed and left `node_modules` incomplete ("1 entry did not
 * activate"). Those entries are removed.
 * @param {string} profile - the tenant's profile directory.
 * @param {{ linuxName: string }} user - the tenant, for diagnostics.
 * @param {readonly string[]} names - bundle package names that must be listed.
 * @param {Record<string, string>} declared - dependencies that must be present.
 * @returns {Promise<void>}
 */
async function mountBundles(profile, user, names, declared) {
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
    const dependencies = manifest.dependencies ?? {}
    for (const [name, spec] of Object.entries(dependencies)) {
      if (!isPayloadLink(spec)) continue
      delete dependencies[name]
      changed = true
    }
    for (const [name, spec] of Object.entries(declared)) {
      if (dependencies[name] === spec) continue
      dependencies[name] = spec
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
 * Ensure one tenant's profile lists every bundle and dependency this image ships.
 * @param {{
 *   home: string,
 *   linuxName: string,
 *   uid: number,
 * }} user - the tenant whose profile to update.
 * @returns {Promise<void>}
 */
async function mountProfileBundles(user) {
  await mountBundles(
    join(user.home, '.dsh', 'profiles', 'web'),
    user,
    PROFILE_BUNDLES,
    await profileDependencies(),
  )
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
