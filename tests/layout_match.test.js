/**
 * Unit tests for matchSavedLayout() — pure layout_switch target resolution.
 *
 * Run: node --test tests/layout_match.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { matchSavedLayout } from '../src/core/ui.js';

const CHARTS = [
  { id: 111, url: 'aaaa1111', name: 'Morning Scan' },
  { id: 222, url: 'bbbb2222', name: 'Scalp' },
  { id: 333, url: 'cccc3333', name: 'scalp copy' },
  { id: 444, url: 'dddd4444', name: 'Best setups' },
];

const pick = (q) => matchSavedLayout(CHARTS, q).match?.id ?? null;

describe('matchSavedLayout', () => {
  it('matches a numeric id given as a string', () => {
    assert.equal(pick('222'), 222);
  });

  it('matches a short url', () => {
    assert.equal(pick('cccc3333'), 333);
  });

  it('exact name wins over case-insensitive and substring hits', () => {
    assert.equal(pick('Scalp'), 222);
  });

  it('falls back to case-insensitive, then a unique substring', () => {
    assert.equal(pick('MORNING SCAN'), 111);
    assert.equal(pick('copy'), 333);
  });

  it('an ambiguous substring matches nothing and lists the candidates', () => {
    assert.deepEqual(matchSavedLayout(CHARTS, 'S'), { match: null, candidates: ['Morning Scan', 'Scalp', 'scalp copy', 'Best setups'] });
  });

  it('an empty or whitespace query matches nothing', () => {
    assert.deepEqual(matchSavedLayout(CHARTS, ''), { match: null, candidates: [] });
    assert.deepEqual(matchSavedLayout(CHARTS, '   '), { match: null, candidates: [] });
  });

  it('no hit → null match, no candidates', () => {
    assert.deepEqual(matchSavedLayout(CHARTS, 'nope'), { match: null, candidates: [] });
    assert.deepEqual(matchSavedLayout(undefined, 'Scalp'), { match: null, candidates: [] });
  });
});
