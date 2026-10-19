/**
 * Workspace access for the drawer.
 *
 * The gateway never opens a user file: every operation is a `bin/vh-file` child
 * process that validates the account, drops to that user with `runuser`, and
 * confines the path to `workspace/`. This module only shuttles bytes.
 *
 * @module v-harness/gateway/files
 */

import { spawn } from 'node:child_process';

const HELPER = process.env.FILE_HELPER ?? '/opt/v-harness/bin/vh-file';
const DATA_ROOT = process.env.DATA_ROOT ?? '/data';

/**
 * Build the helper invocation for the current privilege level.
 * @param {string[]} args
 * @returns {{ command: string, argv: string[] }}
 */
function helper(args) {
  return process.geteuid?.() === 0
    ? { command: HELPER, argv: args }
    : { command: 'sudo', argv: ['-n', HELPER, ...args] };
}

/**
 * @typedef {object} UserRecord
 * @property {string} linuxName
 * @property {string} namespace
 */

/**
 * @param {UserRecord} record
 * @returns {string}
 */
export function homeOf(record) {
  return `${DATA_ROOT}/users/${record.namespace}`;
}

/**
 * Run a helper operation and collect its buffered output.
 * @param {UserRecord} record
 * @param {string[]} args
 * @returns {Promise<{ code: number, stdout: Buffer, stderr: string }>}
 */
function runBuffered(record, args) {
  const { command, argv } = helper([...args.slice(0, 1), record.linuxName, homeOf(record), ...args.slice(1)]);
  return new Promise((resolve) => {
    const child = spawn(command, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    let err = '';
    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => { err += chunk.toString('utf8'); });
    child.on('error', (error) => resolve({ code: 1, stdout: Buffer.alloc(0), stderr: error.message }));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout: Buffer.concat(out), stderr: err.trim() }));
  });
}

/**
 * List one directory of the user's workspace.
 * @param {UserRecord} record
 * @param {string} dir - workspace-relative directory, '' for the root.
 * @returns {Promise<{ path: string, entries: Array<{ name: string, type: string, size?: number, mtime: number }> }>}
 */
export async function listWorkspace(record, dir) {
  const result = await runBuffered(record, ['list', dir]);
  if (result.code !== 0) throw new WorkspaceError(result.stderr || 'cannot list directory');
  return JSON.parse(result.stdout.toString('utf8'));
}

/**
 * Sniff one entry without transferring it.
 * @param {UserRecord} record
 * @param {string} path - workspace-relative path.
 * @returns {Promise<{ type: string, size: number, mtime: number }>}
 */
export async function statWorkspace(record, path) {
  const result = await runBuffered(record, ['stat', path]);
  if (result.code !== 0) throw new WorkspaceError(result.stderr || 'not found');
  return JSON.parse(result.stdout.toString('utf8'));
}

/**
 * Stream one file out of the workspace.
 * @param {UserRecord} record
 * @param {string} path - workspace-relative path.
 * @returns {import('node:child_process').ChildProcess}
 */
export function openWorkspaceFile(record, path) {
  const { command, argv } = helper(['read', record.linuxName, homeOf(record), path]);
  return spawn(command, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * Stream one upload into the workspace.
 * @param {UserRecord} record
 * @param {string} dir - workspace-relative target directory.
 * @param {string} name - file name, no separators.
 * @returns {import('node:child_process').ChildProcess}
 */
export function uploadWorkspaceFile(record, dir, name) {
  const { command, argv } = helper(['put', record.linuxName, homeOf(record), dir, name]);
  return spawn(command, argv, { stdio: ['pipe', 'pipe', 'pipe'] });
}

/** A rejected workspace operation with a user-safe message. */
export class WorkspaceError extends Error {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message);
    this.name = 'WorkspaceError';
  }
}
