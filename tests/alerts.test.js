/**
 * Alert protection / branch tests — no TradingView connection needed.
 *
 * Pinned behaviors (via the pure selectDeleteCandidates helper):
 *   - delete_all without force skips type:'strategy' alerts.
 *   - delete_all with force=true selects every alert (including strategy).
 *   - filter:{type:'strategy'} explicitly targets strategy alerts (operator override).
 *   - filter:{symbol} matches case-insensitively.
 *   - skipped_strategy_count is 0 unless delete_all triggered the protection branch.
 *
 * Plus the input-guard regression on deleteAlerts itself.
 *
 * Run: node --test tests/alerts.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { selectDeleteCandidates, deleteAlerts } from '../src/core/alerts.js';

const FIXTURE = [
  { alert_id: 1, symbol: 'OANDA:XAUUSD', type: 'price', message: 'A' },
  { alert_id: 2, symbol: 'OANDA:XAUUSD', type: 'price', message: 'B' },
  { alert_id: 3, symbol: 'BINANCE:BTCUSDT', type: 'strategy', message: 'bot' },
  { alert_id: 4, symbol: 'OANDA:NAS100USD', type: 'strategy', message: 'bot 2' },
];

describe('selectDeleteCandidates — strategy-alert protection', () => {
  it('delete_all without force skips type:"strategy"', () => {
    const { candidates, skipped_strategy_count } = selectDeleteCandidates(FIXTURE, { delete_all: true });
    assert.deepEqual(candidates.map(a => a.alert_id).sort(), [1, 2]);
    assert.equal(skipped_strategy_count, 2);
  });

  it('delete_all with force=true selects every alert', () => {
    const { candidates, skipped_strategy_count } = selectDeleteCandidates(FIXTURE, { delete_all: true, force: true });
    assert.deepEqual(candidates.map(a => a.alert_id).sort(), [1, 2, 3, 4]);
    assert.equal(skipped_strategy_count, 0);
  });

  it('filter:{type:"strategy"} explicitly targets strategy alerts (operator override)', () => {
    // The default protection only triggers in the delete_all branch; an explicit
    // filter is the operator's "I really mean it" path and bypasses the guard.
    const { candidates, skipped_strategy_count } = selectDeleteCandidates(FIXTURE, { filter: { type: 'strategy' } });
    assert.deepEqual(candidates.map(a => a.alert_id).sort(), [3, 4]);
    assert.equal(skipped_strategy_count, 0);
  });

  it('filter:{symbol} matches case-insensitively', () => {
    const { candidates } = selectDeleteCandidates(FIXTURE, { filter: { symbol: 'oanda:xauusd' } });
    assert.deepEqual(candidates.map(a => a.alert_id).sort(), [1, 2]);
  });

  it('filter:{type, symbol} compounds (AND)', () => {
    const { candidates } = selectDeleteCandidates(FIXTURE, { filter: { type: 'strategy', symbol: 'BINANCE:BTCUSDT' } });
    assert.deepEqual(candidates.map(a => a.alert_id), [3]);
  });
});

describe('deleteAlerts — input guards', () => {
  it('throws when no parameters are specified', async () => {
    await assert.rejects(() => deleteAlerts({}), /Specify alert_id, filter.*delete_all/);
  });

  it('throws when alert_id is non-numeric', async () => {
    await assert.rejects(() => deleteAlerts({ alert_id: 'not-a-number' }), /alert_id must be a number/);
  });
});
