/**
 * Internal platform-profile builders for the local sandbox provider.
 *
 * @module @deepseek-ai/dsh-sandbox-local/profiles
 */

import { grantArgs as landlockGrantArgs } from '@deepseek-ai/node-addon-system/landlock-run'
import { writableRoots } from '@deepseek-ai/dsh-sandbox'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'

/**
 * Top-level trees that hold other accounts' content on a multi-account host.
 * A policy carrying `tenantRoot` replaces each of these with an empty tmpfs, so
 * a sibling home or the deployment state root does not merely lose its write
 * permission but stops existing in the confined view.
 */
const TENANT_MASK_ROOTS = ['/home', '/root', '/data', '/srv', '/mnt', '/media']

/** Whether `path` is `root` itself or lies beneath it. */
function isWithin(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`)
}

/**
 * The mask roots this policy can hide.
 *
 * A candidate that CONTAINS the tenant root (a sibling home inside `/home`) is
 * masked and the tenant root is bound back afterwards. A candidate inside the
 * tenant root is the tenant's own content and stays; a candidate equal to the
 * tenant root is the tenant itself and is never replaced.
 * @param policy - file-effect and visibility policy for one execution.
 * @returns the absolute roots to replace with an empty tmpfs, in argument order.
 */
export function tenantMaskRoots(policy: SandboxPolicy): string[] {
  const tenantRoot = policy.tenantRoot
  if (tenantRoot === undefined || tenantRoot === '/') return []
  return TENANT_MASK_ROOTS.filter((mask) => {
    if (mask === tenantRoot) return false
    // Inside the tenant's own tree: it is the tenant's content, not a sibling's.
    if (isWithin(mask, tenantRoot)) return false
    return true
  })
}

/**
 * Build the bwrap profile arguments for one file-effect policy.
 * @param policy - file-effect policy to express as bwrap mounts.
 * @returns profile arguments before the trailing separator and command argv.
 */
export function bwrapProfileArgs(policy: SandboxPolicy): string[] {
  const args = ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent']
  const masks = tenantMaskRoots(policy)
  // Visibility first: an empty tmpfs over each foreign tree, then the tenant's
  // own root bound back in. The bind must follow the mask — bwrap applies
  // mounts in argument order, so binding first would be buried by the tmpfs.
  for (const mask of masks) args.push('--tmpfs', mask)
  if (policy.mode === 'workspace-write') {
    args.push('--tmpfs', '/tmp')
  }
  // Widest bind first, then the narrower one: a later bind wins for its path.
  // Under read-only the account root comes back read-only; the mask removed
  // its write permission along with its visibility.
  if (masks.length > 0 && policy.tenantRoot !== undefined) {
    args.push(policy.mode === 'workspace-write' ? '--bind' : '--ro-bind', policy.tenantRoot, policy.tenantRoot)
  }
  if (policy.mode === 'workspace-write') {
    args.push('--bind', policy.workspaceRoot, policy.workspaceRoot)
  }
  return args
}

/**
 * Build the Landlock launcher grants for one file-effect policy. Landlock
 * grants are an allow-list over paths that still exist, so it can narrow writes
 * but cannot hide a tree: `tenantRoot` is a mount-table concept and therefore
 * bwrap-only.
 * @param policy - file-effect policy to express as Landlock allow-list grants.
 * @returns launcher grant arguments before the trailing separator and command argv.
 */
export function landlockProfileArgs(policy: SandboxPolicy): string[] {
  const readWrite = ['/dev/null']
  if (policy.mode === 'workspace-write') {
    readWrite.push('/tmp', policy.workspaceRoot)
  }
  return landlockGrantArgs({ readOnly: ['/'], readWrite })
}

/** Quote one path as an SBPL string literal. */
function sbplString(path: string): string {
  return `"${path.replaceAll('\\', String.raw`\\`).replaceAll('"', String.raw`\"`)}"`
}

/**
 * Build the sandbox-exec arguments and SBPL profile for one policy. The
 * writable roots come from the shared {@link writableRoots} helper (canonical,
 * deduplicated) so the Seatbelt grant and the in-process fs fence
 * (`@deepseek-ai/dsh-fs-sandbox`) can never drift apart.
 * @param policy - file-effect policy to express as an SBPL profile.
 * @returns sandbox-exec arguments before the trailing separator and command argv.
 */
export function seatbeltProfileArgs(policy: SandboxPolicy): string[] {
  const forms = ['(version 1)', '(allow default)', '(deny file-write*)', `(allow file-write* (literal ${sbplString('/dev/null')}))`]
  const roots = writableRoots(policy)
  if (roots.length > 0) {
    forms.push(`(allow file-write* ${roots.map(root => `(subpath ${sbplString(root)})`).join(' ')})`)
  }
  return ['-p', forms.join(' ')]
}
