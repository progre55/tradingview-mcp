/**
 * Strategy / virtualized-table / panel-detection tests.
 *
 * Opt-in: this file requires TradingView Desktop (port 9222) AND a chart with
 * a strategy loaded. The `before` hook skips the suite cleanly when either is
 * missing — running this is harmless on machines without a strategy.
 *
 * Run: node --test tests/strategy.test.js
 *
 * Pinned behaviors:
 *   - findStrategySource (via core paths) detects the strategy via at least one signal.
 *   - data_get_strategy_results returns ≥5 metrics with recognizable keys.
 *   - data_get_trades returns the FULL virtualized list (not just the visible window),
 *     with explicit fields parsed from the merged Exit/Entry cells.
 *   - tv_ui_state.strategy_tester.open flips with showWidget/hideWidget.
 *   - ui_evaluate awaits Promise-returning expressions (was returning {}).
 *   - ui_scroll target='strategy-tester' actually moves the trade-table scrollTop.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { evaluate, evaluateAsync, disconnect } from '../src/connection.js';
import * as data from '../src/core/data.js';
import * as health from '../src/core/health.js';
import * as ui from '../src/core/ui.js';
import { STRATEGY_DETECTOR_JS } from '../src/core/_panels.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let suiteSkipped = false;
let skipReason = '';

async function detectStrategy() {
  return await evaluate(`
    (function() {
      ${STRATEGY_DETECTOR_JS}
      try { var hit = findStrategySource(); return { has: !!hit.source, name: hit.name, debug: hit.debug }; }
      catch(e) { return { has: false, error: e.message }; }
    })()
  `);
}

before(async () => {
  try {
    await evaluate('1');
  } catch (e) {
    suiteSkipped = true;
    skipReason = `TradingView not reachable on port 9222: ${e.message}`;
    return;
  }
  try {
    const det = await detectStrategy();
    if (!det?.has) {
      suiteSkipped = true;
      skipReason = `No strategy detected on chart. Sources seen: ${(det?.debug?.by_name || []).join(', ') || '(none)'}`;
    }
  } catch (e) {
    suiteSkipped = true;
    skipReason = `Strategy detection failed: ${e.message}`;
  }
});

after(async () => {
  try { await disconnect(); } catch {}
});

function skipIfNoStrategy(t) {
  if (suiteSkipped) t.skip(skipReason);
}

describe('Strategy detection (shared helper)', () => {
  it('findStrategySource finds the strategy with at least one truthy signal', async (t) => {
    skipIfNoStrategy(t);
    const det = await detectStrategy();
    assert.ok(det.has, `Strategy not found. debug: ${JSON.stringify(det.debug)}`);
    assert.ok(det.name && det.name.length > 0, 'Strategy has a name');
  });
});

describe('data_get_strategy_results (DOM-first)', () => {
  it('returns ≥5 metrics including a recognizable key', async (t) => {
    skipIfNoStrategy(t);
    const r = await data.getStrategyResults();
    assert.ok(r.success, 'success=true');
    assert.ok(r.metric_count >= 5, `Expected ≥5 metrics, got ${r.metric_count}. source=${r.source} error=${r.error}`);
    const keys = Object.keys(r.metrics).map(k => k.toLowerCase());
    // Match either the long form ("Total Closed Trades") or the compact form ("Total trades")
    // — current TV builds vary.
    const expected = ['profit', 'drawdown', 'trades', 'win rate', 'profitable'];
    const hit = expected.find(e => keys.some(k => k.includes(e)));
    assert.ok(hit, `Expected one of ${expected.join(', ')} in keys: ${keys.join(', ')}`);
  });

  it('source is dom_scrape or internal_api (not "none")', async (t) => {
    skipIfNoStrategy(t);
    const r = await data.getStrategyResults();
    assert.ok(['dom_scrape', 'internal_api'].includes(r.source), `Unexpected source=${r.source}`);
  });
});

describe('data_get_trades (full virtualized list)', () => {
  it('returns >0 trades with all expected per-row fields', async (t) => {
    skipIfNoStrategy(t);
    const r = await data.getTrades({ max_trades: 500, settle_ms: 350 });
    assert.ok(r.success, 'success=true');
    assert.ok(r.trade_count > 0, `Expected >0 trades, got ${r.trade_count}. error=${r.error}`);
    const t0 = r.trades[0];
    for (const f of ['trade_num', 'entry_time', 'entry_price', 'exit_time', 'exit_price']) {
      assert.ok(f in t0, `Trade missing field: ${f}`);
    }
  });

  it('trade_num is unique across the full result', async (t) => {
    skipIfNoStrategy(t);
    const r = await data.getTrades({ max_trades: 500, settle_ms: 350 });
    const nums = r.trades.map(x => x.trade_num);
    const unique = new Set(nums);
    assert.equal(unique.size, nums.length, `Duplicate trade_num: ${nums.length - unique.size} dupes`);
  });

  it('trade_count matches Performance Summary total trades (±1 for open position)', async (t) => {
    skipIfNoStrategy(t);
    const meta = await data.getStrategyResults();
    const totalEntry = Object.entries(meta.metrics).find(([k]) => /^total( closed)? trades$/i.test(k));
    if (!totalEntry) return t.skip('Total trades metric not present — cannot cross-check');
    const reported = parseInt(String(totalEntry[1]).replace(/[^\d]/g, ''), 10);
    if (!Number.isFinite(reported)) return t.skip(`Total trades not numeric: ${totalEntry[1]}`);
    const trades = await data.getTrades({ max_trades: 500, settle_ms: 350 });
    const diff = Math.abs(trades.trade_count - reported);
    assert.ok(diff <= 1, `Trade count ${trades.trade_count} vs Performance Summary ${reported} (diff=${diff})`);
  });
});

describe('tv_ui_state.strategy_tester.open', () => {
  // bottomWidgetBar method names vary across TV builds. Probe what's available
  // and adapt — the bug we're guarding against is the DETECTOR returning the
  // wrong open/closed value, not the bwb shape.
  let openMethod = null;
  let closeMethod = null;
  before(async () => {
    if (suiteSkipped) return;
    const probe = await evaluate(`(function() {
      var bwb = window.TradingView && window.TradingView.bottomWidgetBar;
      if (!bwb) return null;
      var has = function(name) { return typeof bwb[name] === 'function'; };
      return { showWidget: has('showWidget'), hideWidget: has('hideWidget'), open: has('open'), close: has('close'), show: has('show'), hide: has('hide') };
    })()`);
    if (probe?.showWidget) openMethod = "bwb.showWidget('backtesting')";
    else if (probe?.open) openMethod = "bwb.open('backtesting')";
    else if (probe?.show) openMethod = 'bwb.show()';
    if (probe?.hideWidget) closeMethod = "bwb.hideWidget('backtesting')";
    else if (probe?.close) closeMethod = "bwb.close('backtesting')";
    else if (probe?.hide) closeMethod = 'bwb.hide()';
  });

  it('reports open=true when the strategy tester is shown', async (t) => {
    skipIfNoStrategy(t);
    if (!openMethod) return t.skip('No bottomWidgetBar open method available');
    await evaluate(`try { var bwb = window.TradingView.bottomWidgetBar; ${openMethod}; } catch(e) {}`);
    await sleep(600);
    const s = await health.uiState();
    assert.ok(s.strategy_tester?.open === true, `Expected open=true (reason=${s.strategy_tester?.reason})`);
  });

  it('reports open=false after the bottom panel is collapsed', async (t) => {
    skipIfNoStrategy(t);
    if (!closeMethod) return t.skip('No bottomWidgetBar close method available');
    await evaluate(`try { var bwb = window.TradingView.bottomWidgetBar; ${closeMethod}; } catch(e) {}`);
    await sleep(600);
    const s = await health.uiState();
    // If the close method on this build doesn't actually collapse the panel, skip rather
    // than fail the detector test — we're testing the detector, not the bwb API surface.
    if (s.bottom_panel?.open) return t.skip(`bwb.${closeMethod} did not collapse bottom panel on this build (height=${s.bottom_panel?.height})`);
    assert.equal(s.strategy_tester?.open, false, `Expected open=false when bottom panel is collapsed (reason=${s.strategy_tester?.reason})`);
    // Reopen for downstream tests.
    if (openMethod) await evaluate(`try { var bwb = window.TradingView.bottomWidgetBar; ${openMethod}; } catch(e) {}`);
    await sleep(500);
  });
});

describe('ui_evaluate awaits Promises', () => {
  it('returns the resolved value, not the bare Promise object', async (t) => {
    skipIfNoStrategy(t);
    const r = await ui.uiEvaluate({ expression: 'new Promise(function(res){ setTimeout(function(){ res({ok: 42}); }, 200); })' });
    assert.ok(r.success);
    assert.deepEqual(r.result, { ok: 42 });
  });
});

describe('ui_scroll target=strategy-tester', () => {
  it('moves the trade-table scrollTop downward', async (t) => {
    skipIfNoStrategy(t);
    // Make sure panel + trades tab are open.
    await evaluate(`try { window.TradingView.bottomWidgetBar.showWidget('backtesting'); } catch(e) {}`);
    await sleep(400);
    await evaluate(`
      (function() {
        var panel = document.querySelector('[data-name="backtesting-content-wrapper"]') || document.querySelector('[data-name="backtesting"]');
        if (!panel) return;
        var tabs = panel.querySelectorAll('[role="tab"], button');
        for (var i = 0; i < tabs.length; i++) {
          if (/list of trades/i.test((tabs[i].textContent || '').trim())) { try { tabs[i].click(); } catch(e) {} break; }
        }
      })()
    `);
    await sleep(500);

    function findScrollEl() {
      return `(function() {
        var rows = document.querySelectorAll('[class*="ka-row"]');
        if (!rows.length) return null;
        var el = rows[0].parentElement;
        for (var i = 0; i < 14 && el; i++) {
          try { var s = getComputedStyle(el); if (/(auto|scroll)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 1) return el; } catch(e) {}
          el = el.parentElement;
        }
        return null;
      })()`;
    }
    // Reset scroll to top so direction=down has somewhere to go.
    await evaluate(`(function() { var el = ${findScrollEl()}; if (el) { el.scrollTop = 0; el.dispatchEvent(new Event('scroll', { bubbles: true })); } })()`);
    await sleep(300);
    const before = await evaluate(`(function() { var el = ${findScrollEl()}; return el ? el.scrollTop : -1; })()`);
    if (before < 0) return t.skip('Trade table scroll container not present (table not virtualized — too few rows)');
    await ui.scroll({ direction: 'down', amount: 400, target: 'strategy-tester' });
    await sleep(300);
    const after = await evaluate(`(function() { var el = ${findScrollEl()}; return el ? el.scrollTop : -1; })()`);
    assert.ok(after > before, `scrollTop did not increase: ${before} → ${after}`);
  });
});
