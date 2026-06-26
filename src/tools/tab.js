import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/tab.js';

export function registerTabTools(server) {
  server.tool('tab_list', 'List all open TradingView chart tabs', {}, async () => {
    try { return jsonResult(await core.list()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('tab_new', 'Open a new chart tab', {}, async () => {
    try { return jsonResult(await core.newTab()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('tab_close', 'Close the current chart tab', {}, async () => {
    try { return jsonResult(await core.closeTab()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('tab_switch', 'Switch to a chart tab by chart_id (preferred), tab_id, or index', {
    chart_id: z.string().optional().describe('Chart id from the /chart/<id>/ URL (from tab_list). PREFERRED — stable across calls and TV restarts; resolved + verified at call time.'),
    tab_id: z.string().optional().describe('CDP target id from tab_list (the "id" field). Stable within a session; regenerated on TV restart.'),
    index: z.coerce.number().optional().describe('Positional index from tab_list (0-based). FRAGILE — CDP target order is recency-based and can change between calls; prefer chart_id.'),
  }, async ({ chart_id, tab_id, index }) => {
    try { return jsonResult(await core.switchTab({ chart_id, tab_id, index })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
