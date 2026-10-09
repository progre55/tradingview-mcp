/**
 * Pure-function tests for resolveInputOverrides — fixes the v3 issue #4
 * silent no-op (`indicator_set_inputs` previously matched only against
 * `id`, so {macro_required: false} returned success:true with empty
 * updated_inputs). The resolver now matches by id, Pine var name, or
 * display title, with case-insensitive fallback.
 *
 * Run: node --test tests/indicator_inputs.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { resolveInputOverrides, buildInputDescriptors } from '../src/core/indicators.js';

const FIXTURE = [
  { id: 'in_0', name: 'macro_required', title: 'Require macro alignment', current_value: true },
  { id: 'in_1', name: 'length', title: 'Length', current_value: 14 },
  { id: 'in_2', name: 'src', title: 'Source', current_value: 'close' },
];

describe('resolveInputOverrides — key resolution', () => {
  it('matches by exact id', () => {
    const { matched, unmatched_keys } = resolveInputOverrides(FIXTURE, { in_1: 50 });
    assert.deepEqual(matched, [{ id: 'in_1', key: 'in_1', value: 50 }]);
    assert.deepEqual(unmatched_keys, []);
  });

  it('matches by Pine variable name', () => {
    const { matched, unmatched_keys } = resolveInputOverrides(FIXTURE, { macro_required: false });
    assert.deepEqual(matched, [{ id: 'in_0', key: 'macro_required', value: false }]);
    assert.deepEqual(unmatched_keys, []);
  });

  it('matches by display title', () => {
    const { matched, unmatched_keys } = resolveInputOverrides(FIXTURE, { 'Require macro alignment': false });
    assert.deepEqual(matched, [{ id: 'in_0', key: 'Require macro alignment', value: false }]);
    assert.deepEqual(unmatched_keys, []);
  });

  it('case-insensitive fallback when exact match misses', () => {
    const { matched, unmatched_keys } = resolveInputOverrides(FIXTURE, { MACRO_REQUIRED: false });
    assert.deepEqual(matched, [{ id: 'in_0', key: 'MACRO_REQUIRED', value: false }]);
    assert.deepEqual(unmatched_keys, []);
  });

  it('unknown key → reported in unmatched_keys, nothing matched', () => {
    const { matched, unmatched_keys } = resolveInputOverrides(FIXTURE, { definitely_not_an_input: 5 });
    assert.deepEqual(matched, []);
    assert.deepEqual(unmatched_keys, ['definitely_not_an_input']);
  });

  it('mixed: name match, title match, and a bogus key', () => {
    const { matched, unmatched_keys } = resolveInputOverrides(FIXTURE, {
      macro_required: false,
      Length: 21,
      bogus_key: 1,
    });
    const ids = matched.map(m => m.id).sort();
    assert.deepEqual(ids, ['in_0', 'in_1']);
    assert.deepEqual(unmatched_keys, ['bogus_key']);
  });

  it('priority: id wins over name/title even if a name collides', () => {
    const fixture = [
      { id: 'foo', name: 'shared', title: 'A', current_value: 1 },
      { id: 'bar', name: 'other', title: 'shared', current_value: 2 },
    ];
    const { matched } = resolveInputOverrides(fixture, { shared: 99 });
    // exact name match on the first input wins; second's title-collision is shadowed
    assert.deepEqual(matched, [{ id: 'foo', key: 'shared', value: 99 }]);
  });

  it('empty overrides → empty matched and empty unmatched', () => {
    const { matched, unmatched_keys } = resolveInputOverrides(FIXTURE, {});
    assert.deepEqual(matched, []);
    assert.deepEqual(unmatched_keys, []);
  });

  it('empty currentInputs → every override is unmatched', () => {
    const { matched, unmatched_keys } = resolveInputOverrides([], { length: 10 });
    assert.deepEqual(matched, []);
    assert.deepEqual(unmatched_keys, ['length']);
  });
});

describe('buildInputDescriptors — getInputValues() joined with metaInfo().inputs', () => {
  // getInputValues() carries only {id, value}; titles live in metaInfo.
  const VALUES = [
    { id: 'text', value: 'x'.repeat(50000) },
    { id: 'pineId', value: 'USER;abc123' },
    { id: 'in_0', value: 9 },
    { id: 'in_1', value: 'y'.repeat(300) },
  ];
  const META = [
    { id: 'text', name: 'ILScript', isHidden: true },
    { id: 'pineId', name: 'pineId', isHidden: true },
    { id: 'in_0', name: 'Fast EMA', group: 'Framework', type: 'integer' },
    { id: 'in_1', name: 'Notes', type: 'string' },
  ];

  it('drops hidden inputs (the encoded script blob made responses tens of KB)', () => {
    const ids = buildInputDescriptors(VALUES, META).map(d => d.id);
    assert.deepEqual(ids, ['in_0', 'in_1']);
  });

  it('populates title/group/type from metaInfo', () => {
    const [first] = buildInputDescriptors(VALUES, META);
    assert.deepEqual(first, { id: 'in_0', name: null, title: 'Fast EMA', group: 'Framework', type: 'integer', current_value: 9 });
  });

  it('truncates long string values', () => {
    const notes = buildInputDescriptors(VALUES, META).find(d => d.id === 'in_1');
    assert.equal(notes.current_value.length, 201);
    assert.ok(notes.current_value.endsWith('…'));
  });

  it('a display-title override resolves to the in_N id', () => {
    const { matched, unmatched_keys } = resolveInputOverrides(buildInputDescriptors(VALUES, META), { 'fast ema': 12 });
    assert.deepEqual(matched, [{ id: 'in_0', key: 'fast ema', value: 12 }]);
    assert.deepEqual(unmatched_keys, []);
  });

  it('missing metaInfo keeps every input with null titles', () => {
    const out = buildInputDescriptors([{ id: 'length', value: 14 }], null);
    assert.deepEqual(out, [{ id: 'length', name: null, title: null, group: null, type: null, current_value: 14 }]);
  });
});
