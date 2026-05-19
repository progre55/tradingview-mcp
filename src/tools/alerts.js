import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/alerts.js';

export function registerAlertTools(server) {
  server.tool(
    'alert_create',
    'Create a price alert via the pricealerts.tradingview.com REST API (cookie auth). Symbol/resolution come from the active chart. Returns alert_id directly. Reads back via /list_alerts to verify the `active` flag (v5 fix — TV\'s create response carries a request-time shell). Currently maps every condition string to type:"cross" — pass conditions_override for other condition types. Notification channels default to all-off; set the optional `notifications` object to enable mobile push, email, popup, etc.',
    {
      condition: z
        .union([
          z.enum(['crossing', 'crossing_down', 'greater_than', 'less_than']),
          z.string(),
        ])
        .describe('Alert condition. Common: "crossing", "crossing_down", "greater_than", "less_than".'),
      price: z.coerce.number().describe('Price level for the alert'),
      message: z.string().optional().describe('Alert message (sent on fire)'),
      notifications: z
        .object({
          popup: z.boolean().optional().describe('TV "Show pop-up" channel.'),
          app: z.boolean().optional().describe('TV "Notify on app" — mobile + desktop push. Default off.'),
          email: z.boolean().optional().describe('TV email channel.'),
          sms: z.boolean().optional().describe('TV "email-to-SMS" channel.'),
          webhook: z.string().url().optional().describe('Webhook URL — presence enables the webhook channel.'),
          sound: z
            .union([
              z.boolean(),
              z.object({
                id: z.string().describe('TV sound id (e.g. "alert/funny/cash-register").'),
                duration: z.union([z.literal(0), z.literal(3), z.literal(5), z.literal(10)]).describe('Sound duration: 0 = Once, 3/5/10 = seconds.'),
              }),
            ])
            .optional()
            .describe('Sound channel. `true` uses TV-UI captured defaults (alert/funny/cash-register, duration=0/Once); pass `{ id, duration }` to override.'),
        })
        .optional()
        .describe('Notification channels. Omit for all-off (popup-only on TV Desktop default).'),
    },
    async ({ condition, price, message, notifications }) => {
      try { return jsonResult(await core.create({ condition, price, message, notifications })); }
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
