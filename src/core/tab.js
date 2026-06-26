/**
 * Core tab management logic.
 * Controls TradingView Desktop tabs via CDP and Electron keyboard shortcuts.
 */
import { getClient, evaluate, attachToTarget } from '../connection.js';

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
 * Open a new chart tab via keyboard shortcut (Ctrl+T / Cmd+T).
 */
export async function newTab() {
  const c = await getClient();

  // Electron/TradingView Desktop uses Ctrl+T for new tab on macOS too
  // But some versions use Cmd+T
  const isMac = process.platform === 'darwin';
  const mod = isMac ? 4 : 2; // 4 = meta (Cmd), 2 = ctrl

  await c.Input.dispatchKeyEvent({
    type: 'keyDown',
    modifiers: mod,
    key: 't',
    code: 'KeyT',
    windowsVirtualKeyCode: 84,
  });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 't', code: 'KeyT' });

  await new Promise(r => setTimeout(r, 2000));

  // Verify a new tab appeared
  const state = await list();
  return { success: true, action: 'new_tab_opened', ...state };
}

/**
 * Close the current tab via keyboard shortcut (Ctrl+W / Cmd+W).
 */
export async function closeTab() {
  const before = await list();
  if (before.tab_count <= 1) {
    throw new Error('Cannot close the last tab. Use tv_launch to restart TradingView instead.');
  }

  const c = await getClient();
  const isMac = process.platform === 'darwin';
  const mod = isMac ? 4 : 2;

  await c.Input.dispatchKeyEvent({
    type: 'keyDown',
    modifiers: mod,
    key: 'w',
    code: 'KeyW',
    windowsVirtualKeyCode: 87,
  });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'w', code: 'KeyW' });

  await new Promise(r => setTimeout(r, 1000));

  const after = await list();
  return { success: true, action: 'tab_closed', tabs_before: before.tab_count, tabs_after: after.tab_count };
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
