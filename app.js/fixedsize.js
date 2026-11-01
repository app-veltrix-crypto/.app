/*
 * Veltrix fixed-size guard.
 * Keeps the page at exactly 1x scale on phones, whatever the browser.
 * Load synchronously in <head>, right after devicegate.js.
 */
(function () {
  "use strict";
  if (window.__VELTRIX_BLOCKED__) return;

  /* Page scale. 1 = original size; 0.9 = everything 10% smaller. Change this one number to tune the size. */
  var SCALE = 0.9;

  function layoutWidth() {
    var s = window.screen || {};
    var a = s.width || 0, b = s.height || 0;
    if (!a || !b) return null;
    var portrait = window.matchMedia ? window.matchMedia("(orientation: portrait)").matches : true;
    var w = portrait ? Math.min(a, b) : Math.max(a, b);
    return Math.round(w / SCALE);
  }

  function viewportContent() {
    var w = layoutWidth();
    return (w ? "width=" + w : "width=device-width") +
      ", initial-scale=" + SCALE + ", maximum-scale=" + SCALE + ", minimum-scale=" + SCALE +
      ", user-scalable=no, viewport-fit=cover";
  }
  var VIEWPORT = viewportContent();

  /* 1. Always keep the viewport tag exact, even if something changes or removes it. */
  function ensureViewport() {
    VIEWPORT = viewportContent();
    var m = document.querySelector('meta[name="viewport"]');
    if (!m) {
      m = document.createElement("meta");
      m.name = "viewport";
      (document.head || document.documentElement).appendChild(m);
    }
    if (m.getAttribute("content") !== VIEWPORT) m.setAttribute("content", VIEWPORT);
    return m;
  }
  ensureViewport();
  window.addEventListener("orientationchange", function () { setTimeout(ensureViewport, 150); });
  window.addEventListener("resize", function () { ensureViewport(); });

  /* 2. iOS Safari ignores user-scalable=no, so block pinch gestures directly. */
  function stop(e) { e.preventDefault(); }
  ["gesturestart", "gesturechange", "gestureend"].forEach(function (t) {
    document.addEventListener(t, stop, { passive: false });
  });

  /* 3. Block two-finger pinch on browsers that deliver it as touch events. */
  document.addEventListener("touchmove", function (e) {
    if (e.touches && e.touches.length > 1) e.preventDefault();
  }, { passive: false });

  /* 4. Block double-tap zoom (older iOS / some Android browsers). */
  var lastTap = 0;
  document.addEventListener("touchend", function (e) {
    var now = Date.now();
    var t = e.target;
    var typing = t && t.closest && t.closest("input,textarea,select,[contenteditable]");
    if (now - lastTap < 320 && !typing) e.preventDefault();
    lastTap = now;
  }, { passive: false });

  /* 5. If the browser ever ends up zoomed in (e.g. after focusing an input), snap back to 1x. */
  var vv = window.visualViewport, resetting = false;
  function resetZoom() {
    if (resetting || !vv || vv.scale <= SCALE + 0.01) return;
    resetting = true;
    var m = ensureViewport();
    m.setAttribute("content", VIEWPORT.replace("maximum-scale=" + SCALE, "maximum-scale=" + (SCALE + 0.0001)));
    setTimeout(function () {
      m.setAttribute("content", VIEWPORT);
      resetting = false;
    }, 60);
  }
  if (vv) {
    vv.addEventListener("resize", resetZoom);
    document.addEventListener("focusout", function () { setTimeout(resetZoom, 150); });
  }
})();
