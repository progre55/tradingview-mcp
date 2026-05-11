/**
 * Core indicator settings logic.
 */
import { evaluate } from '../connection.js';

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

export async function setInputs({ entity_id, inputs: inputsRaw }) {
  const inputs = inputsRaw ? (typeof inputsRaw === 'string' ? JSON.parse(inputsRaw) : inputsRaw) : undefined;
  if (!entity_id) throw new Error('entity_id is required. Use chart_get_state to find study IDs.');
  if (!inputs || typeof inputs !== 'object' || Object.keys(inputs).length === 0) {
    throw new Error('inputs must be a non-empty object, e.g. { length: 50 }');
  }

  const escapedId = entity_id.replace(/'/g, "\\'");

  // First trip into the page: read the full input descriptor list.
  const descriptor = await evaluate(`
    (function() {
      var chart = ${CHART_API};
      var study = chart.getStudyById('${escapedId}');
      if (!study) return { error: 'Study not found: ${escapedId}' };
      var current = study.getInputValues();
      return {
        inputs: current.map(function(inp) {
          return {
            id: inp.id,
            name: inp.name || null,
            title: inp.title || inp.inline || null,
            current_value: inp.value,
          };
        })
      };
    })()
  `);

  if (descriptor && descriptor.error) throw new Error(descriptor.error);
  const currentInputs = descriptor?.inputs || [];

  // Resolve caller keys against id / name / title.
  const { matched, unmatched_keys } = resolveInputOverrides(currentInputs, inputs);
  const idKeyedOverrides = {};
  for (const m of matched) idKeyedOverrides[m.id] = m.value;

  // Surface the full input descriptors regardless of outcome — each is
  // `{id, name, title, current_value}`, and callers can use any of id /
  // name / title as a future override key. Field name is `input_keys` for
  // backward compatibility with the existing tool surface; the descriptor
  // shape is documented in the tool description.
  const input_keys = currentInputs;

  if (matched.length === 0) {
    return {
      success: false,
      error: 'no input keys matched; see input_keys for the valid identifiers',
      entity_id,
      updated_inputs: {},
      unmatched_keys,
      input_keys,
    };
  }

  // Second trip: apply the resolved id-keyed overrides.
  const inputsJson = JSON.stringify(idKeyedOverrides);
  const result = await evaluate(`
    (function() {
      var chart = ${CHART_API};
      var study = chart.getStudyById('${escapedId}');
      if (!study) return { error: 'Study not found: ${escapedId}' };
      var currentInputs = study.getInputValues();
      var overrides = ${inputsJson};
      var updatedKeys = {};
      for (var i = 0; i < currentInputs.length; i++) {
        if (overrides.hasOwnProperty(currentInputs[i].id)) {
          currentInputs[i].value = overrides[currentInputs[i].id];
          updatedKeys[currentInputs[i].id] = overrides[currentInputs[i].id];
        }
      }
      study.setInputValues(currentInputs);
      return { updated_inputs: updatedKeys };
    })()
  `);

  if (result && result.error) throw new Error(result.error);
  return {
    success: true,
    entity_id,
    updated_inputs: result.updated_inputs,
    unmatched_keys,
    input_keys,
  };
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
