/**
 * Core Pine Script logic — shared between MCP tools and CLI.
 * All functions accept plain options objects and return plain JS objects.
 * They throw on error (callers catch and format).
 */
import { evaluate, evaluateAsync, getClient } from '../connection.js';

// ── Monaco finder (injected into TV page) ──
const FIND_MONACO = `
  (function findMonacoEditor() {
    var container = document.querySelector('.monaco-editor.pine-editor-monaco');
    if (!container) return null;
    var el = container;
    var fiberKey;
    for (var i = 0; i < 20; i++) {
      if (!el) break;
      fiberKey = Object.keys(el).find(function(k) { return k.startsWith('__reactFiber$'); });
      if (fiberKey) break;
      el = el.parentElement;
    }
    if (!fiberKey) return null;
    var current = el[fiberKey];
    for (var d = 0; d < 15; d++) {
      if (!current) break;
      if (current.memoizedProps && current.memoizedProps.value && current.memoizedProps.value.monacoEnv) {
        var env = current.memoizedProps.value.monacoEnv;
        if (env.editor && typeof env.editor.getEditors === 'function') {
          var editors = env.editor.getEditors();
          if (editors.length > 0) return { editor: editors[0], env: env };
        }
      }
      current = current.return;
    }
    return null;
  })()
`;

// ── Pine-editor active-tab probe ──
// TradingView's UI exposes the active script's identity through three signals
// (live-probed against the current build):
//
//   1. DOM toolbar — [data-qa-id="pine-script-title-button"] holds the
//      visible script name; [data-qa-id="pine-script-save-button"] reads
//      "Saved" (clean) vs "Save" (dirty). Untitled drafts read "Untitled
//      indicator/strategy/library".
//   2. pine-facade fetch traffic — TradingView calls
//      GET /pine-facade/get/USER;<hex>/(last|<version>) every time a saved
//      tab is loaded. The script_id_part is in the URL; the response body
//      carries scriptName / scriptTitle / lastVersionMaj.
//   3. React fiber tree (low-signal on this build, kept for forward-compat).
//
// `installPineSniffer()` wraps fetch idempotently and stores the latest
// observed identity into `window.__pineActiveScript`. The probe combines
// all three signals — DOM is primary (always available when the editor is
// open), fetch sniffer is secondary (precise id when available), React
// fiber is a forward-compat fallback.
//
// Returns {script_id_part, script_name, version, is_dirty, source} on hit,
// null otherwise. `source` surfaces which signal matched.
const FIND_PINE_TAB_STATE = `
  (function findPineTabState() {
    // Idempotent fetch sniffer — captures /pine-facade/get/<id>/<ver>.
    if (!window.__pineSniffer || !window.__pineSniffer.installed) {
      window.__pineSniffer = { installed: true };
      var GET_RE = /pine-facade\\/get\\/(USER%3B[a-f0-9]+|STD%3B[A-Za-z0-9_]+)\\/(?:last|[\\d.]+)/i;
      var origFetch = window.fetch.bind(window);
      window.fetch = function(input, init) {
        var url = typeof input === 'string' ? input : (input && input.url) || '';
        var m = url.match(GET_RE);
        if (m) {
          var idPart = decodeURIComponent(m[1]);
          return origFetch(input, init).then(function(resp) {
            try {
              var clone = resp.clone();
              clone.json().then(function(j) {
                window.__pineActiveScript = {
                  script_id_part: idPart,
                  script_name: j.scriptName || j.scriptTitle || null,
                  version: j.lastVersionMaj || null,
                  captured_at: Date.now(),
                };
              }).catch(function() {});
            } catch (e) {}
            return resp;
          });
        }
        return origFetch(input, init);
      };
    }

    function readDomToolbar() {
      var titleBtn = document.querySelector('[data-qa-id="pine-script-title-button"]');
      if (!titleBtn) return null;
      var raw = (titleBtn.textContent || '').trim();
      if (!raw) return null;
      var saveBtn = document.querySelector('[data-qa-id="pine-script-save-button"]');
      var saveText = saveBtn ? (saveBtn.textContent || '').trim() : '';
      // Save button shows "Save" (or "Save…" / "Save *") when dirty, "Saved"
      // when clean. The text is doubled by the tooltip — collapse the doubling
      // before the comparison.
      var saveLower = saveText.toLowerCase();
      var halfLen = Math.floor(saveLower.length / 2);
      if (halfLen > 0 && saveLower.slice(0, halfLen) === saveLower.slice(halfLen)) saveLower = saveLower.slice(0, halfLen);
      var is_dirty = saveLower.length > 0 && saveLower.indexOf('saved') === -1 && saveLower.indexOf('save') !== -1;
      // Same doubling collapse for the title text.
      var name = raw;
      if (raw.length % 2 === 0) {
        var half = raw.slice(0, raw.length / 2);
        if (half + half === raw) name = half;
      }
      return { script_name: name, is_dirty: is_dirty };
    }

    var dom = readDomToolbar();
    var sniffed = window.__pineActiveScript || null;

    // Combine DOM + fetch-sniffer signals. DOM gives us name + dirty flag
    // immediately; the sniffer adds the precise script_id when it has caught
    // a recent /get/<id>/... fetch.
    if (dom) {
      var snifferMatchesDom = sniffed && sniffed.script_name && dom.script_name &&
        sniffed.script_name.toLowerCase() === dom.script_name.toLowerCase();
      return {
        script_id_part: snifferMatchesDom ? sniffed.script_id_part : null,
        script_name: dom.script_name,
        version: snifferMatchesDom ? sniffed.version : null,
        is_dirty: dom.is_dirty,
        source: snifferMatchesDom ? 'dom+sniffer' : 'dom_toolbar',
      };
    }

    // No DOM toolbar (editor maybe collapsed). Fall back to sniffer alone.
    if (sniffed && sniffed.script_id_part) {
      return {
        script_id_part: sniffed.script_id_part,
        script_name: sniffed.script_name,
        version: sniffed.version,
        is_dirty: false,
        source: 'sniffer',
      };
    }

    // Last-resort React fiber walk (low signal on current TradingView builds
    // but kept for forward-compat).
    function fiberFromEl(startEl) {
      var el = startEl;
      for (var i = 0; i < 20 && el; i++) {
        var k = Object.keys(el).find(function(kk) { return kk.startsWith('__reactFiber$'); });
        if (k) return el[k];
        el = el.parentElement;
      }
      return null;
    }
    function probeFromProps(p) {
      if (!p || typeof p !== 'object') return null;
      if (p.scriptIdPart || p.scriptName || p.pineId) {
        return {
          script_id_part: p.scriptIdPart || p.pineId || null,
          script_name: p.scriptName || p.name || p.title || null,
          version: p.version || null,
          is_dirty: !!(p.isDirty || p.modified || p.dirty),
        };
      }
      return null;
    }
    var fiber = fiberFromEl(document.querySelector('.monaco-editor.pine-editor-monaco'));
    var current = fiber;
    for (var d = 0; d < 40 && current; d++) {
      var hit = probeFromProps(current.memoizedProps);
      if (hit) { hit.source = 'react_fiber'; return hit; }
      current = current.return;
    }

    return null;
  })()
`;

/**
 * Opens the Pine Editor panel and waits for Monaco to become available.
 * Returns true if editor is accessible, false on timeout.
 */
export async function ensurePineEditorOpen() {
  const already = await evaluate(`
    (function() {
      var m = ${FIND_MONACO};
      return m !== null;
    })()
  `);
  if (already) return true;

  await evaluate(`
    (function() {
      var bwb = window.TradingView && window.TradingView.bottomWidgetBar;
      if (!bwb) return;
      if (typeof bwb.activateScriptEditorTab === 'function') bwb.activateScriptEditorTab();
      else if (typeof bwb.showWidget === 'function') bwb.showWidget('pine-editor');
    })()
  `);

  await evaluate(`
    (function() {
      var btn = document.querySelector('[aria-label="Pine"]')
        || document.querySelector('[data-name="pine-dialog-button"]');
      if (btn) btn.click();
    })()
  `);

  // 75 × 200ms = 15s. Cold-start mounts of Monaco from a fully-closed panel
  // can exceed the original 10s budget — issue #3 in TV-MCP-ISSUES-v3.md.
  for (let i = 0; i < 75; i++) {
    await new Promise(r => setTimeout(r, 200));
    const ready = await evaluate(`(function() { return ${FIND_MONACO} !== null; })()`);
    if (ready) return true;
  }
  return false;
}

// ── Pure / offline functions ──

export function analyze({ source }) {
  const lines = source.split('\n');
  const diagnostics = [];

  let isV6 = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('//@version=6')) { isV6 = true; break; }
    if (trimmed.startsWith('//@version=')) break;
    if (trimmed === '' || trimmed.startsWith('//')) continue;
    break;
  }

  const arrays = new Map();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fromMatch = line.match(/(\w+)\s*=\s*array\.from\(([^)]*)\)/);
    if (fromMatch) {
      const name = fromMatch[1].trim();
      const args = fromMatch[2].trim();
      const size = args === '' ? 0 : args.split(',').length;
      arrays.set(name, { name, size, line: i + 1 });
      continue;
    }
    const newMatch = line.match(/(\w+)\s*=\s*array\.new(?:<\w+>|_\w+)\((\d+)?/);
    if (newMatch) {
      const name = newMatch[1].trim();
      const size = newMatch[2] !== undefined ? parseInt(newMatch[2], 10) : null;
      arrays.set(name, { name, size, line: i + 1 });
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const pattern = /array\.(get|set)\(\s*(\w+)\s*,\s*(-?\d+)/g;
    let match;
    while ((match = pattern.exec(line)) !== null) {
      const method = match[1];
      const arrName = match[2];
      const idx = parseInt(match[3], 10);
      const info = arrays.get(arrName);
      if (!info || info.size === null) continue;
      if (idx < 0 || idx >= info.size) {
        diagnostics.push({
          line: i + 1, column: match.index + 1,
          message: `array.${method}(${arrName}, ${idx}) — index ${idx} out of bounds (array size is ${info.size})`,
          severity: 'error',
        });
      }
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const firstLastPattern = /(\w+)\.(first|last)\(\)/g;
    let match;
    while ((match = firstLastPattern.exec(line)) !== null) {
      const arrName = match[1];
      if (arrName === 'array') continue;
      const info = arrays.get(arrName);
      if (info && info.size === 0) {
        diagnostics.push({
          line: i + 1, column: match.index + 1,
          message: `${arrName}.${match[2]}() called on possibly empty array (declared with size 0)`,
          severity: 'warning',
        });
      }
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.includes('strategy.entry') || trimmed.includes('strategy.close')) {
      let hasStrategyDecl = false;
      for (const l of lines) {
        if (l.trim().startsWith('strategy(')) { hasStrategyDecl = true; break; }
      }
      if (!hasStrategyDecl) {
        diagnostics.push({
          line: i + 1, column: 1,
          message: 'strategy.entry/close used but no strategy() declaration found — did you mean to use indicator()?',
          severity: 'error',
        });
        break;
      }
    }
  }

  if (!isV6 && source.includes('//@version=')) {
    const vMatch = source.match(/\/\/@version=(\d+)/);
    if (vMatch && parseInt(vMatch[1]) < 5) {
      diagnostics.push({
        line: 1, column: 1,
        message: `Script uses Pine v${vMatch[1]} — consider upgrading to v6 for latest features`,
        severity: 'info',
      });
    }
  }

  return {
    success: true,
    issue_count: diagnostics.length,
    diagnostics,
    note: diagnostics.length === 0 ? 'No static analysis issues found. Use pine_compile or pine_smart_compile for full server-side compilation check.' : undefined,
  };
}

// Pure classifier for the FIND_PINE_TAB_STATE probe result. Single choke
// point for the "is this a saved user script vs an untitled draft" rule.
//
// Discriminators (any one suffices for is_untitled_draft):
//   - script_name matches /^Untitled (indicator|strategy|library)/i — TV's
//     UI label for a fresh draft tab.
//   - script_name equals one of newScript()'s default template titles
//     ("My script", "My strategy", "MyLibrary") AND no script_id_part is set.
//   - script_id_part starts with 'STD;NEW_' or 'draft_' (TV-internal prefix).
//
// is_saved is true when there's a name AND it's not untitled.
// A null raw result maps to both flags false — callers fail-closed rather
// than guess.
const UNTITLED_NAME_RE = /^untitled (indicator|strategy|library)\b/i;
const DEFAULT_TEMPLATE_NAMES = new Set(['My script', 'My strategy', 'MyLibrary']);

export function classifyTabState(raw) {
  if (raw === null || raw === undefined) {
    return {
      script_id: null,
      script_name: null,
      version: null,
      is_saved: false,
      is_dirty: false,
      is_untitled_draft: false,
      source: null,
    };
  }
  const idPart = raw.script_id_part || null;
  const name = raw.script_name || null;
  const idIsUntitled = !!idPart && (idPart.indexOf('STD;NEW_') === 0 || idPart.indexOf('draft_') === 0);
  const nameIsUntitled = !!name && (UNTITLED_NAME_RE.test(name) || (DEFAULT_TEMPLATE_NAMES.has(name) && !idPart));
  const isUntitled = idIsUntitled || nameIsUntitled;
  // is_saved: a probe with an id-prefix that doesn't look untitled, OR a
  // probe with a non-untitled name (id may not have been captured yet).
  const isSaved = (!isUntitled && (
    (idPart && idPart.indexOf('USER;') === 0)
    || (!!name && !nameIsUntitled)
  ));
  return {
    script_id: idPart,
    script_name: name,
    version: raw.version || null,
    is_saved: !!isSaved,
    is_dirty: !!raw.is_dirty,
    is_untitled_draft: !!isUntitled,
    source: raw.source || null,
  };
}

export async function check({ source }) {
  const formData = new URLSearchParams();
  formData.append('source', source);

  const response = await fetch(
    'https://pine-facade.tradingview.com/pine-facade/translate_light?user_name=Guest&pine_id=00000000-0000-0000-0000-000000000000',
    {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': 'https://www.tradingview.com/',
      },
      body: formData,
    }
  );

  if (!response.ok) {
    throw new Error(`TradingView API returned ${response.status}: ${response.statusText}`);
  }

  const result = await response.json();
  const errors = [];
  const warnings = [];
  const inner = result?.result;

  if (inner) {
    if (inner.errors2 && inner.errors2.length > 0) {
      for (const e of inner.errors2) {
        errors.push({
          line: e.start?.line, column: e.start?.column,
          end_line: e.end?.line, end_column: e.end?.column,
          message: e.message,
        });
      }
    }
    if (inner.warnings2 && inner.warnings2.length > 0) {
      for (const w of inner.warnings2) {
        warnings.push({ line: w.start?.line, column: w.start?.column, message: w.message });
      }
    }
  }

  if (result.error && typeof result.error === 'string') {
    errors.push({ message: result.error });
  }

  const compiled = errors.length === 0;
  return {
    success: true,
    compiled,
    error_count: errors.length,
    warning_count: warnings.length,
    errors: errors.length > 0 ? errors : undefined,
    warnings: warnings.length > 0 ? warnings : undefined,
    note: compiled ? 'Pine Script compiled successfully.' : undefined,
  };
}

// ── Functions requiring TradingView connection ──

export async function getSource() {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor or Monaco not found in React fiber tree.');

  const source = await evaluate(`
    (function() {
      var m = ${FIND_MONACO};
      if (!m) return null;
      return m.editor.getValue();
    })()
  `);

  if (source === null || source === undefined) {
    throw new Error('Monaco editor found but getValue() returned null.');
  }

  const identity = await readActiveScriptIdentity();
  return {
    success: true,
    source,
    line_count: source.split('\n').length,
    char_count: source.length,
    script_id: identity.script_id,
    script_name: identity.script_name,
  };
}

// Internal: read the active editor tab's identity. Side-effect free, returns
// {script_id, script_name, version, is_saved, is_dirty, is_untitled_draft,
// source}. On any failure (probe error, panel not open) returns the
// classifyTabState(null) shape so callers can fail-closed without try/catch.
async function readActiveScriptIdentity() {
  try {
    const raw = await evaluate(FIND_PINE_TAB_STATE);
    return classifyTabState(raw);
  } catch {
    return classifyTabState(null);
  }
}

// Public: read the active editor tab's identity. Opens the editor panel if
// closed (probe needs the React tree mounted) and returns the classified
// shape. Pure read — does not click, does not mutate the editor.
export async function getActiveScript() {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) {
    return { success: false, error: 'Could not open Pine Editor.', ...classifyTabState(null) };
  }
  return { success: true, ...(await readActiveScriptIdentity()) };
}

export async function setSource({ source }) {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const escaped = JSON.stringify(source);
  const set = await evaluate(`
    (function() {
      var m = ${FIND_MONACO};
      if (!m) return false;
      m.editor.setValue(${escaped});
      return true;
    })()
  `);

  if (!set) throw new Error('Monaco found but setValue() failed.');
  const identity = await readActiveScriptIdentity();
  return {
    success: true,
    lines_set: source.split('\n').length,
    script_id: identity.script_id,
    script_name: identity.script_name,
    is_saved: identity.is_saved,
  };
}

export async function compile() {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const clicked = await evaluate(`
    (function() {
      var btns = document.querySelectorAll('button');
      var fallback = null;
      var saveBtn = null;
      for (var i = 0; i < btns.length; i++) {
        var text = btns[i].textContent.trim();
        if (/save and add to chart/i.test(text)) {
          btns[i].click();
          return 'Save and add to chart';
        }
        if (!fallback && /^(Add to chart|Update on chart)/i.test(text)) {
          fallback = btns[i];
        }
        if (!saveBtn && btns[i].className.indexOf('saveButton') !== -1 && btns[i].offsetParent !== null) {
          saveBtn = btns[i];
        }
      }
      if (fallback) { fallback.click(); return fallback.textContent.trim(); }
      if (saveBtn) { saveBtn.click(); return 'Pine Save'; }
      return null;
    })()
  `);

  if (!clicked) {
    const c = await getClient();
    await c.Input.dispatchKeyEvent({ type: 'keyDown', modifiers: 2, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter' });
  }

  await new Promise(r => setTimeout(r, 2000));
  const identity = await readActiveScriptIdentity();
  return {
    success: true,
    button_clicked: clicked || 'keyboard_shortcut',
    source: 'dom_fallback',
    script_id: identity.script_id,
    script_name: identity.script_name,
  };
}

export async function getErrors() {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const errors = await evaluate(`
    (function() {
      var m = ${FIND_MONACO};
      if (!m) return [];
      var model = m.editor.getModel();
      if (!model) return [];
      var markers = m.env.editor.getModelMarkers({ resource: model.uri });
      return markers.map(function(mk) {
        return { line: mk.startLineNumber, column: mk.startColumn, message: mk.message, severity: mk.severity };
      });
    })()
  `);

  return {
    success: true,
    has_errors: errors?.length > 0,
    error_count: errors?.length || 0,
    errors: errors || [],
  };
}

export async function save() {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  // Identify the tab we're about to save. If the probe can't read it,
  // fail-closed — better than silently saving the wrong tab. Untitled
  // drafts are allowed (Pine's rename dialog covers them).
  const identity = await readActiveScriptIdentity();
  if (identity.source === null) {
    return {
      success: false,
      error: 'could not identify active script; refusing to save',
      script_id: null,
      script_name: null,
    };
  }

  // Click the Pine Editor's save button directly (Ctrl+S saves the chart layout, not the script)
  const clicked = await evaluate(`
    (function() {
      var btn = document.querySelector('[class*="saveButton"]');
      if (!btn) return { clicked: false, error: 'Save button not found' };
      btn.click();
      return { clicked: true };
    })()
  `);
  if (!clicked || !clicked.clicked) throw new Error(clicked?.error || 'Save button not found in Pine Editor.');

  // Wait for the "Save Script" rename dialog (appears for new/untitled scripts)
  let dialogHandled = false;
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 200));
    const dialog = await evaluate(`
      (function() {
        var d = document.querySelector('[data-name="rename-dialog"]');
        if (!d) return null;
        var rect = d.getBoundingClientRect();
        if (rect.width < 10) return null;
        // Click the Save button inside the rename dialog
        var btn = d.querySelector('button[name="save"]');
        if (!btn) {
          // Fallback: look for any Save button in the dialog
          var btns = d.querySelectorAll('button');
          for (var j = 0; j < btns.length; j++) {
            if (btns[j].textContent.trim() === 'Save') { btn = btns[j]; break; }
          }
        }
        if (btn) { btn.click(); return 'confirmed'; }
        return 'dialog_visible_no_button';
      })()
    `);
    if (dialog === 'confirmed') { dialogHandled = true; break; }
    if (dialog === 'dialog_visible_no_button') break;
  }

  if (dialogHandled) await new Promise(r => setTimeout(r, 500));

  const after = await readActiveScriptIdentity();
  return {
    success: true,
    action: dialogHandled ? 'saved_with_dialog' : 'saved',
    script_id: after.script_id || identity.script_id,
    script_name: after.script_name || identity.script_name,
  };
}

export async function getConsole() {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const entries = await evaluate(`
    (function() {
      var results = [];
      var rows = document.querySelectorAll('[class*="consoleRow"], [class*="log-"], [class*="consoleLine"]');
      if (rows.length === 0) {
        var bottomArea = document.querySelector('[class*="layout__area--bottom"]')
          || document.querySelector('[class*="bottom-widgetbar-content"]');
        if (bottomArea) {
          rows = bottomArea.querySelectorAll('[class*="message"], [class*="log"], [class*="console"]');
        }
      }
      if (rows.length === 0) {
        var pinePanel = document.querySelector('.pine-editor-container')
          || document.querySelector('[class*="pine-editor"]')
          || document.querySelector('[class*="layout__area--bottom"]');
        if (pinePanel) {
          var allSpans = pinePanel.querySelectorAll('span, div');
          for (var s = 0; s < allSpans.length; s++) {
            var txt = allSpans[s].textContent.trim();
            if (/^\\d{2}:\\d{2}:\\d{2}/.test(txt) || /error|warning|info/i.test(allSpans[s].className)) {
              rows = Array.from(rows || []);
              rows.push(allSpans[s]);
            }
          }
        }
      }
      for (var i = 0; i < rows.length; i++) {
        var text = rows[i].textContent.trim();
        if (!text) continue;
        var ts = null;
        var tsMatch = text.match(/^(\\d{4}-\\d{2}-\\d{2}\\s+)?\\d{2}:\\d{2}:\\d{2}/);
        if (tsMatch) ts = tsMatch[0];
        var type = 'info';
        var cls = rows[i].className || '';
        if (/error/i.test(cls) || /error/i.test(text.substring(0, 30))) type = 'error';
        else if (/compil/i.test(text.substring(0, 40))) type = 'compile';
        else if (/warn/i.test(cls)) type = 'warning';
        results.push({ timestamp: ts, type: type, message: text });
      }
      return results;
    })()
  `);

  return { success: true, entries: entries || [], entry_count: entries?.length || 0 };
}

export async function smartCompile({ commit = false } = {}) {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const identity = await readActiveScriptIdentity();

  // Default path: compile via TradingView's translate_light API. No DOM
  // click, no save, no version bump. Reads the current Monaco source and
  // POSTs to pine-facade. This is the non-destructive default — the v3
  // bug was that the previous default could click "Pine Save" and overwrite
  // a saved user script.
  if (!commit) {
    const monacoSource = await evaluate(`
      (function() {
        var m = ${FIND_MONACO};
        return m ? m.editor.getValue() : null;
      })()
    `);
    if (monacoSource === null || monacoSource === undefined) {
      throw new Error('Monaco editor found but getValue() returned null.');
    }
    const checked = await check({ source: monacoSource });
    return {
      success: true,
      compiled: checked.compiled,
      has_errors: checked.error_count > 0,
      error_count: checked.error_count,
      warning_count: checked.warning_count,
      errors: checked.errors || [],
      warnings: checked.warnings || [],
      script_id: identity.script_id,
      script_name: identity.script_name,
      source: 'translate_light',
    };
  }

  // commit:true — opt-in destructive path. Click "Save and add to chart" /
  // "Add to chart" / "Update on chart". The "Pine Save" fallback that the
  // old default used has been removed: that path was the data-loss
  // accident in v3 issue #2.
  const studiesBefore = await evaluate(`
    (function() {
      try {
        var chart = window.TradingViewApi._activeChartWidgetWV.value();
        if (chart && typeof chart.getAllStudies === 'function') return chart.getAllStudies().length;
      } catch(e) {}
      return null;
    })()
  `);

  const buttonClicked = await evaluate(`
    (function() {
      var btns = document.querySelectorAll('button');
      var addBtn = null;
      var updateBtn = null;
      for (var i = 0; i < btns.length; i++) {
        var text = btns[i].textContent.trim();
        if (/save and add to chart/i.test(text)) { btns[i].click(); return 'Save and add to chart'; }
        if (!addBtn && /^add to chart$/i.test(text)) addBtn = btns[i];
        if (!updateBtn && /^update on chart$/i.test(text)) updateBtn = btns[i];
      }
      if (addBtn) { addBtn.click(); return 'Add to chart'; }
      if (updateBtn) { updateBtn.click(); return 'Update on chart'; }
      return null;
    })()
  `);

  if (!buttonClicked) {
    return {
      success: false,
      error: 'no add/update button found; pass commit:false to compile via API',
      script_id: identity.script_id,
      script_name: identity.script_name,
      source: 'commit_failed',
    };
  }

  await new Promise(r => setTimeout(r, 2500));

  const errors = await evaluate(`
    (function() {
      var m = ${FIND_MONACO};
      if (!m) return [];
      var model = m.editor.getModel();
      if (!model) return [];
      var markers = m.env.editor.getModelMarkers({ resource: model.uri });
      return markers.map(function(mk) {
        return { line: mk.startLineNumber, column: mk.startColumn, message: mk.message, severity: mk.severity };
      });
    })()
  `);

  const studiesAfter = await evaluate(`
    (function() {
      try {
        var chart = window.TradingViewApi._activeChartWidgetWV.value();
        if (chart && typeof chart.getAllStudies === 'function') return chart.getAllStudies().length;
      } catch(e) {}
      return null;
    })()
  `);
  const studyAdded = (studiesBefore !== null && studiesAfter !== null) ? studiesAfter > studiesBefore : null;

  return {
    success: true,
    button_clicked: buttonClicked,
    has_errors: errors?.length > 0,
    errors: errors || [],
    study_added: studyAdded,
    script_id: identity.script_id,
    script_name: identity.script_name,
    source: 'commit',
  };
}

// Try to open a fresh untitled draft tab in the Pine editor without
// overwriting whatever's currently active. Best-effort: try a programmatic
// new-tab via React handlers, then DOM-click the editor's "+ New" / "Open"
// menu. The post-condition check in newScript() decides whether the attempt
// actually produced an untitled draft.
async function attemptNewTab(type) {
  // Path A: walk fibers from the pine-editor area looking for a tab manager
  // that exposes addNewTab/createNewTab/newScript-style methods, and call it.
  const programmatic = await evaluate(`
    (function tryProgrammaticNewTab() {
      function fiberFromEl(el) {
        for (var i = 0; i < 20 && el; i++) {
          var k = Object.keys(el).find(function(kk) { return kk.startsWith('__reactFiber$'); });
          if (k) return el[k];
          el = el.parentElement;
        }
        return null;
      }
      var TYPE = ${JSON.stringify(type)};
      var pineArea = document.querySelector('[class*="bottom-widgetbar-pine-editor"]')
        || document.querySelector('[class*="pine-editor"]')
        || document.querySelector('.monaco-editor.pine-editor-monaco');
      var fiber = fiberFromEl(pineArea);
      var current = fiber;
      var candidateNames = ['addNewTab', 'createNewTab', 'newTab', 'newScript', 'createScript', 'createNewScript', 'openNewScript'];
      for (var d = 0; d < 40 && current; d++) {
        var p = current.memoizedProps;
        if (p && typeof p === 'object') {
          for (var i = 0; i < candidateNames.length; i++) {
            var fn = p[candidateNames[i]];
            if (typeof fn === 'function') {
              try { fn(TYPE); return { ok: true, via: candidateNames[i] }; }
              catch (e) {
                try { fn(); return { ok: true, via: candidateNames[i] + '(no-arg)' }; }
                catch (e2) { /* try the next candidate */ }
              }
            }
          }
        }
        current = current.return;
      }
      return { ok: false };
    })()
  `);
  if (programmatic && programmatic.ok) return { ok: true, source: 'react_fiber:' + programmatic.via };

  // Path B: open the "Open" dropdown and click "New <type>".
  const dom = await evaluate(`
    (async function tryDomNewTab() {
      var TYPE = ${JSON.stringify(type)};
      var openBtn = document.querySelector('[data-name="open-script"]')
        || Array.from(document.querySelectorAll('button')).find(function(b) {
             return /^open$/i.test((b.textContent || '').trim()) && b.offsetParent !== null;
           });
      if (openBtn) openBtn.click();
      await new Promise(function(r) { setTimeout(r, 350); });
      var labels = TYPE === 'strategy' ? ['New strategy', 'New blank strategy']
        : TYPE === 'library' ? ['New library', 'New blank library']
        : ['New indicator', 'New blank indicator', 'New default built-in script'];
      var items = Array.from(document.querySelectorAll('[role="menuitem"], [class*="menu-item"], [class*="item-"], button, a'));
      for (var j = 0; j < items.length; j++) {
        var txt = (items[j].textContent || '').trim();
        for (var k = 0; k < labels.length; k++) {
          if (txt === labels[k]) {
            items[j].click();
            return { ok: true, via: 'menu:' + labels[k] };
          }
        }
      }
      // Fallback: a "+" / "new tab" button somewhere in the pine-editor area.
      var plus = document.querySelector('[class*="bottom-widgetbar-pine-editor"] [data-name="new-tab"]')
        || document.querySelector('[class*="bottom-widgetbar-pine-editor"] [aria-label*="reate new" i]')
        || document.querySelector('[class*="pine-editor"] [data-name="new-tab"]');
      if (plus) { plus.click(); return { ok: true, via: 'plus-button' }; }
      return { ok: false };
    })()
  `, { awaitPromise: true });
  if (dom && dom.ok) return { ok: true, source: 'dom:' + dom.via };

  return { ok: false, source: null };
}

export async function newScript({ type }) {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const typeMap = { indicator: 'indicator', strategy: 'strategy', library: 'library' };
  const templates = {
    indicator: '//@version=6\nindicator("My script")\nplot(close)',
    strategy: '//@version=6\nstrategy("My strategy", overlay=true)\n',
    library: '//@version=6\n// @description TODO: add library description here\nlibrary("MyLibrary")\n',
  };
  const template = templates[type] || templates.indicator;

  const before = await readActiveScriptIdentity();

  const attempt = await attemptNewTab(type);

  // Wait up to 2s for the active tab to flip to a fresh untitled draft.
  let after = await readActiveScriptIdentity();
  for (let i = 0; i < 20; i++) {
    if (after.is_untitled_draft && after.script_id !== before.script_id) break;
    await new Promise(r => setTimeout(r, 100));
    after = await readActiveScriptIdentity();
  }

  // Post-condition check: if a saved user script is still active, refuse
  // rather than silently overwrite it (the data-loss footgun in v3 issue #1).
  if (after.is_saved) {
    return {
      success: false,
      error: 'another script is open; switch to an empty draft tab first',
      attempted: attempt.source,
      active_script_id: after.script_id,
      active_script_name: after.script_name,
      source: 'verify_failed',
    };
  }

  // Confirmed untitled draft (or unknown identity, in which case the probe
  // failed both ways and we can't verify — fail-closed).
  if (!after.is_untitled_draft) {
    return {
      success: false,
      error: 'could not verify a fresh untitled tab is active; refusing to write',
      attempted: attempt.source,
      probe_source: after.source,
      source: 'verify_failed',
    };
  }

  // Edge case: attemptNewTab found no handler/button, and the active tab is
  // the same untitled draft the user had open before the call. Without this
  // guard, setValue() would clobber an in-progress draft that the operator
  // was about to use. Refuse — the operator can clear the buffer manually or
  // open a new tab themselves.
  const sameTab = !attempt.ok
    && after.script_id === before.script_id
    && after.script_name === before.script_name;
  if (sameTab) {
    return {
      success: false,
      error: 'could not open a new tab; the active untitled draft was not changed, refusing to overwrite its buffer',
      attempted: attempt.source,
      active_script_id: after.script_id,
      active_script_name: after.script_name,
      source: 'verify_failed',
    };
  }

  // Inject the template now that we know we're on an untitled draft.
  const escaped = JSON.stringify(template);
  const set = await evaluate(`
    (function() {
      var m = ${FIND_MONACO};
      if (!m) return false;
      m.editor.setValue(${escaped});
      return true;
    })()
  `);
  if (!set) throw new Error('Monaco editor not found. Ensure Pine Editor is open.');

  return {
    success: true,
    type,
    action: 'new_script_created',
    template: typeMap[type],
    script_id: after.script_id,
    script_name: after.script_name,
    source: attempt.source || 'unknown',
  };
}

export async function openScript({ name }) {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const escapedName = JSON.stringify(name.toLowerCase());

  const result = await evaluateAsync(`
    (function() {
      var target = ${escapedName};
      return fetch('https://pine-facade.tradingview.com/pine-facade/list/?filter=saved', { credentials: 'include' })
        .then(function(r) { return r.json(); })
        .then(function(scripts) {
          if (!Array.isArray(scripts)) return {error: 'pine-facade returned unexpected data'};
          var match = null;
          for (var i = 0; i < scripts.length; i++) {
            var sn = (scripts[i].scriptName || '').toLowerCase();
            var st = (scripts[i].scriptTitle || '').toLowerCase();
            if (sn === target || st === target) { match = scripts[i]; break; }
          }
          if (!match) {
            for (var j = 0; j < scripts.length; j++) {
              var sn2 = (scripts[j].scriptName || '').toLowerCase();
              var st2 = (scripts[j].scriptTitle || '').toLowerCase();
              if (sn2.indexOf(target) !== -1 || st2.indexOf(target) !== -1) { match = scripts[j]; break; }
            }
          }
          if (!match) return {error: 'Script "' + target + '" not found. Use pine_list_scripts to see available scripts.'};

          var id = match.scriptIdPart;
          var ver = match.version || 1;
          return fetch('https://pine-facade.tradingview.com/pine-facade/get/' + id + '/' + ver, { credentials: 'include' })
            .then(function(r2) { return r2.json(); })
            .then(function(data) {
              var source = data.source || '';
              if (!source) return {error: 'Script source is empty', name: match.scriptName || match.scriptTitle};
              var m = ${FIND_MONACO};
              if (m) {
                m.editor.setValue(source);
                return {success: true, name: match.scriptName || match.scriptTitle, id: id, lines: source.split('\\n').length};
              }
              return {error: 'Monaco editor not found to inject source', name: match.scriptName || match.scriptTitle};
            });
        })
        .catch(function(e) { return {error: e.message}; });
    })()
  `);

  if (result?.error) {
    throw new Error(result.error);
  }

  return {
    success: true,
    name: result.name,
    script_id: result.id,
    script_name: result.name,
    lines: result.lines,
    source: 'internal_api',
    opened: true,
  };
}

export async function listScripts() {
  const scripts = await evaluateAsync(`
    fetch('https://pine-facade.tradingview.com/pine-facade/list/?filter=saved', { credentials: 'include' })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (!Array.isArray(data)) return {scripts: [], error: 'Unexpected response from pine-facade'};
        return {
          scripts: data.map(function(s) {
            return {
              id: s.scriptIdPart || null,
              name: s.scriptName || s.scriptTitle || 'Untitled',
              title: s.scriptTitle || null,
              version: s.version || null,
              modified: s.modified || null,
            };
          })
        };
      })
      .catch(function(e) { return {scripts: [], error: e.message}; })
  `);

  return {
    success: true,
    scripts: scripts?.scripts || [],
    count: scripts?.scripts?.length || 0,
    source: 'internal_api',
    error: scripts?.error,
  };
}
