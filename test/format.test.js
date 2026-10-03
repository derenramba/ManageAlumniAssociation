'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { cleanText, cleanHtml } = require('../src/lib/nodash');
const { normaliseBatch } = require('../src/lib/voters');

test('batch ranges keep a hyphen, other dashes are removed', () => {
  assert.equal(cleanText('PGDAEM 2012-14'), 'PGDAEM 2012-14');
  assert.equal(cleanText('Batch 2012–14'), 'Batch 2012-14');
  assert.equal(cleanText('1999-2001'), '1999-01');
  assert.equal(cleanText('Read-only Auditor'), 'Read only Auditor');
  assert.equal(cleanText('Term 2026–2030'), 'Term 2026 to 2030');
  assert.equal(cleanHtml('<td>2012-14</td><td>—</td>'), '<td>2012-14</td><td></td>');
});

test('imported batches are stored as YYYY-YY', () => {
  assert.equal(normaliseBatch('1996-98'), '1996-98');
  assert.equal(normaliseBatch('1998 – 2000'), '1998-00');
  assert.equal(normaliseBatch('2012 to 2014'), '2012-14');
  assert.equal(normaliseBatch('PGDAEM 2010'), 'PGDAEM 2010');
});
