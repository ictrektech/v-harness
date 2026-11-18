/**
 * Deployment switch for a shipped skill.
 *
 * The gateway writes `{ "exclude": ["name"] }` into the tenant home and the
 * provider drops those names from the catalog. Instructions already loaded into
 * a conversation survive that — history is not rewritten — so a model can still
 * try to run the CLI. Every product CLI therefore asks here before doing work,
 * and a switched-off skill fails the same way a missing one would.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * The file naming the skills this account switched off.
 * @returns {string | undefined} the path, or undefined when the deployment has no switch file.
 */
function switchFile() {
  if (process.env.DSH_SKILL_EXCLUDE_FILE !== undefined) return process.env.DSH_SKILL_EXCLUDE_FILE
  if (process.env.DSH_HOME === undefined) return undefined
  return join(process.env.DSH_HOME, 'skill-toggles.json')
}

/**
 * Exit the process when this account switched the skill off.
 * @param {string} name - the skill's kebab-case name.
 * @returns {Promise<void>} resolves when the skill may run.
 */
export async function assertSkillEnabled(name) {
  const file = switchFile()
  if (file === undefined) return
  const text = await readFile(file, 'utf8').catch(() => undefined)
  if (text === undefined) return
  let disabled = []
  try {
    const parsed = JSON.parse(text)
    if (parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.exclude)) disabled = parsed.exclude
  } catch {
    // A record this process cannot read means "nothing switched off"; refusing
    // every product command over a stale file would hide the real cause.
    return
  }
  if (!disabled.includes(name)) return
  process.stderr.write(`${JSON.stringify({ ok: false, error: `skill "${name}" is switched off for this account` })}\n`)
  process.exit(1)
}
