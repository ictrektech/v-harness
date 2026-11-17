import { readFile, writeFile } from 'node:fs/promises';

const path = process.argv[2];
const source = await readFile(path, 'utf8');
// vh-jail reserves a loopback address for each tenant. Only the embedded
// DSH launcher needs to use it. The upstream standalone CLI keeps its default.
const binding = 'ensureProxyRunning({host:LAUNCHER_DEFAULT_HOST,port:0,passthrough:false,debug:false,lane:"dsh"}';
if (source.split(binding).length !== 2) {
  throw new Error('billion-context: expected one DSH proxy launch site');
}
await writeFile(path, source.replace(binding, binding.replace(
  'host:LAUNCHER_DEFAULT_HOST',
  'host:process.env.VH_TENANT_IP||LAUNCHER_DEFAULT_HOST',
)));
