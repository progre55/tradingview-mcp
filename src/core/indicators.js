/**
 * Core indicator settings logic.
 */
import { evaluate, evaluateAsync } from '../connection.js';

const CHART_API = 'window.TradingViewApi._activeChartWidgetWV.value()';

/**
 * Pure helper: given the study's full input descriptor list and the
 * caller-supplied override map (keyed by id, Pine var name, or display
 * title), return the resolved id-keyed override list plus the keys that
 * didn't match any input.
 *
 * Resolution priority per override key: exact `id` → exact `name` → exact
 * `title`/`inline` → case-insensitive variants of all three. The first
 * match wins; subsequent overrides for the same input id replace earlier
 * ones (last write wins, like Object.assign).
 *
 * Issue #4 in TV-MCP-ISSUES-v3.md: the previous implementation only
 * checked `id`, so `{macro_required: false}` (Pine var name) silently
 * no-op'd and the caller was told `success: true, updated_inputs: {}`.
 */
export function resolveInputOverrides(currentInputs, overrides) {
  const inputs = Array.isArray(currentInputs) ? currentInputs : [];
  const byId = new Map();
  const byName = new Map();
  const byTitle = new Map();
  const byIdLower = new Map();
  const byNameLower = new Map();
  const byTitleLower = new Map();
  for (const inp of inputs) {
    if (!inp || typeof inp !== 'object') continue;
    if (inp.id != null) {
      byId.set(String(inp.id), inp.id);
      byIdLower.set(String(inp.id).toLowerCase(), inp.id);
    }
    if (inp.name != null) {
      byName.set(String(inp.name), inp.id);
      byNameLower.set(String(inp.name).toLowerCase(), inp.id);
    }
    const title = inp.title != null ? inp.title : inp.inline;
    if (title != null) {
      byTitle.set(String(title), inp.id);
      byTitleLower.set(String(title).toLowerCase(), inp.id);
    }
  }

  const matched = [];
  const seen = new Map();
  const unmatched_keys = [];
  const overrideKeys = overrides && typeof overrides === 'object' ? Object.keys(overrides) : [];
  for (const key of overrideKeys) {
    const lower = String(key).toLowerCase();
    let id = byId.get(key)
      ?? byName.get(key)
      ?? byTitle.get(key)
      ?? byIdLower.get(lower)
      ?? byNameLower.get(lower)
      ?? byTitleLower.get(lower);
    if (id == null) {
      unmatched_keys.push(key);
      continue;
    }
    seen.set(id, { id, key, value: overrides[key] });
  }
  for (const entry of seen.values()) matched.push(entry);
  return { matched, unmatched_keys };
}

const MAX_INPUT_STRING = 200;

/**
 * Pure: merge getInputValues() ({id, value}) with metaInfo().inputs (which
 * carries the display title as `name`, plus group/type/isHidden) into the
 * descriptors callers resolve against. Hidden inputs are dropped — on Pine
 * scripts they include the encoded IL source blob (`text`), which alone made
 * responses tens of KB. Pine variable names aren't exposed for user scripts.
 */
export function buildInputDescriptors(values, metaInputs) {
  const metaById = new Map((Array.isArray(metaInputs) ? metaInputs : []).map(m => [m.id, m]));
  const out = [];
  for (const v of Array.isArray(values) ? values : []) {
    if (!v || v.id == null) continue;
    const meta = metaById.get(v.id) || {};
    if (meta.isHidden) continue;
    let value = v.value;
    if (typeof value === 'string' && value.length > MAX_INPUT_STRING) value = value.slice(0, MAX_INPUT_STRING) + '…';
    out.push({
      id: v.id,
      name: v.name ?? null,
      title: meta.name ?? v.title ?? v.inline ?? null,
      group: meta.group ?? null,
      type: meta.type ?? null,
      current_value: value,
    });
  }
  return out;
}

export async function setInputs({ entity_id, inputs: inputsRaw, verbose = false, wait_ms = 30000 }) {
  const inputs = inputsRaw ? (typeof inputsRaw === 'string' ? JSON.parse(inputsRaw) : inputsRaw) : undefined;
  if (!entity_id) throw new Error('entity_id is required. Use chart_get_state to find study IDs.');
  if (!inputs || typeof inputs !== 'object' || Object.keys(inputs).length === 0) {
    throw new Error('inputs must be a non-empty object, e.g. { length: 50 }');
  }

  const escapedId = JSON.stringify(entity_id);
  const findSource = `
    var chart = ${CHART_API};
    var study = chart.getStudyById(${escapedId});
    var src = null;
    try { src = chart._chartWidget.model().model().dataSources().find(function(s) { try { return s.id() === ${escapedId}; } catch (e) { return false; } }) || null; } catch (e) {}
  `;

  const raw = await evaluate(`
    (function() {
      ${findSource}
      if (!study) return { error: 'Study not found: ' + ${escapedId} };
      var meta = null;
      try { meta = src && src.metaInfo().inputs.map(function(m) { return { id: m.id, name: m.name, group: m.group, type: m.type, isHidden: !!m.isHidden }; }); } catch (e) {}
      return { values: study.getInputValues(), meta: meta };
    })()
  `);
  if (raw && raw.error) throw new Error(raw.error);
  const currentInputs = buildInputDescriptors(raw?.values, raw?.meta);
  const compactKeys = () => currentInputs.map(d => ({ id: d.id, title: d.title, group: d.group, value: d.current_value }));

  const { matched, unmatched_keys } = resolveInputOverrides(currentInputs, inputs);
  if (matched.length === 0) {
    return {
      success: false,
      error: 'no input keys matched; see input_keys for the valid identifiers (id or title)',
      entity_id,
      updated_inputs: {},
      unmatched_keys,
      input_keys: compactKeys(),
    };
  }
  const idKeyedOverrides = {};
  for (const m of matched) idKeyedOverrides[m.id] = m.value;

  // Subscribe to the study's status before setInputValues so a fast
  // Loading → Completed cycle can't slip past; otherwise a read straight
  // after this call returns the previous run's strategy report.
  const waitMs = Math.max(0, Number(wait_ms) || 0);
  const result = await evaluateAsync(`
    (async function() {
      ${findSource}
      if (!study) return { error: 'Study not found: ' + ${escapedId} };
      var overrides = ${JSON.stringify(idKeyedOverrides)};
      var waitMs = ${waitMs};
      var values = study.getInputValues();
      var updated = {};
      var changed = false;
      for (var i = 0; i < values.length; i++) {
        if (Object.prototype.hasOwnProperty.call(overrides, values[i].id)) {
          if (JSON.stringify(values[i].value) !== JSON.stringify(overrides[values[i].id])) changed = true;
          values[i].value = overrides[values[i].id];
          updated[values[i].id] = overrides[values[i].id];
        }
      }
      function readBack() {
        var now = {};
        study.getInputValues().forEach(function(v) { if (Object.prototype.hasOwnProperty.call(updated, v.id)) now[v.id] = v.value; });
        return now;
      }
      if (!changed) return { updated_inputs: updated, recalc: 'skipped_no_change', current_values: readBack() };
      if (waitMs === 0 || !src || typeof src.onStatusChanged !== 'function' || typeof src.isCompleted !== 'function') {
        study.setInputValues(values);
        return { updated_inputs: updated, recalc: 'not_waited', current_values: readBack() };
      }
      var t0 = Date.now();
      var recalc = await new Promise(function(resolve) {
        var sawRunning = false;
        var delegate = src.onStatusChanged();
        var timer = null;
        function finish(r) { clearTimeout(timer); try { delegate.unsubscribe(null, onStatus); } catch (e) {} resolve(r); }
        // A failed/completed status from before the change is stale until a
        // non-completed status has been seen.
        function onStatus() {
          try {
            if (!src.isCompleted()) {
              if (sawRunning && typeof src.isFailed === 'function' && src.isFailed()) return finish('error');
              sawRunning = true;
              return;
            }
            if (sawRunning) finish('completed');
          } catch (e) { finish('error'); }
        }
        delegate.subscribe(null, onStatus);
        timer = setTimeout(function() { finish('timeout'); }, waitMs);
        study.setInputValues(values);
        onStatus();
      });
      return { updated_inputs: updated, recalc: recalc, recalc_ms: Date.now() - t0, current_values: readBack() };
    })()
  `);
  if (result && result.error) throw new Error(result.error);

  const out = {
    success: true,
    entity_id,
    updated_inputs: result.updated_inputs,
    current_values: result.current_values,
    unmatched_keys,
    recalc: result.recalc,
  };
  if (result.recalc_ms != null) out.recalc_ms = result.recalc_ms;
  if (result.recalc === 'timeout') out.warning = `study did not finish recalculating within ${waitMs}ms; results read now may still be stale`;
  if (result.recalc === 'error') out.warning = 'study reported an error after the input change';
  if (verbose || unmatched_keys.length) out.input_keys = compactKeys();
  return out;
}

export async function toggleVisibility({ entity_id, visible }) {
  if (!entity_id) throw new Error('entity_id is required. Use chart_get_state to find study IDs.');
  if (typeof visible !== 'boolean') throw new Error('visible must be a boolean (true or false)');

  const escapedId = entity_id.replace(/'/g, "\\'");
  const result = await evaluate(`
    (function() {
      var chart = ${CHART_API};
      var study = chart.getStudyById('${escapedId}');
      if (!study) return { error: 'Study not found: ${escapedId}' };
      study.setVisible(${visible});
      var actualVisible = study.isVisible();
      return { visible: actualVisible };
    })()
  `);

  if (result && result.error) throw new Error(result.error);
  return { success: true, entity_id, visible: result.visible };
}
