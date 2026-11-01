/*
 * Veltrix device gate — phones only (Android / iOS).
 * Must be loaded synchronously in <head>, BEFORE any other script.
 *
 * A device is allowed only if ALL of these are true:
 *   1. The user-agent says phone (iPhone/iPod, or Android with "Mobile").
 *      iPads (including iPadOS "desktop mode"), Android tablets, Windows,
 *      macOS, Linux and ChromeOS are rejected.
 *   2. The browser has a touchscreen.
 *   3. The physical screen's shorter side is phone-sized.
 *
 * Checks 2 and 3 stop desktop browsers that merely spoof a phone user-agent.
 * NOTE: this is client-side, so a determined person can still bypass it.
 * For hard enforcement also add the server-side rule described in the README note.
 */
(function () {
  "use strict";

  var MAX_PHONE_SHORT_SIDE = 720; // CSS px; phones & unfolded foldables fit, tablets don't

  function isPhone() {
    var ua = navigator.userAgent || "";
    var touch = navigator.maxTouchPoints || 0;

    // iPadOS 13+ reports itself as a Mac. A Mac with a touchscreen is an iPad.
    if (/Macintosh/i.test(ua) && touch > 1) return false;
    if (/iPad|Tablet|PlayBook|Silk|Kindle/i.test(ua)) return false;

    var isIPhone = /iPhone|iPod/i.test(ua);
    var isAndroidPhone = /Android/i.test(ua) && /Mobile/i.test(ua);
    if (!isIPhone && !isAndroidPhone) return false;

    // Chromium exposes an explicit mobile flag; false on tablets/desktops.
    var uad = navigator.userAgentData;
    if (uad && typeof uad.mobile === "boolean" && uad.mobile === false) return false;

    // Real phones always have a touchscreen.
    if (touch < 1) return false;

    // Screen size (physical screen, not the browser window, so rotating is fine).
    var s = window.screen || {};
    var shortSide = Math.min(s.width || 0, s.height || 0);
    if (shortSide && shortSide > MAX_PHONE_SHORT_SIDE) return false;

    return true;
  }

  var ok;
  try { ok = isPhone(); } catch (e) { ok = false; }
  if (ok) return;

  window.__VELTRIX_BLOCKED__ = true;

  // Stop the parser so none of the app's scripts or network calls ever run.
  try { window.stop(); } catch (e) {}

  /* Same look as the Welcome / Sign in pages: plain page, logo top-left, eyebrow + title + description,
     separate soft cards (like the Welcome choices), the brand-gradient button and a footer resting at the bottom.
     Day / night follows the app's own saved setting (the app defaults to night, exactly like this). */
  var css =
    "*{margin:0;padding:0;box-sizing:border-box}" +
    ":root{--brand:#2450ff;--brand-grad:linear-gradient(135deg,#1a86ff 0%,#2450ff 55%,#6d3bff 100%);" +
    "--brand-ring:rgba(36,80,255,.22);--brand-shadow:0 10px 24px rgba(36,80,255,.28);" +
    "--bg:#fff;--text:#111;--mut:#777;--line:#e7e7e7;--field:#ddd;--soft:#f8f8f8;--card-shadow:0 10px 28px rgba(0,0,0,.05)}" +
    "html[data-theme=dark]{--bg:#000;--text:#eee;--mut:#888;--line:#181818;--field:#2a2a2a;--soft:#0b0b0b;--card-shadow:none;color-scheme:dark}" +
    "html[data-theme=dark] .vg-logo{filter:invert(1) hue-rotate(180deg)}" +
    "html{-webkit-text-size-adjust:100%}" +
    "body{min-height:100vh;min-height:100dvh;background:var(--bg);color:var(--text);" +
    "font-family:-apple-system,BlinkMacSystemFont,'SF Pro Display','SF Pro Text','Helvetica Neue','Segoe UI',Roboto,Arial,sans-serif;" +
    "-webkit-font-smoothing:antialiased;animation:vgPage .45s ease}" +
    "@keyframes vgPage{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}" +
    ".vg-wrap{width:100%;max-width:440px;margin:0 auto;min-height:100vh;min-height:100dvh;display:flex;flex-direction:column;padding:26px 22px}" +
    ".vg-logo{display:block;width:128px;height:auto;align-self:flex-start;user-select:none;-webkit-user-drag:none}" +
    ".vg-title{margin-top:44px;margin-bottom:30px}" +
    ".vg-eyebrow{display:inline-block;margin-bottom:12px;font-size:9px;font-weight:600;letter-spacing:2.2px;color:var(--brand)}" +
    "h1{font-size:29.5px;line-height:1.08;letter-spacing:-1.4px;margin-bottom:12px;font-weight:600}" +
    ".vg-title p{font-size:12px;line-height:1.65;color:var(--mut)}" +
    ".vg-cards{display:flex;flex-direction:column;gap:14px}" +
    ".vg-card{display:flex;align-items:center;gap:16px;padding:18px;border:1px solid var(--line);border-radius:20px;background:var(--bg);box-shadow:var(--card-shadow)}" +
    ".vg-card-ic{flex:0 0 44px;width:44px;height:44px;display:flex;align-items:center;justify-content:center;border-radius:13px;" +
    "background:var(--brand-grad);color:#fff;box-shadow:0 6px 14px rgba(36,80,255,.28)}" +
    ".vg-card-ic svg{width:21px;height:21px}" +
    ".vg-card-copy{flex:1;min-width:0;display:flex;flex-direction:column;gap:5px}" +
    ".vg-card-copy strong{font-size:13.5px;font-weight:600}" +
    ".vg-card-copy small{font-size:11px;line-height:1.5;color:var(--mut)}" +
    ".vg-notice{display:flex;gap:12px;align-items:flex-start;margin-top:14px;padding:14px;border:1px solid var(--line);border-radius:14px;background:var(--soft);color:var(--mut);font-size:10.5px;line-height:1.6}" +
    ".vg-notice svg{flex:0 0 16px;width:16px;height:16px;margin-top:2px;color:var(--brand)}" +
    ".vg-link{margin-top:30px}" +
    ".vg-label{display:block;margin-bottom:9px;font-size:11px;font-weight:600}" +
    ".vg-field{width:100%;height:55px;padding:0 16px;border:1px solid var(--field);border-radius:15px;outline:none;background:var(--bg);color:var(--text);" +
    "font:500 12px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;text-overflow:ellipsis;transition:border-color .2s,box-shadow .2s}" +
    ".vg-field:focus{border-color:var(--brand);box-shadow:0 0 0 4px var(--brand-ring)}" +
    ".vg-btn{appearance:none;display:block;width:100%;min-height:55px;margin-top:14px;border:1px solid transparent;border-radius:15px;" +
    "background:var(--brand-grad);color:#fff;font:600 13px inherit;font-family:inherit;cursor:pointer;box-shadow:var(--brand-shadow);transition:transform .2s,box-shadow .2s}" +
    ".vg-btn:hover{transform:translateY(-2px);box-shadow:0 15px 30px rgba(36,80,255,.34)}" +
    ".vg-btn:active{transform:translateY(0)}" +
    ".vg-foot{margin-top:auto;padding-top:34px;text-align:center;font-size:11px;color:var(--mut)}" +
    "@media(prefers-reduced-motion:reduce){*{animation-duration:.01ms!important;transition-duration:.01ms!important}}";

  var PHONE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="2.5" width="10" height="19" rx="2.4"/><path d="M11 18.5h2"/></svg>';
  var INFO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>';

  var html =
    '<main class="vg-wrap" role="alert">' +
      '<img class="vg-logo" src="app.assets/logo-wordmark.png" alt="Veltrix" onerror="this.style.display=\'none\'">' +
      '<div class="vg-title">' +
        '<span class="vg-eyebrow">NO ACCESS</span>' +
        '<h1>Open this on your phone</h1>' +
        '<p>Veltrix is only available on mobile phones. Please open this link on an Android phone or an iPhone to continue.</p>' +
      '</div>' +
      '<div class="vg-cards">' +
        '<div class="vg-card"><span class="vg-card-ic">' + PHONE + '</span>' +
          '<span class="vg-card-copy"><strong>Android phone</strong><small>Open the link in Chrome or any mobile browser.</small></span></div>' +
        '<div class="vg-card"><span class="vg-card-ic">' + PHONE + '</span>' +
          '<span class="vg-card-copy"><strong>iPhone (iOS)</strong><small>Open the link in Safari or any mobile browser.</small></span></div>' +
      '</div>' +
      '<div class="vg-notice">' + INFO + '<span>Laptops, desktops and tablets can\'t open Veltrix.</span></div>' +
      '<div class="vg-link">' +
        '<label class="vg-label" for="vgUrl">Link to open on your phone</label>' +
        '<input class="vg-field" id="vgUrl" type="text" readonly>' +
        '<button type="button" class="vg-btn" id="vgCopy">Copy link</button>' +
      '</div>' +
      '<div class="vg-foot">Mobile phones only</div>' +
    '</main>';

  function render() {
    var theme = "dark";
    try { if (localStorage.getItem("veltrixTheme") === "light") theme = "light"; } catch (e) {}

    var root = document.documentElement;
    root.removeAttribute("class");
    root.setAttribute("lang", "en");
    root.setAttribute("data-theme", theme);
    root.innerHTML =
      '<head><meta charset="UTF-8">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<meta name="robots" content="noindex,nofollow">' +
      '<link rel="icon" type="image/png" sizes="32x32" href="app.assets/favicon-32.png">' +
      "<title>Veltrix · Mobile only</title><style>" + css + "</style></head>" +
      "<body>" + html + "</body>";

    var url = location.href.split("#")[0];
    var u = document.getElementById("vgUrl");
    if (u) { u.value = url; u.addEventListener("focus", function () { u.select(); }); }

    var b = document.getElementById("vgCopy");
    if (b) b.addEventListener("click", function () {
      function done() { b.textContent = "Link copied ✓"; setTimeout(function () { b.textContent = "Copy link"; }, 2200); }
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(url).then(done, fallback);
        } else { fallback(); }
      } catch (e) { fallback(); }
      function fallback() {
        try {
          u.select(); document.execCommand("copy"); done();
        } catch (e) {}
      }
    });
  }

  render();
})();
