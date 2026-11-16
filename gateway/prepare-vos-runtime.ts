/** Promote the Web runtime's workspace peers before making its standalone deploy tree. */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { packedWorkspaceClosure, readWorkspacePackages } from '../packages/sandbox/sandbox-local/tests/packed-workspace-closure.ts'
import { acceptsNpmPlatform } from '../scripts/npm-platform.ts'

const root = process.cwd()
const path = join(root, 'apps/cli/package.json')
const manifest = JSON.parse(readFileSync(path, 'utf8'))
const packages = readWorkspacePackages(root)
const closure = packedWorkspaceClosure(manifest.name, packages)

for (const member of closure) {
  const { name } = member
  if (name === manifest.name || Object.hasOwn(manifest.dependencies, name)) continue
  if (!acceptsNpmPlatform(member.manifest.os, process.platform)
    || !acceptsNpmPlatform(member.manifest.cpu, process.arch)) continue
  manifest.dependencies[name] = 'workspace:*'
}
writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n')
