// ==UserScript==
// @name         A-Translator
// @namespace    https://github.com/BriocheMasquee
// @version      1.2.0
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
      "display:flex;align-items:center;justify-content:center;padding:16px;"
    );

    const panel = document.createElement("div");
    panel.style.cssText = css(
      "width:min(900px,95vw);height:min(700px,90vh);background:#111;color:#eee;",
      "border:1px solid rgba(255,255,255,.15);border-radius:10px;",
      "box-shadow:0 10px 30px rgba(0,0,0,.6);",
      "display:flex;flex-direction:column;overflow:hidden;",
      "font:13px/1.4 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;"
    );

    const importInput = document.createElement("input");
    importInput.type = "file";
    importInput.accept = ".json,application/json";
    importInput.style.display = "none";
    panel.appendChild(importInput);

    let importMode = "replace";

    const header = document.createElement("div");
    header.style.cssText = css(
      "padding:12px 14px;border-bottom:1px solid rgba(255,255,255,.12);",
      "display:flex;flex-direction:column;gap:14px;"
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
    title.style.cssText = css("font-weight:600;", "font-size:16px;");

    const subtitle = document.createElement("div");
    subtitle.innerHTML =
      "Alchemy is © 2025 Arboreal, LLC. All rights reserved.<br>" +
      "A-Translator is an unofficial tool and is not affiliated with Arboreal, LLC.";
    subtitle.style.cssText = css(
      "font-size:11px;",
      "opacity:.6;",
      "margin-top:2px;",
      "margin-bottom:6px;",
      "text-align:center;"
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
        (toggle.checked ? "rgba(70,170,110,.9)" : "rgba(120,120,120,.45)") +
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
      "height:24px;",
      "line-height:24px;",
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
      toggle.style.background = on ? "rgba(70,170,110,.9)" : "rgba(120,120,120,.45)";
      knob.style.left = on ? "24px" : "3px";
    }

    syncToggleUI(toggle.checked);

    toggle.addEventListener("change", () => {
      syncToggleUI(toggle.checked);
      toggleCore(toggle.checked);
    });

    toggleRow.append(toggleBox, toggleLabel);

    const exportRow = document.createElement("div");
    exportRow.style.cssText = css(
      "display:grid;",
      "grid-auto-flow:column;",
      "grid-auto-columns:max-content;",
      "align-items:center;",
      "gap:10px;"
    );

    const dictLabel = document.createElement("div");
    dictLabel.textContent = "Manage dictionary:";
    dictLabel.style.cssText = css(
      "font-size:12px;",
      "font-weight:600;",
      "opacity:.85;",
      "margin-right:6px;",
      "user-select:none;"
    );

    const btnExport = document.createElement("button");
    btnExport.type = "button";
    btnExport.textContent = "Export dictionary";
    btnExport.style.cssText = css(
      "padding:6px 12px;",
      "border-radius:999px;",
      "border:1px solid rgba(255,255,255,.18);",
      "background:rgba(20,20,22,.70);",
      "color:#eee;",
      "cursor:pointer;",
      "font-size:12px;",
      "white-space:nowrap;",
      "width:auto;"
    );
    btnExport.addEventListener("click", exportDict);

    const btnImport = document.createElement("button");
    btnImport.type = "button";
    btnImport.textContent = "Import ▾";
    btnImport.style.cssText = btnExport.style.cssText;

    function closeImportMenu() {
      document.getElementById("a-translator-import-menu")?.remove();
    }

    function openImportMenu() {
      closeImportMenu();

      const menu = document.createElement("div");
      menu.id = "a-translator-import-menu";
      menu.style.cssText = css(
        "position:absolute;",
        "top:calc(100% + 8px);",
        "right:0;",
        "display:flex;flex-direction:column;gap:6px;",
        "padding:8px;",
        "border-radius:12px;",
        "background:rgba(18,18,20,.92);",
        "border:1px solid rgba(255,255,255,.12);",
        "box-shadow:0 10px 30px rgba(0,0,0,.45);",
        "backdrop-filter: blur(8px);",
        "z-index:2147483647;"
      );

      const mkItem = (label) => {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = label;
        b.style.cssText = css(
          "padding:6px 10px;",
          "border-radius:10px;",
          "border:1px solid rgba(255,255,255,.12);",
          "background:rgba(255,255,255,.06);",
          "color:rgba(255,255,255,.92);",
          "cursor:pointer;",
          "font-size:12px;",
          "text-align:left;",
          "white-space:nowrap;"
        );
        b.addEventListener("mouseenter", () => (b.style.background = "rgba(255,255,255,.10)"));
        b.addEventListener("mouseleave", () => (b.style.background = "rgba(255,255,255,.06)"));
        return b;
      };

      const bReplace = mkItem("Replace current dictionary");
      const bMerge = mkItem("Merge into current dictionary");

      bReplace.addEventListener("click", () => {
        importMode = "replace";
        closeImportMenu();
        importInput.value = "";
        importInput.click();
      });

      bMerge.addEventListener("click", () => {
        importMode = "merge";
        closeImportMenu();
        importInput.value = "";
        importInput.click();
      });

      menu.append(bReplace, bMerge);

      btnImport.style.position = "relative";
      btnImport.appendChild(menu);

      const onDocClick = (e) => {
        if (!menu.contains(e.target) && e.target !== btnImport) {
          closeImportMenu();
          document.removeEventListener("mousedown", onDocClick, true);
        }
      };
      document.addEventListener("mousedown", onDocClick, true);
    }

    btnImport.addEventListener("click", (e) => {
      e.preventDefault();
      const existing = document.getElementById("a-translator-import-menu");
      if (existing) closeImportMenu();
      else openImportMenu();
    });

    const exportHint = document.createElement("div");
    exportHint.textContent = "";
    exportHint.style.cssText = css("opacity:.75;font-size:12px;");

    const dictToLinesFromStorage = () => dictToLines(loadDictionary());

    let filterQuery = "";

    let draftDict = loadDictionary();
    let fullText = dictToLines(draftDict);
    let currentFilteredKeys = null;

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

        exportHint.textContent = "Imported " + res.count + " new entries (" + res.mode + ")";
        setTimeout(() => (exportHint.textContent = ""), 2500);
      } catch (e) {
        console.error("[A-Translator] import error", e);
        exportHint.textContent = "Import error (see console)";
      } finally {
        importInput.value = "";
      }
    });

    exportRow.append(dictLabel, btnExport, btnImport, exportHint);

    const functionsBar = document.createElement("div");
    functionsBar.style.cssText = css(
      "display:flex;",
      "flex-direction:column;",
      "gap:10px;",
      "align-items:flex-start;"
    );

    functionsBar.append(toggleRow, exportRow);
    header.append(headerTop, functionsBar);

    const body = document.createElement("div");
    body.style.cssText = css(
      "padding:10px 12px;",
      "display:flex;flex-direction:column;gap:10px;",
      "flex:1;min-height:0;",
      "align-items:stretch;"
    );

    const funcBlock = document.createElement("div");
    funcBlock.style.cssText = css(
      "width:100%;",
      "align-self:stretch;",
      "display:grid;",
      "grid-template-columns: 1fr auto;",
      "grid-template-rows: auto auto;",
      "column-gap:12px;",
      "row-gap:6px;",
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
    hint.textContent = "DICTIONARY";
    hint.style.cssText = css(
      "font-weight:600;",
      "font-size:12px;",
      "opacity:.9;",
      "margin:0;",
      "padding:0;",
      "text-align:left;"
    );

    const hintCount = document.createElement("span");
    hintCount.id = "a-translator-entry-count";
    hintCount.textContent = "(0 entries)";
    hintCount.style.cssText = css(
      "font-size:12px;",
      "font-weight:500;",
      "opacity:.65;",
      "margin:0;",
      "padding:0;",
      "white-space:nowrap;"
    );

    titleWrap.append(hint, hintCount);

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
      "line-height:1.4;",
      "margin:0;"
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
      "flex:1;min-height:0;width:100%;resize:none;padding:10px 12px;border-radius:10px;",
      "border:1px solid rgba(255,255,255,.18);background:#0b0b0b;color:#eee;",
      "font:12.5px/1.45 ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;outline:none;"
    );

    function escapeRegExp(s) {
      return String(s || "").replace(/[.*+?^{}$()|[\]\\]/g, "\\$&");
    }

    function updateEntryCount() {
      const el = document.getElementById("a-translator-entry-count");
      if (!el || !textarea) return;

      let n = 0;
      for (const line of String(textarea.value || "").split("\n")) {
        const l = line.trim();
        if (!l || l.startsWith("#")) continue;

        const idx = l.indexOf("=");
        if (idx === -1) continue;

        const left = l.slice(0, idx).trim();
        const right = l.slice(idx + 1).trim();
        if (!left || !right) continue;

        n++;
      }

      const meta = loadMeta();
      const lang = String(meta.lang || "und").trim().toLowerCase();
      const dictVersion = String(meta.dictVersion || "0").trim();

      const safeLang = lang.replace(/[^a-z0-9-]/g, "") || "und";
      const safeVer = dictVersion.replace(/[^0-9A-Za-z._-]/g, "") || "0";

      el.textContent = `LANG : ${safeLang.toUpperCase()} V${safeVer.toUpperCase()} • ${n} entries`;
    }

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
      "border-top:1px solid rgba(255,255,255,.12);"
    );

    const footerLeft = document.createElement("div");
    footerLeft.style.cssText = css(
      "display:flex;align-items:center;gap:10px;",
      "justify-content:flex-start;"
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

    const btnClose = makePillButton("Close", [
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
    attachTooltip(btnSave, "Save and apply translations", "top");
    hoverBg(btnSave, "rgba(40,120,70,.55)", "rgba(70,170,110,.9)");

    const btnUninstall = makePillButton("Uninstall A-Translator", [
      "background:rgba(120,40,40,.55);",
      "color:#f3f3f3;",
      "font-weight:500;"
    ]);
    btnUninstall.removeAttribute("title");
    attachTooltip(btnUninstall, "Remove A-Translator and delete stored dictionary", "top");
    hoverBg(btnUninstall, "rgba(120,40,40,.55)", "rgba(150,50,50,.7)");

    btnUninstall.addEventListener("click", () => {
      const ok = confirm(
        "Uninstall A-Translator?\n\nThis will remove the translator and delete the stored dictionary.\nYou will need to reload Alchemy page."
      );
      if (!ok) return;
      uninstall();
    });

    footerLeft.append(btnUninstall);
    footerRight.append(btnSave, btnClose);
    footer.append(footerLeft, footerRight);

    panel.append(header, body, footer);
    overlay.append(panel);
    document.documentElement.appendChild(overlay);

    updateEntryCount();
    textarea.focus();

    const close = () => overlay.remove();

    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close();
    });
    btnClose.addEventListener("click", close);

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

    applyTranslations();
    close();
  });

  overlay.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
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
