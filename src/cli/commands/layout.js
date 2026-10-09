import { register } from '../router.js';
import * as core from '../../core/ui.js';

register('layout', {
  description: 'Layout tools (list, switch)',
  subcommands: new Map([
    ['list', {
      description: 'List saved chart layouts',
      handler: () => core.layoutList(),
    }],
    ['switch', {
      description: 'Switch to a saved layout by name, ID, or short url',
      options: {
        'discard-unsaved': { type: 'boolean', description: 'Drop unsaved changes on the current layout instead of refusing' },
      },
      handler: (opts, positionals) => {
        if (!positionals[0]) throw new Error('Layout name required. Usage: tv layout switch "My Layout"');
        return core.layoutSwitch({ name: positionals.join(' '), discard_unsaved: !!opts['discard-unsaved'] });
      },
    }],
  ]),
});
