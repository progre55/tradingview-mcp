/**
 * Unit tests for tab resolveTarget() — pure resolver, no TradingView connection.
 *
 * Run: node --test tests/tab_resolve.test.js
 *
 * Pins the 3-way handle resolution (chart_id > tab_id > index), the throw
 * branches, the tightened index guard (negative / non-integer / out-of-range),
 * and the duplicate-chart_id matchCount signal.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTarget } from '../src/core/tab.js';

// Mirrors the shape list() returns. Note tab[1] and tab[3] share a chart_id to
// exercise the duplicate-chart collision path.
const TABS = [
  { index: 0, id: 'AAA', url: 'https://www.tradingview.com/chart/chartA/', chart_id: 'chartA' },
  { index: 1, id: 'BBB', url: 'https://www.tradingview.com/chart/chartDUP/', chart_id: 'chartDUP' },
  { index: 2, id: 'CCC', url: 'https://www.tradingview.com/chart/chartC/', chart_id: 'chartC' },
  { index: 3, id: 'DDD', url: 'https://www.tradingview.com/chart/chartDUP/', chart_id: 'chartDUP' },
];

describe('resolveTarget — handle priority', () => {
  it('resolves by chart_id', () => {
    const r = resolveTarget(TABS, { chart_id: 'chartC' });
    assert.equal(r.resolvedBy, 'chart_id');
    assert.equal(r.target.id, 'CCC');
    assert.equal(r.matchCount, 1);
  });

  it('resolves by tab_id', () => {
    const r = resolveTarget(TABS, { tab_id: 'AAA' });
    assert.equal(r.resolvedBy, 'tab_id');
    assert.equal(r.target.chart_id, 'chartA');
    assert.equal(r.matchCount, 1);
  });

  it('resolves by index', () => {
    const r = resolveTarget(TABS, { index: 2 });
    assert.equal(r.resolvedBy, 'index');
    assert.equal(r.target.id, 'CCC');
  });

  it('chart_id wins over tab_id and index when several are given', () => {
    const r = resolveTarget(TABS, { chart_id: 'chartC', tab_id: 'AAA', index: 0 });
    assert.equal(r.resolvedBy, 'chart_id');
    assert.equal(r.target.id, 'CCC');
  });

  it('tab_id wins over index', () => {
    const r = resolveTarget(TABS, { tab_id: 'AAA', index: 2 });
    assert.equal(r.resolvedBy, 'tab_id');
    assert.equal(r.target.id, 'AAA');
  });
});

describe('resolveTarget — duplicate chart_id', () => {
  it('uses the first match and reports matchCount > 1', () => {
    const r = resolveTarget(TABS, { chart_id: 'chartDUP' });
    assert.equal(r.target.id, 'BBB'); // first of BBB/DDD
    assert.equal(r.matchCount, 2);
  });
});

describe('resolveTarget — not-found branches', () => {
  it('unknown chart_id throws and lists open chart_ids', () => {
    assert.throws(
      () => resolveTarget(TABS, { chart_id: 'ZZZBOGUS' }),
      /No open tab with chart_id "ZZZBOGUS".*chartA.*chartC/s,
    );
  });

  it('unknown tab_id throws and lists open tab_ids', () => {
    assert.throws(
      () => resolveTarget(TABS, { tab_id: 'NOPE' }),
      /No open tab with tab_id "NOPE".*AAA.*DDD/s,
    );
  });
});

describe('resolveTarget — index guard (tightened)', () => {
  it('rejects a negative index', () => {
    assert.throws(() => resolveTarget(TABS, { index: -1 }), /out of range/);
  });

  it('rejects an out-of-range index', () => {
    assert.throws(() => resolveTarget(TABS, { index: 4 }), /out of range/);
  });

  it('rejects a non-integer index', () => {
    assert.throws(() => resolveTarget(TABS, { index: 'abc' }), /out of range/);
    assert.throws(() => resolveTarget(TABS, { index: 1.5 }), /out of range/);
  });

  it('accepts a numeric string index (CLI positional)', () => {
    const r = resolveTarget(TABS, { index: '2' });
    assert.equal(r.target.id, 'CCC');
  });
});

describe('resolveTarget — empty / missing input', () => {
  it('no handle throws "requires one of"', () => {
    assert.throws(() => resolveTarget(TABS, {}), /requires one of: chart_id .* tab_id, or index/);
    assert.throws(() => resolveTarget(TABS), /requires one of/);
  });

  it('empty-string index is treated as "no handle", not index 0', () => {
    assert.throws(() => resolveTarget(TABS, { index: '' }), /requires one of/);
  });

  it('empty tabs list throws', () => {
    assert.throws(() => resolveTarget([], { chart_id: 'x' }), /No TradingView chart tabs found/);
    assert.throws(() => resolveTarget(undefined, { index: 0 }), /No TradingView chart tabs found/);
  });
});
