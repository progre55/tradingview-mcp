# `pine_set_source` / `pine_smart_compile` — "Could not open Pine Editor" when editor is stuck in "loading" state

**Date:** 2026-05-23 ~10:00 UTC
**Tools affected:** `pine_set_source`, `pine_smart_compile`, and probably any tool that requires the editor panel to be responsive
**Symbol/TF at time of error:** OANDA:XAUUSD M5 (irrelevant — repro applies to any chart)

## Symptom

`pine_set_source` returns:

```json
{
  "success": false,
  "error": "Could not open Pine Editor."
}
```

Even though:
- `tv_health_check` confirms CDP connected, API available.
- `pine_get_active_script` succeeds and returns the correct script identity.
- `ui_open_panel({panel: "pine-editor", action: "open"})` returns `success: true, was_open: true, performed: "opened"` — i.e., the panel is *already* open from the tool's perspective.

In the actual TradingView UI, the editor pane is visible but stuck showing a "Loading…" spinner — it never finishes loading. The MCP tool sees the panel DOM but cannot inject source because the Monaco editor instance hasn't initialized yet.

## Reproduction

1. Have the Pine Editor panel docked.
2. Trigger a chart reload or symbol/timeframe change that re-mounts the editor.
3. Within the first few seconds (before Monaco settles), call `pine_set_source` from MCP.
4. Error: `"Could not open Pine Editor."`

The user's reliable workaround: close the editor panel via the UI X button, then re-open it via the right toolbar icon. The fresh mount loads cleanly, and `pine_set_source` works on the next call.

## Context where it bit me

While iterating on `pinescript/strategies/fast_scalp_gold_v2.pine`:
- Pushed source v1 → saved successfully.
- Tweaked code locally.
- Tried `pine_set_source` for v2 → got `"Could not open Pine Editor."` despite `was_open: true`.
- `pine_get_active_script` returned `is_dirty: false`, version `9.0` — confirming the editor was on the previously saved version but Monaco wasn't responsive.
- After the user manually closed + reopened the editor panel, the next `pine_set_source` call succeeded.

## Hypothesis

`ui_open_panel` checks the panel's *DOM visibility / aria state*, not the Monaco editor's *ready state*. So a panel that's mounted but mid-loading reports `was_open: true` while Monaco is still spinning up. `pine_set_source` then tries to grab the Monaco instance, finds it unavailable (or in a partial state), and bails with the generic error.

## Suggested fix

In `pine_set_source` (and the editor-opening preamble that `pine_smart_compile` shares), after asserting the panel is open, *also* wait for Monaco's `editor.getModel()` to return a non-null model and for the loading-spinner DOM node to be removed. Pseudocode:

```js
await waitFor(() => {
  const editor = window.monaco?.editor?.getEditors?.()[0];
  const spinner = document.querySelector('[data-name="pine-editor-loading"]'); // or whatever the actual selector is
  return editor && editor.getModel() && !spinner;
}, { timeout: 5000 });
```

Then proceed with the source injection. If the wait times out, return a *structured* error: `error: "pine_editor_monaco_not_ready"` (distinct from `"Could not open Pine Editor."`) so callers can distinguish "panel never opened" from "panel open but Monaco is stuck loading" — the latter is recoverable by close+reopen, the former usually isn't.

A secondary surface: `ui_open_panel` could expose an optional `wait_for_ready: true` flag that polls the same condition before returning, so callers don't have to know about Monaco internals.

## Workaround for now

When `pine_set_source` returns `"Could not open Pine Editor."`:
1. Operator manually closes the Pine Editor panel (click X in the panel header).
2. Operator manually reopens it (Pine Editor icon in the right toolbar).
3. Re-issue the `pine_set_source` call.

MCP-side workaround (until fixed): retry once after a 2-3 second delay before failing — most "Monaco not ready" cases resolve in that window.

## Impact

- Blocks automated Pine source upload from MCP whenever the editor is in this transient state.
- Adds ~30s of operator friction per stuck-loading episode (notice the error → switch to TV → close panel → reopen → re-issue MCP call).
- Particularly painful during iterative dev where source is pushed every few minutes.

## References

- See `tradingview-mcp/issues/2026-05-21-tv-quote-active-chart-widget-undefined.md` for a similar "transient frontend race" pattern with a different symptom.
