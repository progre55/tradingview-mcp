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

import {
  selectDeleteCandidates,
  deleteAlerts,
  classifyAlertCreateOutcome,
  buildNotificationFields,
  SOUND_DEFAULT_ID,
  SOUND_DEFAULT_DURATION,
} from '../src/core/alerts.js';

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

describe('classifyAlertCreateOutcome — v5 verify-after-write', () => {
  it('list overrides the request-time active:false (the v5 bug)', () => {
    const out = classifyAlertCreateOutcome({ active: false }, { active: true });
    assert.deepEqual(out, { active: true, verified_via_list: true, reason: 'list_overrode_create' });
  });

  it('create and verify both report active:true → no override reason', () => {
    const out = classifyAlertCreateOutcome({ active: true }, { active: true });
    assert.deepEqual(out, { active: true, verified_via_list: true, reason: null });
  });

  it('verify reports active:false → legitimately inactive (e.g. fired & auto-deactivated)', () => {
    const out = classifyAlertCreateOutcome({ active: false }, { active: false });
    assert.deepEqual(out, { active: false, verified_via_list: true, reason: null });
  });

  it('verified row missing → falls back to created.active with reason=not_found_in_list', () => {
    const out = classifyAlertCreateOutcome({ active: false }, null);
    assert.deepEqual(out, { active: false, verified_via_list: false, reason: 'not_found_in_list' });
  });

  it('list call errored → falls back to created.active with reason=list_failed', () => {
    const out = classifyAlertCreateOutcome({ active: true }, null, 'network down');
    assert.deepEqual(out, { active: true, verified_via_list: false, reason: 'list_failed' });
  });
});

describe('buildNotificationFields — REST payload translation', () => {
  it('omitted notifications → all channels off (current default)', () => {
    assert.deepEqual(buildNotificationFields(undefined), {
      popup: false,
      mobile_push: false,
      email: false,
      sms_over_email: false,
      web_hook: null,
      sound_file: '',
      sound_duration: 0,
    });
  });

  it('app:true → mobile_push:true, other channels untouched', () => {
    const out = buildNotificationFields({ app: true });
    assert.equal(out.mobile_push, true);
    assert.equal(out.popup, false);
    assert.equal(out.email, false);
    assert.equal(out.sms_over_email, false);
    assert.equal(out.web_hook, null);
  });

  it('sound: { id, duration } → sound_file + sound_duration', () => {
    const out = buildNotificationFields({ sound: { id: 'bell', duration: 10 } });
    assert.equal(out.sound_file, 'bell');
    assert.equal(out.sound_duration, 10);
  });

  it('sound: true → captured TV-UI defaults (cash-register / Once)', () => {
    const out = buildNotificationFields({ sound: true });
    assert.equal(out.sound_file, SOUND_DEFAULT_ID);
    assert.equal(out.sound_duration, SOUND_DEFAULT_DURATION);
    assert.equal(SOUND_DEFAULT_ID, 'alert/funny/cash-register');
    assert.equal(SOUND_DEFAULT_DURATION, 0);
  });

  it('sound: false → sound disabled (no accidental enablement)', () => {
    const out = buildNotificationFields({ sound: false });
    assert.equal(out.sound_file, '');
    assert.equal(out.sound_duration, 0);
  });

  it('webhook URL → web_hook field', () => {
    const out = buildNotificationFields({ webhook: 'https://example.com/hook' });
    assert.equal(out.web_hook, 'https://example.com/hook');
  });

  it('empty webhook string → web_hook stays null (no accidental enablement)', () => {
    const out = buildNotificationFields({ webhook: '' });
    assert.equal(out.web_hook, null);
  });

  it('mixed channels → only requested ones flip on', () => {
    const out = buildNotificationFields({ popup: true, app: true, email: true });
    assert.equal(out.popup, true);
    assert.equal(out.mobile_push, true);
    assert.equal(out.email, true);
    assert.equal(out.sms_over_email, false);
    assert.equal(out.web_hook, null);
    assert.equal(out.sound_file, '');
    assert.equal(out.sound_duration, 0);
  });
});
