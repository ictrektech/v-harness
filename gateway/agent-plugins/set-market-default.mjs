/** Set the bundled market's default region while respecting manual selections. */
import { readFileSync, writeFileSync } from 'node:fs';

const path = process.argv[2];
const source = readFileSync(path, 'utf8');
const upstream = `    if (marketState.region !== undefined)
        config.region = marketState.region;
    let region = config.region ?? 'global';
    let regionAuto = marketState.regionAuto === true;`;
const vos = `    if (marketState.region !== undefined && marketState.regionAuto !== true)
        config.region = marketState.region;
    config.region ??= 'global';
    let region = config.region;
    let regionAuto = false;`;
if (source.split(upstream).length !== 2) {
  throw new Error('dshmarket: verify the download-region initialization before updating the bundled package');
}
writeFileSync(path, source.replace(upstream, vos));
