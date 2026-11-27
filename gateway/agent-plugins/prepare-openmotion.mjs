/** Use the jail's private loopback address for the published local runtime. */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = process.argv[2];
let changed = 0;
for (const name of await readdir(root)) {
  if (!name.endsWith('.ts')) continue;
  const file = join(root, name);
  const source = await readFile(file, 'utf8');
  const after = source
    .replace(/(['"])127\.0\.0\.1\1/g, "(process.env.VH_TENANT_IP ?? '127.0.0.1')")
    .replaceAll('http://127.0.0.1:${', "http://${process.env.VH_TENANT_IP ?? '127.0.0.1'}:${");
  if (after !== source) {
    await writeFile(file, after);
    changed++;
  }
}
if (changed < 3) throw new Error('Recheck OpenMotion loopback binding before updating its runtime');

const mcpPath = join(root, 'mcp.ts');
const mcp = await readFile(mcpPath, 'utf8');
const line = "if (response) process.stdout.write(JSON.stringify(response) + '\\n');";
if (!mcp.includes(line)) throw new Error('Recheck OpenMotion MCP response handling');
await writeFile(mcpPath, "import { exposePreview } from './vos-preview.mjs';\n" + mcp.replace(
  line, "if (response) process.stdout.write(JSON.stringify(await exposePreview(response)) + '\\n');",
));
