/** A profile tree from an earlier layout records a store that no longer matches;
 * the run repairs the metadata and repeats instead of failing the install. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { initProfile } from '@deepseek-ai/dsh-app-boot'
import { runProfilePnpm } from '../src/operations.ts'

function localPackage(dir: string, name: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name, version: '1.0.0' }, undefined, 2)}\n`)
}

it('repairs a store recorded by an earlier layout and repeats a refused add', async () => {
  const home = mkdtempSync(join(tmpdir(), 'manager-store-heal-'))
  onTestFinished(() => { rmSync(home, { recursive: true, force: true }) })
  const dir = join(home, 'profiles', 'test')
  const installAnchor = join(home, 'package.json')
  writeFileSync(installAnchor, '{}\n')
  initProfile(dir, [])
  localPackage(join(home, 'first'), 'first-local')
  localPackage(join(home, 'second'), 'second-local')

  const context = { home, profile: 'test' as const, installAnchor, cwd: home }
  const options = { execution: 'service' as const, outputBytes: 4096, activateNewBundles: false }

  const seeded = await runProfilePnpm(context, ['add', '-w', 'file:./first'], options)
  expect(seeded.exitCode).toBe(0)

  const modules = join(dir, 'node_modules', '.modules.yaml')
  const modulesText = readFileSync(modules, 'utf8')
  const store = /"?storeDir"?:\s*"?([^"\n]+)"?/.exec(modulesText)?.[1]
  expect(store).toBeDefined()
  writeFileSync(modules, modulesText.replace(/"?storeDir"?:\s*"?[^"\n]+"?/, 'storeDir: /layout-that-moved/v11'))

  const repaired = await runProfilePnpm(context, ['add', '-w', 'file:./second'], options)
  expect(repaired.exitCode).toBe(0)
  expect(repaired.output).not.toContain('ERR_PNPM_UNEXPECTED_STORE')
  expect(readFileSync(modules, 'utf8')).toContain(store!)
  expect(readFileSync(join(dir, 'node_modules', 'second-local', 'package.json'), 'utf8')).toContain('"second-local"')
})
