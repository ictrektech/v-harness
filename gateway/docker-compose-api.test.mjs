import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  classify,
  eventVisible,
  filterListing,
  namespaceObjectPath,
} from './docker-proxy.mjs';

/** Only `account` is read by the functions under test. */
const alice = { subject: 'alice', account: 'alice', uid: 20000, home: '/tmp/alice' };
const bob = { subject: 'bob', account: 'bob', uid: 20001, home: '/tmp/bob' };

describe('compose endpoint classification', () => {
  it('allows the network listing at its real path', () => {
    assert.deepEqual(classify('GET', '/v1.43/networks'), { action: 'filter' });
    assert.deepEqual(classify('GET', '/networks'), { action: 'filter' });
  });

  it('filters a network inspection and allows its removal', () => {
    assert.deepEqual(classify('GET', '/networks/db-net'), { action: 'filter' });
    assert.deepEqual(classify('DELETE', '/networks/db-net'), { action: 'allow' });
  });

  it('requires the body check before joining a network', () => {
    assert.deepEqual(classify('POST', '/networks/db-net/connect'), { action: 'mutate' });
    assert.deepEqual(classify('POST', '/networks/db-net/disconnect'), { action: 'mutate' });
    assert.equal(classify('GET', '/networks/db-net/connect').action, 'deny');
  });

  it('filters a volume inspection and allows its removal', () => {
    assert.deepEqual(classify('GET', '/volumes/dbdata'), { action: 'filter' });
    assert.deepEqual(classify('DELETE', '/volumes/dbdata'), { action: 'allow' });
    assert.deepEqual(classify('GET', '/volumes'), { action: 'filter' });
  });

  it('streams events to this tenant only', () => {
    assert.deepEqual(classify('GET', '/v1.43/events'), { action: 'events' });
    assert.equal(classify('POST', '/events').action, 'deny');
  });

  it('still refuses endpoints compose never needs', () => {
    assert.equal(classify('GET', '/grpc').action, 'deny');
    assert.equal(classify('POST', '/networks/prune').action, 'deny');
    assert.equal(classify('GET', '/info').action, 'deny');
  });
});

describe('network and volume namespacing', () => {
  it('prefixes a plain name with the tenant', async () => {
    assert.deepEqual(await namespaceObjectPath(alice, '/networks/db-net', 'DELETE'), {
      path: '/networks/vh-alice-db-net',
    });
    assert.deepEqual(await namespaceObjectPath(alice, '/volumes/dbdata', 'GET'), {
      path: '/volumes/vh-alice-dbdata',
    });
  });

  it('keeps the sub-path and query', async () => {
    const out = await namespaceObjectPath(alice, '/networks/app-net/connect?force=1', 'POST');
    assert.deepEqual(out, { path: '/networks/vh-alice-app-net/connect?force=1' });
  });

  it('refuses another tenant object by name', async () => {
    assert.ok('error' in await namespaceObjectPath(alice, '/networks/vh-bob-db-net', 'GET'));
    assert.ok('error' in await namespaceObjectPath(alice, '/volumes/vh-bob-data', 'DELETE'));
  });

  it('lets a shared object be read but never removed', async () => {
    assert.deepEqual(await namespaceObjectPath(alice, '/networks/vh-shared-db', 'GET'), {
      path: '/networks/vh-shared-db',
    });
    assert.ok('error' in await namespaceObjectPath(alice, '/networks/vh-shared-db', 'DELETE'));
    assert.ok('error' in await namespaceObjectPath(alice, '/volumes/vh-shared-data', 'DELETE'));
  });

  it('refuses a volume addressed by id', async () => {
    assert.ok('error' in await namespaceObjectPath(alice, `/volumes/${'a'.repeat(64)}`, 'GET'));
  });

  it('leaves the collection endpoints alone', async () => {
    assert.deepEqual(await namespaceObjectPath(alice, '/networks', 'GET'), { path: '/networks' });
    assert.deepEqual(await namespaceObjectPath(alice, '/volumes', 'GET'), { path: '/volumes' });
    assert.deepEqual(await namespaceObjectPath(alice, '/networks/create', 'POST'), {
      path: '/networks/create',
    });
  });
});

describe('event attribution', () => {
  it('keeps the tenant own container, network and volume events', () => {
    for (const name of ['vh-alice-web', 'vh-alice-app_default', 'vh-alice-dbdata']) {
      assert.equal(eventVisible(alice, { Actor: { Attributes: { name } } }), true);
    }
  });

  it('drops another tenant events', () => {
    assert.equal(eventVisible(alice, { Actor: { Attributes: { name: 'vh-bob-web' } } }), false);
    assert.equal(eventVisible(bob, { Actor: { Attributes: { name: 'vh-alice-web' } } }), false);
  });

  it('accepts the ownership label as well as the name prefix', () => {
    assert.equal(eventVisible(alice, { Actor: { Attributes: { 'vh.tenant': 'alice' } } }), true);
    assert.equal(eventVisible(alice, { Actor: { Attributes: { 'vh.tenant': 'bob' } } }), false);
  });

  it('drops anything it cannot attribute', () => {
    assert.equal(eventVisible(alice, null), false);
    assert.equal(eventVisible(alice, {}), false);
    assert.equal(eventVisible(alice, { Actor: {} }), false);
    assert.equal(eventVisible(alice, { Actor: { Attributes: {} } }), false);
  });
});

describe('listing filters', () => {
  it('shows only this tenant networks, with the prefix removed', () => {
    const listed = [
      { Name: 'vh-alice-app_default', Id: 'a1' },
      { Name: 'vh-bob-app_default', Id: 'b1' },
      { Name: 'bridge', Id: 'host' },
    ];
    assert.deepEqual(filterListing(alice, '/networks', listed), [
      { Name: 'app_default', Id: 'a1' },
    ]);
  });

  it('hides the host mount point in a single volume inspection', () => {
    const inspected = {
      Name: 'vh-alice-dbdata',
      Mountpoint: '/var/lib/docker/volumes/vh-alice-dbdata/_data',
      Driver: 'local',
    };
    assert.deepEqual(filterListing(alice, '/volumes/vh-alice-dbdata', inspected), {
      Name: 'dbdata',
      Driver: 'local',
    });
  });

  it('hides the gateway membership in a single network inspection', () => {
    const inspected = {
      Name: 'vh-alice-app_default',
      Containers: { abc: { Name: 'vos-app-com-ictrek-v-harness-1' } },
      Driver: 'bridge',
    };
    assert.deepEqual(filterListing(alice, '/networks/vh-alice-app_default', inspected), {
      Name: 'app_default',
      Driver: 'bridge',
    });
  });

  it('shows only this tenant volumes and hides the host mount point', () => {
    const listed = {
      Volumes: [
        { Name: 'vh-alice-dbdata', Mountpoint: '/var/lib/docker/volumes/x/_data' },
        { Name: 'vh-bob-dbdata', Mountpoint: '/var/lib/docker/volumes/y/_data' },
      ],
    };
    assert.deepEqual(filterListing(alice, '/volumes', listed), {
      Volumes: [{ Name: 'dbdata' }],
    });
  });
});
