# TradingView MCP — Claude Instructions

68 tools for reading and controlling a live TradingView Desktop chart via CDP (port 9222).

## Decision Tree — Which Tool When

### "What's on my chart right now?"
1. `chart_get_state` → symbol, timeframe, chart type, list of all indicators with entity IDs
2. `data_get_study_values` → current numeric values from all visible indicators (RSI, MACD, BBands, EMAs, etc.)
3. `quote_get` → real-time price, OHLC, volume for current symbol

### "What levels/lines/labels are showing?"
Custom Pine indicators draw with `line.new()`, `label.new()`, `table.new()`, `box.new()`. These are invisible to normal data tools. Use:

1. `data_get_pine_lines` → horizontal price levels drawn by indicators (deduplicated, sorted high→low)
2. `data_get_pine_labels` → text annotations with prices (e.g., "PDH 24550", "Bias Long ✓")
3. `data_get_pine_tables` → table data formatted as rows (e.g., session stats, analytics dashboards)
4. `data_get_pine_boxes` → price zones / ranges as {high, low} pairs

Use `study_filter` parameter to target a specific indicator by name substring (e.g., `study_filter: "Profiler"`).

Each returned study includes a `state` field: **`has_shapes`** (the indicator has drawn at least one shape) or **`loaded_no_shapes`** (the indicator is on the chart but hasn't drawn yet — e.g. an ORB outside its session window). Use this to distinguish "not drawn yet" from "indicator missing" — the latter is when the study doesn't appear in `studies` at all.

### "Give me price data"
- `data_get_ohlcv` with `summary: true` → compact stats (high, low, range, change%, avg volume, last 5 bars)
- `data_get_ohlcv` without summary → all bars (use `count` to limit, default 100)
- `quote_get` → single latest price snapshot

### "Analyze my chart" (full report workflow)
1. `quote_get` → current price
2. `data_get_study_values` → all indicator readings
3. `data_get_pine_lines` → key price levels from custom indicators
4. `data_get_pine_labels` → labeled levels with context (e.g., "Settlement", "ASN O/U")
5. `data_get_pine_tables` → session stats, analytics tables
6. `data_get_ohlcv` with `summary: true` → price action summary
7. `capture_screenshot` → visual confirmation

### "Change the chart"
- `chart_set_symbol` → switch ticker (e.g., "AAPL", "ES1!", "NYMEX:CL1!")
- `chart_set_timeframe` → switch resolution (e.g., "1", "5", "15", "60", "D", "W")
- `chart_set_type` → switch chart style (Candles, HeikinAshi, Line, Area, Renko, etc.)
- `chart_manage_indicator` → add or remove studies (use full name: "Relative Strength Index", not "RSI")
- `chart_scroll_to_date` → jump to a date (ISO format: "2025-01-15")
- `chart_set_visible_range` → zoom to exact date range (unix timestamps). Note: the actual range silently clamps to available bars — compare `response.actual` vs `response.requested` to detect clamping.

### "Work on Pine Script"
1. `pine_set_source` → inject code into editor
2. `pine_smart_compile` → compile with auto-detection + error check
3. `pine_get_errors` → read compilation errors
4. `pine_get_console` → read log.info() output
5. `pine_get_source` → read current code back (WARNING: can be very large for complex scripts)
6. `pine_save` → save to TradingView cloud
7. `pine_new` → create blank indicator/strategy/library
8. `pine_open` → load a saved script by name

### "Practice trading with replay"
1. `replay_start` with `date: "2025-03-01"` → enter replay mode
2. `replay_step` → advance one bar
3. `replay_autoplay` → auto-advance (set speed with `speed` param in ms)
4. `replay_trade` with `action: "buy"/"sell"/"close"` → execute trades
5. `replay_status` → check position, P&L, current date
6. `replay_stop` → return to realtime

### "Screen multiple symbols"
- `batch_run` with `symbols: ["ES1!", "NQ1!", "YM1!"]` and `action: "screenshot"` or `"get_ohlcv"`

### "Draw on the chart"
- `draw_shape` → horizontal_line, trend_line, rectangle, text (pass point + optional point2)
- `draw_list` → see what's drawn
- `draw_remove_one` → remove by ID
- `draw_clear` → remove all

### "Manage alerts"
- `alert_create` → set price alert (condition: "crossing", "crossing_down", "greater_than", "less_than"). Uses the in-page `_alertService` JS API (preferred) → REST fallback → DOM fallback. Symbol/resolution come from the active chart.
- `alert_list` → view active alerts (returns `alert_id`, `symbol`, `type` ("price" or "strategy"), `condition`, etc.)
- `alert_delete` → three modes:
  - `{ alert_id: <n> }` → delete one alert by id (recommended for cleanup workflows)
  - `{ filter: { type: "price" | "strategy", symbol: "..." } }` → batch-delete a filtered subset
  - `{ delete_all: true }` → delete all alerts EXCEPT `type: "strategy"`. To also include strategy alerts, pass `force: true` (DESTRUCTIVE — wipes bot webhook alerts).

### "Navigate the UI"
- `ui_open_panel` → open/close pine-editor, strategy-tester, watchlist, alerts, trading
- `ui_click` → click buttons by aria-label, text, or data-name
- `layout_switch` → load a saved layout by name
- `ui_fullscreen` → toggle fullscreen
- `capture_screenshot` → take a screenshot (regions: "full", "chart", "strategy_tester")

### "TradingView isn't running"
- `tv_launch` → auto-detect and launch TradingView with CDP on Mac/Win/Linux
- `tv_health_check` → verify connection is working

## Context Management Rules

These tools can return large payloads. Follow these rules to avoid context bloat:

1. **Always use `summary: true` on `data_get_ohlcv`** unless you specifically need individual bars
2. **Always use `study_filter`** on pine tools when you know which indicator you want — don't scan all studies unnecessarily
3. **Never use `verbose: true`** on pine tools unless the user specifically asks for raw drawing data with IDs/colors
4. **Avoid calling `pine_get_source`** on complex scripts — it can return 200KB+. Only read if you need to edit the code.
5. **Avoid calling `data_get_indicator`** on protected/encrypted indicators — their inputs are encoded blobs. Use `data_get_study_values` instead for current values.
6. **Use `capture_screenshot`** for visual context instead of pulling large datasets — a screenshot is ~300KB but gives you the full visual picture
7. **Call `chart_get_state` once** at the start to get entity IDs, then reference them — don't re-call repeatedly
8. **Cap your OHLCV requests** — `count: 20` for quick analysis, `count: 100` for deeper work, `count: 500` only when specifically needed

### Output Size Estimates (compact mode)
| Tool | Typical Output |
|------|---------------|
| `quote_get` | ~200 bytes |
| `data_get_study_values` | ~500 bytes (all indicators) |
| `data_get_pine_lines` | ~1-3 KB per study (deduplicated levels) |
| `data_get_pine_labels` | ~2-5 KB per study (capped at 50) |
| `data_get_pine_tables` | ~1-4 KB per study (formatted rows) |
| `data_get_pine_boxes` | ~1-2 KB per study (deduplicated zones) |
| `data_get_ohlcv` (summary) | ~500 bytes |
| `data_get_ohlcv` (100 bars) | ~8 KB |
| `capture_screenshot` | ~300 bytes (returns file path, not image data) |

## Tool Conventions

- All tools return `{ success: true/false, ... }`
- Entity IDs (from `chart_get_state`) are session-specific — don't cache across sessions
- Pine indicators must be **visible** on chart for pine graphics tools to read their data
- `chart_manage_indicator` requires **full indicator names**: "Relative Strength Index" not "RSI", "Moving Average Exponential" not "EMA", "Bollinger Bands" not "BB"
- Screenshots save to `screenshots/` directory with timestamps
- OHLCV capped at 500 bars; trades capped at 500 per request (default 100)
- Pine labels capped at 50 per study by default (pass `max_labels` to override)
- `data_get_strategy_results` and `data_get_trades` try the **internal API first** (`strat.reportData()` on the active strategy data source) and fall back to DOM scraping only when no strategy is currently selected/computed in the Strategy Tester. The API path is non-intrusive — it does not toggle the bottom panel or shift any tab — and returns long/short metric breakdowns plus rich per-trade fields. The DOM fallback opens the panel + activates the relevant tab.
- `data_get_strategy_results` returns `source: 'internal_api'` (preferred) or `'dom_scrape'`. Internal-API metric labels mirror the Performance Summary ("Net Profit", "Profit Factor", "Sharpe Ratio", "Sortino Ratio", etc.). The response also includes `long_metrics` / `short_metrics` when long/short breakdowns are populated.
- `data_get_trades` returns `source: 'internal_api'` (preferred) or `'dom_scrape'`. The internal-API path returns the full trade list synchronously; the DOM fallback walks the virtualized `ka-table`. Each row exposes `entry_time`, `exit_time`, `entry_price`, `exit_price`, `entry_signal`, `exit_signal`, `pnl_usd`, `pnl_pct`, `favorable_excursion_*`, `adverse_excursion_*`, `cumulative_pnl_*`, plus `contracts` and `trade_num`. A `Margin call` value in `entry_signal` / `exit_signal` is TradingView's marker for an account blow-up under `default_qty_type=strategy.percent_of_equity, default_qty_value=100` — it indicates strategy sizing is too aggressive, not an MCP bug.
- Strategy detection: a Pine source is a strategy iff `meta.id` starts with `StrategyScript$` OR `meta.isTVScriptStrategy === true`. Indicators (including ones with `s.performance()` and `s.preferredZOrder` methods) are NOT strategies — those methods are present on every Pine source on current builds and produce false positives if used as discriminators.
- `tab_switch` brings a chart tab to the desktop foreground AND repoints the CDP socket, so subsequent `evaluate()` / `ui_evaluate` calls land on the new tab. Without the second step, page-context calls would keep reading the original tab regardless of what's visible to the operator.
- `ui_evaluate` awaits Promise-returning expressions — wrap multi-step async logic in `(async function(){ ... })()` and the resolved value is returned directly.
- `ui_scroll` defaults to scrolling the chart canvas (mouse wheel). Pass `target: 'strategy-tester' | 'pine-editor' | 'right-panel'` to scroll those panels via direct `scrollTop` / `scrollLeft` mutation.

## Architecture

```
Claude Code ←→ MCP Server (stdio) ←→ CDP (localhost:9222) ←→ TradingView Desktop (Electron)
```

Pine graphics path: `study._graphics._primitivesCollection.dwglines.get('lines').get(false)._primitivesDataById`
