import { test } from 'node:test';
import assert from 'node:assert/strict';

const { collectVersions, diffVersions, serialize } = await import('./dsh-tree.mjs');

/** One `npm ls --all --json` payload: scoped packages nested under the entry. */
const tree = {
  dependencies: {
    '@deepseek-ai/dsh': {
      version: '0.2.1-rc.2',
      dependencies: {
        '@deepseek-ai/cordis': { version: '0.3.0', dependencies: {} },
        '@deepseek-ai/dsh-llm': { version: '0.2.1-rc.2' },
        react: { version: '18.3.1' },
      },
    },
    npm: { version: '10.9.0' },
  },
};

test('collects scoped versions at every depth and ignores other packages', () => {
  assert.deepEqual(Object.fromEntries(collectVersions(tree)), {
    '@deepseek-ai/dsh': '0.2.1-rc.2',
    '@deepseek-ai/cordis': '0.3.0',
    '@deepseek-ai/dsh-llm': '0.2.1-rc.2',
  });
});

test('tolerates a tree npm could only partially resolve', () => {
  assert.equal(collectVersions({ dependencies: { '@deepseek-ai/dsh': { version: '0.2.1-rc.2', missing: true } } }).size, 1);
  assert.equal(collectVersions(undefined).size, 0);
  assert.equal(collectVersions({ dependencies: {} }).size, 0);
});

test('reports a moved transitive release', () => {
  const expected = new Map([['@deepseek-ai/cordis', '0.3.0']]);
  const actual = new Map([['@deepseek-ai/cordis', '0.3.2']]);
  assert.deepEqual(diffVersions(expected, actual), ['moved    @deepseek-ai/cordis 0.3.0 -> 0.3.2']);
});

test('reports packages that appeared or dropped', () => {
  const differences = diffVersions(
    new Map([['@deepseek-ai/gone', '1.0.0']]),
    new Map([['@deepseek-ai/new', '2.0.0']]),
  );
  assert.deepEqual(differences, ['appeared @deepseek-ai/new 2.0.0', 'dropped  @deepseek-ai/gone (locked at 1.0.0)']);
});

test('a matching tree reports nothing', () => {
  const versions = new Map([['@deepseek-ai/cordis', '0.3.0'], ['@deepseek-ai/dsh', '0.2.1-rc.2']]);
  assert.deepEqual(diffVersions(versions, new Map(versions)), []);
});

test('serializes sorted so an unchanged tree produces an unchanged file', () => {
  assert.equal(
    serialize(new Map([['@deepseek-ai/dsh', '0.2.1-rc.2'], ['@deepseek-ai/cordis', '0.3.0']])),
    '{\n  "@deepseek-ai/cordis": "0.3.0",\n  "@deepseek-ai/dsh": "0.2.1-rc.2"\n}\n',
  );
});
