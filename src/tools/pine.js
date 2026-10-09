import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/pine.js';

export function registerPineTools(server) {
  server.tool('pine_get_source', 'Get current Pine Script source code from the editor', {}, async () => {
    try { return jsonResult(await core.getSource()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_set_source', 'Set Pine Script source code in the editor', {
    source: z.string().describe('Pine Script source code to inject'),
  }, async ({ source }) => {
    try { return jsonResult(await core.setSource({ source })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_compile', 'Compile / add the current Pine Script to the chart', {}, async () => {
    try { return jsonResult(await core.compile()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_get_errors', 'Get Pine Script compilation errors from Monaco markers', {}, async () => {
    try { return jsonResult(await core.getErrors()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_save', 'Save the current Pine Script via the editor Save button, then verify: success:false with error "compile_errors" (Monaco error markers, returned in errors), "study_compile_error" (the on-chart study reports one), "version_not_bumped" (a dirty script whose saved version didn\'t change), or "draft_not_saved" (an untitled draft is still untitled afterwards). A failed save may still have stored the source in TV cloud; the chart keeps the previous compiled version. version_verified:false means the version couldn\'t be read, not that the save failed.', {}, async () => {
    try { return jsonResult(await core.save()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_get_console', 'Read rendered entries from the Pine Logs panel (log.info/warning/error output) as {timestamp, type, message}. The panel must be open (Pine Editor → More → Pine Logs) and the script on the chart; success:false error "pine_logs_panel_not_found" otherwise. The panel is virtualized, so only rendered rows are returned.', {}, async () => {
    try { return jsonResult(await core.getConsole()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_smart_compile', 'Compile via translate_light API (non-destructive). Pass commit:true to also click "Save and add to chart" (DESTRUCTIVE: bumps the saved-script version on TV cloud).', {
    commit: z.coerce.boolean().optional().default(false).describe('Set true to also click Save-and-add-to-chart. DESTRUCTIVE on a saved user script — verify identity via pine_get_active_script first.'),
  }, async ({ commit }) => {
    try { return jsonResult(await core.smartCompile({ commit })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_new', 'Create a fresh untitled Pine Script tab. Auto-opens the Pine Editor panel if closed. Refuses (success:false) when another saved script remains active after the attempt — the caller must switch tabs manually in that case.', {
    type: z.enum(['indicator', 'strategy', 'library']).describe('Type of script to create'),
  }, async ({ type }) => {
    try { return jsonResult(await core.newScript({ type })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_get_active_script', 'Read the active editor tab\'s identity (script_id, script_name, version, is_saved, is_dirty). Side-effect free — does not click, does not write. Use this to verify which script you are about to overwrite before pine_save / pine_smart_compile({commit:true}).', {}, async () => {
    try { return jsonResult(await core.getActiveScript()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_open', 'Open a saved Pine Script by name', {
    name: z.string().describe('Name of the saved script to open (case-insensitive match)'),
  }, async ({ name }) => {
    try { return jsonResult(await core.openScript({ name })); }
    catch (err) { return jsonResult({ success: false, source: 'internal_api', error: err.message }, true); }
  });

  server.tool('pine_list_scripts', 'List saved Pine Scripts', {}, async () => {
    try { return jsonResult(await core.listScripts()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_analyze', 'Run static analysis on Pine Script code WITHOUT compiling — catches array out-of-bounds, unguarded array.first()/last(), bad loop bounds, and implicit bool casts. Works offline, no TradingView connection needed.', {
    source: z.string().describe('Pine Script source code to analyze'),
  }, async ({ source }) => {
    try { return jsonResult(core.analyze({ source })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_check', 'Compile Pine Script via TradingView\'s server API (Guest translate_light) without needing the chart open. Returns compilation errors/warnings. NOT identical to the editor compiler — e.g. it accepts ISO-8601 timestamp("2026-07-10T14:20:00Z"), which the editor rejects — so a pass is necessary but not sufficient. pine_save / pine_get_errors are authoritative.', {
    source: z.string().describe('Pine Script source code to compile/validate'),
  }, async ({ source }) => {
    try { return jsonResult(await core.check({ source })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
