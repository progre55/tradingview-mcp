import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/alerts.js';

export function registerAlertTools(server) {
  server.tool(
    'alert_create',
    'Create a price alert via the pricealerts.tradingview.com REST API (cookie auth). Symbol/resolution come from the active chart. Returns alert_id directly. Currently maps every condition string to type:"cross" — pass conditions_override for other condition types.',
    {
      condition: z
        .union([
          z.enum(['crossing', 'crossing_down', 'greater_than', 'less_than']),
          z.string(),
        ])
        .describe('Alert condition. Common: "crossing", "crossing_down", "greater_than", "less_than".'),
      price: z.coerce.number().describe('Price level for the alert'),
      message: z.string().optional().describe('Alert message (sent on fire)'),
    },
    async ({ condition, price, message }) => {
      try { return jsonResult(await core.create({ condition, price, message })); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    },
  );

  server.tool('alert_list', 'List active alerts (price + strategy) with alert_id, symbol, condition, type.', {}, async () => {
    try { return jsonResult(await core.list()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool(
    'alert_delete',
    'Delete a single alert by alert_id, a filtered subset, or all. delete_all skips type="strategy" alerts unless force=true (protects bot webhook alerts). Exactly one of alert_id, filter, or delete_all is required.',
    {
      alert_id: z.coerce.number().optional().describe('Delete a single alert by id (from alert_list).'),
      filter: z
        .object({
          type: z.enum(['price', 'strategy']).optional().describe('Restrict to price or strategy alerts.'),
          symbol: z.string().optional().describe('Restrict to alerts on this symbol.'),
        })
        .optional()
        .describe('Filtered batch delete. Each match is deleted individually.'),
      delete_all: z.coerce.boolean().optional().describe('Delete all alerts. By default skips type="strategy"; pass force=true to include them.'),
      force: z.coerce.boolean().optional().describe('With delete_all: also delete strategy alerts. DESTRUCTIVE for bot users.'),
    },
    async ({ alert_id, filter, delete_all, force }) => {
      try { return jsonResult(await core.deleteAlerts({ alert_id, filter, delete_all, force })); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    },
  );
}
