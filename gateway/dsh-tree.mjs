/**
 * Lock the @deepseek-ai package versions the published dsh resolves to.
 *
 * The image installs dsh with `npm install -g "@deepseek-ai/dsh@<version>"`,
 * which pins the entry package only: npm reads no lockfile for a global
 * install, so every build re-resolves the tree. Any dependency declared with a
 * `~` or `^` range can therefore move to a newer release with no commit in
 * this repository — and the packages this image copies over the published ones
 * (see gateway/plugins.mjs) were compiled against the older tree. A moved
 * interface turns that combination into a boot-time failure with no change to
 * review.
 *
 * Only `@deepseek-ai/*` is pinned. Third-party releases cannot introduce an
 * interface this image's own builds depend on; the scoped packages can, and
 * they are the ones the covered packages are compiled against.
 *
 * @module
 */
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Scope whose resolved versions decide interface compatibility. */
const SCOPE = '@deepseek-ai/';

/** Committed baseline; absent means the tree has never been reviewed. */
const BASELINE = fileURLToPath(new URL('./dsh-tree.json', import.meta.url));

/**
 * Collect every scoped package version in one `npm ls --json` payload.
 * @param {unknown} payload - parsed `npm ls --all --json` output.
 * @param {Map<string, string>} [found] - accumulator, for recursion.
 * @returns {Map<string, string>} package name to resolved version.
 */
export function collectVersions(payload, found = new Map()) {
  if (!payload || typeof payload !== 'object') return found;
  const dependencies = /** @type {{ dependencies?: unknown }} */ (payload).dependencies;
  if (!dependencies || typeof dependencies !== 'object') return found;
  for (const [name, entry] of Object.entries(dependencies)) {
    const record = /** @type {{ version?: unknown, dependencies?: unknown }} */ (entry);
    if (name.startsWith(SCOPE) && typeof record?.version === 'string') found.set(name, record.version);
    collectVersions(record, found);
  }
  return found;
}

/**
 * Compare a locked baseline against the resolved tree.
 * @param {Map<string, string>} expected - baseline versions.
 * @param {Map<string, string>} actual - versions resolved by this build.
 * @returns {string[]} sorted, human-readable differences; empty when locked.
 */
export function diffVersions(expected, actual) {
  const lines = [];
  for (const [name, version] of expected) {
    const resolved = actual.get(name);
    if (resolved === undefined) lines.push(`dropped  ${name} (locked at ${version})`);
    else if (resolved !== version) lines.push(`moved    ${name} ${version} -> ${resolved}`);
  }
  for (const [name, version] of actual) {
    if (!expected.has(name)) lines.push(`appeared ${name} ${version}`);
  }
  return lines.sort();
}

/**
 * Render a version map as the baseline file's own text.
 * @param {Map<string, string>} versions - resolved versions.
 * @returns {string} stable JSON, newline terminated.
 */
export function serialize(versions) {
  const sorted = [...versions].sort(([left], [right]) => left.localeCompare(right));
  return `${JSON.stringify(Object.fromEntries(sorted), undefined, 2)}\n`;
}

/** Read the resolved tree. The image build resolves the global install;
 * `DSH_TREE_PREFIX` points this at a staging install of the same version when
 * a baseline has to be seeded where no global dsh exists. `npm ls` exits
 * non-zero on peer warnings while still printing the tree, so its stdout is
 * authoritative either way. */
async function installedTree() {
  const prefix = process.env.DSH_TREE_PREFIX;
  const args = prefix === undefined
    ? ['ls', '-g', '--all', '--json']
    : ['ls', '--all', '--json', '--prefix', prefix];
  const result = await execFileAsync('npm', args, { maxBuffer: 256 * 1024 * 1024 })
    .catch(error => {
      if (typeof error.stdout === 'string' && error.stdout.trim() !== '') return error;
      throw new Error('npm ls -g produced no dependency tree', { cause: error });
    });
  return JSON.parse(result.stdout);
}

/** Report and fail the build; a moved interface is never recoverable at boot. */
function fail(message) {
  console.error(message);
  process.exit(1);
}

async function main() {
  const actual = collectVersions(await installedTree());
  if (process.argv.includes('--write')) {
    await writeFile(BASELINE, serialize(actual));
    console.log(`locked ${actual.size} @deepseek-ai packages in gateway/dsh-tree.json`);
    return;
  }
  let expected;
  try {
    expected = new Map(Object.entries(JSON.parse(await readFile(BASELINE, 'utf8'))));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    fail(`gateway/dsh-tree.json does not exist, so this image's dsh tree is not locked.

Review the resolved versions below, then commit them unchanged as
gateway/dsh-tree.json and rebuild. Every later build compares against that
file instead of re-resolving, so an intended upgrade is a reviewed commit
rather than a silent transitive update.

${serialize(actual)}`);
  }
  const differences = diffVersions(expected, actual);
  if (differences.length === 0) {
    console.log(`dsh dependency tree locked (${actual.size} @deepseek-ai packages)`);
    return;
  }
  fail(`the resolved @deepseek-ai dependency tree no longer matches gateway/dsh-tree.json:

${differences.map(line => `  ${line}`).join('\n')}

The packages this image copies over the published ones were built against the
locked tree. Confirm the new versions are compatible with those builds, then
refresh the baseline with:

  node gateway/dsh-tree.mjs --write

and commit gateway/dsh-tree.json together with whatever the upgrade requires.`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
