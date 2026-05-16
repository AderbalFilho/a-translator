// ==UserScript==
// @name         A-Translator
// @namespace    https://github.com/BriocheMasquee
// @version      1.5.0
// @description  Unofficial Alchemy VTT UI translator (dictionary-based)
// @author       Brioche Masquée
// @match        https://app.alchemyrpg.com/*
// @run-at       document-end
// @grant        none
// @homepageURL  https://github.com/BriocheMasquee/a-translator
// @supportURL   https://github.com/BriocheMasquee/a-translator/issues
// @downloadURL  https://raw.githubusercontent.com/BriocheMasquee/a-translator/main/userscript/a-translator.user.js
// @updateURL    https://raw.githubusercontent.com/BriocheMasquee/a-translator/main/userscript/a-translator.user.js
// @license      MIT
// ==/UserScript==

(() => {
  "use strict";

  const SCRIPT_VERSION =
    (typeof GM_info !== "undefined" && GM_info?.script?.version) ||
    (typeof GM !== "undefined" && GM?.info?.script?.version) ||
    "dev";

  // =========================
  // SETTINGS
  // =========================
  const KEY_DICT = "__alchemy_translate_dict__";
  const KEY_ENABLED = "__alchemy_translate_enabled__";
  const KEY_DICT_META = "__alchemy_translate_dict_meta__";
  const KEY_META_LEGACY = "__alchemy_translate_meta__";
  const KEY_USER_TEXTS = "__alchemy_translate_user_texts__";

  const GITHUB_DICTIONARIES_MANIFEST_URLS = [
    "https://raw.githubusercontent.com/BriocheMasquee/a-translator/main/dictionaries/manifest.json",
    "https://raw.githubusercontent.com/BriocheMasquee/a-translator/main/manifest.json"
  ];

  const GITHUB_DICTIONARIES_API_URL =
    "https://api.github.com/repos/BriocheMasquee/a-translator/contents/dictionaries?ref=main";

  // =========================
  // CORE
  // =========================
  const core =
    window.__AlchemyTranslateCore__ ||
    (window.__AlchemyTranslateCore__ = {
      dict: new Map(),
      userTexts: new Set(),
      userTextsMax: 2000,
      recentUserValuesByScopeKey: new Map(),
      recentUserValuesTTLms: 10 * 60 * 1000,
      enabled: true,

      textOrig: new WeakMap(),
      touchedText: new Set(),
      touchedEls: new Set(),
      mutatingText: new WeakSet(),
      lastSetText: new WeakMap(),

      obs: null,
      isApplying: false,
      applyScheduled: false,

      loadEnabledFromStorage() {
        try {
          const v = localStorage.getItem(KEY_ENABLED);
          if (v === null) {
            this.enabled = true;
            return this.enabled;
          }
          this.enabled = v === "1" || v === "true";
        } catch (_) {
          this.enabled = true;
        }
        return this.enabled;
      },

      saveEnabledToStorage() {
        try {
          localStorage.setItem(KEY_ENABLED, this.enabled ? "1" : "0");
        } catch (_) {}
      },

      setEnabled(v) {
        const next = !!v;
        if (next === this.enabled) return this.enabled;
        if (next) this.enable();
        else this.disable();
        return this.enabled;
      },

      disable() {
        this.enabled = false;
        this.saveEnabledToStorage();

        try {
          this.obs?.disconnect();
        } catch (_) {}
        this.obs = null;

        this.isApplying = true;
        try {
          for (const t of this.touchedText) this.restoreTextNode(t);
          for (const el of this.touchedEls) this.restoreAttributes(el);
        } finally {
          this.isApplying = false;
        }
      },

      enable() {
        this.enabled = true;
        this.saveEnabledToStorage();

        this.loadDictFromStorage();
        this.ensureObserver();

        if (this.dict.size > 0 && document.body) {
          setTimeout(() => {
            if (!this.enabled) return;
            this.scanTranslate(document.body);
          }, 0);
        } else {
          this.scheduleApplyTouched();
        }
      },

      loadDictFromStorage() {
        let userDict = {};
        try {
          userDict = JSON.parse(localStorage.getItem(KEY_DICT) || "{}");
        } catch (_) {
          userDict = {};
        }

        const next = new Map();
        for (const [k, v] of Object.entries(userDict)) {
          if (!k || !v) continue;
          next.set(String(k).trim().toLowerCase(), String(v));
        }
        this.dict = next;
        return next.size;
      },

      loadUserTextsFromStorage() {
        try {
          const raw = JSON.parse(localStorage.getItem(KEY_USER_TEXTS) || "[]");
          const next = [];

          if (Array.isArray(raw)) {
           for (const s of raw) {
              if (typeof s !== "string") continue;
              const k = this._normUserText(s);
              if (!k) continue;
              if (k.length > 200) continue;
             next.push(k);
           }
         }

          if (next.length > this.userTextsMax) {
            next.splice(0, next.length - this.userTextsMax);
          }

          this.userTexts = new Set(next);
       } catch (_) {
          this.userTexts = new Set();
        }
        return this.userTexts.size;
      },

      saveUserTextsToStorage() {
       try {
         const arr = Array.from(this.userTexts);
         if (arr.length > this.userTextsMax) {
           arr.splice(0, arr.length - this.userTextsMax);
         }
          localStorage.setItem(KEY_USER_TEXTS, JSON.stringify(arr));
        } catch (_) {}
      },

      _normUserText(s) {
        return String(s || "")
         .replace(/\u00A0/g, " ")
          .replace(/[\u200B-\u200D\uFEFF]/g, "")
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase();
      },

      rememberUserText(value) {
        const key = this._normUserText(value);
        if (!key) return false;

        if (key.length > 200) return false;
        if (!/[a-zàâçéèêëîïôûùüÿñæœ]/i.test(key)) return false;

        if (!this.userTexts.has(key)) {
          this.userTexts.add(key);

          if (this.userTexts.size > this.userTextsMax) {
            const arr = Array.from(this.userTexts);
            const keep = arr.slice(Math.max(0, arr.length - this.userTextsMax));
            this.userTexts = new Set(keep);
         }

          this.saveUserTextsToStorage();
        }

        return true;
      },

      translateString(s) {
        const trimmed = s.trim();
        if (!trimmed) return null;
        const key = trimmed.toLowerCase();
        const t = this.dict.get(key);
        return t ? s.replace(trimmed, t) : null;
      },

      setText(node, value) {
        if (node.nodeValue === value) return;
        this.lastSetText.set(node, value);
        this.mutatingText.add(node);
        node.nodeValue = value;
        queueMicrotask(() => this.mutatingText.delete(node));
      },

      _isInEditableText(nodeOrEl) {
        const el = nodeOrEl?.nodeType === 1 ? nodeOrEl : nodeOrEl?.parentElement;
        if (!el || !el.closest) return false;

        return !!el.closest("textarea, [contenteditable], [role='textbox']");
      },

      _getScopeKey(el) {
        const dlg = el.closest?.('[role="dialog"]');
        if (dlg) {
         const title =
            dlg.getAttribute("aria-label") ||
           dlg.querySelector?.("h1,h2,[data-testid*='title'],[data-id*='title']")?.textContent ||
            "";
         return "dlg:" + location.pathname + ":" + String(title).trim().toLowerCase();
       }
       return "page:" + location.pathname;
      },

      _harvestFieldValues(el, scopeKey) {
       const root = el.closest?.('[role="dialog"]') || document.body;

        let bucket = this.recentUserValuesByScopeKey.get(scopeKey);
        if (!bucket) {
          bucket = new Map();
          this.recentUserValuesByScopeKey.set(scopeKey, bucket);
        }

        const fields = root.querySelectorAll?.("input, textarea") || [];
        for (const f of fields) {
        if (f.tagName === "INPUT") {
            const type = (f.getAttribute("type") || "text").toLowerCase();
              if (type && !["text", "search", "email", "url", "tel", "password"].includes(type)) continue;
            }

          const v = String(f.value || "").trim();
          if (!v) continue;
          if (v.length > 200) continue;

          bucket.set(v.toLowerCase(), Date.now() + this.recentUserValuesTTLms);
        }
      },

      _isRecentUserValue(node) {
        const el = node?.parentElement;
        if (!el) return false;

        const raw = (node.nodeValue || "").trim();
        if (!raw) return false;
        if (raw.length > 200) return false;

        const key = this._getScopeKey(el);
        this._harvestFieldValues(el, key);

        const bucket = this.recentUserValuesByScopeKey.get(key);
        if (!bucket) return false;

        const k = raw.toLowerCase();
        const exp = bucket.get(k);
        if (!exp) return false;

        if (Date.now() > exp) {
          bucket.delete(k);
          return false;
        }
        return true;
      },

      _isInChatUserMessage(nodeOrEl) {
       const el = nodeOrEl?.nodeType === 1 ? nodeOrEl : nodeOrEl?.parentElement;
        if (!el || !el.closest) return false;
        if (!el.closest('[data-testid="virtuoso-item-list"]')) return false;
        const row = el.closest('div[style*="flex-direction: row"][style*="padding-left: 6px"]');
        if (!row) return false;
        if (row.querySelector("img")) return false;
        const txt = (row.textContent || "").toLowerCase();
        if (/\b\d+\s*d\s*\d+\b/.test(txt)) return false;
        if (txt.includes("dice roll") || txt.includes("reroll")) return false;
        return true;
      },

      _isInNotesItem(nodeOrEl) {
        const el = nodeOrEl?.nodeType === 1 ? nodeOrEl : nodeOrEl?.parentElement;
        if (!el || !el.closest) return false;
        const item = el.closest('div[aria-expanded="false"]');
        if (!item) return false;
        for (let cur = item; cur && cur !== document.documentElement; cur = cur.parentElement) {
          if (!cur.querySelector) continue;

          const hasNotesTextarea = !!cur.querySelector(
            'textarea[data-at-orig-placeholder="Entry"], textarea[placeholder="Écrire"]'
          );
          if (hasNotesTextarea) return true;
          if (cur.matches && cur.matches('div[data-id="tab-view-page"]')) break;
        }
        return false;
      },

      translateTextNode(node, updateOrig = false) {
        const raw = node.nodeValue;
       if (raw == null) return;

        if (
         this._isInEditableText(node) ||
          this._isInChatUserMessage(node) ||
          this._isInNotesItem(node) ||
          this._isRecentUserValue(node)
       ) {
          if (this.textOrig.has(node)) this.restoreTextNode(node);
         return;
        }

        if (!this.textOrig.has(node)) {
          this.textOrig.set(node, raw);
          this.touchedText.add(node);
        }

        if (updateOrig) {
          this.textOrig.set(node, raw);
          this.touchedText.add(node);
       }

        const original = this.textOrig.get(node) ?? raw;

        const norm = this._normUserText(original);
        if (norm && this.userTexts.has(norm)) {
          this.setText(node, original);
          return;
        }
        const replaced = this.translateString(original);

        if (replaced) this.setText(node, replaced);
        else this.setText(node, original);
      },

      restoreTextNode(node) {
        const original = this.textOrig.get(node);
        if (original != null) this.setText(node, original);
      },

      _attrKey(attr) {
        const camel = attr.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        return "atOrig" + camel[0].toUpperCase() + camel.slice(1);
      },

      translateAttributes(el) {
        for (const a of ["title", "aria-label", "placeholder"]) {
          const v = el.getAttribute?.(a);
          if (!v) continue;

          const dk = this._attrKey(a);
          if (!el.dataset[dk]) {
            el.dataset[dk] = v;
            this.touchedEls.add(el);
          }

          const original = el.dataset[dk] || v;
          const replaced = this.translateString(original);
          const target = replaced ? replaced.trim() : original;

          if (el.getAttribute(a) !== target) el.setAttribute(a, target);
        }
      },

      restoreAttributes(el) {
        for (const a of ["title", "aria-label", "placeholder"]) {
          const dk = this._attrKey(a);
          const original = el.dataset?.[dk];
          if (original != null && el.getAttribute?.(a) !== original) {
            el.setAttribute?.(a, original);
          }
        }
      },

      scanTranslate(root) {
        if (!this.enabled) return;
        if (!root) return;

        if (root.nodeType === 1) this.translateAttributes(root);
        root.querySelectorAll?.("*").forEach((el) => this.translateAttributes(el));

        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let n;
        while ((n = walker.nextNode())) this.translateTextNode(n);
      },

      applyTouched() {
        if (!document.body) return;

        this.isApplying = true;
        try {
          for (const t of this.touchedText) this.restoreTextNode(t);
          for (const el of this.touchedEls) this.restoreAttributes(el);

          if (this.enabled && this.dict.size > 0) {
            for (const t of this.touchedText) this.translateTextNode(t);
            for (const el of this.touchedEls) this.translateAttributes(el);
          }
        } finally {
          this.isApplying = false;
        }
      },

      scheduleApplyTouched() {
        if (this.applyScheduled) return;
        this.applyScheduled = true;

        setTimeout(() => {
          this.applyScheduled = false;
          this.applyTouched();
        }, 0);
      },

      ensureObserver() {
        if (!this.enabled) return;
        if (this.obs || !document.body) return;

        this.obs = new MutationObserver((mutations) => {
          if (!this.enabled) return;
          if (this.isApplying) return;
          if (this.dict.size === 0) return;

          for (const m of mutations) {
            if (m.type === "characterData") {
              const t = m.target;

              if (this.mutatingText.has(t)) {
               const last = this.lastSetText.get(t);
               if (last != null && t.nodeValue === last) continue;
              }

              this.translateTextNode(t, true);

              const p = t.parentElement;
              if (p) this.scanTranslate(p);
            } else if (m.type === "childList") {
              for (const node of m.addedNodes) this.scanTranslate(node);
            }
          }
        });

        this.obs.observe(document.body, {
          subtree: true,
          childList: true,
          characterData: true
        });
      }
    });

  core.loadDictFromStorage();
  core.loadEnabledFromStorage();
  core.loadUserTextsFromStorage();

  function installRecentUserValueTracker() {
    const track = (e) => {
      if (!core || !core.enabled) return;
      const t = e.target;
      if (!t || !t.matches) return;
      if (!t.matches("input, textarea, [contenteditable], [role='textbox']")) return;

      let v = "";
      if (typeof t.value === "string") v = t.value;
      else v = t.textContent || "";

      v  = String(v || "").trim();
      if (!v) return;
      if (v.length > 200) return;

      core.rememberUserText(v);

      const scopeKey = core._getScopeKey(t);

      let bucket = core.recentUserValuesByScopeKey.get(scopeKey);
      if (!bucket) {
        bucket = new Map();
        core.recentUserValuesByScopeKey.set(scopeKey, bucket);
      }

      bucket.set(v.toLowerCase(), Date.now() + core.recentUserValuesTTLms);
    };

    document.addEventListener("input", track, true);
    document.addEventListener("change", track, true);
    document.addEventListener("blur", track, true);
    document.addEventListener("compositionend", track, true);
  }

  installRecentUserValueTracker();

  function startCore() {
    if (!core.enabled) return;
    core.ensureObserver();
    if (core.dict.size > 0) core.scanTranslate(document.body);
  }

  if (document.body) startCore();
  else window.addEventListener("DOMContentLoaded", startCore, { once: true });

  // =========================
  // UI / TOOLS
  // =========================
  document.getElementById("alchemy-translate-buttons")?.remove();
  document.getElementById("alchemy-translate-editor")?.remove();

  const css = (...parts) => parts.join("");

  function makePillButton(label, baseCssParts = []) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;

    b.style.cssText = css(
      "padding:6px 14px;",
      "border-radius:999px;",
      "border:1px solid rgba(255,255,255,.18);",
      "cursor:pointer;",
      "font-size:12px;",
      "width:auto;",
      "white-space:nowrap;",
      "display:inline-flex;",
      "justify-content:center;",
      "align-items:center;",
      ...baseCssParts
    );
    return b;
  }

  function hoverBg(el, baseBg, hoverBg2) {
    el.style.background = baseBg;
    el.addEventListener("mouseenter", () => (el.style.background = hoverBg2));
    el.addEventListener("mouseleave", () => (el.style.background = baseBg));
    el.addEventListener("focus", () => (el.style.background = hoverBg2));
    el.addEventListener("blur", () => (el.style.background = baseBg));
  }

  function attachTooltip(target, text, position = "top") {
    const tip = document.createElement("div");
    tip.textContent = text;

    tip.style.cssText = css(
      "position:absolute;",
      "padding:6px 8px;",
      "border-radius:10px;",
      "background:rgba(18,18,20,.92);",
      "border:1px solid rgba(255,255,255,.12);",
      "color:rgba(255,255,255,.92);",
      "font:12px/1.2 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;",
      "white-space:nowrap;",
      "box-shadow:0 10px 30px rgba(0,0,0,.45);",
      "backdrop-filter: blur(8px);",
      "pointer-events:none;",
      "opacity:0;",
      "visibility:hidden;",
      "transition:opacity .12s ease, transform .12s ease;",
      "z-index:2147483647;"
    );

    if (position === "top") {
      tip.style.left = "50%";
      tip.style.bottom = "calc(100% + 8px)";
      tip.style.transform = "translateX(-50%) translateY(2px)";
    } else if (position === "right") {
      tip.style.left = "calc(100% + 8px)";
      tip.style.top = "50%";
      tip.style.transform = "translateY(-50%) translateX(-2px)";
    }

    const show = () => {
      tip.style.visibility = "visible";
      tip.style.opacity = "1";
      tip.style.transform =
        position === "top"
          ? "translateX(-50%) translateY(0)"
          : "translateY(-50%) translateX(0)";
    };

    const hide = () => {
      tip.style.opacity = "0";
      tip.style.visibility = "hidden";
    };

    const computed = window.getComputedStyle(target).position;
    if (computed === "static") target.style.position = "relative";

    target.appendChild(tip);

    target.addEventListener("mouseenter", show);
    target.addEventListener("mouseleave", hide);
    target.addEventListener("focus", show);
    target.addEventListener("blur", hide);
  }

  function loadDictionary() {
    try {
      return JSON.parse(localStorage.getItem(KEY_DICT) || "{}");
    } catch (_) {
      return {};
    }
  }

  function saveDictionary(obj) {
    localStorage.setItem(KEY_DICT, JSON.stringify(obj || {}));
  }

  function loadMeta() {
  try {
    const old = localStorage.getItem(KEY_META_LEGACY);
    const cur = localStorage.getItem(KEY_DICT_META);

    if (old && !cur) {
      localStorage.setItem(KEY_DICT_META, old);
      localStorage.removeItem(KEY_META_LEGACY);
    }

    const raw = JSON.parse(localStorage.getItem(KEY_DICT_META) || "{}");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    return raw;
  } catch (_) {
    return {};
  }
}

  function saveMeta(meta) {
  try {
    localStorage.setItem(KEY_DICT_META, JSON.stringify(meta || {}));
  } catch (_) {}
}

  function loadEnabledFlag() {
    try {
      const v = localStorage.getItem(KEY_ENABLED);
      if (v === null) return true;
      return v === "1" || v === "true";
    } catch (_) {
      return true;
    }
  }

  function applyTranslations() {
    core.loadDictFromStorage();
    core.loadEnabledFromStorage();
    core.scheduleApplyTouched();
  }

  function toggleCore(on) {
    core.setEnabled(!!on);
  }

  function exportDict() {
  const entries = loadDictionary();
  const meta = loadMeta();

  const lang = String(meta.lang || "und").trim().toLowerCase();
  const dictVersion = String(meta.dictVersion || "0").trim();

  const payload = {
    meta: {
      lang,
      dictVersion,
      scriptVersion: SCRIPT_VERSION,
      exportedAt: new Date().toISOString()
    },
    entries
  };

  const json = JSON.stringify(payload, null, 2);

  // Nom de fichier : langue + version du dictionnaire
  const safeLang = lang.replace(/[^a-z0-9-]/g, "") || "undefined";
  const safeVer = dictVersion.replace(/[^0-9A-Za-z._-]/g, "") || "0";
  const filename = `${safeLang}-dict-v${safeVer}.json`;

  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();

  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

  function importDictFromJsonText(jsonText, mode = "replace") {
    mode = mode === "merge" ? "merge" : "replace";

    let data;
    try {
      data = JSON.parse(String(jsonText || "").trim());
    } catch (e) {
      console.error("[A-Translator] Import: invalid JSON", e);
      return { ok: false, error: "Invalid JSON" };
    }

    let importedMeta = null;
    if (data && typeof data === "object" && !Array.isArray(data) && data.entries && typeof data.entries === "object") {
      importedMeta = (data.meta && typeof data.meta === "object") ? data.meta : null;
      data = data.entries;
    }

    if (!data || typeof data !== "object" || Array.isArray(data)) {
      console.error("[A-Translator] Import: JSON must be an object");
      return { ok: false, error: "JSON must be an object" };
    }

    const cleaned = {};
    for (const [k, v] of Object.entries(data)) {
      const src = String(k || "").trim().toLowerCase();
      const dst = String(v || "").trim();
      if (!src || !dst) continue;
      cleaned[src] = dst;
    }

    const current = loadDictionary();

    let addedCount = 0;
    if (mode === "merge") {
      for (const k of Object.keys(cleaned)) {
        if (!Object.prototype.hasOwnProperty.call(current, k)) addedCount++;
      }
    } else {
      addedCount = Object.keys(cleaned).length;
    }

    const next = mode === "merge" ? { ...current, ...cleaned } : cleaned;

    if (importedMeta) {
      const prev = loadMeta();

      const lang = String(importedMeta.lang || prev.lang || "und").trim().toLowerCase();
      const dictVersion = String(importedMeta.dictVersion || prev.dictVersion || "0").trim();

      saveMeta({
        ...prev,
        lang,
        dictVersion
      });
    }

    saveDictionary(next);
    applyTranslations();

    console.log("[A-Translator] Import OK:", addedCount, "added entries (mode:", mode + ")");
    return { ok: true, count: addedCount, mode };
  }

  async function importDictFromGithubUrl(url, sourceInfo = null) {
    const candidates = [String(url || "").trim()].filter(Boolean);

    const version = String(sourceInfo?.dictVersion || "").trim();
    if (version && url) {
      const versionedUrl = String(url).replace(/-v[^/]*\.json$/i, "-v" + version + ".json");
      if (versionedUrl && !candidates.includes(versionedUrl)) candidates.push(versionedUrl);
    }

    let response = null;
    let usedUrl = "";
    let lastStatus = "";

    for (const candidate of candidates) {
      response = await fetch(candidate, { cache: "no-store" });
      usedUrl = candidate;

      if (response.ok) break;
      lastStatus = String(response.status);
      response = null;
    }

    if (!response || !response.ok) {
      throw new Error("GitHub import failed: HTTP " + (lastStatus || "unknown") + " — " + candidates.join(" | "));
    }

    const text = await response.text();
    const result = importDictFromJsonText(text, "replace");

    if (result && result.ok !== false && sourceInfo) {
      const previousMeta = loadMeta();
      saveMeta({
        ...previousMeta,
        id: sourceInfo.id || previousMeta.id || "",
        name: sourceInfo.name || sourceInfo.label || previousMeta.name || "",
        lang: sourceInfo.lang || previousMeta.lang || "und",
        dictVersion: sourceInfo.dictVersion || previousMeta.dictVersion || "0",
        description: sourceInfo.description || previousMeta.description || "",
        source: "github",
        sourceLabel: "A-Translator official GitHub",
        sourceUrl: usedUrl || sourceInfo.url || url,
        manifestUpdatedAt: sourceInfo.manifestUpdatedAt || null,
        importedAt: new Date().toISOString()
      });
    }

    return result;
  }

  async function listGithubDictionaries() {
    for (const manifestUrl of GITHUB_DICTIONARIES_MANIFEST_URLS) {
      try {
        const response = await fetch(manifestUrl, { cache: "no-store" });
        if (!response.ok) continue;

        const manifest = await response.json();
        const list = manifest && Array.isArray(manifest.dictionaries) ? manifest.dictionaries : [];

        const dictionaries = list
          .filter((dict) => {
            if (!dict || typeof dict !== "object") return false;
            if (!dict.id || !dict.url) return false;
            return true;
          })
          .map((dict) => ({
            id: String(dict.id || "").trim(),
            label: String(dict.name || dict.id || "Dictionary").trim(),
            name: String(dict.name || dict.id || "Dictionary").trim(),
            lang: String(dict.lang || "und").trim().toLowerCase(),
            dictVersion: String(dict.dictVersion || "0").trim(),
            description: String(dict.description || "").trim(),
            url: String(dict.url || "").trim(),
            manifestUpdatedAt: manifest.updatedAt || null
          }))
          .sort((a, b) => a.label.localeCompare(b.label));

        if (dictionaries.length > 0) return dictionaries;
      } catch (e) {
        console.warn("[A-Translator] Manifest lookup failed:", manifestUrl, e);
      }
    }

    const response = await fetch(GITHUB_DICTIONARIES_API_URL, { cache: "no-store" });
    if (!response.ok) {
      throw new Error("GitHub dictionary list failed: HTTP " + response.status);
    }

    const files = await response.json();
    if (!Array.isArray(files)) return [];

    return files
      .filter((file) => {
        if (!file || file.type !== "file") return false;
        if (!file.name || !file.download_url) return false;
        if (file.name.toLowerCase() === "manifest.json") return false;
        return file.name.toLowerCase().endsWith(".json");
      })
      .map((file) => ({
        id: file.name.replace(/\.json$/i, ""),
        label: file.name.replace(/\.json$/i, ""),
        name: file.name.replace(/\.json$/i, ""),
        lang: "und",
        dictVersion: "0",
        description: "",
        url: file.download_url,
        manifestUpdatedAt: null
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }

  function compareDictionaryVersions(a, b) {
    const pa = String(a || "0").split(/[.-]/).map((x) => parseInt(x, 10) || 0);
    const pb = String(b || "0").split(/[.-]/).map((x) => parseInt(x, 10) || 0);
    const len = Math.max(pa.length, pb.length);

    for (let i = 0; i < len; i++) {
      const va = pa[i] || 0;
      const vb = pb[i] || 0;
      if (va > vb) return 1;
      if (va < vb) return -1;
    }

    return 0;
  }

  function uninstall() {
    document.getElementById("alchemy-translate-buttons")?.remove();
    document.getElementById("alchemy-translate-editor")?.remove();

    localStorage.removeItem(KEY_DICT);
    localStorage.removeItem(KEY_ENABLED);
    localStorage.removeItem(KEY_DICT_META);
    localStorage.removeItem(KEY_META_LEGACY);

    try { delete window.AlchemyTranslate; } catch (_) {}
    try { delete window.__AlchemyTranslateCore__; } catch (_) {}

    console.log("[A-Translator] uninstalled. Reloading…");
    setTimeout(() => location.reload(), 50);
  }

  function resetDictionary() {
    localStorage.removeItem(KEY_DICT);
    localStorage.removeItem(KEY_DICT_META);
    localStorage.removeItem(KEY_META_LEGACY);

    core.loadDictFromStorage();
    core.scheduleApplyTouched();

    console.log("[A-Translator] dictionary reset.");
  }

  function openEditor() {
    let textarea;

    const dictToLines = (dict) =>
      Object.entries(dict)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([src, dst]) => src + " = " + dst)
        .join("\n");

    const existing = document.getElementById("alchemy-translate-editor");
    if (existing) existing.remove();

    const overlay = document.createElement("div");
    overlay.id = "alchemy-translate-editor";
    overlay.style.cssText = css(
      "position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.55);",
      "display:flex;align-items:center;justify-content:center;padding:16px;",
      "overflow:auto;"
    );

    const panel = document.createElement("div");
    panel.style.cssText = css(
      "width:66vw;",
      "min-width:760px;",
      "max-width:1100px;",
      "height:auto;",
      "max-height:88vh;",
      "background:#111;color:#eee;",
      "border:1px solid rgba(255,255,255,.15);border-radius:10px;",
      "box-shadow:0 10px 30px rgba(0,0,0,.6);",
      "display:flex;flex-direction:column;overflow:hidden;",
      "position:relative;",
      "font:13px/1.4 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;"
    );

    function openConfirmDialog({ title = "Confirm action", message = "", confirmLabel = "Confirm", cancelLabel = "Cancel", danger = false } = {}) {
      return new Promise((resolve) => {
        document.getElementById("a-translator-confirm-dialog")?.remove();

        const confirmOverlay = document.createElement("div");
        confirmOverlay.id = "a-translator-confirm-dialog";
        confirmOverlay.style.cssText = css(
          "position:absolute;",
          "inset:0;",
          "z-index:2147483647;",
          "display:flex;",
          "align-items:center;",
          "justify-content:center;",
          "padding:16px;",
          "background:rgba(0,0,0,.48);",
          "backdrop-filter:blur(3px);"
        );

        const box = document.createElement("div");
        box.style.cssText = css(
          "width:min(430px,90%);",
          "border-radius:16px;",
          "border:1px solid rgba(255,255,255,.14);",
          "background:rgba(18,18,20,.96);",
          "box-shadow:0 18px 50px rgba(0,0,0,.55);",
          "padding:16px;",
          "display:flex;",
          "flex-direction:column;",
          "gap:12px;",
          "color:rgba(255,255,255,.92);"
        );

        const heading = document.createElement("div");
        heading.textContent = title;
        heading.style.cssText = css(
          "font-size:14px;",
          "font-weight:700;",
          "letter-spacing:.2px;"
        );

        const bodyText = document.createElement("div");
        bodyText.textContent = message;
        bodyText.style.cssText = css(
          "font-size:12px;",
          "line-height:1.45;",
          "opacity:.72;",
          "white-space:pre-line;"
        );

        const actions = document.createElement("div");
        actions.style.cssText = css(
          "display:flex;",
          "flex-direction:row;",
          "justify-content:flex-end;",
          "align-items:center;",
          "gap:10px;",
          "padding-top:4px;",
          "width:100%;"
        );

        const btnCancel = makePillButton(cancelLabel, [
          "background:rgba(255,255,255,.045);",
          "color:rgba(255,255,255,.86);",
          "min-width:110px;",
          "justify-content:center;"
        ]);

        const btnConfirm = makePillButton(confirmLabel, [
          danger ? "background:rgba(120,40,40,.65);" : "background:rgba(40,120,70,.55);",
          "color:#fff;",
          "font-weight:600;",
          "min-width:110px;",
          "justify-content:center;"
        ]);

        hoverBg(
          btnConfirm,
          danger ? "rgba(120,40,40,.65)" : "rgba(40,120,70,.55)",
          danger ? "rgba(150,50,50,.78)" : "rgba(70,170,110,.9)"
        );
        hoverBg(btnCancel, "rgba(255,255,255,.045)", "rgba(255,255,255,.075)");

        const closeConfirm = (value) => {
          confirmOverlay.remove();
          resolve(value);
        };

        btnCancel.addEventListener("click", () => closeConfirm(false));
        btnConfirm.addEventListener("click", () => closeConfirm(true));
        confirmOverlay.addEventListener("click", (e) => {
          if (e.target === confirmOverlay) closeConfirm(false);
        });
        confirmOverlay.addEventListener("keydown", (e) => {
          if (e.key === "Escape") closeConfirm(false);
          if (e.key === "Enter") closeConfirm(true);
        });

        actions.append(btnCancel, btnConfirm);
        box.append(heading, bodyText, actions);
        confirmOverlay.appendChild(box);
        panel.appendChild(confirmOverlay);

        setTimeout(() => btnConfirm.focus(), 0);
      });
    }

    const importInput = document.createElement("input");
    importInput.type = "file";
    importInput.accept = ".json,application/json";
    importInput.style.display = "none";
    panel.appendChild(importInput);

    const importMode = "replace";

    const header = document.createElement("div");
    header.style.cssText = css(
      "padding:18px 14px 20px 14px;border-bottom:1px solid rgba(255,255,255,.12);",
      "display:flex;flex-direction:column;gap:16px;",
      "flex-shrink:0;"
    );

    const headerTop = document.createElement("div");
    headerTop.style.cssText = css(
      "display:flex;",
      "flex-direction:column;",
      "align-items:center;",
      "gap:6px;"
    );

    const title = document.createElement("div");
    title.textContent = "A-TRANSLATOR (v " + SCRIPT_VERSION + ")";
    title.style.cssText = css("font-weight:700;", "font-size:18px;", "letter-spacing:.2px;");

    const subtitle = document.createElement("div");
    subtitle.innerHTML =
      "Alchemy is © 2025 Arboreal, LLC. All rights reserved · " +
      "Community-driven Alchemy translator by La Brioche Masquée" +
      "<a href='https://github.com/BriocheMasquee/a-translator' target='_blank' rel='noopener noreferrer' style='color:rgba(120,190,255,.92);text-decoration:none;font-weight:500;'>Join us on GitHub</a>";
    subtitle.style.cssText = css(
      "font-size:10px;",
      "opacity:.58;",
      "margin-top:4px;",
      "margin-bottom:2px;",
      "text-align:center;",
      "width:100%;",
      "display:flex;",
      "justify-content:center;",
      "align-items:center;",
      "gap:4px;",
      "flex-wrap:nowrap;",
      "white-space:nowrap;"
    );

    headerTop.append(title, subtitle);

    const toggleRow = document.createElement("div");
    toggleRow.style.cssText = css(
      "display:flex;",
      "flex-direction:row;",
      "align-items:center;",
      "gap:10px;"
    );

    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.checked = loadEnabledFlag();
    toggle.style.cssText = css(
      "appearance:none;width:46px;height:24px;border-radius:999px;",
      "background:" +
        (toggle.checked ? "rgba(40,120,70,.55)" : "rgba(120,120,120,.45)") +
        ";",
      "position:relative;cursor:pointer;flex-shrink:0;"
    );

    const knob = document.createElement("div");
    knob.style.cssText = css(
      "position:absolute;top:3px;left:" + (toggle.checked ? "24px" : "3px") + ";",
      "width:18px;height:18px;border-radius:999px;background:#111;",
      "transition:left .15s ease;pointer-events:none;"
    );

    const toggleBox = document.createElement("div");
    toggleBox.style.cssText = css("position:relative;width:46px;height:24px;flex-shrink:0;");
    toggleBox.append(toggle, knob);

    const toggleLabel = document.createElement("div");
    toggleLabel.style.cssText = css(
      "display:flex;",
      "align-items:center;",
      "height:32px;",
      "line-height:32px;",
      "font-size:12px;",
      "opacity:.85;",
      "user-select:none;",
      "margin:0;",
      "padding:0;"
    );

    const LABEL_ON = "Translations ON";
    const LABEL_OFF = "Translations OFF";

    function syncToggleUI(on) {
      toggleLabel.textContent = on ? LABEL_ON : LABEL_OFF;
      toggle.style.background = on ? "rgba(40,120,70,.55)" : "rgba(120,120,120,.45)";
      knob.style.left = on ? "24px" : "3px";
    }

    syncToggleUI(toggle.checked);

    toggle.addEventListener("change", () => {
      syncToggleUI(toggle.checked);
      toggleCore(toggle.checked);
    });

    toggleRow.append(toggleBox, toggleLabel);

    const dictionaryCards = document.createElement("div");
    dictionaryCards.style.cssText = css(
      "display:grid;",
      "grid-template-columns:1fr 2fr;",
      "gap:12px;",
      "width:100%;"
    );

    const exportRow = document.createElement("div");
    exportRow.style.cssText = css(
      "display:flex;",
      "flex-direction:column;",
      "align-items:flex-start;",
      "gap:10px;",
      "padding:12px;",
      "border-radius:14px;",
      "border:1px solid rgba(255,255,255,.12);",
      "background:rgba(255,255,255,.035);",
      "box-shadow:inset 0 1px 0 rgba(255,255,255,.04);"
    );

    const dictLabel = document.createElement("div");
    dictLabel.textContent = "Manage dictionary";
    dictLabel.style.cssText = css(
      "font-size:13px;",
      "font-weight:700;",
      "opacity:.95;",
      "user-select:none;",
      "text-transform:uppercase;",
      "letter-spacing:.35px;"
    );

    const dictActions = document.createElement("div");
    dictActions.style.cssText = css(
      "display:flex;",
      "flex-direction:column;",
      "align-items:stretch;",
      "gap:8px;",
      "width:100%;"
    );

    const makeDictionaryActionButton = (label, iconSvg) => {
      const b = document.createElement("button");
      b.type = "button";
      b.style.cssText = css(
        "width:100%;",
        "min-height:38px;",
        "padding:8px 12px;",
        "border-radius:12px;",
        "border:1px solid rgba(255,255,255,.10);",
        "background:rgba(255,255,255,.045);",
        "color:rgba(255,255,255,.92);",
        "cursor:pointer;",
        "font-size:13px;",
        "font-weight:500;",
        "display:flex;",
        "align-items:center;",
        "justify-content:flex-start;",
        "gap:12px;",
        "text-align:left;",
        "box-shadow:inset 0 1px 0 rgba(255,255,255,.04);"
      );

      const icon = document.createElement("span");
      icon.innerHTML = iconSvg;
      icon.style.cssText = css(
        "width:20px;",
        "height:20px;",
        "display:inline-flex;",
        "align-items:center;",
        "justify-content:center;",
        "color:rgba(70,170,110,.95);",
        "flex-shrink:0;"
      );

      const text = document.createElement("span");
      text.textContent = label;

      b.append(icon, text);
      b.addEventListener("mouseenter", () => (b.style.background = "rgba(255,255,255,.075)"));
      b.addEventListener("mouseleave", () => (b.style.background = "rgba(255,255,255,.045)"));
      b.addEventListener("focus", () => (b.style.background = "rgba(255,255,255,.075)"));
      b.addEventListener("blur", () => (b.style.background = "rgba(255,255,255,.045)"));
      return b;
    };

    const EXPORT_SVG =
      "<svg width='20' height='20' viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg'>" +
      "<path d='M12 3v12' stroke='currentColor' stroke-width='2' stroke-linecap='round'/>" +
      "<path d='M7 8l5-5 5 5' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/>" +
      "<path d='M5 15v4h14v-4' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/>" +
      "</svg>";

    const IMPORT_LOCAL_SVG =
      "<svg width='20' height='20' viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg'>" +
      "<path d='M6 3h8l4 4v14H6V3z' stroke='currentColor' stroke-width='2' stroke-linejoin='round'/>" +
      "<path d='M14 3v5h5' stroke='currentColor' stroke-width='2' stroke-linejoin='round'/>" +
      "</svg>";

    const IMPORT_GITHUB_SVG =
      "<svg width='20' height='20' viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg'>" +
      "<path d='M12 3c-4.6 0-8 3.4-8 8 0 3.6 2.3 6.6 5.5 7.6.4.1.5-.2.5-.4v-1.5c-2.2.5-2.7-.9-2.7-.9-.4-.9-.9-1.2-.9-1.2-.7-.5.1-.5.1-.5.8.1 1.3.8 1.3.8.7 1.3 2 1 2.5.8.1-.5.3-.9.5-1.1-1.8-.2-3.6-.9-3.6-4 0-.9.3-1.6.8-2.2-.1-.2-.4-1 .1-2.1 0 0 .7-.2 2.2.8.6-.2 1.2-.2 1.8-.2s1.2.1 1.8.2c1.5-1 2.2-.8 2.2-.8.5 1.1.2 1.9.1 2.1.5.6.8 1.3.8 2.2 0 3.1-1.9 3.8-3.6 4 .3.2.5.7.5 1.4v2.1c0 .2.2.5.6.4A8 8 0 0 0 20 11c0-4.6-3.4-8-8-8z' stroke='currentColor' stroke-width='1.5' stroke-linejoin='round'/>" +
      "</svg>";

    const EDIT_DICTIONARY_SVG =
      "<svg width='20' height='20' viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg'>" +
      "<path d='M4 20h4l11-11a2.8 2.8 0 0 0-4-4L4 16v4z' stroke='currentColor' stroke-width='2' stroke-linejoin='round'/>" +
      "<path d='M13.5 6.5l4 4' stroke='currentColor' stroke-width='2' stroke-linecap='round'/>" +
      "</svg>";

    const btnExport = makeDictionaryActionButton("Export", EXPORT_SVG);
    btnExport.addEventListener("click", exportDict);

    const btnImport = makeDictionaryActionButton("Import (local)", IMPORT_LOCAL_SVG);

    const btnImportGithub = makeDictionaryActionButton("Import (GitHub)", IMPORT_GITHUB_SVG);


    async function handleGithubImport() {
      try {
        const dictionaries = await listGithubDictionaries();

        if (!Array.isArray(dictionaries) || dictionaries.length === 0) {
          await openConfirmDialog({
            title: "No dictionary found",
            message: "No GitHub dictionary could be found.",
            confirmLabel: "OK",
            cancelLabel: "Close"
          });
          return;
        }

        document.getElementById("a-translator-github-dropdown")?.remove();

        const dropdown = document.createElement("div");
        dropdown.id = "a-translator-github-dropdown";
        dropdown.style.cssText = css(
          "position:absolute;",
          "left:0;",
          "top:calc(100% + 8px);",
          "width:100%;",
          "display:flex;",
          "flex-direction:column;",
          "gap:6px;",
          "padding:8px;",
          "border-radius:12px;",
          "border:1px solid rgba(255,255,255,.12);",
          "background:rgba(18,18,20,.96);",
          "box-shadow:0 14px 40px rgba(0,0,0,.45);",
          "backdrop-filter:blur(8px);",
          "z-index:2147483647;"
        );

        btnImportGithub.style.position = "relative";
        btnImportGithub.appendChild(dropdown);

        const closeDropdown = () => {
          dropdown.remove();
          document.removeEventListener("click", outsideHandler, true);
        };

        const outsideHandler = (event) => {
          if (!dropdown.contains(event.target) && event.target !== btnImportGithub) {
            closeDropdown();
          }
        };

        setTimeout(() => {
          document.addEventListener("click", outsideHandler, true);
        }, 0);

        for (const dict of dictionaries) {
          const item = document.createElement("button");
          item.type = "button";
          item.style.cssText = css(
            "width:100%;",
            "padding:10px 12px;",
            "border-radius:10px;",
            "border:1px solid rgba(255,255,255,.10);",
            "background:rgba(255,255,255,.045);",
            "color:rgba(255,255,255,.92);",
            "cursor:pointer;",
            "display:flex;",
            "flex-direction:column;",
            "align-items:flex-start;",
            "gap:2px;",
            "text-align:left;"
          );

          const itemTitle = document.createElement("span");
          itemTitle.textContent = dict.label || dict.name || dict.id || "Dictionary";
          itemTitle.style.cssText = css(
            "font-size:12px;",
            "font-weight:600;"
          );

          const itemMeta = document.createElement("span");
          itemMeta.textContent =
            String(dict.lang || "und").toUpperCase() +
            " · v" +
            String(dict.dictVersion || "0");
          itemMeta.style.cssText = css(
            "font-size:10px;",
            "opacity:.62;"
          );

          item.append(itemTitle, itemMeta);

          item.addEventListener("mouseenter", () => {
            item.style.background = "rgba(255,255,255,.08)";
          });

          item.addEventListener("mouseleave", () => {
            item.style.background = "rgba(255,255,255,.045)";
          });

          item.addEventListener("click", async (e) => {
            e.preventDefault();
            e.stopPropagation();

            closeDropdown();

            const ok = await openConfirmDialog({
              title: "Import GitHub dictionary",
              message:
                (dict.label || dict.name || dict.id || "Dictionary") +
                "\n\nThis will replace the current local dictionary.",
              confirmLabel: "Import",
              cancelLabel: "Cancel"
            });

            if (!ok) return;

            try {
              const res = await importDictFromGithubUrl(dict.url, dict);

              if (!res || res.ok === false) {
                await openConfirmDialog({
                  title: "GitHub import failed",
                  message: "The selected dictionary could not be imported. Check the console for details.",
                  confirmLabel: "OK",
                  cancelLabel: "Close"
                });
                return;
              }

              draftDict = loadDictionary();
              filterQuery = "";
              searchInput.value = "";
              refreshTextarea();
              refreshCurrentDictionaryInfo();
            } catch (err) {
              console.error("[A-Translator] GitHub import error", err);

              await openConfirmDialog({
                title: "GitHub import error",
                message: String(err && err.message ? err.message : err),
                confirmLabel: "OK",
                cancelLabel: "Close"
              });
            }
          });

          dropdown.appendChild(item);
        }

        return;
      } catch (e) {
        console.error("[A-Translator] GitHub import error", e);
        await openConfirmDialog({
          title: "GitHub import error",
          message: String(e && e.message ? e.message : e),
          confirmLabel: "OK",
          cancelLabel: "Close"
        });
      }
    }

    btnImportGithub.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      handleGithubImport();
    });

    const btnEditDictionary = makeDictionaryActionButton("Edit current dictionary", EDIT_DICTIONARY_SVG);

    let dictionaryEditorVisible = false;

    btnEditDictionary.addEventListener("click", () => {
      dictionaryEditorVisible = !dictionaryEditorVisible;

      body.style.display = dictionaryEditorVisible ? "flex" : "none";

      btnEditDictionary.style.background = dictionaryEditorVisible
        ? "rgba(255,255,255,.10)"
        : "rgba(255,255,255,.045)";

      const editButtonLabel = btnEditDictionary.querySelector("span:last-child");
      if (editButtonLabel) {
        editButtonLabel.textContent = dictionaryEditorVisible
          ? "Close dictionary editor"
          : "Edit current dictionary";
      }

      if (dictionaryEditorVisible) {
        setTimeout(() => textarea?.focus(), 0);
      }
    });

    btnImport.addEventListener("click", (e) => {
      e.preventDefault();

      openConfirmDialog({
        title: "Import local dictionary",
        message: "This will replace the current local dictionary.",
        confirmLabel: "Import",
        cancelLabel: "Cancel"
      }).then((ok) => {
        if (!ok) return;

        importInput.value = "";
        importInput.click();
      });
    });

    const exportHint = document.createElement("div");
    exportHint.textContent = "";
    exportHint.style.cssText = css("display:none;");

    const dictToLinesFromStorage = () => dictToLines(loadDictionary());

    let filterQuery = "";

    let draftDict = loadDictionary();
    let fullText = dictToLines(draftDict);
    let currentFilteredKeys = null;
    let hasUnsavedChanges = false;

    function setUnsavedChanges(value) {
      hasUnsavedChanges = !!value;
      if (typeof unsavedChangesLabel !== "undefined") {
        unsavedChangesLabel.textContent = hasUnsavedChanges ? "Unsaved changes" : "";
      }
      if (typeof btnSave !== "undefined") {
        btnSave.disabled = !hasUnsavedChanges;
        btnSave.style.opacity = hasUnsavedChanges ? "1" : ".45";
        btnSave.style.cursor = hasUnsavedChanges ? "pointer" : "default";
      }
    }

    function refreshTextarea() {
      fullText = dictToLines(draftDict);
      renderTextarea();
    }

    importInput.addEventListener("change", async () => {
      const file = importInput.files && importInput.files[0];
      if (!file) return;

      try {
        exportHint.textContent = "Importing…";

        const text = await file.text();
        const res = importDictFromJsonText(text, importMode);

        if (!res || res.ok === false) {
          exportHint.textContent = "Import failed";
          return;
        }

        draftDict = loadDictionary();
        filterQuery = "";
        searchInput.value = "";
        refreshTextarea();
        refreshCurrentDictionaryInfo();

        exportHint.textContent = "Imported " + res.count + " new entries (" + res.mode + ")";
        setTimeout(() => (exportHint.textContent = ""), 2500);
      } catch (e) {
        console.error("[A-Translator] import error", e);
        exportHint.textContent = "Import error (see console)";
      } finally {
        importInput.value = "";
      }
    });

    dictActions.append(btnExport, btnImport, btnImportGithub, btnEditDictionary);
    exportRow.append(dictLabel, dictActions, exportHint);

    const currentDictionaryCard = document.createElement("div");
    currentDictionaryCard.style.cssText = css(
      "display:flex;",
      "flex-direction:column;",
      "align-items:flex-start;",
      "gap:10px;",
      "padding:12px;",
      "border-radius:14px;",
      "border:1px solid rgba(255,255,255,.12);",
      "background:rgba(255,255,255,.035);",
      "box-shadow:inset 0 1px 0 rgba(255,255,255,.04);"
    );

    const currentDictionaryTitle = document.createElement("div");
    currentDictionaryTitle.textContent = "Current dictionary";
    currentDictionaryTitle.style.cssText = css(
      "font-size:12px;",
      "font-weight:700;",
      "opacity:.92;",
      "user-select:none;",
      "text-transform:uppercase;",
      "letter-spacing:.3px;"
    );

    const currentDictionaryInfo = document.createElement("div");
    currentDictionaryInfo.style.cssText = css(
      "font-size:11px;",
      "line-height:1.55;",
      "opacity:.72;",
      "width:100%;"
    );

    function formatDictionaryDate(value) {
      if (!value) return "Never";
      try {
        const d = new Date(value);
        if (Number.isNaN(d.getTime())) return String(value);

        const year = String(d.getFullYear());
        const month = String(d.getMonth() + 1).padStart(2, "0");
        const day = String(d.getDate()).padStart(2, "0");

        return year + "-" + month + "-" + day;
      } catch (_) {
        return String(value);
      }
    }

    function refreshCurrentDictionaryInfo() {
      const meta = loadMeta();
      const entries = loadDictionary();

      const name = String(meta.name || meta.id || "Local dictionary").trim();
      const lang = String(meta.lang || "und").trim().toUpperCase();
      const version = String(meta.dictVersion || "0").trim();
      const source = String(meta.sourceLabel || meta.source || "Local").trim();
      const importedAt = formatDictionaryDate(meta.importedAt);
      // const manifestUpdatedAt = formatDictionaryDate(meta.manifestUpdatedAt);
      const count = Object.keys(entries).length;

      currentDictionaryInfo.innerHTML =
        "<div style='font-size:13px;font-weight:700;opacity:.95;margin-bottom:8px;'>" + name + "</div>" +
        "<div style='display:grid;grid-template-columns:90px 1fr;column-gap:14px;row-gap:4px;width:100%;'>" +
          "<span style='opacity:.58;'>Language:</span><strong>" + lang + "</strong>" +
          "<span style='opacity:.58;'>Version:</span><strong>" + version + "</strong>" +
          "<span style='opacity:.58;'>Source:</span><strong>" + source + "</strong>" +
          "<span style='opacity:.58;'>Entries:</span><strong>" + count + "</strong>" +
          "<span style='opacity:.58;'>Imported:</span><strong>" + importedAt + "</strong>" +
        "</div>";

      refreshCurrentDictionaryStatus();
    }

    const currentDictionaryFooter = document.createElement("div");
    currentDictionaryFooter.style.cssText = css(
      "width:100%;",
      "margin-top:auto;",
      "padding-top:10px;",
      "border-top:1px solid rgba(255,255,255,.10);",
      "display:flex;",
      "flex-direction:row;",
      "align-items:center;",
      "justify-content:space-between;",
      "gap:10px;"
    );

    const currentDictionaryStatus = document.createElement("div");
    currentDictionaryStatus.textContent = "Status: Up to date";
    currentDictionaryStatus.style.cssText = css(
      "font-size:12px;",
      "opacity:.9;",
      "white-space:nowrap;",
      "color:rgba(255,255,255,.78);"
    );

    function setCurrentDictionaryStatus(text, color = "rgba(255,255,255,.78)") {
      currentDictionaryStatus.textContent = text;
      currentDictionaryStatus.style.color = color;
    }

    const btnUpdateDictionary = makePillButton("Update", [
      "background:rgba(40,120,70,.55);",
      "color:#fff;",
      "border:1px solid rgba(255,255,255,.12);",
      "font-weight:600;"
    ]);
    btnUpdateDictionary.style.display = "none";
    btnUpdateDictionary.disabled = true;
    hoverBg(btnUpdateDictionary, "rgba(40,120,70,.55)", "rgba(70,170,110,.9)");

    let pendingDictionaryUpdate = null;

    async function refreshCurrentDictionaryStatus() {
      const meta = loadMeta();
      const entries = loadDictionary();
      const count = Object.keys(entries).length;

      pendingDictionaryUpdate = null;
      btnUpdateDictionary.style.display = "none";
      btnUpdateDictionary.disabled = true;

      if (count === 0) {
        setCurrentDictionaryStatus("Status:", "rgba(255,255,255,.55)");
        return;
      }

      if (meta.source !== "github" || !meta.id) {
        setCurrentDictionaryStatus("Status: Local dictionary", "rgba(255,255,255,.62)");
        return;
      }

      setCurrentDictionaryStatus("Status: Checking…", "rgba(120,190,255,.92)");

      try {
        const dictionaries = await listGithubDictionaries();
        const remote = dictionaries.find((dict) => {
          if (meta.id && dict.id === meta.id) return true;
          if (meta.sourceUrl && dict.url === meta.sourceUrl) return true;
          return false;
        });

        if (!remote) {
          setCurrentDictionaryStatus("Status: Unknown", "rgba(255,190,120,.92)");
          return;
        }

        const localVersion = String(meta.dictVersion || "0");
        const remoteVersion = String(remote.dictVersion || "0");

        if (compareDictionaryVersions(remoteVersion, localVersion) > 0) {
          pendingDictionaryUpdate = remote;
          setCurrentDictionaryStatus("Status: Update available", "rgba(255,190,120,.95)");
          btnUpdateDictionary.style.display = "inline-flex";
          btnUpdateDictionary.disabled = false;
        } else {
          setCurrentDictionaryStatus("Status: Up to date", "rgba(120,210,150,.95)");
        }
      } catch (e) {
        console.warn("[A-Translator] Version check failed", e);
        setCurrentDictionaryStatus("Status: Check failed", "rgba(255,140,140,.95)");
      }
    }

    btnUpdateDictionary.addEventListener("click", async () => {
      if (!pendingDictionaryUpdate) return;

      const ok = await openConfirmDialog({
        title: "Update dictionary",
        message:
          (pendingDictionaryUpdate.label || pendingDictionaryUpdate.name || pendingDictionaryUpdate.id || "Dictionary") +
          "\n\nThis will replace the current local dictionary with the latest GitHub version.",
        confirmLabel: "Update",
        cancelLabel: "Cancel"
      });

      if (!ok) return;

      try {
        const res = await importDictFromGithubUrl(pendingDictionaryUpdate.url, pendingDictionaryUpdate);

        if (!res || res.ok === false) {
          await openConfirmDialog({
            title: "Update failed",
            message: "The dictionary could not be updated. Check the console for details.",
            confirmLabel: "OK",
            cancelLabel: "Close"
          });
          return;
        }

        draftDict = loadDictionary();
        filterQuery = "";
        searchInput.value = "";
        refreshTextarea();
        refreshCurrentDictionaryInfo();
      } catch (e) {
        console.error("[A-Translator] Dictionary update error", e);
        await openConfirmDialog({
          title: "Update error",
          message: String(e && e.message ? e.message : e),
          confirmLabel: "OK",
          cancelLabel: "Close"
        });
      }
    });

    const currentDictionaryControls = document.createElement("div");
    currentDictionaryControls.style.cssText = css(
      "display:flex;",
      "flex-direction:row;",
      "align-items:center;",
      "justify-content:flex-end;",
      "gap:10px;",
      "white-space:nowrap;"
    );

    currentDictionaryControls.append(toggleRow, btnUpdateDictionary);
    currentDictionaryFooter.append(currentDictionaryStatus, currentDictionaryControls);
    refreshCurrentDictionaryInfo();
    currentDictionaryCard.append(currentDictionaryTitle, currentDictionaryInfo, currentDictionaryFooter);
    dictionaryCards.append(exportRow, currentDictionaryCard);


    const functionsBar = document.createElement("div");
    functionsBar.style.cssText = css(
      "display:flex;",
      "flex-direction:column;",
      "gap:10px;",
      "align-items:stretch;",
      "width:100%;"
    );

    functionsBar.append(dictionaryCards);
    header.append(headerTop, functionsBar);

    const body = document.createElement("div");
    body.style.cssText = css(
      "padding:10px 12px;",
      "display:none;",
      "flex-direction:column;",
      "gap:10px;",
      "align-items:stretch;",
      "overflow:auto;",
      "min-height:0;",
      "flex:1 1 auto;",
      "max-height:48vh;"
    );

    const funcBlock = document.createElement("div");
    funcBlock.style.cssText = css(
      "width:100%;",
      "align-self:stretch;",
      "display:grid;",
      "grid-template-columns: 1fr auto;",
      "grid-template-rows: auto auto;",
      "column-gap:12px;",
      "row-gap:0;",
      "text-align:left;"
    );

    const titleWrap = document.createElement("div");
    titleWrap.style.cssText = css(
      "grid-column:1;",
      "grid-row:1;",
      "display:flex;",
      "align-items:baseline;",
      "gap:8px;",
      "justify-content:flex-start;",
      "min-width:0;",
      "text-align:left;"
    );

    const hint = document.createElement("div");
    hint.textContent = "DICTIONARY EDITOR";
    hint.style.cssText = css(
      "font-weight:600;",
      "font-size:12px;",
      "opacity:.9;",
      "margin:0;",
      "padding:0;",
      "line-height:1.1;",
      "text-align:left;"
    );

    titleWrap.append(hint);

    const searchInput = document.createElement("input");
    searchInput.type = "search";
    searchInput.placeholder = "Search…";
    searchInput.autocomplete = "off";
    searchInput.spellcheck = false;
    searchInput.style.cssText = css(
      "grid-column:2;",
      "grid-row:1;",
      "justify-self:end;",
      "align-self:center;",
      "width:260px;",
      "max-width:40vw;",
      "padding:6px 10px;",
      "border-radius:999px;",
      "border:1px solid rgba(255,255,255,.18);",
      "background:#0b0b0b;",
      "color:#eee;",
      "font-size:12px;",
      "outline:none;",
      "text-align:left;"
    );

    const hintDescription = document.createElement("div");
    hintDescription.style.cssText = css(
      "grid-column:1 / -1;",
      "grid-row:2;",
      "justify-self:start;",
      "text-align:left;",
      "font-size:12px;",
      "opacity:.75;",
      "line-height:1.1;",
      "margin:0;",
      "margin-top:-7px;"
    );
    hintDescription.textContent = "One entry per line. Use the format: ";
    const em = document.createElement("em");
    em.textContent = "key = translation";
    hintDescription.append(em);

    funcBlock.append(titleWrap, searchInput, hintDescription);

    textarea = document.createElement("textarea");
    textarea.id = "alchemy-translate-textarea";
    textarea.spellcheck = false;
    textarea.style.cssText = css(
      "width:100%;",
      "height:30vh;",
      "min-height:220px;",
      "max-height:34vh;",
      "resize:vertical;",
      "padding:10px 12px;",
      "border-radius:10px;",
      "border:1px solid rgba(255,255,255,.18);",
      "background:#0b0b0b;",
      "color:#eee;",
      "overflow:auto;",
      "font:12.5px/1.45 ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;",
      "outline:none;"
    );

    function escapeRegExp(s) {
      return String(s || "").replace(/[.*+?^{}$()|[\]\\]/g, "\\$&");
    }

    function updateEntryCount() {}

    function renderTextarea() {
      const q = String(filterQuery || "").trim();

      if (!q) {
        currentFilteredKeys = null;
        textarea.readOnly = false;

        fullText = dictToLines(draftDict);
        textarea.value = fullText;

        updateEntryCount();
        return;
      }

      const re = new RegExp(escapeRegExp(q), "i");

      const lines = dictToLines(draftDict).split("\n");

      const filtered = lines.filter((line) => {
        const l = line.trim();
        if (!l) return false;
        if (l.startsWith("#")) return false;
        return re.test(line);
      });

      currentFilteredKeys = filtered
        .map((line) => {
          const idx = line.indexOf("=");
          if (idx === -1) return null;
          return line.slice(0, idx).trim().toLowerCase();
        })
        .filter(Boolean);

      textarea.readOnly = false;
      textarea.value = filtered.join("\n");
      updateEntryCount();
    }

    renderTextarea();

    textarea.addEventListener("input", () => {
      const q = String(filterQuery || "").trim();

      const parsed = {};
      for (const line of String(textarea.value || "").split("\n")) {
        const l = line.trim();
        if (!l || l.startsWith("#")) continue;

        const idx = l.indexOf("=");
        if (idx === -1) continue;

        const src = l.slice(0, idx).trim().toLowerCase();
        const dst = l.slice(idx + 1).trim();
        if (!src || !dst) continue;

        parsed[src] = dst;
      }

      if (!q) {
        draftDict = parsed;
      } else {
        for (const [k, v] of Object.entries(parsed)) {
          draftDict[k] = v;
        }

        if (Array.isArray(currentFilteredKeys)) {
          for (const k of currentFilteredKeys) {
            if (!Object.prototype.hasOwnProperty.call(parsed, k)) {
              delete draftDict[k];
            }
          }
        }
      }

      updateEntryCount();
      setUnsavedChanges(true);
    });

    searchInput.addEventListener("input", () => {
      filterQuery = searchInput.value || "";
      renderTextarea();
    });

    body.append(funcBlock, textarea);

    const footer = document.createElement("div");
    footer.style.cssText = css(
      "padding:12px 12px 14px 12px;",
      "display:flex;",
      "flex-direction:row;",
      "align-items:center;",
      "justify-content:space-between;",
      "gap:10px;",
      "border-top:1px solid rgba(255,255,255,.12);",
      "flex-shrink:0;"
    );

    const footerLeft = document.createElement("div");
    footerLeft.style.cssText = css(
      "display:flex !important;",
      "flex-direction:row !important;",
      "flex-wrap:nowrap !important;",
      "align-items:center !important;",
      "justify-content:flex-start !important;",
      "gap:10px;",
      "min-width:0;"
    );

    toggleRow.style.cssText = css(
      "display:flex !important;",
      "flex-direction:row !important;",
      "flex-wrap:nowrap !important;",
      "align-items:center !important;",
      "justify-content:center !important;",
      "gap:10px;",
      "white-space:nowrap;",
      "height:32px;",
      "padding:0 12px;",
      "border-radius:999px;",
      "background:transparent;"
    );

    const footerRight = document.createElement("div");
    footerRight.style.cssText = css(
      "margin-left:auto;",
      "display:flex !important;",
      "flex-direction:row !important;",
      "flex-wrap:nowrap !important;",
      "justify-content:flex-end !important;",
      "align-items:center !important;",
      "gap:10px;"
    );

    const btnClose = makePillButton("Cancel", [
      "padding:6px 12px;",
      "background:#1b1b1b;",
      "color:#eee;"
    ]);

    const btnSave = makePillButton("Save", [
      "background:rgba(40,120,70,.55);",
      "color:#fff;",
      "font-weight:600;"
    ]);
    btnSave.removeAttribute("title");
    attachTooltip(btnSave, "Save and close", "top");
    hoverBg(btnSave, "rgba(40,120,70,.55)", "rgba(70,170,110,.9)");
    btnSave.disabled = true;
    btnSave.style.opacity = ".45";
    btnSave.style.cursor = "default";

    const btnResetDictionary = makePillButton("Reset dictionary", [
      "background:rgba(120,40,40,.55);",
      "color:#f3f3f3;",
      "font-weight:500;"
    ]);
    btnResetDictionary.removeAttribute("title");
    attachTooltip(btnResetDictionary, "Delete the stored dictionary and metadata", "top");
    hoverBg(btnResetDictionary, "rgba(120,40,40,.55)", "rgba(150,50,50,.7)");

    btnResetDictionary.addEventListener("click", () => {
      openConfirmDialog({
        title: "Reset dictionary",
        message: "This will delete the stored dictionary and its metadata. A-Translator will remain installed.",
        confirmLabel: "Reset",
        cancelLabel: "Cancel",
        danger: true
      }).then((ok) => {
        if (!ok) return;

        resetDictionary();
        draftDict = {};
        filterQuery = "";
        searchInput.value = "";
        refreshTextarea();
        refreshCurrentDictionaryInfo();
        setUnsavedChanges(false);
      });
    });

    const unsavedChangesLabel = document.createElement("div");
    unsavedChangesLabel.textContent = "";
    unsavedChangesLabel.style.cssText = css(
      "font-size:12px;",
      "color:rgba(255,190,120,.95);",
      "white-space:nowrap;",
      "opacity:.9;"
    );

    footerLeft.append(btnResetDictionary, unsavedChangesLabel);
    footerRight.append(btnSave, btnClose);
    footer.append(footerLeft, footerRight);

    panel.append(header, body, footer);
    overlay.append(panel);
    document.documentElement.appendChild(overlay);

    updateEntryCount();
    setUnsavedChanges(false);
    textarea.focus();

    const close = () => overlay.remove();

    async function requestClose() {
      if (!hasUnsavedChanges) {
        close();
        return;
      }

      const ok = await openConfirmDialog({
        title: "Discard changes?",
        message: "You have unsaved changes. Close the editor without saving?",
        confirmLabel: "Discard",
        cancelLabel: "Cancel",
        danger: true
      });

      if (ok) close();
    }

    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) requestClose();
    });
    btnClose.addEventListener("click", requestClose);

function applyEditsFromTextarea() {
  const lines = String(textarea.value || "").split("\n");

  for (const line of lines) {
    const l = line.trim();
    if (!l || l.startsWith("#")) continue;

    const idx = l.indexOf("=");
    if (idx === -1) continue;

    const src = l.slice(0, idx).trim().toLowerCase();
    const dst = l.slice(idx + 1).trim();

    if (!src) continue;

    if (dst) {
      draftDict[src] = dst;
    } else {
      delete draftDict[src];
    }
  }
}

  btnSave.addEventListener("click", () => {
      if (typeof applyEditsFromTextarea === "function") {
        applyEditsFromTextarea();
      }

    const meta = loadMeta();
    if (!meta.lang) {
      const guessed = String(navigator.language || "undefined")
        .split("-")[0]
        .toLowerCase();
      saveMeta({ ...meta, lang: guessed || "undefined" });
    }
    if (!meta.dictVersion) {
      saveMeta({ ...loadMeta(), dictVersion: "1" }); // ou "0" si tu préfères
    }

    saveDictionary(draftDict);
    setUnsavedChanges(false);

    applyTranslations();
    close();
  });

  overlay.addEventListener("keydown", (e) => {
    if (e.key === "Escape") requestClose();
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      btnSave.click();
      }
    });
  }

  function mountButtons() {
    if (document.getElementById("alchemy-translate-buttons")) return;

    const box = document.createElement("div");
    box.id = "alchemy-translate-buttons";

    box.style.cssText = css(
      "position:fixed;left:30px;top:80px;width:56px;",
      "z-index:2147483647;display:flex;flex-direction:column;gap:6px;align-items:center;"
    );

    const mkIconBtn = (label, svg) => {
      const b = document.createElement("button");
      b.type = "button";
      b.removeAttribute("title");
      b.setAttribute("aria-label", label);

      b.style.cssText = css(
        "width:36px;height:36px;",
        "border-radius:999px;",
        "border:1px solid rgba(255,255,255,.16);",
        "background:rgba(20,20,22,.70);",
        "backdrop-filter: blur(6px);",
        "color:rgba(255,255,255,.9);",
        "display:flex;align-items:center;justify-content:center;",
        "cursor:pointer;",
        "box-shadow: inset 0 1px 0 rgba(255,255,255,.06), 0 6px 18px rgba(0,0,0,.35);",
        "position:relative;"
      );

      b.innerHTML = svg;

      const tip = document.createElement("div");
      tip.textContent = label;
      tip.style.cssText = css(
        "position:absolute;left:calc(100% + 10px);top:50%;transform:translateY(-50%);",
        "padding:6px 8px;border-radius:10px;",
        "background:rgba(18,18,20,.92);",
        "border:1px solid rgba(255,255,255,.12);",
        "color:rgba(255,255,255,.92);",
        "font:12px/1.2 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;",
        "white-space:nowrap;",
        "box-shadow:0 10px 30px rgba(0,0,0,.45);",
        "backdrop-filter: blur(8px);",
        "pointer-events:none;",
        "opacity:0;visibility:hidden;",
        "transition:opacity .12s ease, transform .12s ease;",
        "z-index:2147483647;"
      );

      const show = () => {
        tip.style.visibility = "visible";
        tip.style.opacity = "1";
        tip.style.transform = "translateY(-50%) translateX(2px)";
        b.style.background = "rgba(30,30,34,.80)";
      };

      const hide = () => {
        tip.style.opacity = "0";
        tip.style.visibility = "hidden";
        tip.style.transform = "translateY(-50%)";
        b.style.background = "rgba(20,20,22,.70)";
      };

      b.appendChild(tip);

      b.addEventListener("mouseenter", show);
      b.addEventListener("mouseleave", hide);
      b.addEventListener("focus", show);
      b.addEventListener("blur", hide);

      return b;
    };

    const TRANSLATE_SVG =
      "<svg width='16' height='16' viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg'>" +
      "<path d='M3 5h10' stroke='currentColor' stroke-width='2' stroke-linecap='round'/>" +
      "<path d='M8 5c0 6-3 9-5 11' stroke='currentColor' stroke-width='2' stroke-linecap='round'/>" +
      "<path d='M6 10c2 2 5 4 7 5' stroke='currentColor' stroke-width='2' stroke-linecap='round'/>" +
      "<path d='M14 19l3.5-9L21 19' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/>" +
      "<path d='M15.2 16h4.6' stroke='currentColor' stroke-width='2' stroke-linecap='round'/>" +
      "</svg>";

    const bTranslations = mkIconBtn("Open A-Translator", TRANSLATE_SVG);
    bTranslations.addEventListener("click", openEditor);

    box.append(bTranslations);
    document.documentElement.appendChild(box);
  }

  window.AlchemyTranslate = { openEditor, uninstall };
  mountButtons();
})();
