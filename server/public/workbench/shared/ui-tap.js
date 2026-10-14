/* ui-tap.js -- the ONE tap-report implementation, shared by two front ends:
     * the scan page  -> the server INLINES this file into its single script block
                        (that page must keep exactly one script; see the renderer);
     * the workbench -> loaded by a script tag with src="/workbench/shared/ui-tap.js".
   ASCII ONLY in this file, and never write the opening tag of a script element here:
   the scan renderer inlines this text, and its "exactly one script" sentinels (plus the
   hardcoded-Chinese gate) count raw occurrences of that tag in the rendered page.
   FACTS ONLY -- target / tap_id / since_ms / page. Never a form value, never PII.
   The server decides whether a tap counts as "repeated" (config window); this file
   only reports how long it has been since the same target was last tapped.
   Contract (shared with src/config/uiTap.js):
     POST <base><path>?target=..&tap_id=..&since_ms=..&page=..  -> 204 (or 400 if no target) */
(function (global) {
  'use strict';

  var TARGET_ATTR = 'data-tap-target';
  var DEFAULT_PATH = '/ui-tap';
  var DEFAULT_FORM_FIELD = 'tap_id';

  function newTapId() {
    return 'tap-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  var lastAt = {};      // target -> timestamp of the previous tap on that target
  var currentId = '';   // most recent tap id: the next write request carries it

  function buildUrl(options) {
    var o = options || {};
    var url = (o.base || '') + (o.path || DEFAULT_PATH)
      + '?target=' + encodeURIComponent(o.target || '')
      + '&tap_id=' + encodeURIComponent(o.tapId || '')
      + '&page=' + encodeURIComponent(o.page || '');
    if (typeof o.sinceMs === 'number' && o.sinceMs >= 0) {
      url += '&since_ms=' + Math.round(o.sinceMs);
    }
    return url;
  }

  // Never throws, never blocks: a failed report must not affect the tap itself.
  // sendBeacon ONLY: the scan page inlines this file into a block that is pinned to
  // stay minimal (no fetch / no XHR there -- see scanPrintFeedback AC-PF3), and every
  // target browser/webview that runs this product has sendBeacon.
  function send(url) {
    try {
      if (global.navigator && global.navigator.sendBeacon) {
        return global.navigator.sendBeacon(url) === true;
      }
    } catch (error) { /* a failed report must never block the tap */ }
    return false;
  }

  function track(target, options) {
    var o = options || {};
    if (!target) return '';
    var now = Date.now();
    var previous = lastAt[target];
    var tapId = newTapId();
    lastAt[target] = now;
    currentId = tapId;
    send(buildUrl({
      base: o.base,
      path: o.path,
      page: o.page,
      target: target,
      tapId: tapId,
      sinceMs: typeof previous === 'number' ? (now - previous) : null,
    }));
    return tapId;
  }

  // Put the tap id on the form that is about to be submitted, so the write request
  // can be correlated with the tap that caused it (result event).
  function stampForm(form, options) {
    var o = options || {};
    if (!form || !form.querySelector) return '';
    var field = o.formField || DEFAULT_FORM_FIELD;
    var tapId = o.tapId || currentId || newTapId();
    currentId = tapId;
    var input = form.querySelector('input[name="' + field + '"]');
    if (!input) {
      input = document.createElement('input');
      input.setAttribute('type', 'hidden');
      input.setAttribute('name', field);
      form.appendChild(input);
    }
    input.setAttribute('value', tapId);
    return tapId;
  }

  function targetOf(node) {
    var current = node;
    while (current && current !== document) {
      if (current.getAttribute && current.getAttribute(TARGET_ATTR)) {
        return { node: current, target: current.getAttribute(TARGET_ATTR) };
      }
      current = current.parentNode;
    }
    return null;
  }

  // Delegated wiring for a page that has no tap handlers of its own (the workbench).
  // NOTE: this never cancels the browser's default action -- a tap must always keep working.
  function bind(options) {
    var o = options || {};
    document.addEventListener('click', function (event) {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      var hit = targetOf(event.target);
      if (hit) track(hit.target, o);
    }, true);
    document.addEventListener('submit', function (event) {
      stampForm(event.target, o);
    }, true);
  }

  global.dshUiTap = {
    newTapId: newTapId,
    track: track,
    send: send,
    buildUrl: buildUrl,
    stampForm: stampForm,
    bind: bind,
    currentTapId: function () { return currentId; },
    // The field name this reporter stamps (read by core/api-client.js -- one source: here).
    formField: DEFAULT_FORM_FIELD,
    // The element attribute that opts an element into tap reporting.
    targetAttr: TARGET_ATTR,
  };
}(typeof window !== 'undefined' ? window : this));
