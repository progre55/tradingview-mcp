/**
 * Core chart control logic.
 */
import { evaluate, evaluateAsync } from '../connection.js';
import { waitForChartReady } from '../wait.js';

const CHART_API = 'window.TradingViewApi._activeChartWidgetWV.value()';

export async function getState() {
  const state = await evaluate(`
    (function() {
      var chart = ${CHART_API};
      var studies = [];
      try {
        var allStudies = chart.getAllStudies();
        studies = allStudies.map(function(s) {
          return { id: s.id, name: s.name || s.title || 'unknown' };
        });
      } catch(e) {}
      return {
        symbol: chart.symbol(),
        resolution: chart.resolution(),
        chartType: chart.chartType(),
        studies: studies,
      };
    })()
  `);
  return { success: true, ...state };
}

export async function setSymbol({ symbol }) {
  await evaluateAsync(`
    (function() {
      var chart = ${CHART_API};
      return new Promise(function(resolve) {
        chart.setSymbol('${symbol.replace(/'/g, "\\'")}', {});
        setTimeout(resolve, 500);
      });
    })()
  `);
  const ready = await waitForChartReady(symbol);
  return { success: true, symbol, chart_ready: ready };
}

export async function setTimeframe({ timeframe }) {
  await evaluate(`
    (function() {
      var chart = ${CHART_API};
      chart.setResolution('${timeframe.replace(/'/g, "\\'")}', {});
    })()
  `);
  const ready = await waitForChartReady(null, timeframe);
  return { success: true, timeframe, chart_ready: ready };
}

export async function setType({ chart_type }) {
  const typeMap = {
    'Bars': 0, 'Candles': 1, 'Line': 2, 'Area': 3,
    'Renko': 4, 'Kagi': 5, 'PointAndFigure': 6, 'LineBreak': 7,
    'HeikinAshi': 8, 'HollowCandles': 9,
  };
  const typeNum = typeMap[chart_type] ?? Number(chart_type);
  if (isNaN(typeNum)) {
    throw new Error(`Unknown chart type: ${chart_type}. Use a name (Candles, Line, etc.) or number (0-9).`);
  }
  await evaluate(`
    (function() {
      var chart = ${CHART_API};
      chart.setChartType(${typeNum});
    })()
  `);
  return { success: true, chart_type, type_num: typeNum };
}

export async function manageIndicator({ action, indicator, entity_id, inputs: inputsRaw }) {
  const inputs = inputsRaw ? (typeof inputsRaw === 'string' ? JSON.parse(inputsRaw) : inputsRaw) : undefined;

  if (action === 'add') {
    const inputArr = inputs ? Object.entries(inputs).map(([k, v]) => ({ id: k, value: v })) : [];
    const before = await evaluate(`${CHART_API}.getAllStudies().map(function(s) { return s.id; })`);
    await evaluate(`
      (function() {
        var chart = ${CHART_API};
        chart.createStudy('${indicator.replace(/'/g, "\\'")}', false, false, ${JSON.stringify(inputArr)});
      })()
    `);
    await new Promise(r => setTimeout(r, 1500));
    const after = await evaluate(`${CHART_API}.getAllStudies().map(function(s) { return s.id; })`);
    const newIds = (after || []).filter(id => !(before || []).includes(id));
    return { success: newIds.length > 0, action: 'add', indicator, entity_id: newIds[0] || null, new_study_count: newIds.length };
  } else if (action === 'remove') {
    if (!entity_id) throw new Error('entity_id required for remove action. Use chart_get_state to find study IDs.');
    await evaluate(`
      (function() {
        var chart = ${CHART_API};
        chart.removeEntity('${entity_id.replace(/'/g, "\\'")}');
      })()
    `);
    return { success: true, action: 'remove', entity_id };
  } else {
    throw new Error('action must be "add" or "remove"');
  }
}

export async function getVisibleRange() {
  const result = await evaluate(`
    (function() {
      var chart = ${CHART_API};
      return { visible_range: chart.getVisibleRange(), bars_range: chart.getVisibleBarsRange() };
    })()
  `);
  return { success: true, visible_range: result.visible_range, bars_range: result.bars_range };
}

// Pure helper: decide whether the post-scroll visible range actually covers
// the requested target. Used by setVisibleRange and scrollToDate after they
// fire the underlying chart event. Issue v4 #1: zoomToBarsRange is a no-op
// when the target falls outside the currently-loaded bars (the main series
// only holds what TV's data feed has streamed so far). The classifier maps
// (requested, actual) → {moved, target_in_actual} so callers see the bug
// instead of the previous silent success.
//
// Tolerance: we accept "target inside actual.from .. actual.to" as covered.
// `moved` is a structural before/after check — if the chart didn't move at
// all and the target wasn't already in the visible range, the scroll is a
// no-op.
export function classifyVisibleRangeOutcome({ before, after, target }) {
  const safe = (r) => r && Number.isFinite(r.from) && Number.isFinite(r.to);
  if (!safe(after)) {
    return { success: false, moved: false, target_in_actual: false, reason: 'no_actual_range' };
  }
  const moved = !!safe(before) && (before.from !== after.from || before.to !== after.to);
  const target_in_actual = target == null
    ? true
    : (after.from <= Number(target) && Number(target) <= after.to);
  return {
    success: target_in_actual,
    moved,
    target_in_actual,
    reason: target_in_actual
      ? null
      : (moved ? 'target_outside_actual_range' : 'chart_did_not_move'),
  };
}

async function readVisibleRange() {
  return evaluate(`
    (function() {
      var chart = ${CHART_API};
      try { var r = chart.getVisibleRange(); return { from: r.from || 0, to: r.to || 0 }; }
      catch(e) { return { from: 0, to: 0, error: e.message }; }
    })()
  `);
}

export async function setVisibleRange({ from, to }) {
  const before = await readVisibleRange();
  await evaluate(`
    (function() {
      var chart = ${CHART_API};
      var m = chart._chartWidget.model();
      var ts = m.timeScale();
      var bars = m.mainSeries().bars();
      var startIdx = bars.firstIndex();
      var endIdx = bars.lastIndex();
      var fromIdx = startIdx, toIdx = endIdx;
      for (var i = startIdx; i <= endIdx; i++) {
        var v = bars.valueAt(i);
        if (v && v[0] >= ${from} && fromIdx === startIdx) fromIdx = i;
        if (v && v[0] <= ${to}) toIdx = i;
      }
      ts.zoomToBarsRange(fromIdx, toIdx);
    })()
  `);
  await new Promise(r => setTimeout(r, 800));
  const actual = await readVisibleRange();
  // Target is "the middle of the requested range" — any bar between from..to
  // is acceptable coverage for setVisibleRange.
  const target = Math.floor((Number(from) + Number(to)) / 2);
  const outcome = classifyVisibleRangeOutcome({ before, after: actual, target });
  if (outcome.success) {
    return { success: true, requested: { from, to }, actual };
  }
  return {
    success: false,
    error: outcome.reason === 'chart_did_not_move'
      ? 'chart did not move — requested range likely falls outside loaded bars. Scroll the chart manually or pick a range covered by getVisibleRange().'
      : 'chart moved but the requested range is not inside actual.from..actual.to (likely clamped to loaded bars).',
    requested: { from, to },
    actual,
    moved: outcome.moved,
  };
}

export async function scrollToDate({ date }) {
  let timestamp;
  if (/^\d+$/.test(date)) timestamp = Number(date);
  else timestamp = Math.floor(new Date(date).getTime() / 1000);
  if (isNaN(timestamp)) throw new Error(`Could not parse date: ${date}. Use ISO format (2024-01-15) or unix timestamp.`);

  const resolution = await evaluate(`${CHART_API}.resolution()`);
  let secsPerBar = 60;
  const res = String(resolution);
  if (res === 'D' || res === '1D') secsPerBar = 86400;
  else if (res === 'W' || res === '1W') secsPerBar = 604800;
  else if (res === 'M' || res === '1M') secsPerBar = 2592000;
  else { const mins = parseInt(res, 10); if (!isNaN(mins)) secsPerBar = mins * 60; }

  const halfWindow = 25 * secsPerBar;
  const from = timestamp - halfWindow;
  const to = timestamp + halfWindow;

  const before = await readVisibleRange();
  await evaluate(`
    (function() {
      var chart = ${CHART_API};
      var m = chart._chartWidget.model();
      var ts = m.timeScale();
      var bars = m.mainSeries().bars();
      var startIdx = bars.firstIndex();
      var endIdx = bars.lastIndex();
      var fromIdx = startIdx, toIdx = endIdx;
      for (var i = startIdx; i <= endIdx; i++) {
        var v = bars.valueAt(i);
        if (v && v[0] >= ${from} && fromIdx === startIdx) fromIdx = i;
        if (v && v[0] <= ${to}) toIdx = i;
      }
      ts.zoomToBarsRange(fromIdx, toIdx);
    })()
  `);
  await new Promise(r => setTimeout(r, 800));
  const actual = await readVisibleRange();
  const outcome = classifyVisibleRangeOutcome({ before, after: actual, target: timestamp });
  if (outcome.success) {
    return {
      success: true,
      date,
      centered_on: timestamp,
      resolution,
      window: { from, to },
      actual,
    };
  }
  return {
    success: false,
    error: outcome.reason === 'chart_did_not_move'
      ? 'chart did not scroll — the requested date likely falls outside loaded bars. Try a date already covered by getVisibleRange(), or scroll the chart manually first to load history.'
      : 'chart moved but the requested date is not inside actual.from..actual.to (likely clamped to loaded bars).',
    date,
    centered_on: timestamp,
    resolution,
    requested_window: { from, to },
    actual,
    moved: outcome.moved,
  };
}

export async function symbolInfo() {
  const result = await evaluate(`
    (function() {
      var chart = ${CHART_API};
      var info = chart.symbolExt();
      return {
        symbol: info.symbol, full_name: info.full_name, exchange: info.exchange,
        description: info.description, type: info.type, pro_name: info.pro_name,
        typespecs: info.typespecs, resolution: chart.resolution(), chart_type: chart.chartType()
      };
    })()
  `);
  return { success: true, ...result };
}

export async function symbolSearch({ query, type }) {
  // Use TradingView's public symbol search REST API (works without auth)
  const params = new URLSearchParams({
    text: query,
    hl: '1',
    exchange: '',
    lang: 'en',
    search_type: type || '',
    domain: 'production',
  });

  const resp = await fetch(`https://symbol-search.tradingview.com/symbol_search/v3/?${params}`, {
    headers: { 'Origin': 'https://www.tradingview.com', 'Referer': 'https://www.tradingview.com/' },
  });
  if (!resp.ok) throw new Error(`Symbol search API returned ${resp.status}`);
  const data = await resp.json();

  const strip = s => (s || '').replace(/<\/?em>/g, '');
  const results = (data.symbols || data || []).slice(0, 15).map(r => ({
    symbol: strip(r.symbol),
    description: strip(r.description),
    exchange: r.exchange || r.prefix || '',
    type: r.type || '',
    full_name: r.exchange ? `${r.exchange}:${strip(r.symbol)}` : strip(r.symbol),
  }));

  return { success: true, query, source: 'rest_api', results, count: results.length };
}
