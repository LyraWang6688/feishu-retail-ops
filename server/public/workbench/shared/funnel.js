/* funnel.js -- the ONE page-view reporter for the workbench.
   Kept SEPARATE from ui-tap.js on purpose: ui-tap.js is INLINED into the scan page
   (its bytes are pinned by byte-parity rulers), so it must not grow. The scan page
   reports page views SERVER-SIDE instead; only the workbench needs a client beacon.
   ASCII ONLY (same gate as ui-tap.js). Facts only: page + step identifier (no PII,
   no form values). Server logs ui.page.view / ui.step.enter via handleUiTap. */
(function (global) {
  'use strict';
  var DEFAULT_PATH = '/api/workbench/ui-tap';
  // Never throws, never blocks: a failed report must not affect the page.
  function view(page, options) {
    var o = options || {};
    if (!page) return false;
    var url = (o.base || '') + (o.path || DEFAULT_PATH)
      + '?kind=page_view&page=' + encodeURIComponent(page)
      + (o.step ? '&step=' + encodeURIComponent(o.step) : '');
    try {
      if (global.navigator && global.navigator.sendBeacon) {
        return global.navigator.sendBeacon(url) === true;
      }
    } catch (error) { /* a failed report must never block the page */ }
    return false;
  }
  global.dshFunnel = { view: view };
}(typeof window !== 'undefined' ? window : this));
