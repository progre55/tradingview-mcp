/**
 * Core UI automation logic.
 */
import { evaluate, evaluateAsync, getClient } from '../connection.js';
import { PANEL_DETECT_JS } from './_panels.js';

export async function click({ by, value }) {
  const escaped = JSON.stringify(value);
  const result = await evaluate(`
    (function() {
      var by = ${JSON.stringify(by)};
      var value = ${escaped};
      var el = null;
      if (by === 'aria-label') el = document.querySelector('[aria-label="' + value.replace(/"/g, '\\\\"') + '"]');
      else if (by === 'data-name') el = document.querySelector('[data-name="' + value.replace(/"/g, '\\\\"') + '"]');
      else if (by === 'text') {
        var candidates = document.querySelectorAll('button, a, [role="button"], [role="menuitem"], [role="tab"]');
        for (var i = 0; i < candidates.length; i++) {
          var text = candidates[i].textContent.trim();
          if (text === value || text.toLowerCase() === value.toLowerCase()) { el = candidates[i]; break; }
        }
      } else if (by === 'class-contains') el = document.querySelector('[class*="' + value.replace(/"/g, '\\\\"') + '"]');
      if (!el) return { found: false };
      el.click();
      return { found: true, tag: el.tagName.toLowerCase(), text: (el.textContent || '').trim().substring(0, 80), aria_label: el.getAttribute('aria-label') || null, data_name: el.getAttribute('data-name') || null };
    })()
  `);
  if (!result || !result.found) throw new Error('No matching element found for ' + by + '="' + value + '"');
  return { success: true, clicked: result };
}

export async function openPanel({ panel, action }) {
  const isBottomPanel = panel === 'pine-editor' || panel === 'strategy-tester';
  if (isBottomPanel) {
    const widgetName = panel === 'pine-editor' ? 'pine-editor' : 'backtesting';
    const result = await evaluate(`
      (function() {
        ${PANEL_DETECT_JS}
        var bwb = window.TradingView && window.TradingView.bottomWidgetBar;
        if (!bwb) return { error: 'bottomWidgetBar not available' };
        var panel = ${JSON.stringify(panel)};
        var widgetName = ${JSON.stringify(widgetName)};
        var action = ${JSON.stringify(action)};
        var bottomArea = document.querySelector('[class*="layout__area--bottom"]');
        var isOpen = !!(bottomArea && bottomArea.offsetHeight > 50);
        if (panel === 'pine-editor') { var monacoEl = document.querySelector('.monaco-editor.pine-editor-monaco'); isOpen = isOpen && !!monacoEl; }
        if (panel === 'strategy-tester') { isOpen = isStrategyTesterOpen().open; }
        var performed = 'none';
        if (action === 'open' || (action === 'toggle' && !isOpen)) {
          if (panel === 'pine-editor') { if (typeof bwb.activateScriptEditorTab === 'function') bwb.activateScriptEditorTab(); else if (typeof bwb.showWidget === 'function') bwb.showWidget(widgetName); }
          else { if (typeof bwb.showWidget === 'function') bwb.showWidget(widgetName); }
          performed = 'opened';
        } else if (action === 'close' || (action === 'toggle' && isOpen)) {
          if (typeof bwb.hideWidget === 'function') bwb.hideWidget(widgetName);
          performed = 'closed';
        }
        return { was_open: isOpen, performed: performed };
      })()
    `);
    if (result && result.error) throw new Error(result.error);
    return { success: true, panel, action, was_open: result?.was_open ?? false, performed: result?.performed ?? 'unknown' };
  } else {
    const selectorMap = {
      'watchlist': { dataName: 'base-watchlist-widget-button', ariaLabel: 'Watchlist' },
      'alerts': { dataName: 'alerts-button', ariaLabel: 'Alerts' },
      'trading': { dataName: 'trading-button', ariaLabel: 'Trading Panel' },
    };
    const sel = selectorMap[panel];
    const result = await evaluate(`
      (function() {
        var dataName = ${JSON.stringify(sel.dataName)};
        var ariaLabel = ${JSON.stringify(sel.ariaLabel)};
        var action = ${JSON.stringify(action)};
        var btn = document.querySelector('[data-name="' + dataName + '"]') || document.querySelector('[aria-label="' + ariaLabel + '"]');
        if (!btn) return { error: 'Button not found for panel: ' + ${JSON.stringify(panel)} };
        var isActive = btn.getAttribute('aria-pressed') === 'true' || btn.classList.contains('isActive') || btn.classList.toString().indexOf('active') !== -1 || btn.classList.toString().indexOf('Active') !== -1;
        var rightArea = document.querySelector('[class*="layout__area--right"]');
        var sidebarOpen = !!(rightArea && rightArea.offsetWidth > 50);
        var isOpen = isActive && sidebarOpen;
        var performed = 'none';
        if (action === 'open' && !isOpen) { btn.click(); performed = 'opened'; }
        else if (action === 'close' && isOpen) { btn.click(); performed = 'closed'; }
        else if (action === 'toggle') { btn.click(); performed = isOpen ? 'closed' : 'opened'; }
        else { performed = isOpen ? 'already_open' : 'already_closed'; }
        return { was_open: isOpen, performed: performed };
      })()
    `);
    if (result && result.error) throw new Error(result.error);
    return { success: true, panel, action, was_open: result?.was_open ?? false, performed: result?.performed ?? 'unknown' };
  }
}

export async function fullscreen() {
  const result = await evaluate(`
    (function() {
      var btn = document.querySelector('[data-name="header-toolbar-fullscreen"]');
      if (!btn) return { found: false };
      btn.click();
      return { found: true };
    })()
  `);
  if (!result || !result.found) throw new Error('Fullscreen button not found');
  return { success: true, action: 'fullscreen_toggled' };
}

export async function layoutList() {
  const layouts = await evaluateAsync(`
    new Promise(function(resolve) {
      try {
        window.TradingViewApi.getSavedCharts(function(charts) {
          if (!charts || !Array.isArray(charts)) { resolve({layouts: [], source: 'internal_api', error: 'getSavedCharts returned no data'}); return; }
          var result = charts.map(function(c) { return { id: c.id || c.chartId || null, name: c.name || c.title || 'Untitled', symbol: c.symbol || null, resolution: c.resolution || null, modified: c.timestamp || c.modified || null }; });
          resolve({layouts: result, source: 'internal_api'});
        });
        setTimeout(function() { resolve({layouts: [], source: 'internal_api', error: 'getSavedCharts timed out'}); }, 5000);
      } catch(e) { resolve({layouts: [], source: 'internal_api', error: e.message}); }
    })
  `);
  return { success: true, layout_count: layouts?.layouts?.length || 0, source: layouts?.source, layouts: layouts?.layouts || [], error: layouts?.error };
}

/**
 * Pure: pick a saved layout for `query` from getSavedCharts() entries.
 * Order: numeric id or short url (exact) → exact name → case-insensitive name
 * → case-insensitive substring, only when exactly one layout contains it.
 * Returns { match, candidates }; candidates lists an ambiguous substring hit.
 */
export function matchSavedLayout(charts, query) {
  const none = { match: null, candidates: [] };
  if (!Array.isArray(charts) || query == null) return none;
  const q = String(query).trim();
  if (!q) return none;
  const ql = q.toLowerCase();
  const nameOf = c => c.name || c.title || '';
  const exact = charts.find(c => String(c.id) === q || c.url === q)
    || charts.find(c => nameOf(c) === q)
    || charts.find(c => nameOf(c).toLowerCase() === ql);
  if (exact) return { match: exact, candidates: [] };
  const partial = charts.filter(c => nameOf(c).toLowerCase().includes(ql));
  if (partial.length === 1) return { match: partial[0], candidates: [] };
  return { match: null, candidates: partial.map(nameOf) };
}

export async function layoutSwitch({ name, discard_unsaved = false }) {
  const saved = await evaluateAsync(`
    new Promise(function(resolve) {
      try {
        window.TradingViewApi.getSavedCharts(function(charts) {
          if (!Array.isArray(charts)) { resolve({ error: 'getSavedCharts returned no data' }); return; }
          resolve({ charts: charts.map(function(c) { return { id: c.id, url: c.url, name: c.name || c.title || '' }; }) });
        });
        setTimeout(function() { resolve({ error: 'getSavedCharts timed out' }); }, 5000);
      } catch (e) { resolve({ error: e.message }); }
    })
  `);
  if (saved?.error) throw new Error(saved.error);
  const { match, candidates } = matchSavedLayout(saved.charts, name);
  if (!match && candidates.length) return { success: false, error: `Layout "${name}" is ambiguous.`, candidates };
  if (!match) return { success: false, error: `Layout "${name}" not found.`, available: saved.charts.map(c => c.name) };
  if (!match.url) return { success: false, error: `Layout "${match.name}" has no short url; cannot load it.`, layout_id: match.id };

  // loadChartFromServer(id) is a silent no-op: it hands the bare id to
  // loadChart(), which expects a chart-list entry. loadChartByUrl resolves the
  // entry itself and throws when the layout isn't opened. Its 3rd argument
  // skips the unsaved-changes prompt, which discards those changes.
  const load = await evaluateAsync(`
    (async function() {
      var api = window.TradingViewApi;
      var hc = null;
      try { hc = api._saveChartService.hasChanges(); if (hc && typeof hc.value === 'function') hc = hc.value(); } catch (e) {}
      var discard = ${discard_unsaved ? 'true' : 'false'};
      // Unknown counts as unsaved: loadChartByUrl would otherwise block on its modal.
      if (hc !== false && !discard) return { unsaved: true, unknown: hc !== true };
      if (!api._loadChartService || typeof api._loadChartService.loadChartByUrl !== 'function') {
        return { error: 'loadChartByUrl is not available on this build' };
      }
      try {
        await Promise.race([
          api._loadChartService.loadChartByUrl(${JSON.stringify(match.url)}, undefined, discard),
          new Promise(function(_, reject) { setTimeout(function() { reject(new Error('loadChartByUrl timed out after 15s')); }, 15000); }),
        ]);
        return { ok: true };
      } catch (e) { return { error: e && e.message ? e.message : String(e) }; }
    })()
  `);
  if (load?.unsaved) {
    return {
      success: false,
      error: 'unsaved_changes',
      detail: load.unknown
        ? 'Could not read whether the current layout has unsaved changes. Save it first, or pass discard_unsaved:true.'
        : 'The current layout has unsaved changes. Save it first, or pass discard_unsaved:true to drop them.',
      layout: match.name,
    };
  }
  if (load?.error) return { success: false, error: load.error, layout: match.name, layout_id: match.id };

  const expected = `/chart/${match.url}/`;
  const deadline = Date.now() + 5000;
  let state = null;
  while (Date.now() < deadline) {
    try {
      state = await evaluate(`
        (function() {
          var r = { path: location.pathname };
          try { var c = window.TradingViewApi._activeChartWidgetWV.value(); r.symbol = c.symbol(); r.resolution = c.resolution(); } catch (e) {}
          return r;
        })()
      `);
    } catch { /* page mid-navigation; retry */ }
    if (state?.path === expected) break;
    await new Promise(r => setTimeout(r, 250));
  }
  if (state?.path !== expected) {
    return { success: false, error: 'layout did not load', expected_path: expected, actual_path: state?.path ?? null, layout: match.name };
  }
  const result = {
    success: true,
    action: 'switched',
    layout: match.name,
    layout_id: match.id,
    chart_id: match.url,
    symbol: state.symbol ?? null,
    resolution: state.resolution ?? null,
  };
  if (process.env.TV_CHART_ID && process.env.TV_CHART_ID !== match.url) {
    result.note = `TV_CHART_ID pins "${process.env.TV_CHART_ID}"; after a reconnect the session resolves to that chart, not this tab. Use tab_switch with chart_id "${match.url}".`;
  }
  return result;
}

export async function keyboard({ key, modifiers }) {
  const c = await getClient();
  let mod = 0;
  if (modifiers) {
    if (modifiers.includes('alt')) mod |= 1;
    if (modifiers.includes('ctrl')) mod |= 2;
    if (modifiers.includes('meta')) mod |= 4;
    if (modifiers.includes('shift')) mod |= 8;
  }
  const keyMap = {
    'Enter': { code: 'Enter', vk: 13 }, 'Escape': { code: 'Escape', vk: 27 }, 'Tab': { code: 'Tab', vk: 9 },
    'Backspace': { code: 'Backspace', vk: 8 }, 'Delete': { code: 'Delete', vk: 46 },
    'ArrowUp': { code: 'ArrowUp', vk: 38 }, 'ArrowDown': { code: 'ArrowDown', vk: 40 },
    'ArrowLeft': { code: 'ArrowLeft', vk: 37 }, 'ArrowRight': { code: 'ArrowRight', vk: 39 },
    'Space': { code: 'Space', vk: 32 }, 'Home': { code: 'Home', vk: 36 }, 'End': { code: 'End', vk: 35 },
    'PageUp': { code: 'PageUp', vk: 33 }, 'PageDown': { code: 'PageDown', vk: 34 },
    'F1': { code: 'F1', vk: 112 }, 'F2': { code: 'F2', vk: 113 }, 'F5': { code: 'F5', vk: 116 },
  };
  const mapped = keyMap[key] || { code: 'Key' + key.toUpperCase(), vk: key.toUpperCase().charCodeAt(0) };
  await c.Input.dispatchKeyEvent({ type: 'keyDown', modifiers: mod, key, code: mapped.code, windowsVirtualKeyCode: mapped.vk });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', key, code: mapped.code });
  return { success: true, key, modifiers: modifiers || [] };
}

export async function typeText({ text }) {
  const c = await getClient();
  await c.Input.insertText({ text });
  return { success: true, typed: text.substring(0, 100), length: text.length };
}

export async function hover({ by, value }) {
  const coords = await evaluate(`
    (function() {
      var by = ${JSON.stringify(by)};
      var value = ${JSON.stringify(value)};
      var el = null;
      if (by === 'aria-label') {
        el = document.querySelector('[aria-label="' + value.replace(/"/g, '\\\\"') + '"]');
        if (!el) el = document.querySelector('[aria-label*="' + value.replace(/"/g, '\\\\"') + '"]');
      }
      else if (by === 'data-name') el = document.querySelector('[data-name="' + value.replace(/"/g, '\\\\"') + '"]');
      else if (by === 'text') {
        var candidates = document.querySelectorAll('button, a, [role="button"], [role="menuitem"], [role="tab"], span, div');
        for (var i = 0; i < candidates.length; i++) { var text = candidates[i].textContent.trim(); if (text === value || text.toLowerCase() === value.toLowerCase()) { el = candidates[i]; break; } }
      } else if (by === 'class-contains') el = document.querySelector('[class*="' + value.replace(/"/g, '\\\\"') + '"]');
      if (!el) return null;
      var rect = el.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, tag: el.tagName.toLowerCase() };
    })()
  `);
  if (!coords) throw new Error('Element not found for ' + by + '="' + value + '"');
  const c = await getClient();
  await c.Input.dispatchMouseEvent({ type: 'mouseMoved', x: coords.x, y: coords.y });
  return { success: true, hovered: { by, value, tag: coords.tag, x: coords.x, y: coords.y } };
}

export async function scroll({ direction, amount, target }) {
  const c = await getClient();
  const px = amount || 300;
  const tgt = target || 'chart';
  const dx = direction === 'left' ? -px : direction === 'right' ? px : 0;
  const dy = direction === 'up' ? -px : direction === 'down' ? px : 0;

  const probe = await evaluate(`
    (function() {
      ${PANEL_DETECT_JS}
      var tgt = ${JSON.stringify(tgt)};
      var el = null;
      if (tgt === 'chart') {
        el = document.querySelector('[data-name="pane-canvas"]') || document.querySelector('[class*="chart-container"]') || document.querySelector('canvas');
      } else if (tgt === 'strategy-tester') {
        var panel = findStrategyTesterContainer();
        if (panel) {
          var rows = panel.querySelectorAll('[class*="ka-row"]');
          if (rows.length) {
            var sc = rows[0].parentElement;
            for (var i = 0; i < 14 && sc; i++) {
              try {
                var st = getComputedStyle(sc);
                if (/(auto|scroll)/.test(st.overflowY) && sc.scrollHeight > sc.clientHeight + 1) { el = sc; break; }
              } catch(e) {}
              sc = sc.parentElement;
            }
          }
          if (!el) el = panel;
        }
      } else if (tgt === 'pine-editor') {
        el = document.querySelector('.monaco-editor.pine-editor-monaco');
      } else if (tgt === 'right-panel') {
        el = document.querySelector('[class*="layout__area--right"]');
      }
      if (!el) return null;
      var isCanvas = el.tagName === 'CANVAS';
      if (!isCanvas) {
        el.scrollLeft = (el.scrollLeft || 0) + ${dx};
        el.scrollTop  = (el.scrollTop  || 0) + ${dy};
        try { el.dispatchEvent(new Event('scroll', { bubbles: true })); } catch(e) {}
        return { method: 'scrollTop', tag: el.tagName.toLowerCase(), scrollTop: el.scrollTop };
      }
      var rect = el.getBoundingClientRect();
      return { method: 'mouseWheel', x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    })()
  `);

  if (!probe) {
    if (tgt !== 'chart') throw new Error('No scrollable target found for: ' + tgt);
    // Fall through to old chart-canvas behavior using window-center fallback.
    await c.Input.dispatchMouseEvent({ type: 'mouseWheel', x: 400, y: 400, deltaX: dx, deltaY: dy });
    return { success: true, direction, amount: px, target: tgt, method: 'mouseWheel' };
  }
  if (probe.method === 'scrollTop') {
    return { success: true, direction, amount: px, target: tgt, method: 'scrollTop', scroll_top: probe.scrollTop };
  }
  await c.Input.dispatchMouseEvent({ type: 'mouseWheel', x: probe.x, y: probe.y, deltaX: dx, deltaY: dy });
  return { success: true, direction, amount: px, target: tgt, method: 'mouseWheel' };
}

export async function mouseClick({ x, y, button, double_click }) {
  const c = await getClient();
  const btn = button === 'right' ? 'right' : button === 'middle' ? 'middle' : 'left';
  const btnNum = btn === 'right' ? 2 : btn === 'middle' ? 1 : 0;
  await c.Input.dispatchMouseEvent({ type: 'mouseMoved', x, y });
  await c.Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: btn, buttons: btnNum, clickCount: 1 });
  await c.Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: btn });
  if (double_click) {
    await new Promise(r => setTimeout(r, 50));
    await c.Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: btn, buttons: btnNum, clickCount: 2 });
    await c.Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: btn });
  }
  return { success: true, x, y, button: btn, double_click: !!double_click };
}

export async function findElement({ query, strategy }) {
  const strat = strategy || 'text';
  const results = await evaluate(`
    (function() {
      var query = ${JSON.stringify(query)};
      var strategy = ${JSON.stringify(strat)};
      var results = [];
      if (strategy === 'css') {
        var els = document.querySelectorAll(query);
        for (var i = 0; i < Math.min(els.length, 20); i++) {
          var rect = els[i].getBoundingClientRect();
          results.push({ tag: els[i].tagName.toLowerCase(), text: (els[i].textContent || '').trim().substring(0, 80), aria_label: els[i].getAttribute('aria-label') || null, data_name: els[i].getAttribute('data-name') || null, x: rect.x, y: rect.y, width: rect.width, height: rect.height, visible: els[i].offsetParent !== null });
        }
      } else if (strategy === 'aria-label') {
        var els = document.querySelectorAll('[aria-label*="' + query.replace(/"/g, '\\\\"') + '"]');
        for (var i = 0; i < Math.min(els.length, 20); i++) {
          var rect = els[i].getBoundingClientRect();
          results.push({ tag: els[i].tagName.toLowerCase(), text: (els[i].textContent || '').trim().substring(0, 80), aria_label: els[i].getAttribute('aria-label') || null, data_name: els[i].getAttribute('data-name') || null, x: rect.x, y: rect.y, width: rect.width, height: rect.height, visible: els[i].offsetParent !== null });
        }
      } else {
        var all = document.querySelectorAll('button, a, [role="button"], [role="menuitem"], [role="tab"], input, select, label, span, div, h1, h2, h3, h4');
        for (var i = 0; i < all.length; i++) {
          var text = all[i].textContent.trim();
          if (text.toLowerCase().indexOf(query.toLowerCase()) !== -1 && text.length < 200) {
            var rect = all[i].getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              results.push({ tag: all[i].tagName.toLowerCase(), text: text.substring(0, 80), aria_label: all[i].getAttribute('aria-label') || null, data_name: all[i].getAttribute('data-name') || null, x: rect.x, y: rect.y, width: rect.width, height: rect.height, visible: all[i].offsetParent !== null });
              if (results.length >= 20) break;
            }
          }
        }
      }
      return results;
    })()
  `);
  return { success: true, query, strategy: strat, count: results?.length || 0, elements: results || [] };
}

export async function uiEvaluate({ expression }) {
  const result = await evaluateAsync(expression);
  return { success: true, result };
}
