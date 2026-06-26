import { register } from '../router.js';
import * as core from '../../core/tab.js';

register('tab', {
  description: 'Tab management (list, new, close, switch)',
  subcommands: new Map([
    ['list', {
      description: 'List all open chart tabs',
      handler: () => core.list(),
    }],
    ['new', {
      description: 'Open a new chart tab',
      handler: () => core.newTab(),
    }],
    ['close', {
      description: 'Close the current tab',
      handler: () => core.closeTab(),
    }],
    ['switch', {
      description: 'Switch to a tab by chart_id (preferred), tab_id, or index',
      options: {
        'chart-id': { type: 'string', description: 'Chart id from the /chart/<id>/ URL (preferred)' },
        'tab-id': { type: 'string', description: 'CDP target id (stable within a session)' },
      },
      handler: (opts, positionals) => {
        if (opts['chart-id']) return core.switchTab({ chart_id: opts['chart-id'] });
        if (opts['tab-id']) return core.switchTab({ tab_id: opts['tab-id'] });
        if (positionals[0] === undefined) {
          throw new Error('Provide --chart-id <id> (preferred), --tab-id <id>, or an index. Usage: tv tab switch --chart-id <chart-id> | tv tab switch 0');
        }
        return core.switchTab({ index: positionals[0] });
      },
    }],
  ]),
});
