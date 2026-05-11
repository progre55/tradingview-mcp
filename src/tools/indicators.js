import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/indicators.js';

export function registerIndicatorTools(server) {
  server.tool('indicator_set_inputs', 'Change indicator/study input values. Override keys are matched against input id, Pine variable name, or display title (case-insensitive). Returns updated_inputs (id-keyed map of what was applied), unmatched_keys (overrides that didn\'t match any input), and input_keys — a list of descriptor objects {id, name, title, current_value} for every input the study exposes (the caller can use any of id / name / title as a future override key). When a non-empty inputs object yields zero matches, the call returns success:false rather than the previous silent no-op.', {
    entity_id: z.string().describe('Entity ID of the study (from chart_get_state)'),
    inputs: z.string().describe('JSON string of input overrides, e.g. \'{"length": 50, "source": "close"}\'. Keys can be the input id, the Pine variable name (e.g. "macro_required"), or the display title (e.g. "Require macro alignment").'),
  }, async ({ entity_id, inputs }) => {
    try { return jsonResult(await core.setInputs({ entity_id, inputs })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('indicator_toggle_visibility', 'Show or hide an indicator/study on the chart', {
    entity_id: z.string().describe('Entity ID of the study (from chart_get_state)'),
    visible: z.coerce.boolean().describe('true to show, false to hide'),
  }, async ({ entity_id, visible }) => {
    try { return jsonResult(await core.toggleVisibility({ entity_id, visible })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
