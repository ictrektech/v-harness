#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { assertSkillEnabled } from '../../.skill-guard.mjs';
await assertSkillEnabled('image-studio');

class CliError extends Error {}
function parseArgs(argv) {
  const flags = new Map();
  const positional = [];
  for (let n = 0; n < argv.length; n++) {
    const value = argv[n];
    if (value.startsWith('--')) flags.set(value.slice(2), argv[++n]);
    else positional.push(value);
  }
  return { flags, positional };
}
function stringFlag(flags, name) { return flags.get(name); }
function requireArgument(value, name) {
  if (typeof value !== 'string' || !value) throw new CliError(name + ' is required');
  return value;
}
function resolveConnection() {
  return { socketPath: process.env.VH_SCHEDULER_SOCKET ?? join(homedir(), '.dsh', 'v-scheduler.sock') };
}
function print(value) { console.log(JSON.stringify(value, null, 2)); }
async function request(connection, path, { method, body }) {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      socketPath: connection.socketPath, path, method,
      headers: payload === undefined ? {} : {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      },
    }, res => {
      const chunks = [];
      let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (size > 8 * 1024 * 1024) res.destroy(new CliError('response too large'));
        else chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => {
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString());
          if (res.statusCode >= 400 || value.code !== 'OK') {
            reject(new CliError('V-Scheduler HTTP ' + res.statusCode + ': ' + (value.code ?? value.error)));
          } else resolve(value.data);
        } catch (error) { reject(error); }
      });
    });
    req.setTimeout(120000, () => req.destroy(new CliError('V-Scheduler request timed out')));
    req.on('error', reject);
    req.end(payload);
  });
}
async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2))
  const [command, id] = positional
  if (!command || flags.has('help')) {
    return print({ commands: ['nodes', 'managed-nodes', 'backends', 'add --json-file PATH', 'update ID --json-file PATH', 'rescan ID', 'runtime ID', 'remove ID'] })
  }
  const connection = resolveConnection(flags)
  if (!connection.socketPath) throw new CliError('Open v-harness in VOS before using node management')
  let method = 'GET'
  let path
  let body
  const prefix = '/scheduler/api/v1/'
  if (command === 'nodes' || command === 'managed-nodes') path = prefix + command
  else if (command === 'backends') path = prefix + 'backend-deployments'
  else if (command === 'add' || command === 'update') {
    const file = requireArgument(stringFlag(flags, 'json-file'), '--json-file')
    body = JSON.parse(readFileSync(file, 'utf8'))
    method = command === 'add' ? 'POST' : 'PUT'
    path = prefix + 'managed-nodes'
    if (command === 'update') path += '/' + encodeURIComponent(requireArgument(id, 'node ID'))
  } else if (['rescan', 'runtime', 'remove'].includes(command)) {
    path = prefix + 'managed-nodes/' + encodeURIComponent(requireArgument(id, 'node ID'))
    method = command === 'remove' ? 'DELETE' : 'POST'
    if (command !== 'remove') path += '/' + command
  } else throw new CliError('Unknown node management command')
  return print(await request(connection, path, { method, body }))
}
main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
