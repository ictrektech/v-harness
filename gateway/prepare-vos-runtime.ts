/** Promote the Web runtime's workspace peers before making its standalone deploy tree. */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { packedWorkspaceClosure, readWorkspacePackages } from '../packages/sandbox/sandbox-local/tests/packed-workspace-closure.ts'
import { acceptsNpmPlatform } from '../scripts/npm-platform.ts'

const root = process.cwd()
// VOS uses V-Voice; omit the local recognizer before computing the deploy closure.
const voiceRoot = join(root, 'packages/experimental/voice-input-bundle')
const voiceManifestPath = join(voiceRoot, 'package.json')
const voiceManifest = JSON.parse(readFileSync(voiceManifestPath, 'utf8'))
delete voiceManifest.dependencies['@deepseek-ai/dsh-experimental-speech-to-text-sensevoice']
writeFileSync(voiceManifestPath, JSON.stringify(voiceManifest, null, 2) + '\n')
const voicePatchPath = join(voiceRoot, 'cordis.patch.yml')
const voicePatch = readFileSync(voicePatchPath, 'utf8')
const localRow = /    - id: speech-to-text-sensevoice\n[\s\S]*?(?=    - id:)/u
if (!localRow.test(voicePatch)) throw new Error('Recheck the VOS voice composition before deploying')
writeFileSync(voicePatchPath, voicePatch.replace(localRow, '').replace('defaultProvider: sensevoice-local', 'defaultProvider: v-scheduler-voice'))
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
