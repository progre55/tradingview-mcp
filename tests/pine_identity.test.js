/**
 * Pure-function tests for classifyTabState — the choke point that decides
 * whether the active Pine editor tab is a saved user script vs an untitled
 * draft. The whole v3 issue #1 fix hinges on this classification, so the
 * branches are pinned here as a unit test (no TradingView connection).
 *
 * Discriminators (any one triggers is_untitled_draft):
 *   - script_name matches /^Untitled (indicator|strategy|library)/i.
 *   - script_name is one of newScript()'s default templates AND no id set.
 *   - script_id_part starts with 'STD;NEW_' or 'draft_'.
 *
 * Run: node --test tests/pine_identity.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { classifyTabState } from '../src/core/pine.js';

describe('classifyTabState — no probe data', () => {
  it('null raw → both flags false (probe failed; fail-closed)', () => {
    const out = classifyTabState(null);
    assert.equal(out.is_saved, false);
    assert.equal(out.is_untitled_draft, false);
    assert.equal(out.script_id, null);
    assert.equal(out.script_name, null);
    assert.equal(out.source, null);
  });

  it('undefined raw → same shape as null', () => {
    assert.deepEqual(classifyTabState(undefined), classifyTabState(null));
  });

  it('probe with no name and no id → both flags false', () => {
    const out = classifyTabState({ source: 'dom_toolbar' });
    assert.equal(out.is_saved, false);
    assert.equal(out.is_untitled_draft, false);
    assert.equal(out.source, 'dom_toolbar');
  });
});

describe('classifyTabState — untitled drafts', () => {
  it('TV "Untitled strategy" toolbar text → untitled', () => {
    const out = classifyTabState({ script_name: 'Untitled strategy', source: 'dom_toolbar' });
    assert.equal(out.is_untitled_draft, true);
    assert.equal(out.is_saved, false);
  });

  it('TV "Untitled indicator" toolbar text → untitled', () => {
    const out = classifyTabState({ script_name: 'Untitled indicator' });
    assert.equal(out.is_untitled_draft, true);
    assert.equal(out.is_saved, false);
  });

  it('STD;NEW_indicator id → untitled (legacy probe path)', () => {
    const out = classifyTabState({ script_id_part: 'STD;NEW_indicator', script_name: 'Untitled', source: 'react_fiber' });
    assert.equal(out.is_untitled_draft, true);
    assert.equal(out.is_saved, false);
    assert.equal(out.script_id, 'STD;NEW_indicator');
  });

  it('draft_xyz id → untitled (legacy probe path)', () => {
    const out = classifyTabState({ script_id_part: 'draft_xyz', script_name: 'My draft' });
    assert.equal(out.is_untitled_draft, true);
    assert.equal(out.is_saved, false);
  });

  it('default template name "My strategy" with no id → untitled', () => {
    const out = classifyTabState({ script_name: 'My strategy' });
    assert.equal(out.is_untitled_draft, true);
    assert.equal(out.is_saved, false);
  });
});

describe('classifyTabState — saved user scripts', () => {
  it('name only ("XAUUSD Scalper v1"), id not yet captured → saved', () => {
    const out = classifyTabState({ script_name: 'XAUUSD Scalper v1', source: 'dom_toolbar' });
    assert.equal(out.is_saved, true);
    assert.equal(out.is_untitled_draft, false);
    assert.equal(out.script_id, null);
    assert.equal(out.script_name, 'XAUUSD Scalper v1');
  });

  it('USER;abc123 id + name + version → saved', () => {
    const out = classifyTabState({ script_id_part: 'USER;abc123', script_name: 'NQ ORB-15 + FVG', version: '9.0', source: 'dom+sniffer' });
    assert.equal(out.is_saved, true);
    assert.equal(out.is_untitled_draft, false);
    assert.equal(out.script_id, 'USER;abc123');
    assert.equal(out.script_name, 'NQ ORB-15 + FVG');
    assert.equal(out.version, '9.0');
  });

  it('saved script that happens to be named "My strategy" still classified as saved if id is set', () => {
    const out = classifyTabState({ script_id_part: 'USER;deadbeef', script_name: 'My strategy' });
    assert.equal(out.is_saved, true);
    assert.equal(out.is_untitled_draft, false);
  });
});

describe('classifyTabState — is_dirty', () => {
  it('preserved verbatim from input', () => {
    assert.equal(classifyTabState({ script_id_part: 'USER;x', script_name: 'X', is_dirty: true }).is_dirty, true);
    assert.equal(classifyTabState({ script_id_part: 'USER;x', script_name: 'X', is_dirty: false }).is_dirty, false);
    assert.equal(classifyTabState({ script_id_part: 'USER;x', script_name: 'X' }).is_dirty, false);
  });
});
