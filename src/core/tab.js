/**
 * Core tab management logic.
 * Controls TradingView Desktop tabs via CDP and the Desktop tab strip.
 */
import CDP from 'chrome-remote-interface';
import { evaluate, getTargetInfo, attachToTarget } from '../connection.js';

const CDP_HOST = 'localhost';
const CDP_PORT = 9222;

/**
 * List all open chart tabs (CDP page targets).
 */
export async function list() {
  const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
  const targets = await resp.json();

  const tabs = targets
    .filter(t => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url))
    .map((t, i) => ({
      index: i,
      id: t.id,
      title: t.title.replace(/^Live stock.*charts on /, ''),
      url: t.url,
      chart_id: t.url.match(/\/chart\/([^/?]+)/)?.[1] || null,
    }));

  return { success: true, tab_count: tabs.length, tabs };
}

/**
 * Pure: the targets in `afterTabs` whose CDP id wasn't in `beforeIds`.
 * Compares by id, not count or position — /json/list order is recency-based.
 */
export function diffNewTabs(beforeIds, afterTabs) {
  const before = new Set(beforeIds);
  return (afterTabs || []).filter(t => !before.has(t.id));
}

async function listAllTargets() {
  const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
  return resp.json();
}

// Desktop chrome (tab strip, new-tab launcher) renders in its own file:// pages,
// not in any chart page, so clicks there need a dedicated short-lived CDP
// session. Never reuses the shared client in connection.js.
async function evaluateOnTarget(target, expression) {
  const c = await CDP({ host: CDP_HOST, port: CDP_PORT, target: target.id });
  try {
    const r = await c.Runtime.evaluate({ expression, returnByValue: true });
    if (r.exceptionDetails) return { ok: false, reason: r.exceptionDetails.text || 'eval_error' };
    return { ok: true, value: r.result?.value };
  } finally {
    try { await c.close(); } catch { /* already gone */ }
  }
}

// With several Desktop windows we can't tell which tab strip owns a target,
// and clicking ".tab.active" in the wrong one closes an unrelated tab.
async function evaluateOnShell(expression) {
  const shells = (await listAllTargets()).filter(t => t.type === 'page' && /app\/window\/index\.html/.test(t.url));
  if (!shells.length) return { ok: false, reason: 'desktop_shell_target_not_found' };
  if (shells.length > 1) return { ok: false, reason: 'multiple_desktop_windows_unsupported' };
  return evaluateOnTarget(shells[0], expression);
}

async function poll(fn, predicate, timeoutMs, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  let state = await fn();
  while (!predicate(state) && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, intervalMs));
    state = await fn();
  }
  return state;
}

// Foregrounds `target`, confirms via `readVisibility` that it is the visible
// page (only the foreground tab reports "visible"), then clicks the active
// tab's close button in the Desktop tab strip and waits for the target to go.
async function closeTargetViaShell(target, readVisibility) {
  const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/activate/${target.id}`);
  if (!resp.ok) return { success: false, error: `failed to activate tab: HTTP ${resp.status}` };
  const visible = await poll(readVisibility, v => v === 'visible', 3000);
  if (visible !== 'visible') {
    return { success: false, error: 'tab did not become the foreground tab; refusing to click close' };
  }
  const clicked = await evaluateOnShell(`
    (function() {
      var btn = document.querySelector('.tab.active .tab-close-button');
      if (!btn) return false;
      btn.click();
      return true;
    })()
  `);
  if (!clicked.ok || !clicked.value) {
    return { success: false, error: 'active tab close button not found in Desktop tab strip', reason: clicked.reason };
  }
  const gone = await poll(listAllTargets, ts => !ts.some(t => t.id === target.id), 5000);
  if (gone.some(t => t.id === target.id)) {
    return { success: false, error: 'tab is still open after clicking close (an unsaved-changes prompt may be showing)' };
  }
  return { success: true };
}

/**
 * Open a new chart tab. On current Desktop builds a synthetic Cmd/Ctrl+T on a
 * chart page is a no-op (the accelerator belongs to Electron's main-process
 * menu), so this clicks the tab strip's "New tab" button, which opens a
 * launcher page, then picks "Create new layout" or the named layout card.
 */
export async function newTab({ layout } = {}) {
  const beforeTargets = await listAllTargets();
  const beforeIds = beforeTargets.map(t => t.id);
  const before = await list();

  const clicked = await evaluateOnShell(`
    (function() {
      var btn = document.querySelector('button[aria-label="New tab"], button[title="New tab"]');
      if (!btn) return false;
      btn.click();
      return true;
    })()
  `);
  if (!clicked.ok || !clicked.value) {
    return { success: false, error: 'Desktop "New tab" button not found', reason: clicked.reason };
  }

  const launcher = (await poll(
    async () => (await listAllTargets()).find(t => !beforeIds.includes(t.id) && /app\/new-tab\/index\.html/.test(t.url)),
    t => !!t,
    5000,
  ));
  if (!launcher) {
    return { success: false, error: 'new-tab launcher did not appear', tabs_before: before.tab_count };
  }

  // The launcher renders asynchronously; retry until its layout list exists.
  const pick = await poll(
    () => evaluateOnTarget(launcher, `
      (function() {
        var want = ${JSON.stringify(layout ?? null)};
        var list = document.querySelector('.layout-list');
        if (!list) return { ready: false };
        if (want === null) {
          var create = list.querySelector('.create-new-layout-button');
          if (!create) return { ready: true, clicked: false, reason: 'create_new_layout_button_not_found' };
          create.click();
          return { ready: true, clicked: true, picked: 'create_new_layout' };
        }
        var cards = Array.from(list.querySelectorAll('li.layout-list-item:not(.create-new-layout-button)'));
        if (!cards.length) return { ready: false };
        var names = cards.map(function(li) { var n = li.querySelector('.layout-list-item-info span'); return n ? n.textContent.trim() : ''; });
        var idx = names.indexOf(want);
        if (idx < 0) idx = names.map(function(n) { return n.toLowerCase(); }).indexOf(want.toLowerCase());
        if (idx < 0) return { ready: true, clicked: false, reason: 'layout_not_in_launcher', visible_layouts: names };
        cards[idx].click();
        return { ready: true, clicked: true, picked: names[idx] };
      })()
    `).catch(e => ({ ok: false, reason: e.message })),
    r => !r.ok || r.value?.ready,
    5000,
  );
  if (!pick.ok || !pick.value?.clicked) {
    const cleanup = await closeTargetViaShell(launcher, () => evaluateOnTarget(launcher, 'document.visibilityState').then(r => r.value).catch(() => null));
    return {
      success: false,
      error: pick.value?.reason || pick.reason || 'launcher_not_ready',
      visible_layouts: pick.value?.visible_layouts,
      launcher_closed: cleanup.success,
      hint: 'The launcher only lists recent/favorite layouts. For any other layout: tab_new (no args), tab_switch to it, then layout_switch.',
    };
  }

  const after = await poll(list, s => diffNewTabs(beforeIds, s.tabs).length > 0, 10000);
  const added = diffNewTabs(beforeIds, after.tabs);
  if (!added.length) {
    return { success: false, error: 'no new chart tab appeared', picked: pick.value.picked, tabs_before: before.tab_count, tabs_after: after.tab_count };
  }
  const tab = added[0];
  return {
    success: true,
    action: 'new_tab_opened',
    picked: pick.value.picked,
    tab_id: tab.id,
    chart_id: tab.chart_id,
    url: tab.url,
    tabs_before: before.tab_count,
    tabs_after: after.tab_count,
    note: 'The CDP session is still attached to the previous tab; call tab_switch with this tab_id to operate on it.',
  };
}

/**
 * Close the tab the CDP session is attached to. Cmd/Ctrl+W is a no-op on
 * current Desktop builds (same main-process-accelerator problem as Cmd+T).
 */
export async function closeTab() {
  const before = await list();
  if (before.tab_count <= 1) {
    throw new Error('Cannot close the last tab. Use tv_launch to restart TradingView instead.');
  }
  const current = await getTargetInfo();
  if (!current?.id) throw new Error('No attached chart tab to close.');

  const closed = await closeTargetViaShell(current, () => evaluate('document.visibilityState').catch(() => null));
  if (!closed.success) return { ...closed, tab_id: current.id, tabs_before: before.tab_count };
  const after = await list();
  return {
    success: true,
    action: 'tab_closed',
    tab_id: current.id,
    chart_id: before.tabs.find(t => t.id === current.id)?.chart_id ?? null,
    tabs_before: before.tab_count,
    tabs_after: after.tab_count,
    note: 'The CDP session reattaches to the default chart tab on the next call; use tab_switch to pick one explicitly.',
  };
}

/**
 * Resolve which tab to switch to from a tabs array (pure — no I/O, unit-tested).
 * Priority: chart_id (preferred) > tab_id > index. Throws listing the open ids
 * when a handle doesn't resolve, or when no handle is given.
 *
 * Resolve by chart_id whenever possible: CDP /json/list ordering is recency /
 * last-click based, so a positional `index` captured from a prior tab_list is
 * stale by the time a switch runs and can point at a different tab. chart_id is
 * parsed from the /chart/<id>/ URL and is stable across calls and TV restarts;
 * tab_id (the CDP target id) is stable within a session.
 *
 * Returns { target, resolvedBy, matchCount } — matchCount > 1 flags a chart_id
 * that is open in more than one tab (first match is used).
 */
export function resolveTarget(tabs, { chart_id, tab_id, index } = {}) {
  if (!tabs || !tabs.length) throw new Error('No TradingView chart tabs found.');

  if (chart_id) {
    const matches = tabs.filter(t => t.chart_id === chart_id);
    if (!matches.length) {
      throw new Error(`No open tab with chart_id "${chart_id}". Open chart_ids: ${tabs.map(t => t.chart_id).join(', ')}`);
    }
    return { target: matches[0], resolvedBy: 'chart_id', matchCount: matches.length };
  }
  if (tab_id) {
    const target = tabs.find(t => t.id === tab_id);
    if (!target) {
      throw new Error(`No open tab with tab_id "${tab_id}". Open tab_ids: ${tabs.map(t => t.id).join(', ')}`);
    }
    return { target, resolvedBy: 'tab_id', matchCount: 1 };
  }
  if (index !== undefined && index !== null && index !== '') {
    const idx = Number(index);
    if (!Number.isInteger(idx) || idx < 0 || idx >= tabs.length) {
      throw new Error(`Tab index ${index} out of range (have ${tabs.length} tabs)`);
    }
    return { target: tabs[idx], resolvedBy: 'index', matchCount: 1 };
  }
  throw new Error('tab_switch requires one of: chart_id (preferred), tab_id, or index.');
}

/**
 * Switch to a tab, resolving it at call time by chart_id (preferred), tab_id,
 * or index (see resolveTarget). Brings the tab to the desktop foreground AND
 * repoints the CDP client at the new target — without the second step,
 * evaluate() keeps reading the original tab regardless of which one is visible
 * to the operator.
 */
export async function switchTab({ chart_id, tab_id, index } = {}) {
  const { tabs } = await list();
  const { target, resolvedBy, matchCount } = resolveTarget(tabs, { chart_id, tab_id, index });

  // fetch() does NOT reject on a 4xx/5xx, so check resp.ok explicitly — a 404
  // here (activate endpoint failed) would otherwise silently skip foregrounding
  // the tab while the attach below still succeeds, returning a false success.
  let resp;
  try {
    resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/activate/${target.id}`);
  } catch (e) {
    throw new Error(`Failed to activate tab ${target.id}: ${e.message}`);
  }
  if (!resp.ok) {
    throw new Error(`Failed to activate tab ${target.id}: /json/activate returned HTTP ${resp.status}.`);
  }

  // Repoint the CDP socket so subsequent evaluate() calls land on this tab.
  // attachToTarget resolves by stable target id (not index) and returns the
  // fresh target object.
  const attached = await attachToTarget(target.id);

  // For chart_id, confirm the attached target still carries the requested id —
  // the tab could have closed or navigated between list() and attach. The
  // tab_id / index paths attached by the exact id resolveTarget returned, so
  // there is nothing further to verify there.
  const attachedChartId = attached.url?.match(/\/chart\/([^/?]+)/)?.[1] || null;
  if (resolvedBy === 'chart_id' && attachedChartId !== chart_id) {
    throw new Error(`Switch verification failed: attached chart_id "${attachedChartId}" != requested "${chart_id}".`);
  }

  const result = { success: true, action: 'switched', resolved_by: resolvedBy, tab_id: target.id, chart_id: attachedChartId ?? target.chart_id };
  if (matchCount > 1) result.match_count = matchCount;
  return result;
}
