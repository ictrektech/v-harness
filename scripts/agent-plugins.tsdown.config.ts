import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { defineConfig } from 'tsdown'

/**
 * Scoped host bundle for the agent-side tool plugins the v-harness image
 * stages into tenant profiles (scripts/stage-agent-plugins.ts). The root
 * tsdown.config.ts bundles every workspace package; only these need the
 * `lib/index.js` entry their package.json declares, so the image build runs
 * this config instead of the full pass. The rules mirror the root config's
 * host face; the Typert plugin is omitted because no staged package declares
 * Typert definitions.
 *
 * The package list lives in gateway/agent-plugins/plugins.txt — the same list
 * the Dockerfile's tsc and staging steps read — so adding a tool plugin is a
 * one-line change there plus the carrier's dependency and patch row.
 *
 * tsdown resolves the workspace patterns against this config file's own
 * directory, not the process cwd, so the package paths are anchored here
 * absolutely.
 */
const repositoryRoot = join(import.meta.dirname, '..')
const AGENT_PLUGIN_PACKAGES = readFileSync(join(repositoryRoot, 'gateway/agent-plugins/plugins.txt'), 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean)

export default defineConfig({
  // tsdown's workspace option takes package-directory glob patterns, not
  // manifest paths (the root config runs its manifest discovery through
  // workspacePackageGlobs for the same reason).
  workspace: AGENT_PLUGIN_PACKAGES.map((directory) => join(repositoryRoot, directory)),
  entry: ['lib/types/{index,startup}.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
