/**
 * Write the consumer manifest that installs this repository's packed runtime
 * into the container image.
 *
 * The image runs the dsh built from this checkout, not the published package,
 * so `npm install` has to resolve every harness dependency from the tarballs
 * `release/pack.ts` just produced. Each dependency is therefore a `file:` URL,
 * which never consults the registry even when the version it names is already
 * published there.
 *
 * The install prefix is a parameter because the tarballs are packed in the
 * builder stage and installed in the runtime stage: the manifest must name the
 * path the tarballs occupy in the final image, not the one they were packed at.
 */

import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { isEntry } from './release/process.ts'
import { packedIdentity } from './release/tarball.ts'

/** Manifest name of the consumer that holds the installed runtime. */
const CONSUMER_NAME = 'dsh-packed-runtime'

/**
 * Read every tarball of one packed directory.
 * @param directory - absolute pack output directory.
 * @param installPrefix - absolute path the same directory occupies in the image.
 * @returns Package name to the `file:` URL that installs it.
 */
function directoryDependencies(directory: string, installPrefix: string): Record<string, string> {
  const tarballs = readdirSync(directory).filter(name => name.endsWith('.tgz')).sort()
  if (tarballs.length === 0) throw new Error(`${directory} holds no packed tarball`)
  const installedDirectory = join(installPrefix, basename(directory))
  return Object.fromEntries(tarballs.map((filename) => {
    const { name } = packedIdentity(join(directory, filename))
    return [name, `file:${join(installedDirectory, filename)}`]
  }))
}

/** Write the manifest named by `--out` for the directories named by `--from`. */
function main(): void {
  const { values } = parseArgs({
    options: {
      out: { type: 'string' },
      'install-prefix': { type: 'string' },
      from: { type: 'string', multiple: true },
    },
    allowPositionals: false,
  })
  const installPrefix = values['install-prefix']
  if (values.out === undefined || installPrefix === undefined || values.from === undefined) {
    throw new Error('usage: packed-runtime-manifest.ts --out <dir> --install-prefix <path> --from <packed dir> [--from ...]')
  }
  const dependencies = Object.assign(
    {},
    ...values.from.map(directory => directoryDependencies(resolve(directory), installPrefix)),
  )
  const out = resolve(values.out)
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, 'package.json'), `${JSON.stringify({
    name: CONSUMER_NAME,
    version: '0.0.0',
    private: true,
    dependencies,
  }, null, 2)}\n`)
  console.log(`packed runtime: ${String(Object.keys(dependencies).length)} package(s) -> ${join(out, 'package.json')}`)
}

if (isEntry(import.meta.url)) main()
