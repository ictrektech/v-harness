/**
 * The ticket a tab presents for itself: which channel wins, and the guarantee
 * that it never reaches a tenant.
 *
 * Run: `node --test gateway/tab-ticket.test.mjs`
 * @module v-harness/gateway/tab-ticket.test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TICKET_HEADER, TICKET_PARAM, explicitTicket, stripTicketParam } from './tab-ticket.mjs';

/** @param {Record<string, string>} headers @param {string} [url] */
function request(headers, url = '/api/session/list') {
  return { headers, url };
}

test('the header names the ticket', () => {
  assert.equal(explicitTicket(request({ [TICKET_HEADER]: 'ticket-a' })), 'ticket-a');
});

test('the query names the ticket where a header cannot', () => {
  assert.equal(explicitTicket(request({}, `/api/remote.mux?${TICKET_PARAM}=ticket-b`)), 'ticket-b');
});

test('the header wins over the query', () => {
  assert.equal(
    explicitTicket(request({ [TICKET_HEADER]: 'header-ticket' }, `/api/x?${TICKET_PARAM}=query-ticket`)),
    'header-ticket',
  );
});

test('a request naming no ticket says so', () => {
  assert.equal(explicitTicket(request({})), undefined);
  assert.equal(explicitTicket(request({ [TICKET_HEADER]: '' })), undefined);
  assert.equal(explicitTicket(request({}, `/api/x?${TICKET_PARAM}=`)), undefined);
  assert.equal(explicitTicket(request({}, '/api/x?other=1')), undefined);
});

test('the ticket is stripped before the request reaches a tenant', () => {
  assert.equal(stripTicketParam(`/api/remote.mux?${TICKET_PARAM}=secret`), '/api/remote.mux');
  assert.equal(stripTicketParam(`/api/x?a=1&${TICKET_PARAM}=secret&b=2`), '/api/x?a=1&b=2');
  assert.equal(stripTicketParam(`/plugins/state?session=x&${TICKET_PARAM}=secret`), '/plugins/state?session=x');
});

test('a request without the parameter is left exactly as it was', () => {
  assert.equal(stripTicketParam('/api/x?a=1'), '/api/x?a=1');
  assert.equal(stripTicketParam('/api/x'), '/api/x');
});
