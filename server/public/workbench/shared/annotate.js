/*
 * Page annotate mode -- business owner asked for this on 2026-10-16 (verbatim):
 *   "I add a small switch on the page: once you turn it on, whichever block I click
 *    gets highlighted and pops up its NAME (e.g. 'return fold bar' / 'order amount input')
 *    => you screenshot it for me and I do not have to guess which block it is".
 *   Her scope (verbatim): BOTH the scan page AND the workbench.
 *
 * ---------------------------------------------------------------------------
 * This file is the SINGLE SOURCE OF TRUTH:
 *   - the scan page INLINES it at render time into one script element
 *     (that page must not pull an extra resource: "one request opens the page");
 *   - the workbench loads the SAME file via src="/workbench/shared/annotate.js".
 *   Never copy it into two places: test/pageAnnotate.test.js pins "inlined == this file".
 *
 * GATE: it only appears when the URL carries ?annotate=1. Without that parameter this
 *   script returns immediately -- no DOM, no listeners, no change to any form.
 *
 * Source of the technical trade-offs (do NOT write them as "her requirement"):
 *   - "scan page has zero JS" is OUR (agent-side) constraint; she corrected it twice on
 *     2026-10-12: "I never said that, we ARE able to do dynamic interaction". So this
 *     feature adds a script and the AC-W2 / AC-6R5 sentinels were migrated in pairs
 *     (before-verbatim -> after-verbatim, both recorded in those tests).
 *   - This file is ASCII-only (same rule as shared/ui-tap.js): user-visible Chinese is
 *     written as \uXXXX escapes, so it never trips the hardcoded-Chinese gate.
 *   - This file must NOT contain a script-open-tag literal: those would be counted as
 *     extra script blocks by the existing sentinels once it is inlined.
 *
 * Non-intrusive (her red line): it does not change any existing form behaviour, does not
 *   change submission, and does not add links. In annotate mode a click does
 *   preventDefault + stopPropagation -- on purpose: she is pointing at a block to ask
 *   "which one is this"; if that click also submitted a form or navigated away, the
 *   annotation could not be done. To operate normally, close annotate / drop the param.
 */
(function () {
  'use strict';

  var PARAM = { name: 'annotate', value: '1' };

  // Gate: only ?annotate=1 enters annotate mode; otherwise nothing at all happens.
  function enabled() {
    try {
      var search = (typeof location !== 'undefined' && location && location.search) || '';
      if (search.indexOf(PARAM.name + '=' + PARAM.value) >= 0) return true;
      // Also accept the plain '?annotate=1' / '&annotate=1' shapes at the end of the query.
      return /[?&]annotate=1(&|$)/.test(search);
    } catch (error) {
      return false;
    }
  }

  var api = { enabled: enabled, nameOf: nameOf, tagClassOf: tagClassOf, panel: null };

  // --- Name resolution: data-view first, then data-*, then tag + class ---------
  var OWN_MARKERS = ['data-annotate-highlight', 'data-annotate-panel', 'data-annotate-copy', 'data-annotate-close'];
  var SKIP_ATTRS = ['data-annotate-name', 'data-annotate-empty'];

  function tagOf(element) {
    return String((element && element.tagName) || '').toLowerCase() || 'unknown';
  }

  // 'div.a.b' shape (classes de-duplicated, at most 3: the name must identify a block).
  function tagClassOf(element) {
    var tag = tagOf(element);
    var raw = String((element && element.getAttribute && element.getAttribute('class')) || '');
    var classes = raw.split(/\s+/).filter(function (name, index, all) {
      return name && all.indexOf(name) === index;
    }).slice(0, 3);
    return classes.length ? tag + '.' + classes.join('.') : tag;
  }

  function usableValue(value) {
    var text = String(value == null ? '' : value).trim();
    if (!text) return '';
    if (text.length > 60) return '';
    return text;
  }

  // This block's OWN data-view (empty string when absent).
  function ownDataView(element) {
    if (!element || !element.getAttribute) return '';
    return usableValue(element.getAttribute('data-view'));
  }

  // Walk up to the nearest data-* marker (skipping the annotate layer's own markers).
  function nearestDataMarker(element) {
    var node = element;
    var depth = 0;
    while (node && node.getAttribute && depth < 12) {
      if (ownDataView(node)) return 'data-view="' + ownDataView(node) + '"';
      var attrs = node.attributes || [];
      for (var i = 0; i < attrs.length; i += 1) {
        var name = String(attrs[i].name || '');
        if (name.indexOf('data-') !== 0) continue;
        if (OWN_MARKERS.indexOf(name) >= 0) continue;
        if (SKIP_ATTRS.indexOf(name) >= 0) continue;
        var value = usableValue(attrs[i].value);
        if (!value) continue;
        return name + '="' + value + '"';
      }
      node = node.parentElement;
      depth += 1;
    }
    return '';
  }

  /*
   * Priority (a source-level sentinel in test/pageAnnotate.test.js pins this order):
   *   1. the block's OWN data-view
   *   2. nearest ANCESTOR data-view (she clicked a cell inside a block: report the block)
   *   3. tag + class (e.g. div.disclosure)
   *   4. nearest other data-* marker
   *   5. the tag name alone -- never an empty string, the panel always shows a name.
   */
  function nameOf(element) {
    if (!element) return '';
    var own = ownDataView(element);
    if (own) return 'data-view="' + own + '"';
    var ancestorView = '';
    var node = element.parentElement;
    var depth = 0;
    while (node && node.getAttribute && !ancestorView && depth < 12) {
      ancestorView = ownDataView(node);
      node = node.parentElement;
      depth += 1;
    }
    if (ancestorView) return 'data-view="' + ancestorView + '"';
    var tagClass = tagClassOf(element);
    if (tagClass.indexOf('.') >= 0) return tagClass;
    var marker = nearestDataMarker(element);
    if (marker) return marker;
    return tagClass;
  }

  // --- Highlight outline (position: fixed => no reflow, never covers the layout) ---
  var HIGHLIGHT_STYLE = [
    'position: fixed', 'pointer-events: none', 'z-index: 2147483000',
    'border: 2px solid var(--primary, #1f6feb)',
    'background: var(--primary-soft, rgba(31, 111, 235, 0.12))',
    'border-radius: var(--radius-sm, 8px)', 'box-sizing: border-box',
    'left: 0', 'top: 0', 'width: 0', 'height: 0', 'display: none',
  ].join('; ');

  function place(box, element) {
    if (!box || !element || !element.getBoundingClientRect) return;
    var rect = element.getBoundingClientRect();
    if (!rect || (!rect.width && !rect.height)) { box.style.display = 'none'; return; }
    box.style.display = 'block';
    box.style.left = rect.left + 'px';
    box.style.top = rect.top + 'px';
    box.style.width = rect.width + 'px';
    box.style.height = rect.height + 'px';
  }

  // --- Floating panel (position: fixed => it does not push the page structure) -----
  function buildPanel() {
    var panel = document.createElement('div');
    panel.setAttribute('data-view', 'annotate-panel');
    panel.setAttribute('data-annotate-panel', '1');
    panel.setAttribute('role', 'dialog');
    panel.style.cssText = [
      'position: fixed', 'left: 12px', 'right: 12px', 'bottom: 12px',
      'z-index: 2147483646', 'display: none',
      'background: var(--surface, #fff)', 'color: var(--text, #111)',
      'border: 1px solid var(--border, #d9d9d9)',
      'border-radius: var(--radius-md, 12px)',
      'box-shadow: var(--shadow-pop, 0 8px 24px rgba(0, 0, 0, 0.16))',
      'padding: var(--space-3, 12px)', 'font-size: var(--font-size-sm, 13px)',
      'line-height: var(--line-height-tight, 1.35)', 'box-sizing: border-box',
    ].join('; ');

    var name = document.createElement('p');
    name.setAttribute('data-view', 'annotate-name');
    name.setAttribute('data-annotate-name', '1');
    name.style.cssText = 'margin: 0 0 8px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-all;';
    panel.appendChild(name);

    var actions = document.createElement('div');
    actions.style.cssText = 'display: flex; gap: 8px;';

    // "copy" -- Chinese is escaped so this file stays ASCII-only.
    var copy = document.createElement('button');
    copy.type = 'button';
    copy.setAttribute('data-view', 'annotate-copy');
    copy.setAttribute('data-annotate-copy', '1');
    copy.textContent = '\u590d\u5236';
    copy.style.cssText = 'flex: 1; min-height: var(--control-height, 44px);';
    actions.appendChild(copy);

    // "close"
    var close = document.createElement('button');
    close.type = 'button';
    close.setAttribute('data-view', 'annotate-close');
    close.setAttribute('data-annotate-close', '1');
    close.textContent = '\u5173\u95ed';
    close.style.cssText = 'flex: 1; min-height: var(--control-height, 44px);';
    actions.appendChild(close);

    panel.appendChild(actions);
    return { panel: panel, name: name, copy: copy, close: close };
  }

  function copyText(text) {
    try {
      if (typeof navigator !== 'undefined' && navigator && navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(text);
      }
    } catch (error) { /* fall through to the legacy path */ }
    try {
      var area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', 'readonly');
      area.style.cssText = 'position: fixed; left: -9999px; top: 0;';
      document.body.appendChild(area);
      area.select();
      var ok = document.execCommand && document.execCommand('copy');
      document.body.removeChild(area);
      return Promise.resolve(ok);
    } catch (error) {
      return Promise.resolve(false);
    }
  }

  // --- Enter annotate mode (only reachable when enabled() is true) ----------------
  function start() {
    var COPY_LABEL = '\u590d\u5236';      // "copy"
    var COPIED = '\u5df2\u590d\u5236';    // "copied"
    var COPY_FAILED = '\u590d\u5236\u5931\u8d25'; // "copy failed"

    if (!document.body) return; // defensive: no body yet => nothing to attach to (never half-build the layer)

    var box = document.createElement('div');
    box.setAttribute('data-view', 'annotate-highlight');
    box.setAttribute('data-annotate-highlight', '1');
    box.style.cssText = HIGHLIGHT_STYLE;

    var panel = buildPanel();
    document.body.appendChild(box);
    document.body.appendChild(panel.panel);

    var current = null;
    var pinned = null;

    function paint(element) {
      if (!element || element === panel.panel || panel.panel.contains(element)) return;
      current = element;
      place(box, element);
    }

    // Hover: highlight the outline. Capture phase so nobody can swallow it.
    document.addEventListener('mouseover', function (event) {
      if (pinned) return;
      paint(event.target);
    }, true);

    // Scroll / resize: fixed coordinates move, so repaint.
    function repaint() { if (current) place(box, current); }
    window.addEventListener('scroll', repaint, true);
    window.addEventListener('resize', repaint);

    // Click: pin that block and show its name.
    document.addEventListener('click', function (event) {
      var target = event.target;
      if (panel.panel.contains(target)) return;
      event.preventDefault();
      event.stopPropagation();
      pinned = target;
      paint(target);
      panel.name.textContent = nameOf(target) || tagOf(target);
      panel.copy.textContent = COPY_LABEL;
      panel.panel.style.display = 'block';
    }, true);

    // Copy button: put that very name on the clipboard.
    panel.copy.addEventListener('click', function () {
      var text = panel.name.textContent || '';
      Promise.resolve(copyText(text)).then(function (ok) {
        panel.copy.textContent = ok === false ? COPY_FAILED : COPIED;
      }, function () { panel.copy.textContent = COPY_FAILED; });
    });

    // Close button: hide the panel (it must never block the normal page structure).
    panel.close.addEventListener('click', function () {
      panel.panel.style.display = 'none';
      pinned = null;
    });

    api.panel = panel.panel;
  }

  try {
    if (typeof window !== 'undefined') window.dshAnnotate = api;
  } catch (error) { /* not attachable: enabled() below still decides */ }

  if (!enabled()) return; // no ?annotate=1 => stop here: zero DOM, zero listeners.

  if (document.readyState === 'loading' || !document.body) {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
