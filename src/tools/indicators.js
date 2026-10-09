import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/indicators.js';

export function registerIndicatorTools(server) {
  server.tool('indicator_set_inputs', 'Change indicator/study input values. Override keys match the input id (e.g. "in_3") or display title (e.g. "Slow EMA"), case-insensitive; Pine variable names only work on built-ins that expose them. Waits for the study to finish recalculating (recalc: completed | error | timeout | skipped_no_change | not_waited) so a following data_get_strategy_results / data_get_trades reads the new run. Returns updated_inputs, current_values (read back after the change), unmatched_keys; input_keys ({id, title, group, value}, hidden inputs excluded) only when keys didn\'t match or verbose:true. Zero matches → success:false.', {
    entity_id: z.string().describe('Entity ID of the study (from chart_get_state)'),
    inputs: z.string().describe('JSON string of input overrides, e.g. \'{"in_3": 20, "Slow EMA": 50}\'. Keys can be the input id or the display title.'),
    verbose: z.boolean().optional().describe('Always include input_keys (default false)'),
    wait_ms: z.coerce.number().optional().describe('Max ms to wait for the recalculation to finish (default 30000). 0 returns immediately; a strategy read right after can then still see the previous run, because the recalc may not have started yet.'),
  }, async ({ entity_id, inputs, verbose, wait_ms }) => {
    try { return jsonResult(await core.setInputs({ entity_id, inputs, verbose, wait_ms })); }
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
