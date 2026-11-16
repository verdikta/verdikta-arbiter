'use strict';

// Acceptance: a shared bearer token.

const test = require('node:test');
const assert = require('node:assert/strict');
const { checkBearer } = require('../../src/auth');

const TOKEN = 'k'.repeat(40);

test('only the exact token, as a Bearer credential, is accepted', () => {
  assert.equal(checkBearer(`Bearer ${TOKEN}`, TOKEN), true);
  assert.equal(checkBearer(`bearer ${TOKEN}`, TOKEN), true, 'the scheme is case-insensitive (RFC 9110)');
  for (const header of [undefined, '', TOKEN, `Bearer ${TOKEN}x`, `Bearer ${TOKEN.slice(1)}`, `Basic ${TOKEN}`,
    `Bearer  ${TOKEN}`, `Bearer ${TOKEN} `, `Bearer ${TOKEN}\n`, ['Bearer', TOKEN]]) {
    assert.equal(checkBearer(header, TOKEN), false, JSON.stringify(header));
  }
  assert.equal(checkBearer('Bearer ', ''), false, 'an empty configured token never matches');
});
