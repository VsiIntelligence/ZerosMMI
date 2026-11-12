/**
 * Zeros website preview runtime (runs INSIDE the sandboxed preview iframe).
 *
 * Two scripts are injected into every assembled page:
 *   PREVIEW_PRELUDE  - first thing in <head>: error capture, click-handler bookkeeping, verify-mode stubs.
 *   PREVIEW_RUNTIME  - end of <body>: link routing, verify(), smoke(), capture() (screenshots), host messages.
 *
 * Both are String.raw so backslashes in regexes reach the browser untouched.
 * RULE: no backticks and no dollar-brace sequences inside these strings.
 *
 * Protocol (iframe -> parent, always { source: "zeros-preview", type, ... }):
 *   runtime {kind, value} | page {path} | navigate-request {path, anchor}
 *   verification {...report} | smoke {...} | screenshot {dataUrl,width,height,slices}
 * Host -> iframe: { source: "zeros-preview-host", type: "verify" | "smoke" | "screenshot" | "ping", ... }
 */

export const PREVIEW_PRELUDE = String.raw`
(function () {
  var D = {};
  try { D = JSON.parse(document.getElementById("zeros-runtime-data").textContent || "{}"); } catch (e) {}
  var verify = D.mode === "verify";
  var Z = (window.__ZEROS__ = {
    mode: D.mode || "preview", page: D.current || "index.html", pages: D.pages || [],
    errors: [], listeners: new WeakMap(), internal: 0, navCount: 0
  });
  function send(type, payload) {
    try { parent.postMessage(Object.assign({ source: "zeros-preview", type: type }, payload || {}), "*"); } catch (e) {}
  }
  Z.send = send;
  function memStorage() {
    var data = Object.create(null);
    return {
      get length() { return Object.keys(data).length; },
      key: function (i) { var k = Object.keys(data)[i]; return k === undefined ? null : k; },
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
      setItem: function (k, v) { data[String(k)] = String(v); },
      removeItem: function (k) { delete data[k]; },
      clear: function () { for (var k in data) delete data[k]; }
    };
  }
  ["localStorage", "sessionStorage"].forEach(function (name) {
    try { void window[name]; } catch (e) {
      try { Object.defineProperty(window, name, { configurable: true, value: memStorage() }); } catch (e2) {}
    }
  });
  function record(kind, value, extra) {
    var item = Object.assign({ kind: kind, value: String(value == null ? "" : value).slice(0, 400), page: Z.page }, extra || {});
    if (Z.errors.length < 60) Z.errors.push(item);
    send("runtime", { kind: kind, value: item.value });
  }
  Z.record = record;

  window.addEventListener("error", function (e) {
    var t = e.target;
    if (t && t !== window && t.tagName) {
      var url = t.currentSrc || t.src || t.href || "";
      if (url && url.indexOf("data:") !== 0) record("asset", t.tagName.toLowerCase() + " failed to load: " + url.slice(0, 160), { asset: true });
      return;
    }
    var where = e.lineno ? " (line " + e.lineno + ":" + (e.colno || 0) + ")" : "";
    record("error", (e.message || "Script error") + where);
  }, true);
  window.addEventListener("unhandledrejection", function (e) {
    var r = e.reason;
    record("error", "Unhandled promise rejection: " + (r && r.message ? r.message : String(r)));
  });
  var origErr = console.error;
  console.error = function () {
    try { record("console", Array.prototype.slice.call(arguments).map(function (a) { return a && a.message ? a.message : String(a); }).join(" ")); } catch (e) {}
    return origErr.apply(console, arguments);
  };

  var TRACK = { click: 1, pointerdown: 1, pointerup: 1, mousedown: 1, mouseup: 1, touchstart: 1, keydown: 1, submit: 1, change: 1, input: 1 };
  var origAdd = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (type) {
    try {
      if (!Z.internal && TRACK[type]) {
        var set = Z.listeners.get(this);
        if (!set) { set = {}; Z.listeners.set(this, set); }
        set[type] = (set[type] || 0) + 1;
      }
    } catch (e) {}
    return origAdd.apply(this, arguments);
  };

  if (verify) {
    window.alert = function () {}; window.confirm = function () { return true; }; window.prompt = function () { return ""; };
    window.open = function (u) { record("nav", "window.open blocked: " + u); return null; };
    if ("IntersectionObserver" in window) {
      var FakeIO = function (cb) { this._cb = cb; };
      FakeIO.prototype.observe = function (el) {
        var self = this;
        setTimeout(function () {
          try {
            var r = el.getBoundingClientRect();
            self._cb([{ target: el, isIntersecting: true, intersectionRatio: 1, boundingClientRect: r, intersectionRect: r, rootBounds: null, time: performance.now() }], self);
          } catch (e) {}
        }, 30);
      };
      FakeIO.prototype.unobserve = function () {}; FakeIO.prototype.disconnect = function () {}; FakeIO.prototype.takeRecords = function () { return []; };
      window.IntersectionObserver = FakeIO;
    }
    var st = document.createElement("style");
    st.textContent = "html{scroll-behavior:auto !important}*,*::before,*::after{transition-duration:0s !important;transition-delay:0s !important;animation-duration:0.001s !important;animation-delay:0s !important;animation-iteration-count:1 !important}";
    (document.head || document.documentElement).appendChild(st);
  }
})();
`;

export const PREVIEW_RUNTIME = String.raw`
(function () {
  var Z = window.__ZEROS__;
  if (!Z) return;
  var D = JSON.parse(document.getElementById("zeros-runtime-data").textContent || "{}");
  var PAGES = D.pages || [];
  var send = Z.send;
  function internal(fn) { Z.internal++; try { return fn(); } finally { Z.internal--; } }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function isExternal(h) { return /^(https?:|\/\/|mailto:|tel:|sms:|javascript:|data:|blob:)/i.test(h); }

  function normalizePath(value) {
    var clean = String(value || "").replace(/^\.\//, "").replace(/^\//, "").split(/[?#]/)[0] || "index.html";
    clean = clean.replace(/\/+$/, "");
    if (!clean || clean === ".") return "index.html";
    if (!/\.html?$/i.test(clean)) clean = clean + ".html";
    return clean;
  }
  function resolveRoute(href) {
    if (!href || isExternal(href) || href.charAt(0) === "#") return undefined;
    var clean = normalizePath(href);
    if (PAGES.indexOf(clean) >= 0) return clean;
    var base = (clean.split("/").pop() || clean).toLowerCase();
    var stem = base.replace(/\.html?$/i, "");
    for (var i = 0; i < PAGES.length; i++) {
      var pb = (PAGES[i].split("/").pop() || PAGES[i]).toLowerCase();
      if (pb === base || pb.replace(/\.html?$/i, "") === stem) return PAGES[i];
    }
    return undefined;
  }
  function nav(page, anchor) {
    Z.navCount++;
    send("navigate-request", { path: page, anchor: anchor || "" });
  }
  window.__ZEROS_ROUTE__ = function (p) { var t = resolveRoute(p) || p; nav(t, ""); };

  var toastTimer = 0;
  function toast(msg) {
    if (Z.mode === "verify") return;
    var el = document.getElementById("zeros-toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "zeros-toast";
      el.style.cssText = "position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:2147483647;padding:8px 14px;border-radius:999px;background:rgba(10,10,16,.92);color:#fff;font:600 12px system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.4);pointer-events:none;transition:opacity .2s";
      document.body.appendChild(el);
    }
    el.textContent = msg; el.style.opacity = "1";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.style.opacity = "0"; }, 1800);
  }

  internal(function () {
    document.addEventListener("click", function (event) {
      var t = event.target;
      var el = t && t.closest ? t.closest("a[href], [data-zeros-route], [data-href], [data-link], [data-page]") : null;
      if (!el) return;
      var route = el.getAttribute("data-zeros-route");
      if (route) { event.preventDefault(); event.stopPropagation(); nav(route, el.getAttribute("data-zeros-anchor") || ""); return; }
      var href = el.getAttribute("href") || el.getAttribute("data-href") || el.getAttribute("data-link") || el.getAttribute("data-page") || "";
      if (href.charAt(0) === "#") {
        event.preventDefault();
        if (href.length > 1) {
          var id = decodeURIComponent(href.slice(1)), target = document.getElementById(id) || document.getElementsByName(id)[0];
          if (target) target.scrollIntoView({ behavior: Z.mode === "verify" ? "auto" : "smooth", block: "start" });
          else Z.record("link", "Broken anchor: " + href.slice(0, 80), { link: href });
        } else { window.scrollTo({ top: 0, behavior: Z.mode === "verify" ? "auto" : "smooth" }); }
        return;
      }
      if (!href || /^(mailto:|tel:|sms:|javascript:)/i.test(href)) return;
      if (/^(https?:|\/\/)/i.test(href)) {
        if (el.getAttribute("target") !== "_blank") { event.preventDefault(); try { window.open(href, "_blank", "noopener"); } catch (e) {} }
        return;
      }
      if (el.hasAttribute("download") || /^(data:|blob:)/i.test(href)) return;
      event.preventDefault(); event.stopPropagation();
      var page = resolveRoute(href);
      if (page) { nav(page, href.indexOf("#") >= 0 ? href.slice(href.indexOf("#") + 1) : ""); return; }
      Z.record("link", "Broken link: " + href.slice(0, 120), { link: href });
      toast("Page not found: " + href.slice(0, 40));
    }, true);
    document.addEventListener("submit", function (event) {
      if (event.defaultPrevented) return;
      var form = event.target;
      var action = form && form.getAttribute ? (form.getAttribute("action") || "") : "";
      var page = action && !isExternal(action) ? resolveRoute(action) : undefined;
      event.preventDefault();
      if (page) nav(page, "");
      else toast("Preview: form submitted");
    }, false);
  });

  /* ------------------------------------------------------------ helpers */
  function visible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    var r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    var cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none";
  }
  function sel(el) {
    if (!el || !el.tagName) return "?";
    var s = el.tagName.toLowerCase();
    if (el.id) s += "#" + el.id;
    else if (el.className && typeof el.className === "string") s += "." + el.className.trim().split(/\s+/).slice(0, 2).join(".");
    var t = (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 28);
    return t ? s + ' "' + t + '"' : s;
  }
  function accName(el) {
    var t = (el.getAttribute("aria-label") || el.getAttribute("title") || el.textContent || "").replace(/\s+/g, " ").trim();
    if (!t) { var img = el.querySelector("img[alt]"); if (img) t = img.getAttribute("alt") || ""; }
    if (!t && el.value) t = String(el.value);
    if (!t) { var st = el.querySelector("svg title"); if (st) t = st.textContent || ""; }
    return t;
  }
  function hasHandler(el) {
    for (var n = el; n && n.nodeType === 1; n = n.parentElement) {
      if (n.hasAttribute("onclick") || typeof n.onclick === "function") return true;
      var s = Z.listeners.get(n);
      if (s && (s.click || s.pointerdown || s.mousedown || s.pointerup || s.mouseup || s.touchstart)) return true;
    }
    var d = Z.listeners.get(document), w = Z.listeners.get(window);
    return !!((d && (d.click || d.pointerdown)) || (w && (w.click || w.pointerdown)));
  }

  var colorCtx = null, colorCache = {};
  function toRgba(str) {
    if (colorCache[str]) return colorCache[str];
    if (!colorCtx) { var c = document.createElement("canvas"); c.width = c.height = 1; colorCtx = c.getContext("2d", { willReadFrequently: true }); }
    var out = null;
    try {
      colorCtx.clearRect(0, 0, 1, 1);
      colorCtx.fillStyle = "#010203"; colorCtx.fillStyle = str;
      colorCtx.fillRect(0, 0, 1, 1);
      var p = colorCtx.getImageData(0, 0, 1, 1).data;
      if (!(p[0] === 1 && p[1] === 2 && p[2] === 3 && p[3] === 255)) out = { r: p[0], g: p[1], b: p[2], a: p[3] / 255 };
    } catch (e) {}
    colorCache[str] = out;
    return out;
  }
  function lum(c) {
    function f(v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  }
  function over(top, bot) {
    var a = top.a + bot.a * (1 - top.a);
    if (a <= 0) return { r: 0, g: 0, b: 0, a: 0 };
    return { r: (top.r * top.a + bot.r * bot.a * (1 - top.a)) / a, g: (top.g * top.a + bot.g * bot.a * (1 - top.a)) / a, b: (top.b * top.a + bot.b * bot.a * (1 - top.a)) / a, a: a };
  }
  function effectiveBg(el) {
    var layers = [];
    for (var n = el; n && n.nodeType === 1; n = n.parentElement) {
      var cs = getComputedStyle(n);
      var bi = cs.backgroundImage;
      if (bi && bi !== "none") {
        if (bi.indexOf("gradient") < 0) return null; /* photo/pattern background: unknown */
        var stops = (bi.match(/rgba?\([^)]*\)/g) || []).map(toRgba).filter(Boolean);
        if (!stops.length) return null;
        var avg = { r: 0, g: 0, b: 0, a: 0 };
        stops.forEach(function (c) { avg.r += c.r; avg.g += c.g; avg.b += c.b; avg.a += c.a; });
        avg = { r: avg.r / stops.length, g: avg.g / stops.length, b: avg.b / stops.length, a: avg.a / stops.length };
        var under = toRgba(cs.backgroundColor);
        if (under && under.a > 0) layers.push(under);
        layers.push(avg);
        if (avg.a >= 0.95) break;
        continue;
      }
      var c = toRgba(cs.backgroundColor);
      if (c && c.a > 0) { layers.push(c); if (c.a >= 1) break; }
    }
    var acc = { r: 255, g: 255, b: 255, a: 1 };
    for (var i = layers.length - 1; i >= 0; i--) acc = over(layers[i], acc);
    return acc;
  }
  function contrastChecks() {
    var nodes = document.querySelectorAll("h1,h2,h3,h4,p,li,a,button,span,label,blockquote,figcaption,small,td,th");
    var seen = 0, low = [], borderline = 0, sampled = 0;
    for (var i = 0; i < nodes.length && sampled < 160; i++) {
      var el = nodes[i], own = "";
      for (var k = 0; k < el.childNodes.length; k++) if (el.childNodes[k].nodeType === 3) own += el.childNodes[k].nodeValue;
      if (own.trim().length < 2 || !visible(el)) continue;
      var cs = getComputedStyle(el);
      if (parseFloat(cs.opacity) < 0.3) continue;
      var fg = toRgba(cs.color), bg = effectiveBg(el);
      if (!fg || !bg) continue;
      sampled++;
      var fgc = over(fg, bg);
      var l1 = lum(fgc), l2 = lum(bg);
      var ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      var size = parseFloat(cs.fontSize), bold = parseInt(cs.fontWeight, 10) >= 700;
      var large = size >= 24 || (size >= 18.66 && bold);
      if (ratio < (large ? 2.4 : 3.2)) low.push({ el: sel(el), ratio: Math.round(ratio * 10) / 10 });
      else if (ratio < (large ? 3 : 4.5)) borderline++;
      seen++;
    }
    return { sampled: seen, low: low.slice(0, 6), lowCount: low.length, borderline: borderline };
  }

  /* -------------------------------------------------------------- verify */
  function runVerify() {
    var doc = document, out = { page: Z.page, title: (doc.title || "").trim() };
    internal(function () {
      Array.prototype.forEach.call(doc.querySelectorAll("img[loading=lazy]"), function (i) { i.loading = "eager"; });
    });
    var missing = [];
    if (!out.title) missing.push("<title>");
    if (!doc.querySelector('meta[name="viewport"]')) missing.push("viewport meta");
    if (!doc.querySelector('meta[name="description"]')) missing.push("meta description");
    if (!doc.documentElement.getAttribute("lang")) missing.push("html lang");
    var h1s = doc.querySelectorAll("h1");
    if (h1s.length !== 1) missing.push(h1s.length ? "more than one <h1>" : "<h1>");
    if (!doc.querySelector("main, [role=main]")) missing.push("<main>");
    out.missing = missing;

    var links = Array.prototype.slice.call(doc.querySelectorAll("a[href]"));
    var broken = [];
    links.forEach(function (a) {
      var h = a.getAttribute("href") || "";
      if (a.hasAttribute("data-zeros-route") || isExternal(h)) return;
      if (h.charAt(0) === "#") {
        if (h.length > 1) { var id = decodeURIComponent(h.slice(1)); if (!doc.getElementById(id) && !doc.getElementsByName(id).length) broken.push(h + " (no element with that id)"); }
        return;
      }
      if (!resolveRoute(h) && !a.hasAttribute("download")) broken.push(h);
    });
    out.brokenLocalLinks = broken.slice(0, 12);

    var badAssets = [];
    Array.prototype.forEach.call(doc.querySelectorAll("img[src]"), function (img) {
      var s = img.getAttribute("src") || "";
      if (s && s.indexOf("data:") !== 0 && img.complete && img.naturalWidth === 0) badAssets.push(s.slice(0, 90));
    });
    Z.errors.forEach(function (e) { if (e.asset && e.page === Z.page) badAssets.push(e.value.replace(/^.* failed to load: /, "").slice(0, 90)); });
    out.missingLocalAssets = Array.from(new Set(badAssets)).slice(0, 12);

    var unnamed = 0, dead = [], noAlt = 0;
    Array.prototype.forEach.call(doc.querySelectorAll("button, [role=button], input[type=button], input[type=submit], a[href]"), function (el) {
      if (!visible(el)) return;
      if (!accName(el)) unnamed++;
      var tag = el.tagName.toLowerCase();
      if (tag === "a") {
        var h = el.getAttribute("href") || "";
        if ((h === "#" || h === "") && !el.hasAttribute("data-zeros-route") && !hasHandler(el)) dead.push(sel(el));
      } else if (tag === "button" || el.getAttribute("role") === "button" || el.type === "button") {
        var inForm = !!el.closest("form");
        var submit = tag === "button" && (el.getAttribute("type") || "submit") === "submit" && inForm;
        if (!submit && !hasHandler(el) && !el.disabled && !el.hasAttribute("popovertarget") && !el.closest("summary")) dead.push(sel(el));
      }
    });
    Array.prototype.forEach.call(doc.querySelectorAll("img"), function (img) { if (!img.hasAttribute("alt")) noAlt++; });
    out.unnamedButtons = unnamed;
    out.nonFunctionalButtons = dead.slice(0, 10);
    out.imagesWithoutAlt = noAlt;

    var vw = window.innerWidth;
    var sw = Math.max(doc.documentElement.scrollWidth, doc.body ? doc.body.scrollWidth : 0);
    out.horizontalOverflow = sw > vw + 2;
    out.overflowCulprits = [];
    if (out.horizontalOverflow) {
      var all = doc.body.querySelectorAll("*");
      for (var i = 0; i < all.length && out.overflowCulprits.length < 4; i++) {
        var r = all[i].getBoundingClientRect();
        if (r.width > 0 && r.right > vw + 2 && getComputedStyle(all[i]).position !== "fixed") out.overflowCulprits.push(sel(all[i]) + " (right edge " + Math.round(r.right) + "px)");
      }
    }
    var clipped = [];
    Array.prototype.forEach.call(doc.body.querySelectorAll("h1,h2,h3,p,a,button,li,span"), function (el) {
      if (clipped.length >= 4) return;
      var cs = getComputedStyle(el);
      /* visually hidden text (screen-reader labels) is clipped on purpose: not a layout problem */
      if (el.clientWidth <= 2 || (el.closest && el.closest(".sr-only, [aria-hidden='true']"))) return;
      if ((cs.overflow === "hidden" || cs.overflowX === "hidden") && cs.textOverflow !== "ellipsis" && el.scrollWidth > el.clientWidth + 4 && el.clientWidth > 0 && (el.textContent || "").trim()) clipped.push(sel(el));
    });
    out.clippedText = clipped;

    var text = (doc.body.innerText || "").replace(/\s+/g, " ").trim();
    out.textLength = text.length;
    out.sections = doc.querySelectorAll("section, article, .section").length;
    out.hasNav = !!doc.querySelector("nav, header a");
    out.hasFooter = !!doc.querySelector("footer");
    out.images = doc.querySelectorAll("img, svg, canvas, picture, video").length;
    var tiny = 0;
    Array.prototype.forEach.call(doc.body.querySelectorAll("p,li,a,span,td,label"), function (el) {
      var own = ""; for (var k = 0; k < el.childNodes.length; k++) if (el.childNodes[k].nodeType === 3) own += el.childNodes[k].nodeValue;
      if (own.trim().length > 3 && visible(el) && parseFloat(getComputedStyle(el).fontSize) < 12) tiny++;
    });
    out.tinyText = tiny;
    out.contrast = contrastChecks();
    var hs = Array.prototype.map.call(doc.querySelectorAll("h1,h2,h3"), function (h) { return h.tagName.toLowerCase() + ": " + (h.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60); });
    out.headings = hs.slice(0, 14);
    out.viewport = { w: vw, h: window.innerHeight };
    out.docHeight = Math.max(doc.documentElement.scrollHeight, doc.body.scrollHeight);
    out.errors = Z.errors.filter(function (e) { return e.page === Z.page && e.kind !== "nav"; }).slice(0, 12).map(function (e) { return { kind: e.kind, value: e.value }; });

    var blocking = out.errors.length || out.brokenLocalLinks.length || out.missingLocalAssets.length || out.horizontalOverflow || out.textLength < 120 || out.contrast.lowCount > 2;
    out.ok = !blocking;
    return out;
  }

  /* --------------------------------------------------------------- smoke */
  function runSmoke() {
    var restore = { a: window.alert, c: window.confirm, p: window.prompt };
    window.alert = function () {}; window.confirm = function () { return true; }; window.prompt = function () { return ""; };
    var errBefore = Z.errors.length;
    var cands = Array.prototype.slice.call(document.querySelectorAll('button:not([type=submit]):not([disabled]), [role=button], input[type=button], a[href="#"]:not([data-zeros-route]), summary, [onclick]')).filter(visible).slice(0, 14);
    var res = { tested: 0, dead: [], newErrors: [] };
    return cands.reduce(function (chain, el) {
      return chain.then(function () {
        var mutated = 0, y0 = window.scrollY, nav0 = Z.navCount;
        var mo = new MutationObserver(function (l) { mutated += l.length; });
        mo.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
        try { el.click(); } catch (e) {}
        return sleep(140).then(function () {
          mo.disconnect();
          res.tested++;
          if (!mutated && window.scrollY === y0 && Z.navCount === nav0) res.dead.push(sel(el));
        });
      });
    }, Promise.resolve()).then(function () {
      window.alert = restore.a; window.confirm = restore.c; window.prompt = restore.p;
      res.newErrors = Z.errors.slice(errBefore).map(function (e) { return e.kind + ": " + e.value; }).slice(0, 8);
      return res;
    });
  }

  /* ------------------------------------------------------------- capture */
  var PROPS = ("display,position,top,right,bottom,left,z-index,float,clear,box-sizing,width,height,min-width,min-height,max-width,max-height," +
    "margin-top,margin-right,margin-bottom,margin-left,padding-top,padding-right,padding-bottom,padding-left," +
    "border-top-width,border-right-width,border-bottom-width,border-left-width,border-top-style,border-right-style,border-bottom-style,border-left-style," +
    "border-top-color,border-right-color,border-bottom-color,border-left-color,border-top-left-radius,border-top-right-radius,border-bottom-right-radius,border-bottom-left-radius," +
    "background-color,background-image,background-size,background-position,background-repeat,background-clip,background-origin,background-blend-mode," +
    "color,font-family,font-size,font-weight,font-style,font-variant,font-stretch,line-height,letter-spacing,word-spacing,text-align,text-decoration-line,text-decoration-color,text-decoration-style,text-transform,text-indent,text-shadow,text-overflow,white-space,word-break,overflow-wrap,vertical-align,writing-mode,direction," +
    "flex-direction,flex-wrap,flex-grow,flex-shrink,flex-basis,justify-content,align-items,align-content,align-self,order,gap,row-gap,column-gap,justify-items,justify-self," +
    "grid-template-columns,grid-template-rows,grid-column-start,grid-column-end,grid-row-start,grid-row-end,grid-auto-flow,grid-auto-columns,grid-auto-rows," +
    "overflow-x,overflow-y,opacity,visibility,transform,transform-origin,filter,backdrop-filter,mix-blend-mode,box-shadow,outline-width,outline-style,outline-color,outline-offset,clip-path,mask-image,object-fit,object-position,aspect-ratio,list-style-type,list-style-position,columns,column-count,column-gap,table-layout,border-collapse,border-spacing,caret-color,accent-color," +
    "fill,stroke,stroke-width,stroke-linecap,stroke-linejoin,stroke-dasharray,stroke-dashoffset,fill-opacity,stroke-opacity,fill-rule,stop-color,stop-opacity").split(",");

  function styleText(cs) {
    var t = "";
    for (var i = 0; i < PROPS.length; i++) {
      var v = cs.getPropertyValue(PROPS[i]);
      if (v) t += PROPS[i] + ":" + v + ";";
    }
    return t;
  }
  function blobToDataUrl(b) { return new Promise(function (res) { var fr = new FileReader(); fr.onload = function () { res(fr.result); }; fr.onerror = function () { res(null); }; fr.readAsDataURL(b); }); }
  function fetchDataUrl(url) {
    return Promise.race([fetch(url, { mode: "cors" }).then(function (r) { return r.ok ? r.blob() : null; }).then(function (b) { return b ? blobToDataUrl(b) : null; }), sleep(2500).then(function () { return null; })]).catch(function () { return null; });
  }
  function imgToDataUrl(img) {
    var src = img.currentSrc || img.src || "";
    if (!src) return Promise.resolve(null);
    if (src.indexOf("data:") === 0) return Promise.resolve(src);
    try {
      var c = document.createElement("canvas");
      c.width = img.naturalWidth || 1; c.height = img.naturalHeight || 1;
      c.getContext("2d").drawImage(img, 0, 0);
      return Promise.resolve(c.toDataURL("image/png"));
    } catch (e) { return fetchDataUrl(src); }
  }
  function collectFontCss() {
    var faces = [];
    try { document.fonts.forEach(function (f) { if (f.status === "loaded") faces.push(f); }); } catch (e) {}
    if (!faces.length) return Promise.resolve("");
    function sameFace(block) {
      var fam = (block.match(/font-family:\s*([^;]+);/) || [])[1];
      var wt = (block.match(/font-weight:\s*([^;]+);/) || [])[1];
      var stl = (block.match(/font-style:\s*([^;]+);/) || [])[1] || "normal";
      var ur = (block.match(/unicode-range:\s*([^;]+);/) || [])[1] || "";
      if (!fam) return false;
      fam = fam.replace(/["']/g, "").trim(); wt = (wt || "400").trim();
      return faces.some(function (f) {
        return f.family.replace(/["']/g, "") === fam && String(f.weight) === wt && f.style === stl.trim() && (!ur || (f.unicodeRange || "").replace(/\s/g, "") === ur.replace(/\s/g, ""));
      });
    }
    var sources = [];
    Array.prototype.forEach.call(document.querySelectorAll("style"), function (s) { sources.push(Promise.resolve(s.textContent || "")); });
    Array.prototype.forEach.call(document.querySelectorAll('link[rel=stylesheet][href^="http"]'), function (l) {
      sources.push(Promise.race([fetch(l.href, { mode: "cors" }).then(function (r) { return r.ok ? r.text() : ""; }), sleep(2500).then(function () { return ""; })]).catch(function () { return ""; }));
    });
    return Promise.all(sources).then(function (texts) {
      var blocks = [];
      texts.forEach(function (t) { (t.match(/@font-face\s*\{[^}]*\}/g) || []).forEach(function (b) { if (sameFace(b)) blocks.push(b); }); });
      blocks = blocks.slice(0, 10);
      return Promise.all(blocks.map(function (b) {
        var m = b.match(/url\(["']?([^)"']+)["']?\)/);
        if (!m || m[1].indexOf("data:") === 0) return Promise.resolve(b);
        return fetchDataUrl(m[1]).then(function (d) { return d ? b.replace(m[0], "url(" + d + ")") : ""; });
      }));
    }).then(function (arr) { return arr.filter(Boolean).join("\n"); }).catch(function () { return ""; });
  }

  function buildClone() {
    var liveRoot = document.body;
    var clone = liveRoot.cloneNode(true);
    var pseudoCss = "", pid = 0;
    var jobs = [];
    var liveAll = [liveRoot].concat(Array.prototype.slice.call(liveRoot.querySelectorAll("*")));
    var cloneAll = [clone].concat(Array.prototype.slice.call(clone.querySelectorAll("*")));
    var drop = [];
    for (var i = 0; i < liveAll.length; i++) {
      var live = liveAll[i], c = cloneAll[i];
      if (!c) continue;
      var tag = live.tagName.toLowerCase();
      if (tag === "script" || tag === "noscript" || tag === "style" || tag === "link" || tag === "template" || tag === "meta" || tag === "iframe" || tag === "object" || tag === "embed" || tag === "audio" || (live.id === "zeros-toast")) { drop.push(c); continue; }
      var cs = getComputedStyle(live);
      c.setAttribute("style", styleText(cs));
      if (cs.position === "fixed" || cs.position === "sticky") c.setAttribute("class", ((c.getAttribute("class") || "") + " zfix").trim());
      ["::before", "::after"].forEach(function (pe) {
        var ps = getComputedStyle(live, pe), content = ps.getPropertyValue("content");
        if (content && content !== "none" && content !== "normal") {
          var cls = "zc" + (pid++);
          c.setAttribute("class", ((c.getAttribute("class") || "") + " " + cls).trim());
          pseudoCss += "." + cls + pe + "{" + styleText(ps) + "content:" + content + ";}\n";
        }
      });
      if (tag === "img") {
        jobs.push(imgToDataUrl(live).then(function (d) {
          if (d) { c.setAttribute("src", d); c.removeAttribute("srcset"); c.removeAttribute("sizes"); }
          else { c.removeAttribute("src"); c.setAttribute("style", (c.getAttribute("style") || "") + "background:rgba(128,128,128,.25);"); }
        }));
      } else if (tag === "canvas") {
        try {
          var im = document.createElement("img");
          im.setAttribute("src", live.toDataURL("image/png"));
          im.setAttribute("style", c.getAttribute("style") || "");
          c.parentNode.replaceChild(im, c);
        } catch (e) { /* tainted canvas: leave blank */ }
      } else if (tag === "input") {
        if (live.type === "checkbox" || live.type === "radio") { if (live.checked) c.setAttribute("checked", "checked"); else c.removeAttribute("checked"); }
        else c.setAttribute("value", live.value || "");
      } else if (tag === "textarea") { c.textContent = live.value || ""; }
      else if (tag === "video") { c.removeAttribute("src"); c.removeAttribute("autoplay"); }
    }
    drop.forEach(function (d) { if (d.parentNode) d.parentNode.removeChild(d); });
    Array.prototype.forEach.call(clone.querySelectorAll("*"), function (n) {
      Array.prototype.slice.call(n.attributes).forEach(function (a) {
        if (!/^[A-Za-z_][\w.\-]*$/.test(a.name) || /^on/i.test(a.name) || /^data-/.test(a.name) || a.name === "contenteditable") n.removeAttribute(a.name);
      });
    });
    return Promise.all(jobs).then(function () { return { clone: clone, pseudoCss: pseudoCss }; });
  }

  function svgFor(cloneHtml, css, vw, vh, offset, bg) {
    var style = "<style>" + (css + (offset > 0 ? "\n.zfix{visibility:hidden !important}" : "")).replace(/</g, "&lt;") + "</style>";
    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + vw + '" height="' + vh + '"><foreignObject x="0" y="0" width="' + vw + '" height="' + vh + '">' +
      '<div xmlns="http://www.w3.org/1999/xhtml" style="width:' + vw + "px;height:" + vh + "px;overflow:hidden;position:relative;background:" + bg + '">' +
      style + '<div style="position:absolute;left:0;top:' + (-offset) + "px;width:" + vw + 'px">' + cloneHtml + "</div></div></foreignObject></svg>";
  }
  function loadImage(url) {
    return new Promise(function (res, rej) { var i = new Image(); i.onload = function () { res(i); }; i.onerror = function () { rej(new Error("svg render failed")); }; i.src = url; });
  }

  function settle() {
    try { document.getAnimations().forEach(function (a) { try { a.finish(); } catch (e) { try { a.cancel(); } catch (e2) {} } }); } catch (e) {}
    return sleep(80);
  }

  function capture(opts) {
    opts = opts || {};
    return settle().then(function () { return captureNow(opts); });
  }

  function captureNow(opts) {
    var vw = window.innerWidth, vh = window.innerHeight;
    var docH = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight, vh);
    var slices = Math.max(1, Math.min(opts.slices || 3, Math.ceil(docH / vh)));
    var outW = Math.min(opts.maxWidth || 1000, vw), scale = outW / vw;
    var hcs = getComputedStyle(document.documentElement), bcs = getComputedStyle(document.body);
    var bgc = toRgba(bcs.backgroundColor);
    var bg = (bgc && bgc.a > 0.05) ? bcs.backgroundColor : (toRgba(hcs.backgroundColor) && toRgba(hcs.backgroundColor).a > 0.05 ? hcs.backgroundColor : "#ffffff");
    return Promise.all([buildClone(), collectFontCss()]).then(function (r) {
      var built = r[0], fonts = r[1];
      var xml = new XMLSerializer().serializeToString(built.clone).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
      var css = fonts + "\n" + built.pseudoCss + "\n*{animation:none !important;transition:none !important;caret-color:transparent}";
      var canvas = document.createElement("canvas");
      canvas.width = Math.round(vw * scale); canvas.height = Math.round(Math.min(docH, vh * slices) * scale);
      var ctx = canvas.getContext("2d");
      ctx.fillStyle = bg; ctx.fillRect(0, 0, canvas.width, canvas.height);
      var chain = Promise.resolve();
      for (var s = 0; s < slices; s++) (function (k) {
        chain = chain.then(function () {
          var svg = svgFor(xml, css, vw, vh, k * vh, bg);
          // data: URL (not blob:) so Chromium does not treat the SVG as cross-origin and taint the canvas.
          var url = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
          return loadImage(url).then(function (img) {
            ctx.drawImage(img, 0, Math.round(k * vh * scale), canvas.width, Math.round(vh * scale));
          });
        });
      })(s);
      return chain.then(function () {
        return { dataUrl: canvas.toDataURL("image/jpeg", opts.quality || 0.78), width: canvas.width, height: canvas.height, slices: slices, docHeight: docH };
      });
    });
  }
  Z.capture = capture;

  /* ------------------------------------------------------- host messages */
  internal(function () {
    window.addEventListener("message", function (event) {
      var m = event.data;
      if (!m || m.source !== "zeros-preview-host") return;
      var id = m.id;
      if (m.type === "verify") {
        try { var rep = runVerify(); rep.id = id; send("verification", rep); } catch (e) { send("verification", { id: id, ok: false, page: Z.page, errors: [{ kind: "error", value: "verify failed: " + e.message }], missing: [], brokenLocalLinks: [], missingLocalAssets: [], nonFunctionalButtons: [] }); }
      } else if (m.type === "smoke") {
        runSmoke().then(function (r) { r.id = id; send("smoke", r); }).catch(function (e) { send("smoke", { id: id, tested: 0, dead: [], newErrors: [String(e.message)] }); });
      } else if (m.type === "screenshot") {
        capture(m.opts).then(function (r) { r.id = id; send("screenshot", r); }).catch(function (e) { send("screenshot", { id: id, dataUrl: "", error: String(e && e.message || e) }); });
      } else if (m.type === "ping") { send("runtime", { kind: "pong", value: Z.page }); }
    });
  });

  function announce() {
    var ready = (document.fonts && document.fonts.ready) ? Promise.race([document.fonts.ready, sleep(1800)]) : Promise.resolve();
    ready.then(function () {
      if (D.anchor) { var t = document.getElementById(D.anchor); if (t) t.scrollIntoView(); }
      send("page", { path: Z.page }); send("runtime", { kind: "loaded", value: Z.page });
    });
  }
  if (document.readyState === "complete") announce(); else window.addEventListener("load", announce);
})();
`;
