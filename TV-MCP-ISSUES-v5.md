# TradingView MCP issues found (round 5)

Encountered while setting two price alerts on `OANDA:XAUUSD` during a live
scalping session on 2026-05-18. Goal was to set a long-trigger watch at
4533 and a breakout watch at 4549, then walk away from the screen.

## 1. `alert_create` returns `active: false` on freshly-created alerts that are actually active

```
alert_create({
  condition: "crossing_down",
  price: 4533,
  message: "XAUUSD M5 scalp-long trigger zone @ 4533. ..."
})
→ {
    success: true,
    source: "rest",
    alert_id: 4726219197,
    symbol: "OANDA:XAUUSD",
    condition: { type: "cross", ... resolution: "1" },
    active: false,                                       ← WRONG
    expiration: "2026-06-17T11:38:00Z",
    price: 4533,
    message: "XAUUSD M5 scalp-long trigger zone @ 4533. ..."
  }
```

The operator independently verified in the TradingView UI that **both
created alerts were active and listed under "Active alerts"**. A
follow-up `alert_list({})` call moments later confirmed the same:

```
alert_list()
→ {
    alerts: [
      {
        alert_id: 4726219197,
        symbol:    "OANDA:XAUUSD",
        type:      "price",
        active:    true,                                ← CORRECT here
        last_fired: null,
        created:    "2026-05-18T11:38:00Z",
        ...
      },
      {
        alert_id: 4726219205,
        symbol:    "OANDA:XAUUSD",
        type:      "price",
        active:    false,                               ← also correct (see note 2 below)
        last_fired: "2026-05-18T11:39:24Z",
        created:    "2026-05-18T11:38:00Z",
        ...
      },
      ...
    ]
  }
```

So `alert_create` returns `active: false` for an alert that the TV server
has accepted, attached to the chart, and made fire-eligible. `alert_list`,
called against the same alert seconds later, returns `active: true`. The
misreporting is in the `alert_create` response builder, not in TV.

A reasonable LLM caller reading the `alert_create` response interprets
`active: false` as "alert was created but is parked / disabled and won't
fire" and warns the operator to manually toggle it on. That warning is
wrong and erodes trust in the tool. The cost in this session was small
(operator double-checked the UI and confirmed both alerts were live), but
on a longer-horizon trade where the operator walks away, a false
"inactive" reading would lead to them manually re-enabling an already-
active alert — best case, no-op; worst case, accidental duplicate or a
fat-finger toggle that disables a different alert.

### Sub-finding: the 4549 alert legitimately deactivated 84 seconds later

Separately, `alert_id: 4726219205` (price=4549, condition="crossing")
fired at `2026-05-18T11:39:24Z`, 84 seconds after creation, because XAUUSD
crossed up through 4549. Because the alert was created with
`frequency: "on_first_fire"` (the REST API default), it auto-deactivated
after the single fire and now correctly shows `active: false` in
`alert_list`. **This second `active: false` is correct** — the alert did
its job and retired. The bug is only the *initial* `active: false`
returned by `alert_create` on the alert that hadn't fired yet.

### Suspected cause

The `alert_create` response is being built from a request-time / pre-commit
snapshot of the alert object — likely an `Alert` shell created locally
before the REST POST has persisted to the pricealerts service — and the
`active` flag in that shell defaults to `false`. The actual activation
happens on the TV server side once the alert is registered, and a
subsequent `alert_list` correctly reflects the server state.

Less likely but worth a glance: the response could be reading
`alert.active` off the in-flight HTTP response body where TV's API itself
returns the inactive default before its own backend re-emits the activated
state. If that's the case, the fix is at the MCP boundary, not in TV.

### Suggestion

Either:

1. **Read-back verify**: after the create POST, follow up with a single
   `GET /pricealerts/<alert_id>` (or filter `alert_list` to the new ID)
   and return that authoritative `active` flag. ~80ms latency cost, fully
   removes the misreport.
2. **Drop the misleading field**: if the create endpoint genuinely cannot
   tell whether the alert is active at the moment of return, omit
   `active` from the `alert_create` response entirely. A consumer that
   needs the answer can always call `alert_list` themselves. Better to
   return nothing than to return a value that is reliably wrong.

Of the two, option 1 is the better fix — option 2 just shifts the problem
to the caller and silently changes a response schema.

### Workaround

Until fixed: after every `alert_create`, immediately call `alert_list`
and read the row matching the returned `alert_id` to get the real
`active` state. This is what would have caught the issue in this
session if it had been done in-line.

## 2. `alert_create` exposes no parameter for notification channels

Same session, related friction. The operator asked for the new alerts
to "notify in app" (TradingView's mobile + desktop push). The
`alert_create` JSON schema currently accepts only:

```
{
  condition: "crossing" | "crossing_down" | "greater_than" | "less_than" | <override>,
  price:     <number>,
  message:   <string>
}
```

There is no parameter for:

- `Show pop-up`
- `Play sound` (and which sound)
- `Notify on app` (mobile + desktop push)
- `Send email`
- `Send email-to-SMS`
- `Webhook URL`

A TradingView alert created via the UI has all of these as togglable
options on the "Notifications" tab of the alert dialog. The REST
`/pricealerts` POST accepts a `notifications` (or similarly named)
sub-object that the MCP tool is not surfacing. As a result, every alert
created through the MCP is silently popup-only on the operator's
Desktop client — which means an operator who leaves the screen and is
relying on the mobile app for the trigger will miss it entirely.

This bit me this session. The operator set two alerts via the MCP
intending to walk away from the chart, then discovered after the fact
that there's no way to enable mobile push through the tool and had to
edit each alert manually in the TV UI.

### Suggestion

Extend the `alert_create` schema with an optional `notifications` object:

```
notifications: {
  popup?:   boolean   // default true (matches TV default)
  sound?:   boolean | { id: string, duration: 0|3|5|10 }
  app?:     boolean   // mobile + desktop push
  email?:   boolean
  sms?:     boolean   // email-to-SMS
  webhook?: string    // URL — when present, enables webhook channel
}
```

When omitted, current behavior (popup-only or whatever TV defaults to)
stays. When present, forwarded to the REST body. This is additive and
does not break existing callers.

### Workaround

Until fixed: after `alert_create`, manually edit the alert in the TV UI
(right-click the alert in the right-panel alerts list → Edit →
Notifications tab → toggle the channels you want). Painful for batch
alert creation; manageable for one-offs.

## Impact on this session

- ~1 minute lost to operator double-checking TV's UI and confirming both
  alerts were active despite the API saying otherwise (issue 1).
- ~2 minutes lost to discovering that the new alerts only fire popup
  notifications and manually editing each one to enable mobile push
  (issue 2).
- Both issues continue the pattern documented in v3 and v4: MCP write
  tools either return state that doesn't match TV (issue 1) or expose
  only a fraction of the underlying TV capability (issue 2). Issue 1 is
  the **6th** cumulative state-misreporting issue. Issue 2 is the first
  documented case of an under-exposed REST surface — but `alert_delete`
  and the strategy-alert subset of `alert_create` likely have similar
  blind spots that haven't been tripped over yet.

## Pattern note (continuity from v3/v4)

The recurring failure mode is now stable enough to generalize:

> **MCP write tools should never trust a response body composed before
> the action lands on TV. They should follow every state-mutating call
> with a verification read against the same data source, and surface
> the verified state — not the request-time shell.**

v3 and v4 closed this for `pine_new`, `pine_set_source`,
`pine_smart_compile`, `indicator_set_inputs`, `chart_scroll_to_date`,
and `chart_set_visible_range` via the verify-after-write pattern (read
state before, fire mutation, read state after, classify the outcome).
`alert_create` is the next candidate for the same treatment.

---

## Resolution

Same playbook as v3 and v4: extract the post-action classification into a pure
helper, pin the branches with unit tests, and have `alert_create` read back
authoritative state from the same data source the operator's `alert_list`
hits. Plus an additive `notifications` parameter that maps to the REST
payload fields the tool was hardcoding off.

### Root cause (issue 1)

`/create_alert` returns the request-time shell of the alert object —
`active` is the default `false` from before TV's pricealerts backend
finishes activation. The MCP tool was reading `created.active` directly off
that response, producing the misreport. `/list_alerts` reads the
post-activation state, so a read-back closes the gap.

### Fix

`src/core/alerts.js`:

1. **New pure helper `classifyAlertCreateOutcome(created, verified, listError)`**
   → returns `{ active, verified_via_list, reason }`. Mirrors
   `classifyVisibleRangeOutcome` in `src/core/chart.js`. Five branches pinned
   in `tests/alerts.test.js`:
   - `verified.active=true, created.active=false` → `active:true,
     verified_via_list:true, reason:'list_overrode_create'` (the v5 bug,
     now corrected).
   - `verified.active=true, created.active=true` → `active:true,
     verified_via_list:true, reason:null`.
   - `verified.active=false` → `active:false, verified_via_list:true,
     reason:null` (legitimately inactive — covers the sub-finding where
     `alert_id 4726219205` fired and auto-deactivated).
   - `verified` missing → `active:created.active, verified_via_list:false,
     reason:'not_found_in_list'`.
   - listing call errored → `active:created.active,
     verified_via_list:false, reason:'list_failed'`.

2. **`create()` now reads back via `list()`** after the create POST
   succeeds, finds the row by `alert_id`, and feeds
   `classifyAlertCreateOutcome` to build the response. Cost: one extra REST
   call (~80 ms). The response now carries `active`, `verified_via_list`,
   and `verify_reason`.

3. **New pure helper `buildNotificationFields(notifications)`** → returns
   `{ popup, mobile_push, email, sms_over_email, web_hook, sound_file,
   sound_duration }`. The payload no longer hardcodes channel keys; it
   spreads this helper's output. Omitting `notifications` produces the v4
   defaults (every channel off) — zero behavior change for existing
   callers. Six branches pinned in `tests/alerts.test.js`:
   - `undefined` → all-off defaults.
   - `{ app: true }` → `mobile_push: true`, others untouched.
   - `{ sound: true }` → captured TV-UI defaults (`alert/funny/cash-register`, duration `0` / "Once").
   - `{ sound: { id, duration } }` → `sound_file`, `sound_duration` set explicitly.
   - `{ sound: false }` → sound disabled.
   - `{ webhook: 'https://...' }` → `web_hook` set.
   - `{ webhook: '' }` → `web_hook` stays `null` (empty-string guard).
   - mixed → only requested channels flip on.

4. **DOM fallback removed.** `tryDomCreate` was already documented as
   broken on current builds (selectors changed; `price_set: false`).
   Removed the function and its caller branch. On REST failure, `create()`
   now returns a clean `success: false` with the `rest_status` /
   `rest_response` / `rest_body_preview` / `rest_error` diagnostics
   (previously buried under the dead-end `dom_legacy` payload). The
   `getClient` import was dropped along with the DOM path.

`src/tools/alerts.js`:

5. **Zod schema extended.** `alert_create` now accepts an optional
   `notifications` object with `popup?`, `app?`, `email?`, `sms?`,
   `webhook?` (URL-validated), and `sound?: boolean | { id, duration:
   0|3|5|10 }`. The boolean shorthand uses TV-UI captured defaults
   (`alert/funny/cash-register`, duration `0` = "Once"), captured via
   `scripts/capture_alert_sound.js`. Tool description updated to drop
   the stale `_alertService` mention and surface the verify-after-write
   contract.

### Notification key mapping

User-facing surface → REST payload key (the keys already on the wire from
the captured UI request, just no longer hardcoded off):

| User-facing  | REST key         | TV UI label          |
|--------------|------------------|----------------------|
| `popup`      | `popup`          | Show pop-up          |
| `app`        | `mobile_push`    | Notify on app        |
| `email`      | `email`          | Send email           |
| `sms`        | `sms_over_email` | Send email-to-SMS    |
| `webhook`    | `web_hook`       | Webhook URL          |
| `sound.id`   | `sound_file`     | Play sound           |
| `sound.duration` | `sound_duration` | Sound duration   |

### Out of scope

- **`alert_delete` schema audit.** v5 §"Impact" speculates the delete tool
  may have similar under-exposed-surface blind spots. Not in this PR — no
  reported friction yet, and the v5 fix is already a 5-file change.
- **DOM-fallback re-introduction.** If a future TV build re-enables
  reliable DOM selectors, the path is in git history — but the v5-introduced
  verify-after-write hinges on having an `alert_id` to look up, which DOM
  creates don't return.

### Verification

Unit suite: 18/18 pass on `tests/alerts.test.js` (7 pre-existing + 5
`classifyAlertCreateOutcome` + 6 `buildNotificationFields`). Full
non-environmental suite: 61/61 pass across `alerts.test.js`,
`cli.test.js`, `indicator_inputs.test.js`, `pine_identity.test.js`,
`visible_range.test.js`. The strategy / e2e suites are opt-in integration
tests requiring TradingView Desktop and a loaded strategy — they don't
exercise the alerts module.

Live verification (recommended before close):

1. `alert_create({ condition: "crossing_down", price: <near>,
   message: "v5 verify", notifications: { app: true, popup: true } })`
   against `OANDA:XAUUSD` → response must show `active: true,
   verified_via_list: true` (and likely `verify_reason:
   'list_overrode_create'` if the original race repros).
2. In the TV UI: right-click the new alert → Edit → Notifications tab →
   confirm "Notify on app" and "Show pop-up" are toggled on.
3. `alert_list()` → confirm the same row reads `active: true`.
4. Create an alert immediately above live price with `condition:
   "crossing"`, wait for it to fire and auto-deactivate, then call
   `alert_list` — confirm the helper still reports `active: false,
   verified_via_list: true, verify_reason: null` for the post-fire state
   (no over-correction).
5. `alert_delete({ alert_id: <new id> })` to clean up.
