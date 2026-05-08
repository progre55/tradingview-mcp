/**
 * Shared JS-string fragments injected into TradingView via CDP evaluate().
 *
 * Each export is the body of one or more JS function declarations, ready to be
 * concatenated inside an IIFE on the page. Callers prepend the fragment they
 * need, then call the function it defines.
 *
 * Why JS strings instead of helper modules: every CDP round-trip has latency.
 * Doing detection + scrape + scroll inside a single in-page IIFE costs one
 * round-trip; splitting it across N evaluate() calls costs N round-trips and
 * — with virtualized tables — re-renders that race against the next read.
 */

// ─── Panel detection ─────────────────────────────────────────────
// Defines isStrategyTesterOpen() and findStrategyTesterContainer().
// Both rely only on document.* + window.TradingView.* — safe to embed anywhere.
export const PANEL_DETECT_JS = `
function isStrategyTesterOpen() {
  var bottom = document.querySelector('[class*="layout__area--bottom"]');
  var bottomOpen = !!(bottom && bottom.offsetHeight > 50);
  if (!bottomOpen) return { open: false, reason: 'bottom_collapsed' };

  try {
    var bwb = window.TradingView && window.TradingView.bottomWidgetBar;
    if (bwb) {
      var fn = bwb.activeWidget || bwb.getActiveWidget || bwb.currentWidget;
      if (typeof fn === 'function') {
        var w = fn.call(bwb);
        var name = (w && (w.name || w.id || w.widgetName)) || (typeof w === 'string' ? w : null);
        if (name) return { open: /backtest|strategy/i.test(name), reason: 'activeWidget', widget: name };
      }
    }
  } catch(e) {}

  try {
    var tabBtn = document.querySelector('[data-name="backtesting-button"]')
              || document.querySelector('button[aria-controls*="backtesting"]');
    if (tabBtn && tabBtn.getAttribute('aria-pressed') === 'true') {
      return { open: true, reason: 'tab_pressed' };
    }
  } catch(e) {}

  var stratPanel = findStrategyTesterContainer();
  if (stratPanel && stratPanel.offsetHeight > 50) {
    return { open: true, reason: 'panel_height' };
  }
  return { open: false, reason: 'no_signal' };
}

function findStrategyTesterContainer() {
  return document.querySelector('[data-name="backtesting-content-wrapper"]')
      || document.querySelector('[data-name="backtesting"]')
      || document.querySelector('[class*="strategyReport"]')
      || document.querySelector('[class*="backtesting"]');
}
`;

// ─── Strategy data-source detection ──────────────────────────────
// Defines findStrategySource() — locates the strategy in chart.model().dataSources().
// Returns { source, name, signals, debug }. debug enumerates what was tried so a
// failure produces something useful instead of "No strategy found."
//
// Discriminators (live-probed against the current build):
//   1. meta.id starts with 'StrategyScript$'    — TV's strategy bundle prefix
//   2. meta.isTVScriptStrategy === true         — explicit flag on the strategy meta
//   3. ordersData/reportData methods on source  — confirms it's a strategy source
//
// Pine indicators on this build look like 'Script$…@tv-scripting'; strategies
// look like 'StrategyScript$…@tv-scripting'. The trailing '@tv-scripting-101'
// pattern from older builds no longer applies.
//
// We deliberately DO NOT match on s.performance() / s.preferredZOrder — every
// Pine source on this build (indicators included: JMA, Ehlers Trendline,
// Fisher, Hurst, etc.) exposes those, so they're false-positive markers.
//
// The fallback to chart.getAllStudies() name-matching is kept but uses the
// same strict candidate test before promoting a hit.
export const STRATEGY_DETECTOR_JS = `
function findStrategySource() {
  var debug = { sources_total: 0, by_name: [], candidates: [] };
  function isStrategyCandidate(s, meta) {
    if (!meta) return { match: false };
    var byTypeId = typeof meta.id === 'string' && /^StrategyScript\\$/.test(meta.id);
    var byMeta = meta.isTVScriptStrategy === true || meta.isStrategy === true || meta.is_strategy === true;
    var byMethods = typeof s.ordersData === 'function' && typeof s.reportData === 'function';
    return {
      match: !!(byTypeId || byMeta),
      byTypeId: !!byTypeId,
      byMeta: !!byMeta,
      byMethods: !!byMethods,
    };
  }
  var hit = null;
  try {
    var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
    var sources = chart.model().model().dataSources();
    debug.sources_total = sources.length;
    for (var i = 0; i < sources.length; i++) {
      var s = sources[i];
      var meta = null;
      try { meta = s.metaInfo && s.metaInfo(); } catch(e) {}
      var name = (meta && (meta.description || meta.shortDescription)) || '';
      if (name) debug.by_name.push(name);
      var c = isStrategyCandidate(s, meta);
      if (c.match) {
        debug.candidates.push({ name: name, signals: c });
        if (!hit) hit = { source: s, name: name, signals: c };
      }
    }

    if (!hit) {
      var api = window.TradingViewApi._activeChartWidgetWV.value();
      var pubStudies = (api.getAllStudies && api.getAllStudies()) || [];
      debug.public_studies = pubStudies.map(function(p){ return p.name || p.title || ''; });
      for (var k = 0; k < pubStudies.length; k++) {
        var pname = pubStudies[k].name || pubStudies[k].title || '';
        for (var j = 0; j < sources.length; j++) {
          var sj = sources[j];
          var smeta = null;
          try { smeta = sj.metaInfo && sj.metaInfo(); } catch(e) {}
          var sname = (smeta && (smeta.description || smeta.shortDescription)) || '';
          if (sname && sname === pname) {
            var c2 = isStrategyCandidate(sj, smeta);
            if (c2.match) { hit = { source: sj, name: sname, signals: { fromGetAllStudies: true, ...c2 } }; break; }
          }
        }
        if (hit) break;
      }
    }
  } catch(e) { debug.error = e.message; }
  return { source: hit ? hit.source : null, name: hit ? hit.name : null, signals: hit ? hit.signals : null, debug: debug };
}
`;

// ─── Strategy reportData() reader ────────────────────────────────
// Defines findActiveStrategy() — picks the strategy data source whose
// reportData() is currently populated. When multiple strategies sit on the
// chart, only the one selected in the Strategy Tester computes a backtest;
// the others' reportData() returns null. This helper distinguishes that
// from "no strategies at all".
//
// Returns { source, name, reportData, ordersData } when a populated strategy
// is found, else { source: null, candidates: [...] } so the caller can fall
// back to DOM scraping with diagnostics.
//
// Performance key mapping is colocated so the same body shape is consumed
// the same way at every call site.
//
// Requires STRATEGY_DETECTOR_JS earlier (uses findStrategySource debug
// for fallback diagnostics).
export const STRATEGY_DATA_FN = `
function findActiveStrategy() {
  var debug = { strategies_seen: [] };
  try {
    var chart = window.TradingViewApi._activeChartWidgetWV.value();
    var sources = chart._chartWidget.model().model().dataSources();
    var firstStrategy = null;
    for (var i = 0; i < sources.length; i++) {
      var s = sources[i];
      var meta = null;
      try { meta = s.metaInfo && s.metaInfo(); } catch(e) {}
      if (!meta || !meta.id || !/^StrategyScript\\$/.test(meta.id)) continue;
      var name = meta.description || meta.shortDescription || '';
      debug.strategies_seen.push(name);
      var rd = null, od = null;
      try { rd = typeof s.reportData === 'function' ? s.reportData() : null; } catch(e) {}
      try { od = typeof s.ordersData === 'function' ? s.ordersData() : null; } catch(e) {}
      if (!firstStrategy) firstStrategy = { source: s, name: name };
      if (rd) return { source: s, name: name, reportData: rd, ordersData: od, debug: debug };
    }
    return { source: null, first_strategy_name: firstStrategy ? firstStrategy.name : null, debug: debug };
  } catch (e) {
    return { source: null, debug: { error: e.message, strategies_seen: debug.strategies_seen } };
  }
}

// Map TradingView's performance object (cryptic camelCase) to the
// human-readable labels the DOM Performance Summary uses, so callers see
// the same metrics whether they came from internal API or DOM scrape.
function mapPerformanceMetrics(rd) {
  if (!rd || !rd.performance) return {};
  var perf = rd.performance;
  var all = perf.all || {};
  var out = {};
  function set(label, v) { if (v !== null && v !== undefined) out[label] = v; }
  set('Net Profit', all.netProfit);
  set('Net Profit %', all.netProfitPercent);
  set('Gross Profit', all.grossProfit);
  set('Gross Loss', all.grossLoss);
  set('Profit Factor', all.profitFactor);
  set('Percent Profitable', all.percentProfitable);
  set('Total Closed Trades', all.totalTrades);
  set('Total Open Trades', all.totalOpenTrades);
  set('Number Winning Trades', all.numberOfWiningTrades);
  set('Number Losing Trades', all.numberOfLosingTrades);
  set('Avg Trade', all.avgTrade);
  set('Avg Winning Trade', all.avgWinTrade);
  set('Avg Losing Trade', all.avgLosTrade);
  set('Ratio Avg Win / Avg Loss', all.ratioAvgWinAvgLoss);
  set('Largest Winning Trade', all.largestWinTrade);
  set('Largest Losing Trade', all.largestLosTrade);
  set('Avg # Bars in Trades', all.avgBarsInTrade);
  set('Avg # Bars in Winning Trades', all.avgBarsInWinTrade);
  set('Avg # Bars in Losing Trades', all.avgBarsInLossTrade);
  set('Commission Paid', all.commissionPaid);
  set('Margin Calls', all.marginCalls);
  set('Max Contracts Held', all.maxContractsHeld);
  set('Max Drawdown', perf.maxStrategyDrawDown);
  set('Max Drawdown %', perf.maxStrategyDrawDownPercent);
  set('Max Run-up', perf.maxStrategyRunUp);
  set('Max Run-up %', perf.maxStrategyRunUpPercent);
  set('Open PL', perf.openPL);
  set('Open PL %', perf.openPLPercent);
  set('Buy & Hold Return', perf.buyHoldReturn);
  set('Buy & Hold Return %', perf.buyHoldReturnPercent);
  set('Sharpe Ratio', perf.sharpeRatio);
  set('Sortino Ratio', perf.sortinoRatio);
  set('Max Margin Used', perf.maxMarginUsed);
  set('Avg Margin Used', perf.avgMarginUsed);
  return { metrics: out, long: perf.long, short: perf.short };
}

// Project a single internal trade row (cryptic keys) to the same shape
// COLLECT_TRADES_FN's DOM scraper produces. Cryptic key reference:
//   e: entry leg {c=signal, p=price, tm=timestamp_ms, tp='le'|'se'}
//   x: exit leg  {c=signal, p=price, tm=timestamp_ms, tp='lx'|'sx'}
//   q: contracts
//   tp: trade profit {v=usd, p=fraction}
//   cp: cumulative pnl {v, p}
//   rn: run-up / favorable excursion {v, p}
//   dd: drawdown / adverse excursion {v, p}
function projectInternalTrade(row, idx) {
  function pct(p) { return p == null ? null : Math.round(p * 100 * 1e6) / 1e6; }
  function usd(v) { return v == null ? null : v; }
  function tsToIso(tm) { return tm && Number.isFinite(tm) ? new Date(tm).toISOString() : null; }
  var e = row.e || {};
  var x = row.x || {};
  var direction = e.tp === 'se' ? 'Short' : (e.tp === 'le' ? 'Long' : (e.c || null));
  return {
    trade_num: idx + 1,
    type: direction,
    entry_time: tsToIso(e.tm),
    exit_time: tsToIso(x.tm),
    entry_signal: e.c || null,
    exit_signal: x.c || null,
    entry_price: e.p ?? null,
    exit_price: x.p ?? null,
    contracts: row.q ?? null,
    position_value: null,
    pnl_usd: usd(row.tp && row.tp.v),
    pnl_pct: pct(row.tp && row.tp.p),
    favorable_excursion_usd: usd(row.rn && row.rn.v),
    favorable_excursion_pct: pct(row.rn && row.rn.p),
    adverse_excursion_usd: usd(row.dd && row.dd.v),
    adverse_excursion_pct: pct(row.dd && row.dd.p),
    cumulative_pnl_usd: usd(row.cp && row.cp.v),
    cumulative_pnl_pct: pct(row.cp && row.cp.p),
  };
}
`;

// ─── Performance Summary scraper ─────────────────────────────────
// Defines scrapePerformanceSummary() — DOM scrape of the Performance Summary tab.
// Auto-activates the tab if it isn't selected. Returns { found, metrics, ... }.
// Requires PANEL_DETECT_JS to be embedded earlier (uses findStrategyTesterContainer).
export const SCRAPE_PERF_SUMMARY_FN = `
function scrapePerformanceSummary() {
  var panel = findStrategyTesterContainer();
  if (!panel) return { found: false, reason: 'no_panel' };

  try {
    var tabs = panel.querySelectorAll('[role="tab"], button');
    for (var i = 0; i < tabs.length; i++) {
      var t = (tabs[i].textContent || '').trim();
      if (/^(metrics|performance summary|overview|summary)$/i.test(t)) {
        var sel = tabs[i].getAttribute('aria-selected');
        var act = tabs[i].getAttribute('data-active');
        if (sel !== 'true' && act !== 'true') { try { tabs[i].click(); } catch(e) {} }
        break;
      }
    }
  } catch(e) {}

  var metrics = {};
  try {
    var reportEls = panel.querySelectorAll('[class*="containerCell"], [class*="reportItem"], [class*="metric"]');
    reportEls.forEach(function(el) {
      var label = el.querySelector('[class*="title"], [class*="label"]');
      var val = el.querySelector('[class*="value"]');
      if (label && val) {
        var k = (label.textContent || '').trim();
        var v = (val.textContent || '').trim();
        if (k && v && !metrics[k]) metrics[k] = v;
      }
    });
  } catch(e) {}

  if (Object.keys(metrics).length < 5) {
    try {
      var WHITELIST = /^(Net Profit|Gross Profit|Gross Loss|Max\\s+(?:Run-up|Drawdown)|Total Closed Trades|Number Winning Trades|Number Losing Trades|Avg Trade|Profit Factor|Percent Profitable|Avg Winning Trade|Avg Losing Trade|Ratio Avg Win\\s*\\/\\s*Avg Loss|Largest Winning Trade|Largest Losing Trade|Avg # Bars in Trades|Sharpe Ratio|Sortino Ratio|Buy & Hold Return|Open PL|Commission Paid)$/i;
      var lines = (panel.innerText || '').split('\\n').map(function(l){ return l.trim(); }).filter(Boolean);
      for (var i = 0; i < lines.length - 1; i++) {
        if (WHITELIST.test(lines[i])) {
          var v = lines[i+1];
          if (lines[i+2] && /^[\\(\\+\\-]/.test(lines[i+2])) v += ' ' + lines[i+2];
          if (!metrics[lines[i]]) metrics[lines[i]] = v;
        }
      }
    } catch(e) {}
  }

  return { found: true, metrics: metrics };
}
`;

// ─── List of Trades scraper ──────────────────────────────────────
// Defines collectTrades(maxScrolls, settleMs) — async scraper that activates the
// "List of Trades" tab, walks the virtualized ka-table, scrolls page-by-page,
// dedupes by trade #, and splits the multi-line cells into typed fields.
//
// DOM layout per row (10 ka-cells):
//   0: "<trade_num>\\n<type>"                    e.g., "5\\nLong"
//   1: literal "Exit\\nEntry" labels (skipped)
//   2: "<exit_time>\\n<entry_time>"
//   3: "<exit_signal>\\n<entry_signal>"          e.g., "X\\nLong"
//   4: "<exit_price>\\nUSD\\n<entry_price>\\nUSD" (currency tags filtered)
//   5: "<contracts>\\n<position_value e.g. 4.97 KUSD>"
//   6: "<net_pnl>\\nUSD\\n<net_pnl_pct>"
//   7: "<favorable_excursion>\\nUSD\\n<pct>"     (run-up)
//   8: "<adverse_excursion>\\nUSD\\n<pct>"       (drawdown)
//   9: "<cumulative_pnl>\\nUSD\\n<pct>"
//
// Uses innerText (preserves visual newlines) rather than textContent (which strips them).
// Requires PANEL_DETECT_JS earlier.
export const COLLECT_TRADES_FN = `
async function collectTrades(maxScrolls, settleMs) {
  function sleep(ms) { return new Promise(function(r){ setTimeout(r, ms); }); }
  function parseNum(s) {
    if (s == null) return null;
    var t = String(s).replace(/\\u2212/g, '-').replace(/[^\\d.\\-]/g, '');
    if (!t || t === '-' || t === '.') return null;
    var n = parseFloat(t);
    return isNaN(n) ? null : n;
  }
  function lines(el) {
    if (!el) return [];
    return (el.innerText || '').split('\\n').map(function(x){ return x.trim(); }).filter(Boolean);
  }
  function valueParts(el) {
    return lines(el).filter(function(s){ return !/^USD$/i.test(s); });
  }
  function parsePnlCell(el) {
    var parts = valueParts(el);
    return { usd: parseNum(parts[0]), pct: parseNum(parts[1]) };
  }

  var panel = findStrategyTesterContainer();
  if (!panel) return { error: 'no_panel', trades: [] };

  var tabs = panel.querySelectorAll('[role="tab"], button');
  var tradesTab = null;
  for (var i = 0; i < tabs.length; i++) {
    var t = (tabs[i].textContent || '').trim();
    if (/list of trades/i.test(t)) { tradesTab = tabs[i]; break; }
  }
  if (tradesTab) {
    var sel = tradesTab.getAttribute('aria-selected');
    var act = tradesTab.getAttribute('data-active');
    if (sel !== 'true' && act !== 'true') { try { tradesTab.click(); } catch(e) {} }
    await sleep(settleMs);
  }

  function findScrollContainer() {
    var rows = panel.querySelectorAll('[class*="ka-row"]');
    if (!rows.length) return null;
    var el = rows[0].parentElement;
    for (var i = 0; i < 14 && el; i++) {
      try {
        var st = getComputedStyle(el);
        if (/(auto|scroll)/.test(st.overflowY) && el.scrollHeight > el.clientHeight + 1) return el;
      } catch(e) {}
      el = el.parentElement;
    }
    return null;
  }

  function parseRow(r) {
    var cells = r.querySelectorAll('[class*="ka-cell"]');
    if (cells.length < 9) return null;
    var c0 = lines(cells[0]);
    var tradeNum = parseInt(c0[0], 10);
    if (isNaN(tradeNum)) return null;
    var c2 = lines(cells[2]);
    var c3 = lines(cells[3]);
    var c4 = valueParts(cells[4]);
    var c5 = lines(cells[5]);
    var pnl       = parsePnlCell(cells[6]);
    var favorable = parsePnlCell(cells[7]);
    var adverse   = parsePnlCell(cells[8]);
    var cumPnl    = cells[9] ? parsePnlCell(cells[9]) : { usd: null, pct: null };
    return {
      trade_num: tradeNum,
      type: c0[1] || null,
      entry_time: c2[1] || null,
      exit_time:  c2[0] || null,
      entry_signal: c3[1] || null,
      exit_signal:  c3[0] || null,
      entry_price: parseNum(c4[1]),
      exit_price:  parseNum(c4[0]),
      contracts: parseNum(c5[0]),
      position_value: c5[1] || null,
      pnl_usd: pnl.usd,
      pnl_pct: pnl.pct,
      favorable_excursion_usd: favorable.usd,
      favorable_excursion_pct: favorable.pct,
      adverse_excursion_usd: adverse.usd,
      adverse_excursion_pct: adverse.pct,
      cumulative_pnl_usd: cumPnl.usd,
      cumulative_pnl_pct: cumPnl.pct,
    };
  }

  function readVisibleRows() {
    var out = [];
    var rows = panel.querySelectorAll('[class*="ka-row"]');
    rows.forEach(function(r) {
      var parsed = parseRow(r);
      if (parsed) out.push(parsed);
    });
    return out;
  }

  var container = findScrollContainer();
  if (!container) {
    return { error: null, trades: readVisibleRows(), source: 'dom_scrape', virtualized: false };
  }

  var seen = new Map();
  var prevScroll = -1;
  var stagnant = 0;
  container.scrollTop = 0;
  try { container.dispatchEvent(new Event('scroll', { bubbles: true })); } catch(e) {}
  await sleep(settleMs);

  var pass = 0;
  for (pass = 0; pass < maxScrolls; pass++) {
    var rows = readVisibleRows();
    var added = 0;
    for (var k = 0; k < rows.length; k++) {
      if (!seen.has(rows[k].trade_num)) { seen.set(rows[k].trade_num, rows[k]); added++; }
    }
    var atBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 2;
    if (atBottom && added === 0) {
      stagnant++;
      if (stagnant >= 2) break;
    } else if (container.scrollTop === prevScroll && added === 0) {
      stagnant++;
      if (stagnant >= 2) break;
    } else {
      stagnant = 0;
    }
    prevScroll = container.scrollTop;
    var step = Math.max(60, container.clientHeight - 20);
    container.scrollTop = Math.min(container.scrollHeight, container.scrollTop + step);
    try { container.dispatchEvent(new Event('scroll', { bubbles: true })); } catch(e) {}
    await sleep(settleMs);
  }

  readVisibleRows().forEach(function(r) { if (!seen.has(r.trade_num)) seen.set(r.trade_num, r); });
  var sorted = Array.from(seen.values()).sort(function(a,b){ return a.trade_num - b.trade_num; });
  return { error: null, trades: sorted, source: 'dom_scrape', virtualized: true, scrolls: pass };
}
`;
