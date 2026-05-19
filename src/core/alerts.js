/**
 * Core alert logic.
 *
 * REST endpoints (cookies-only auth — no auth_token, no CSRF):
 *   GET  /list_alerts                        existing
 *   POST /create_alert    body {payload: {…}}     captured from UI
 *   POST /delete_alerts   body {payload: {alert_ids: [...]}}   batch-native
 *
 * Body shape mirrors what TradingView's own UI sends. Required fields per the
 * captured request: symbol (JSON-escaped), resolution, conditions (array),
 * expiration, active, ignore_warnings, plus the notification channel toggles
 * (popup, mobile_push, email, sms_over_email, web_hook, sound_file,
 * sound_duration). Server returns the created alert (including alert_id) but
 * with a request-time `active: false` shell — `create()` reads back via
 * `/list_alerts` to get the authoritative state (v5 fix).
 *
 * `_alertService` was removed from this TradingView build — JS-side fallback
 * is gone. tv_discover still enumerates it (will show methodCount: 0) so a
 * future build that restores the service is detectable. The DOM dialog
 * fallback was removed in v5 — its price-input selector is broken on current
 * builds (produces price_set: false) and a DOM-created alert has no alert_id
 * for the new verify-after-write path to look up.
 */
import { evaluate, evaluateAsync } from '../connection.js';

const PRICEALERTS_ORIGIN = 'https://pricealerts.tradingview.com';

// In-page alert-service probe. Kept exported for tv_discover.
// Returns {available: false} on current builds since _alertService is gone.
export const ALERT_SERVICE_PROBE_FN = `
  function methodNames(obj) {
    if (!obj) return [];
    var pool = [];
    try { pool = pool.concat(Object.getOwnPropertyNames(obj)); } catch(e) {}
    try {
      var p = Object.getPrototypeOf(obj);
      if (p && p !== Object.prototype) pool = pool.concat(Object.getOwnPropertyNames(p));
    } catch(e) {}
    var seen = {}, out = [];
    for (var i = 0; i < pool.length; i++) {
      var k = pool[i];
      if (seen[k] || k === 'constructor') continue;
      seen[k] = true;
      try { if (typeof obj[k] === 'function') out.push(k); } catch(e) {}
    }
    return out;
  }
  function probeAlertService() {
    var raw = (window.TradingViewApi && window.TradingViewApi._alertService) || null;
    var unwrapped = null;
    var wrapped = false;
    if (raw && typeof raw.value === 'function') {
      try { unwrapped = raw.value(); wrapped = true; } catch(e) {}
    }
    var svc = unwrapped || raw;
    return {
      available: !!svc,
      wrapped: wrapped,
      methods: methodNames(svc),
    };
  }
`;

async function listRaw() {
  return evaluateAsync(`
    fetch('${PRICEALERTS_ORIGIN}/list_alerts', { credentials: 'include' })
      .then(function(r) { return r.json(); })
      .catch(function(e) { return { s: 'error', errmsg: e.message }; })
  `);
}

function parseSymbol(rawSymbol) {
  try { return JSON.parse(String(rawSymbol).replace(/^=/, '')).symbol || rawSymbol; }
  catch { return rawSymbol; }
}

function shapeAlert(a) {
  return {
    alert_id: a.alert_id,
    symbol: parseSymbol(a.symbol),
    type: a.type,
    message: a.message,
    active: a.active,
    condition: a.condition,
    resolution: a.resolution,
    created: a.create_time,
    last_fired: a.last_fire_time,
    expiration: a.expiration,
  };
}

// Build the JSON-escaped symbol string TradingView's alert API expects, e.g.
//   ={"symbol":"OANDA:XAUUSD","session":"regular","currency-id":"USD"}
// Reads from chart.symbolExt() so we don't require callers to pass a symbol.
async function readChartContext() {
  return evaluate(`
    (function() {
      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      var ext = {};
      try { ext = chart.symbolExt() || {}; } catch(e) {}
      var sym = ext.symbol || chart.symbol();
      var session = ext.session || 'regular';
      var currencyId = ext['currency-id'] || ext.currency_id || ext.currency_code || '';
      var obj = { symbol: sym };
      if (currencyId) obj['currency-id'] = currencyId;
      if (session) obj.session = session;
      return {
        symbol_json: '=' + JSON.stringify(obj),
        symbol: sym,
        resolution: String(chart.resolution()),
      };
    })()
  `);
}

// Map a condition string to the server-side conditions array shape captured
// from the TradingView UI. Today we ship 'cross' only — that's the case the
// TV-MCP-ISSUES-v2.md report was about. For other conditions, callers can
// pass `conditions_override` to send the array directly.
function buildConditions(condition, price, resolution) {
  return [{
    type: 'cross',
    frequency: 'on_first_fire',
    series: [{ type: 'barset' }, { type: 'value', value: Number(price) }],
    resolution: String(resolution),
  }];
}

// TV's UI defaults for the sound channel, captured via
// scripts/capture_alert_sound.js against a live build. Used when callers
// pass the boolean shorthand `sound: true`. Re-capture with that script if
// a future build changes the default sound id.
export const SOUND_DEFAULT_ID = 'alert/funny/cash-register';
export const SOUND_DEFAULT_DURATION = 0; // 0 = "Once"

// Translate the user-facing `notifications` object into the REST payload's
// channel keys. Omitting `notifications` (or any sub-field) keeps the v4
// hardcoded behavior: every channel off. Sound accepts either the boolean
// shorthand (uses captured TV-UI defaults) or an explicit `{ id, duration }`.
// Exported for unit tests.
export function buildNotificationFields(notifications) {
  const n = notifications || {};
  const fields = {
    popup: n.popup === true,
    mobile_push: n.app === true,
    email: n.email === true,
    sms_over_email: n.sms === true,
    web_hook: typeof n.webhook === 'string' && n.webhook ? n.webhook : null,
    sound_file: '',
    sound_duration: 0,
  };
  if (n.sound === true) {
    fields.sound_file = SOUND_DEFAULT_ID;
    fields.sound_duration = SOUND_DEFAULT_DURATION;
  } else if (n.sound && typeof n.sound === 'object' && typeof n.sound.id === 'string') {
    fields.sound_file = n.sound.id;
    const d = Number(n.sound.duration);
    fields.sound_duration = Number.isFinite(d) ? d : 0;
  }
  return fields;
}

// v5 fix: classify the post-create state by reading back via /list_alerts.
// TV's /create_alert response carries a request-time shell with active:false
// even when the alert is accepted and fire-eligible; the authoritative state
// only persists on the listing endpoint. This pure helper makes the decision
// testable. Mirrors classifyVisibleRangeOutcome in src/core/chart.js.
export function classifyAlertCreateOutcome(created, verified, listError) {
  const createdActive = !!(created && created.active);
  if (listError) {
    return { active: createdActive, verified_via_list: false, reason: 'list_failed' };
  }
  if (!verified) {
    return { active: createdActive, verified_via_list: false, reason: 'not_found_in_list' };
  }
  const verifiedActive = !!verified.active;
  const overrode = verifiedActive && !createdActive;
  return {
    active: verifiedActive,
    verified_via_list: true,
    reason: overrode ? 'list_overrode_create' : null,
  };
}

async function postCreateAlert(payload) {
  return evaluateAsync(`
    (async function() {
      try {
        var resp = await fetch('${PRICEALERTS_ORIGIN}/create_alert', {
          method: 'POST',
          credentials: 'include',
          body: ${JSON.stringify(JSON.stringify({ payload }))},
        });
        var text = await resp.text();
        var json = null; try { json = JSON.parse(text); } catch(e) {}
        return { status: resp.status, ok: resp.ok, response: json, body_preview: text.slice(0, 400) };
      } catch (e) {
        return { error: e.message };
      }
    })()
  `);
}

async function postDeleteAlerts(alert_ids) {
  return evaluateAsync(`
    (async function() {
      try {
        var resp = await fetch('${PRICEALERTS_ORIGIN}/delete_alerts', {
          method: 'POST',
          credentials: 'include',
          body: JSON.stringify({ payload: { alert_ids: ${JSON.stringify(alert_ids)} } }),
        });
        var text = await resp.text();
        var json = null; try { json = JSON.parse(text); } catch(e) {}
        return { status: resp.status, ok: resp.ok, response: json, body_preview: text.slice(0, 400) };
      } catch (e) {
        return { error: e.message };
      }
    })()
  `);
}

export async function create({ condition, price, message, conditions_override, expiration_days, notifications } = {}) {
  const numericPrice = Number(price);
  if (!Number.isFinite(numericPrice)) {
    return { success: false, error: 'price must be a finite number', price, condition, message: message || '(none)' };
  }

  let ctx;
  try { ctx = await readChartContext(); }
  catch (e) { return { success: false, error: 'could not read chart context: ' + e.message }; }

  const conditions = conditions_override || buildConditions(condition || 'crossing', numericPrice, ctx.resolution);
  const days = Number.isFinite(Number(expiration_days)) ? Number(expiration_days) : 30;
  const expiration = new Date(Date.now() + days * 24 * 3600 * 1000).toISOString();

  const payload = {
    symbol: ctx.symbol_json,
    resolution: ctx.resolution,
    message: message || '',
    conditions,
    expiration,
    auto_deactivate: true,
    active: true,
    ignore_warnings: true,
    name: null,
    ...buildNotificationFields(notifications),
  };

  const rest = await postCreateAlert(payload);
  if (!rest || !rest.response || rest.response.s !== 'ok' || !rest.response.r) {
    return {
      success: false,
      source: 'rest',
      error: 'REST create_alert failed',
      rest_status: rest?.status,
      rest_response: rest?.response,
      rest_body_preview: rest?.body_preview,
      rest_error: rest?.error,
      price: numericPrice,
      condition,
      message: message || '(none)',
    };
  }

  const created = rest.response.r;

  // v5 fix: read back via /list_alerts. TV's create response carries a
  // request-time shell with active:false even when the alert is accepted.
  let verifiedRow = null;
  let listError = null;
  try {
    const listing = await list();
    if (listing.success) verifiedRow = listing.alerts.find(a => a.alert_id === created.alert_id) || null;
    else listError = listing.error || 'list_unsuccessful';
  } catch (e) {
    listError = e.message;
  }
  const outcome = classifyAlertCreateOutcome(created, verifiedRow, listError);

  return {
    success: true,
    source: 'rest',
    alert_id: created.alert_id,
    symbol: parseSymbol(created.symbol),
    condition: created.condition,
    active: outcome.active,
    verified_via_list: outcome.verified_via_list,
    verify_reason: outcome.reason,
    expiration: created.expiration,
    price: numericPrice,
    message: message || '(none)',
  };
}

export async function list() {
  const data = await listRaw();
  if (!data || data.s !== 'ok' || !Array.isArray(data.r)) {
    return { success: true, alert_count: 0, source: 'internal_api', alerts: [], error: data?.errmsg || 'Unexpected response' };
  }
  const alerts = data.r.map(shapeAlert);
  return { success: true, alert_count: alerts.length, source: 'internal_api', alerts };
}

// Pure helper — given a listing and the user's flags, decide which alerts to
// delete and how many strategy alerts are being skipped. Exported for unit tests.
export function selectDeleteCandidates(allAlerts, { filter, delete_all, force } = {}) {
  let candidates = allAlerts;
  if (filter) {
    if (filter.type) candidates = candidates.filter(a => a.type === filter.type);
    if (filter.symbol) {
      const want = String(filter.symbol).toLowerCase();
      candidates = candidates.filter(a => String(a.symbol || '').toLowerCase() === want);
    }
  } else if (delete_all && !force) {
    // Default protection: keep type:'strategy' alerts so a user with bot webhook
    // alerts present doesn't wipe their automation by running delete_all.
    candidates = candidates.filter(a => a.type !== 'strategy');
  }
  const skipped_strategy_count = (delete_all && !force)
    ? allAlerts.filter(a => a.type === 'strategy').length
    : 0;
  return { candidates, skipped_strategy_count };
}

export async function deleteAlerts({ alert_id, filter, delete_all, force } = {}) {
  if (alert_id == null && !filter && !delete_all) {
    throw new Error('Specify alert_id, filter (e.g. {type:"price"}), or delete_all.');
  }

  // Resolve the set of alert_ids to delete. Single id is a one-element batch.
  let ids;
  let skipped_strategy_count = 0;
  if (alert_id != null) {
    const id = Number(alert_id);
    if (!Number.isFinite(id)) throw new Error('alert_id must be a number.');
    ids = [id];
  } else {
    const listing = await list();
    if (!listing.success) throw new Error('Could not list alerts before bulk delete.');
    const sel = selectDeleteCandidates(listing.alerts, { filter, delete_all, force });
    ids = sel.candidates.map(a => a.alert_id);
    skipped_strategy_count = sel.skipped_strategy_count;
  }

  if (ids.length === 0) {
    return { success: true, deleted_count: 0, skipped_strategy_count, results: [] };
  }

  // /delete_alerts is batch-native — one call deletes the whole array.
  const resp = await postDeleteAlerts(ids);
  const ok = resp && resp.response && resp.response.s === 'ok';
  const results = ids.map(id => ({ alert_id: id, success: !!ok }));

  return {
    success: !!ok,
    deleted_count: ok ? ids.length : 0,
    skipped_strategy_count,
    skipped_note: skipped_strategy_count > 0 && delete_all && !force
      ? 'Strategy alerts skipped by default. Pass force: true to include them.'
      : undefined,
    results,
    rest_status: resp?.status,
    rest_response: resp?.response,
    rest_body_preview: ok ? undefined : resp?.body_preview,
    rest_error: resp?.error,
  };
}
