/**
 * Stage the v-harness image's agent-side tool plugins into one payload
 * directory (run inside the Dockerfile's agent-plugins stage).
 *
 * The tenant profile installs its harness packages from the npm registry, and
 * the fork's tool plugins are unpublished, so the profile would neither carry
 * their packages nor be able to load them. A hand-copied package fails twice
 * over: `tsc -b` per-package output lands in `lib/types/` while the manifest
 * entry points at `lib/index.js` (the publish flow bundles that entry with
 * tsdown), and the dependency chain has to be assembled by hand. This script
 * closes both gaps: the Dockerfile builds the plugins the way the publish
 * flow does, and the dependency closure below is computed from each plugin's
 * manifest instead of being listed by hand.
 *
 * Payload layout (copied to /opt/v-harness/agent-plugins by the image):
 *   manifest.json                    { plugins, packages }
 *   node_modules/<name>/              plugin and closure packages
 *   node_modules/vh-agent-plugins/    the carrier bundle that mounts the rows
 *
 * gateway/plugins.mjs reads the payload at tenant creation: plugin packages
 * overwrite the profile's copy, closure packages fill only what is missing,
 * and peer dependencies resolve through dsh's runtime resolution from the
 * installation, so they are deliberately not staged.
 *
 * Usage:
 *   node --import tsx/esm scripts/stage-agent-plugins.ts \
 *     --out /build/agent-plugins \
 *     --plugin packages/skill/skill-album [--plugin <package-dir> ...]
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const repositoryRoot = process.cwd()

/**
 * Package files the payload carries, mirroring what `pnpm pack` ships for
 * these packages: the manifest, the built runtime and declarations, and the
 * non-code payload directories a plugin may declare.
 */
const PAYLOAD_FILES = ['package.json', 'lib', 'locale', 'assets', 'cordis.patch.yml', 'presets']

/** The carrier bundle, kept next to the gateway code that syncs it. */
const CARRIER_SOURCE = 'gateway/agent-plugins/vh-agent-plugins'
const CARRIER_NAME = 'vh-agent-plugins'

interface PackageManifest {
  name?: unknown
  version?: unknown
  dependencies?: Record<string, unknown>
}

function readManifest(directory: string): PackageManifest & { name: string; version: string } {
  const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as PackageManifest
  if (typeof manifest.name !== 'string' || manifest.name === '') {
    throw new Error(`${directory}/package.json must declare a non-empty name`)
  }
  if (typeof manifest.version !== 'string' || manifest.version === '') {
    throw new Error(`${directory}/package.json must declare a non-empty version`)
  }
  return manifest as PackageManifest & { name: string; version: string }
}

/** Every workspace package under packages/<group>/<pkg>, by name. */
function workspacePackageMap(): Map<string, string> {
  const map = new Map<string, string>()
  const packagesRoot = join(repositoryRoot, 'packages')
  for (const group of readdirSync(packagesRoot, { withFileTypes: true })) {
    if (!group.isDirectory()) continue
    for (const entry of readdirSync(join(packagesRoot, group.name), { withFileTypes: true })) {
      const directory = join(packagesRoot, group.name, entry.name)
      if (!entry.isDirectory() || !existsSync(join(directory, 'package.json'))) continue
      const name = readManifest(directory).name
      if (map.has(name)) throw new Error(`duplicate workspace package name: ${name}`)
      map.set(name, directory)
    }
  }
  return map
}

/**
 * The real-dependency closure of the plugin packages. Peer dependencies are
 * deliberately excluded: dsh's runtime resolution supplies every package the
 * installation carries, so staging them would shadow the installation's
 * single cordis instance and duplicate harness services inside the profile.
 */
function dependencyClosure(
  workspace: Map<string, string>,
  pluginDirectories: readonly string[],
): Map<string, string> {
  const closure = new Map<string, string>()
  const queue = [...pluginDirectories]
  for (let directory = queue.shift(); directory !== undefined; directory = queue.shift()) {
    const manifest = readManifest(directory)
    for (const name of Object.keys(manifest.dependencies ?? {})) {
      if (closure.has(name)) continue
      const dependencyDirectory = workspace.get(name)
      if (dependencyDirectory === undefined) {
        console.log(
          `stage-agent-plugins: ${manifest.name} depends on ${name}, which is not a `
            + 'packages/ workspace package; the dsh installation supplies it at runtime',
        )
        continue
      }
      closure.set(name, dependencyDirectory)
      queue.push(dependencyDirectory)
    }
  }
  return closure
}

/** Copy one package's payload files into the staging tree. */
function stagePackage(payloadModules: string, directory: string, name: string): void {
  const target = join(payloadModules, name)
  rmSync(target, { recursive: true, force: true })
  for (const file of PAYLOAD_FILES) {
    const source = join(directory, file)
    if (!existsSync(source)) continue
    cpSync(source, join(target, file), { recursive: true })
  }
  if (!existsSync(join(target, 'package.json'))) {
    throw new Error(`${name}: staging produced no package.json`)
  }
}

/**
 * Verify the carrier depends on and mounts exactly the staged plugins, then
 * stage it. The dependencies are what make dsh's profile-scope resolution
 * carry the plugin packages; the patch rows are what mount them. Failing at
 * build time keeps an image from shipping a bundle whose rows cannot load.
 */
function stageCarrier(payloadModules: string, pluginNames: readonly string[]): void {
  const carrierDirectory = join(repositoryRoot, CARRIER_SOURCE)
  const manifest = readManifest(carrierDirectory)
  const dependencies = Object.keys(manifest.dependencies ?? {})
  const undeclared = pluginNames.filter(name => !dependencies.includes(name))
  if (undeclared.length !== 0) {
    throw new Error(
      `${CARRIER_SOURCE}/package.json must declare the staged plugins in dependencies; `
        + `missing: ${undeclared.join(', ')}`,
    )
  }
  const patch = readFileSync(join(carrierDirectory, 'cordis.patch.yml'), 'utf8')
  const unmounted = pluginNames.filter(name => !patch.includes(name))
  if (unmounted.length !== 0) {
    throw new Error(
      `${CARRIER_SOURCE}/cordis.patch.yml must mount every staged plugin; missing: ${unmounted.join(', ')}`,
    )
  }
  stagePackage(payloadModules, carrierDirectory, CARRIER_NAME)
}

/** The default plugin list: the same file the Dockerfile's other steps read. */
function defaultPluginDirectories(): string[] {
  const list = join(repositoryRoot, 'gateway/agent-plugins/plugins.txt')
  return readFileSync(list, 'utf8')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(directory => join(repositoryRoot, directory))
}

function parseArguments(argv: readonly string[]): { out: string; plugins: string[] } {
  let out: string | undefined
  const plugins: string[] = []
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--out') {
      out = argv[++index]
      continue
    }
    if (argv[index] === '--plugin') {
      const directory = argv[++index]
      if (directory === undefined) throw new Error('--plugin requires a package directory')
      plugins.push(resolve(repositoryRoot, directory))
      continue
    }
    throw new Error(`unknown argument: ${String(argv[index])}`)
  }
  if (out === undefined) throw new Error('--out <directory> is required')
  return { out: resolve(out), plugins: plugins.length === 0 ? defaultPluginDirectories() : plugins }
}

function main(): void {
  const { out, plugins } = parseArguments(process.argv.slice(2))
  const payloadModules = join(out, 'node_modules')
  rmSync(out, { recursive: true, force: true })
  mkdirSync(payloadModules, { recursive: true })

  const workspace = workspacePackageMap()
  const names: string[] = []
  const versions: Record<string, string> = {}
  for (const directory of plugins) {
    const manifest = readManifest(directory)
    names.push(manifest.name)
    versions[manifest.name] = manifest.version
    stagePackage(payloadModules, directory, manifest.name)
    console.log(`stage-agent-plugins: staged plugin ${manifest.name}@${manifest.version}`)
  }
  const closure = dependencyClosure(workspace, plugins)
  for (const [name, directory] of closure) {
    versions[name] = readManifest(directory).version
    stagePackage(payloadModules, directory, name)
    console.log(`stage-agent-plugins: staged dependency ${name}@${versions[name]}`)
  }
  stageCarrier(payloadModules, names)

  writeFileSync(
    join(out, 'manifest.json'),
    `${JSON.stringify({ plugins: names, packages: versions }, undefined, 2)}\n`,
  )
  console.log(`stage-agent-plugins: payload ready at ${out} (${names.length} plugins, ${closure.size} dependencies)`)
}

try {
  main()
} catch (error: unknown) {
  console.error(`stage-agent-plugins: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
