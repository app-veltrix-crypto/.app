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

  var css =
    "*{margin:0;padding:0;box-sizing:border-box}" +
    "html,body{height:100%}" +
    "body{display:flex;align-items:center;justify-content:center;padding:24px;" +
    "font-family:-apple-system,BlinkMacSystemFont,'SF Pro Display','Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;" +
    "background:#0b0d12;color:#f4f5f8;-webkit-font-smoothing:antialiased}" +
    "@media (prefers-color-scheme:light){body{background:#f5f6f9;color:#111}" +
    ".vg-card{background:#fff!important;border-color:#e8eaf0!important;box-shadow:0 20px 60px rgba(20,24,40,.10)!important}" +
    ".vg-sub,.vg-hint{color:#6b7080!important}.vg-chip{background:#f0f2f7!important;color:#3d4254!important}" +
    ".vg-btn{background:#111!important;color:#fff!important}}" +
    ".vg-card{width:100%;max-width:440px;text-align:center;padding:40px 28px 32px;border-radius:28px;" +
    "background:#141720;border:1px solid #232838;box-shadow:0 20px 60px rgba(0,0,0,.45)}" +
    ".vg-logo{width:72px;height:72px;border-radius:20px;margin:0 auto 22px;display:block;object-fit:contain}" +
    ".vg-ic{width:56px;height:56px;margin:0 auto 18px;border-radius:50%;display:flex;align-items:center;justify-content:center;" +
    "background:rgba(36,80,255,.14);color:#4d74ff}" +
    ".vg-ic svg{width:28px;height:28px}" +
    ".vg-eyebrow{font-size:11px;font-weight:700;letter-spacing:2px;color:#4d74ff;margin-bottom:10px}" +
    "h1{font-size:26px;line-height:1.15;letter-spacing:-.8px;margin-bottom:12px}" +
    ".vg-sub{font-size:14.5px;line-height:1.6;color:#9aa0b2;margin-bottom:22px}" +
    ".vg-chips{display:flex;gap:10px;justify-content:center;margin-bottom:24px;flex-wrap:wrap}" +
    ".vg-chip{display:inline-flex;align-items:center;gap:8px;padding:10px 16px;border-radius:999px;background:#1d2130;" +
    "color:#d8dbe6;font-size:13.5px;font-weight:600}" +
    ".vg-chip svg{width:16px;height:16px}" +
    ".vg-btn{appearance:none;border:0;cursor:pointer;width:100%;padding:15px 18px;border-radius:16px;background:#2450ff;" +
    "color:#fff;font:600 15px inherit;font-family:inherit}" +
    ".vg-btn:active{transform:scale(.98)}" +
    ".vg-hint{margin-top:14px;font-size:12px;color:#7d8397;word-break:break-all}";

  var html =
    '<div class="vg-card" role="alert">' +
      '<img class="vg-logo" src="app.assets/logo.veltrix.png" alt="Veltrix" onerror="this.style.display=\'none\'">' +
      '<div class="vg-ic" aria-hidden="true">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
        '<rect x="7" y="2.5" width="10" height="19" rx="2.4"/><path d="M11 18.5h2"/></svg>' +
      '</div>' +
      '<div class="vg-eyebrow">NO ACCESS</div>' +
      '<h1>Open this on your phone</h1>' +
      '<p class="vg-sub">Veltrix is only available on mobile phones. ' +
      'Laptops, desktops and tablets can\'t open it. Please visit this link on an Android or iPhone device.</p>' +
      '<div class="vg-chips">' +
        '<span class="vg-chip"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="2.5" width="10" height="19" rx="2.4"/></svg>Android</span>' +
        '<span class="vg-chip"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="2.5" width="10" height="19" rx="2.4"/></svg>iPhone (iOS)</span>' +
      '</div>' +
      '<button type="button" class="vg-btn" id="vgCopy">Copy link to open on phone</button>' +
      '<div class="vg-hint" id="vgUrl"></div>' +
    '</div>';

  function render() {
    var root = document.documentElement;
    root.removeAttribute("class");
    root.setAttribute("lang", "en");
    root.innerHTML =
      '<head><meta charset="UTF-8">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<meta name="robots" content="noindex,nofollow">' +
      "<title>Veltrix · Mobile only</title><style>" + css + "</style></head>" +
      "<body>" + html + "</body>";

    var url = location.href.split("#")[0];
    var u = document.getElementById("vgUrl");
    if (u) u.textContent = url;

    var b = document.getElementById("vgCopy");
    if (b) b.addEventListener("click", function () {
      function done() { b.textContent = "Link copied ✓"; setTimeout(function () { b.textContent = "Copy link to open on phone"; }, 2200); }
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(url).then(done, fallback);
        } else { fallback(); }
      } catch (e) { fallback(); }
      function fallback() {
        try {
          var t = document.createElement("textarea");
          t.value = url; document.body.appendChild(t); t.select();
          document.execCommand("copy"); document.body.removeChild(t); done();
        } catch (e) {}
      }
    });
  }

  render();
})();
