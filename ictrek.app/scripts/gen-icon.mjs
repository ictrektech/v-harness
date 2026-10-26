/** Export the approved app artwork to the 256px RGBA VOS package icon. */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../assets/icon-master.png', import.meta.url));
const target = fileURLToPath(new URL('../src/icon.png', import.meta.url));
execFileSync('magick', [source, '-resize', '256x256', '-define', 'png:color-type=6', target]);
console.log(`wrote ${target}`);
