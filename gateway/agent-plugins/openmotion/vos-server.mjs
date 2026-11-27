import { homedir } from 'node:os';
import { join } from 'node:path';
process.env.MOTION_DATA_DIR = join(homedir(), 'workspace', 'OpenMotion');
process.env.PORT = process.argv[2];
const { startServer } = await import('./server.ts');
const running = await startServer();
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { void running.close(); });
