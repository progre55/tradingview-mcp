/**
 * Unit tests for pine_save's post-condition (classifySaveOutcome,
 * lookupSavedVersion) and the strategy-reader readiness gates
 * (strategyNotReady, strategyBlocker). Pure — no TradingView connection.
 *
 * Run: node --test tests/save_outcome.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifySaveOutcome, lookupSavedVersion } from '../src/core/pine.js';
import { strategyNotReady, strategyBlocker } from '../src/core/data.js';

const ERROR_MARKER = { line: 3, column: 15, message: 'timestamp(s): unrecognized datetime format', severity: 8 };
const WARNING_MARKER = { line: 1, column: 1, message: 'shadowed variable', severity: 4 };

describe('classifySaveOutcome', () => {
  it('error markers fail the save even though the version bumped', () => {
    const r = classifySaveOutcome({ markers: [ERROR_MARKER], wasDirty: true, versionBefore: '2.0', versionAfter: '3.0' });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'compile_errors');
    assert.deepEqual(r.errors, [ERROR_MARKER]);
  });

  it('warnings alone do not fail the save', () => {
    const r = classifySaveOutcome({ markers: [WARNING_MARKER], wasDirty: true, versionBefore: '2.0', versionAfter: '3.0' });
    assert.deepEqual(r, { ok: true, version_verified: true });
  });

  it('a dirty script whose version did not move fails', () => {
    const r = classifySaveOutcome({ markers: [], wasDirty: true, versionBefore: '2.0', versionAfter: '2.0' });
    assert.equal(r.error, 'version_not_bumped');
  });

  it('a clean script with an unchanged version is fine', () => {
    assert.equal(classifySaveOutcome({ markers: [], wasDirty: false, versionBefore: '2.0', versionAfter: '2.0' }).ok, true);
  });

  it('unknown versions do not fail; they surface as version_verified:false', () => {
    assert.deepEqual(classifySaveOutcome({ markers: [], wasDirty: true, versionBefore: null, versionAfter: '1.0' }), { ok: true, version_verified: false });
  });

  it('an untitled draft that is still untitled afterwards fails even with unknown versions', () => {
    const r = classifySaveOutcome({ markers: [], wasDirty: true, versionBefore: null, versionAfter: null, wasUntitled: true, stillUntitled: true });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'draft_not_saved');
  });

  it('an untitled draft that got a name counts as saved', () => {
    const r = classifySaveOutcome({ markers: [], wasDirty: true, versionBefore: null, versionAfter: '1.0', wasUntitled: true, stillUntitled: false });
    assert.deepEqual(r, { ok: true, version_verified: false });
  });

  it('a compile error on the on-chart study fails', () => {
    assert.equal(classifySaveOutcome({ markers: [], wasDirty: true, versionBefore: '1.0', versionAfter: '2.0', studyCompileError: true }).error, 'study_compile_error');
  });
});

describe('lookupSavedVersion', () => {
  const SCRIPTS = [
    { id: 'USER;aaa', name: 'Alpha', version: '4.0' },
    { id: 'USER;bbb', name: 'Dup', version: '1.0' },
    { id: 'USER;ccc', name: 'Dup', version: '7.0' },
  ];

  it('prefers the script id', () => {
    assert.equal(lookupSavedVersion(SCRIPTS, { script_id: 'USER;ccc', script_name: 'Alpha' }), '7.0');
  });

  it('falls back to a unique name', () => {
    assert.equal(lookupSavedVersion(SCRIPTS, { script_id: null, script_name: 'Alpha' }), '4.0');
  });

  it('an ambiguous name resolves to null rather than guessing', () => {
    assert.equal(lookupSavedVersion(SCRIPTS, { script_name: 'Dup' }), null);
  });
});

describe('strategyNotReady', () => {
  it('loading is not ready', () => {
    assert.equal(strategyNotReady({ populated: true, strategy_name: 'S', calc_status: 'loading' }), true);
  });

  it('a populated report without a strategy name (post-save transient) is not ready', () => {
    assert.equal(strategyNotReady({ populated: true, strategy_name: '', calc_status: 'completed' }), true);
  });

  it('an unpopulated, completed strategy is ready (falls through to the DOM path)', () => {
    assert.equal(strategyNotReady({ populated: false, calc_status: 'completed' }), false);
  });

  it('completed with a name is ready', () => {
    assert.equal(strategyNotReady({ populated: true, strategy_name: 'S', calc_status: 'completed' }), false);
  });
});

describe('strategyBlocker — what the reader returns after waiting', () => {
  it('still loading → strategy_recalculating', () => {
    assert.equal(strategyBlocker({ populated: true, strategy_name: 'S', calc_status: 'loading' }), 'strategy_recalculating');
  });

  it('failed calculation → strategy_calc_error instead of the previous run\'s report', () => {
    assert.equal(strategyBlocker({ populated: true, strategy_name: 'S', calc_status: 'error' }), 'strategy_calc_error');
  });

  it('a completed but nameless report is used rather than failed', () => {
    assert.equal(strategyBlocker({ populated: true, strategy_name: '', calc_status: 'completed' }), null);
  });

  it('a nameless report with unknown status is still blocked', () => {
    assert.equal(strategyBlocker({ populated: true, strategy_name: '', calc_status: 'unknown' }), 'strategy_recalculating');
  });
});
