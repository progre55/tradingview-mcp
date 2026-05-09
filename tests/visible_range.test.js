/**
 * Pure-function tests for classifyVisibleRangeOutcome — the choke point
 * that decides whether a setVisibleRange / scrollToDate call actually
 * landed on the target. v4 issue #1 (TV-MCP-ISSUES-v4.md) was that the
 * tools returned success:true even when the chart didn't move, because
 * `zoomToBarsRange(fromIdx, toIdx)` is a no-op when the target falls
 * outside the currently-loaded bar range.
 *
 * Run: node --test tests/visible_range.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { classifyVisibleRangeOutcome } from '../src/core/chart.js';

describe('classifyVisibleRangeOutcome', () => {
  it('target inside actual range → success even if chart did not move', () => {
    // The user already happened to be looking at a range that covers the
    // target — calling scrollToDate is a no-op but it succeeded.
    const out = classifyVisibleRangeOutcome({
      before: { from: 1000, to: 2000 },
      after: { from: 1000, to: 2000 },
      target: 1500,
    });
    assert.equal(out.success, true);
    assert.equal(out.moved, false);
    assert.equal(out.target_in_actual, true);
    assert.equal(out.reason, null);
  });

  it('target inside actual range AND chart moved → success', () => {
    const out = classifyVisibleRangeOutcome({
      before: { from: 1000, to: 2000 },
      after: { from: 5000, to: 6000 },
      target: 5500,
    });
    assert.equal(out.success, true);
    assert.equal(out.moved, true);
  });

  it('target outside actual range AND chart did not move → silent-failure footgun (v4 #1)', () => {
    // Reproduces the bug: user asks for Oct 2024, chart stays on May 2026.
    const out = classifyVisibleRangeOutcome({
      before: { from: 1778109300, to: 1778273700 },
      after: { from: 1778109300, to: 1778273700 },
      target: 1728950400,
    });
    assert.equal(out.success, false);
    assert.equal(out.moved, false);
    assert.equal(out.target_in_actual, false);
    assert.equal(out.reason, 'chart_did_not_move');
  });

  it('target outside actual range BUT chart moved → clamped (visibility partial)', () => {
    // The chart moved but landed on a clamped range that doesn't cover the target.
    const out = classifyVisibleRangeOutcome({
      before: { from: 1778100000, to: 1778200000 },
      after: { from: 1777000000, to: 1777100000 },
      target: 1728950400,
    });
    assert.equal(out.success, false);
    assert.equal(out.moved, true);
    assert.equal(out.target_in_actual, false);
    assert.equal(out.reason, 'target_outside_actual_range');
  });

  it('null target → success based on actual existing alone (no target check)', () => {
    // Used by setVisibleRange callers who don't have a single target point;
    // any non-empty actual range is acceptable.
    const out = classifyVisibleRangeOutcome({
      before: { from: 1000, to: 2000 },
      after: { from: 5000, to: 6000 },
      target: null,
    });
    assert.equal(out.success, true);
  });

  it('actual missing → success:false, reason no_actual_range', () => {
    const out = classifyVisibleRangeOutcome({
      before: { from: 1000, to: 2000 },
      after: null,
      target: 1500,
    });
    assert.equal(out.success, false);
    assert.equal(out.reason, 'no_actual_range');
  });

  it('actual with non-finite from → no_actual_range', () => {
    const out = classifyVisibleRangeOutcome({
      before: { from: 1000, to: 2000 },
      after: { from: 'not a number', to: 6000 },
      target: 1500,
    });
    assert.equal(out.success, false);
    assert.equal(out.reason, 'no_actual_range');
  });

  it('before missing → moved:false (cannot tell), but success can still be true if target_in_actual', () => {
    const out = classifyVisibleRangeOutcome({
      before: null,
      after: { from: 1000, to: 2000 },
      target: 1500,
    });
    assert.equal(out.success, true);
    assert.equal(out.moved, false);
    assert.equal(out.target_in_actual, true);
  });

  it('target exactly at the boundary → covered (inclusive)', () => {
    const lo = classifyVisibleRangeOutcome({
      before: { from: 0, to: 0 },
      after: { from: 1000, to: 2000 },
      target: 1000,
    });
    const hi = classifyVisibleRangeOutcome({
      before: { from: 0, to: 0 },
      after: { from: 1000, to: 2000 },
      target: 2000,
    });
    assert.equal(lo.success, true);
    assert.equal(hi.success, true);
  });
});
