// scripts/test/extract-parser.test.js — Phase 2b unit tests for the
// --cities/--niches multi-value CLI parser (fix for the "City, ST, City, ST"
// comma-splitting gotcha).
//
// Run:  npm test  (node --test test/extract-parser.test.js …)
//
// Regression: `--cities "San Antonio, TX"` used to split on EVERY comma and
// produce two bogus values ("San Antonio" + "TX"); and `--cities "San Antonio,
// TX, Fort Worth, TX"` produced four. Multi-value inputs are now unambiguous:
//   • ' | ' or ';' separates items while KEEPING each "City, ST" whole,
//   • a plain comma list merges adjacent "City, ST" pairs,
//   • repeated --cities / --niches flags append.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseArgs, splitList } = require('../extract-leads');

test('splitList: single "City, ST" stays ONE value (the regression)', () => {
  assert.deepEqual(splitList('San Antonio, TX'), ['San Antonio, TX']);
});

test('splitList: two "City, ST" comma-separated merge into two whole pairs', () => {
  assert.deepEqual(splitList('San Antonio, TX, Fort Worth, TX'), [
    'San Antonio, TX',
    'Fort Worth, TX',
  ]);
});

test('splitList: " | " separates multi-values, keeping internal commas', () => {
  assert.deepEqual(splitList('San Antonio, TX | Fort Worth, TX'), [
    'San Antonio, TX',
    'Fort Worth, TX',
  ]);
});

test('splitList: ";" separates multi-values, keeping internal commas', () => {
  assert.deepEqual(splitList('San Antonio, TX;Fort Worth, TX'), [
    'San Antonio, TX',
    'Fort Worth, TX',
  ]);
});

test('splitList: legacy plain comma list still splits (no inner commas)', () => {
  assert.deepEqual(splitList('Junk Removal, Roofing'), ['Junk Removal', 'Roofing']);
});

test('splitList: trims whitespace and drops empty entries', () => {
  assert.deepEqual(splitList('  Austin, TX  |   |  Dallas, TX  '), [
    'Austin, TX',
    'Dallas, TX',
  ]);
});

test('parseArgs: repeated --cities flags append', () => {
  const opts = parseArgs(['--cities', 'San Antonio, TX', '--cities', 'Fort Worth, TX']);
  assert.deepEqual(opts.cities, ['San Antonio, TX', 'Fort Worth, TX']);
});

test('parseArgs: repeated --niches flags append', () => {
  const opts = parseArgs(['--niches', 'Junk Removal', '--niches', 'Roofing', '--niches', 'HVAC']);
  assert.deepEqual(opts.niches, ['Junk Removal', 'Roofing', 'HVAC']);
});

test('parseArgs: single --cities with a state keeps the comma', () => {
  const opts = parseArgs(['--cities', 'San Antonio, TX', '--limit', '4']);
  assert.deepEqual(opts.cities, ['San Antonio, TX']);
  assert.equal(opts.limit, 4);
});
