import { register } from '../router.js';
import * as core from '../../core/alerts.js';

register('alert', {
  description: 'Alert tools (list, create, delete)',
  subcommands: new Map([
    ['list', {
      description: 'List active alerts',
      handler: () => core.list(),
    }],
    ['create', {
      description: 'Create a price alert (uses _alertService → REST → DOM fallback)',
      options: {
        price: { type: 'string', short: 'p', description: 'Price level' },
        condition: { type: 'string', short: 'c', description: 'Condition: crossing, crossing_down, greater_than, less_than' },
        message: { type: 'string', short: 'm', description: 'Alert message' },
      },
      handler: (opts) => core.create({
        price: Number(opts.price),
        condition: opts.condition || 'crossing',
        message: opts.message,
      }),
    }],
    ['delete', {
      description: 'Delete alerts by id, by filter, or all (excludes type=strategy by default; pass --force to include them)',
      options: {
        'alert-id': { type: 'string', description: 'Delete a single alert by id' },
        type: { type: 'string', description: 'Filter by type (price | strategy)' },
        symbol: { type: 'string', description: 'Filter by symbol (case-insensitive)' },
        all: { type: 'boolean', description: 'Delete all alerts (excludes strategy alerts unless --force)' },
        force: { type: 'boolean', description: 'With --all: also delete strategy alerts. DESTRUCTIVE for bot users.' },
      },
      handler: (opts) => {
        const filter = (opts.type || opts.symbol)
          ? { type: opts.type, symbol: opts.symbol }
          : undefined;
        return core.deleteAlerts({
          alert_id: opts['alert-id'] != null ? Number(opts['alert-id']) : undefined,
          filter,
          delete_all: opts.all,
          force: opts.force,
        });
      },
    }],
  ]),
});
