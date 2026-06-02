// ==UserScript==
// @name         A-TranslatorW
// @namespace    https://github.com/BriocheMasquee
// @version      2.0.0
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

  // V2 dictionary pack storage. These keys are added without replacing the legacy
  // single-dictionary storage yet, so v1.x data remains fully compatible.
  const KEY_DICT_PACKS = "__alchemy_translate_dict_packs__";
  const KEY_ACTIVE_PACK_IDS = "__alchemy_translate_active_pack_ids__";

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
        let sourceDict = null;

        try {
          const packs = loadDictionaryPacks();
          const activeIds = loadActivePackIds();

          if (Object.keys(packs).length > 0 && activeIds.length > 0) {
            const normalizedActiveIds = normalizeActivePackIds(packs, activeIds);
            if (JSON.stringify(normalizedActiveIds) !== JSON.stringify(activeIds)) {
              saveActivePackIds(normalizedActiveIds);
            }
            sourceDict = compileActiveDictionary(packs, normalizedActiveIds);
          }
        } catch (_) {}

        if (!sourceDict) {
          try {
            sourceDict = JSON.parse(localStorage.getItem(KEY_DICT) || "{}");
          } catch (_) {
            sourceDict = {};
          }
        }

        const next = new Map();
        for (const [k, v] of Object.entries(sourceDict)) {
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
          let changed = false;

          if (Array.isArray(raw)) {
           for (const s of raw) {
              if (typeof s !== "string") continue;
              const k = this._normUserText(s);
              if (!k) continue;
              if (k.length > 200) continue;
              if (this.dict.has(k)) {
                changed = true;
                continue;
              }
             next.push(k);
           }
         }

          if (next.length > this.userTextsMax) {
            next.splice(0, next.length - this.userTextsMax);
          }

          this.userTexts = new Set(next);
          if (changed || this.userTexts.size !== next.length) this.saveUserTextsToStorage();
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
        if (this.dict.has(key)) return false;

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
        if (t) return s.replace(trimmed, t);

        const punctuated = trimmed.match(/^(.+?)([:：;])$/);
        if (punctuated) {
          const base = punctuated[1].trim().toLowerCase();
          const baseTranslation = this.dict.get(base);
          if (baseTranslation) return s.replace(trimmed, baseTranslation + punctuated[2]);
        }

        return null;
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
        if (norm && this.userTexts.has(norm) && !this.dict.has(norm)) {
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

  // V2 preparation: migrate the current legacy dictionary into the new pack
  // storage without changing the active translation behavior yet.
  ensureDictionaryPackMigration();
  migrateLocalPacksToUserOverrides();

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
      "position:fixed;",
      "padding:6px 8px;",
      "border-radius:10px;",
      "background:rgba(18,18,20,.92);",
      "border:1px solid rgba(255,255,255,.12);",
      "color:rgba(255,255,255,.92);",
      "font:12px/1.2 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;",
      "width:max-content;",
      "max-width:min(300px, calc(100vw - 48px));",
      "white-space:normal;",
      "box-shadow:0 10px 30px rgba(0,0,0,.45);",
      "backdrop-filter: blur(8px);",
      "pointer-events:none;",
      "opacity:0;",
      "visibility:hidden;",
      "transition:opacity .12s ease, transform .12s ease;",
      "z-index:2147483647;"
    );

    const place = () => {
      const rect = target.getBoundingClientRect();
      const margin = 12;
      const gap = 10;

      tip.style.left = "0";
      tip.style.top = "0";
      tip.style.transform = "none";

      const tipRect = tip.getBoundingClientRect();
      let left = rect.left + rect.width / 2 - tipRect.width / 2;
      let top = rect.bottom + gap;

      if (position === "top") {
        top = rect.top - tipRect.height - gap;
      } else if (position === "right") {
        left = rect.right + gap;
        top = rect.top + rect.height / 2 - tipRect.height / 2;
      } else if (position === "panel-right") {
        const panelRect =
          target.closest?.("#alchemy-translate-editor > div")?.getBoundingClientRect() ||
          target.closest?.("#alchemy-translate-editor")?.getBoundingClientRect() ||
          rect;
        left = panelRect.right + gap;
        if (left + tipRect.width + margin > window.innerWidth) {
          left = panelRect.left - tipRect.width - gap;
        }
        top = rect.top + rect.height / 2 - tipRect.height / 2;
      }

      left = Math.max(margin, Math.min(left, window.innerWidth - tipRect.width - margin));
      top = Math.max(margin, Math.min(top, window.innerHeight - tipRect.height - margin));
      tip.style.left = left + "px";
      tip.style.top = top + "px";
    };

    const show = () => {
      if (!tip.parentElement) document.documentElement.appendChild(tip);
      tip.style.visibility = "visible";
      tip.style.opacity = "1";
      place();
    };

    const hide = () => {
      tip.style.opacity = "0";
      tip.style.visibility = "hidden";
      tip.remove();
    };

    const computed = window.getComputedStyle(target).position;
    if (computed === "static") target.style.position = "relative";

    target.addEventListener("mouseenter", show);
    target.addEventListener("mouseleave", hide);
    target.addEventListener("focus", show);
    target.addEventListener("blur", hide);
    window.addEventListener("resize", place);
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

  function loadDictionaryPacks() {
    try {
      const raw = JSON.parse(localStorage.getItem(KEY_DICT_PACKS) || "{}");
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
      return raw;
    } catch (_) {
      return {};
    }
  }

  function saveDictionaryPacks(packs) {
    try {
      localStorage.setItem(KEY_DICT_PACKS, JSON.stringify(packs || {}));
    } catch (_) {}
  }

  function loadActivePackIds() {
    try {
      const raw = JSON.parse(localStorage.getItem(KEY_ACTIVE_PACK_IDS) || "[]");
      if (!Array.isArray(raw)) return [];
      return raw.map((id) => String(id || "").trim()).filter(Boolean);
    } catch (_) {
      return [];
    }
  }

  function saveActivePackIds(ids) {
    try {
      const cleaned = Array.isArray(ids)
        ? ids.map((id) => String(id || "").trim()).filter(Boolean)
        : [];
      localStorage.setItem(KEY_ACTIVE_PACK_IDS, JSON.stringify(cleaned));
    } catch (_) {}
  }

  function buildLegacyDictionaryPack() {
    const entries = loadDictionary();
    const meta = loadMeta();
    const count = Object.keys(entries).length;

    if (count === 0) return null;

    return {
      meta: {
        id: meta.id || "legacy-local",
        name: meta.name || "Legacy local dictionary",
        lang: meta.lang || "und",
        type: meta.type || "core",
        dictVersion: meta.dictVersion || "0",
        scriptVersion: meta.scriptVersion || SCRIPT_VERSION,
        source: meta.source || "legacy",
        sourceLabel: meta.sourceLabel || "Legacy local storage",
        sourceUrl: meta.sourceUrl || "",
        importedAt: meta.importedAt || null,
        migratedAt: new Date().toISOString()
      },
      entries
    };
  }

  function ensureDictionaryPackMigration() {
    const packs = loadDictionaryPacks();
    const activeIds = loadActivePackIds();

    if (Object.keys(packs).length > 0 || activeIds.length > 0) {
      return { packs, activeIds };
    }

    const legacyPack = buildLegacyDictionaryPack();
    if (!legacyPack) return { packs: {}, activeIds: [] };

    const id = String(legacyPack.meta.id || "legacy-local").trim() || "legacy-local";
    const nextPacks = { [id]: legacyPack };
    const nextActiveIds = [id];

    saveDictionaryPacks(nextPacks);
    saveActivePackIds(nextActiveIds);

    console.log("[A-Translator] migrated legacy dictionary to dictionary packs:", id);
    return { packs: nextPacks, activeIds: nextActiveIds };
  }

  function migrateLocalPacksToUserOverrides() {
    const packs = loadDictionaryPacks();
    const activeIds = loadActivePackIds();
    const activeSet = new Set(activeIds);
    let changed = false;

    for (const [id, pack] of Object.entries(packs)) {
      if (!pack || typeof pack !== "object") continue;

      const meta = pack.meta && typeof pack.meta === "object" ? pack.meta : {};
      const source = String(meta.source || "").trim().toLowerCase();
      const type = String(meta.type || "").trim().toLowerCase();
      const lang = String(meta.lang || "und").trim().toLowerCase() || "und";

      const shouldMigrate =
        source === "local" &&
        (id.endsWith("-local") || String(meta.id || "").endsWith("-local"));

      if (!shouldMigrate) continue;

      const nextId = lang !== "und" ? `${lang}-user` : "user-overrides";

      packs[nextId] = {
        meta: {
          ...meta,
          id: nextId,
          name: meta.name || "User overrides",
          lang,
          type: "user",
          source: "user",
          sourceLabel: "User overrides",
          migratedFrom: id,
          migratedAt: new Date().toISOString()
        },
        entries: pack.entries || {}
      };

      delete packs[id];
      activeSet.delete(id);
      activeSet.add(nextId);
      changed = true;
    }

    for (const [id, pack] of Object.entries(packs)) {
      if (String(pack?.meta?.type || "").toLowerCase() === "user") {
        activeSet.add(id);
      }
    }

    if (changed) {
      saveDictionaryPacks(packs);
      saveActivePackIds(Array.from(activeSet));
      console.log("[A-Translator] migrated local packs to user overrides");
    }
  }

  function compileActiveDictionary(packs = loadDictionaryPacks(), activeIds = loadActivePackIds()) {
    const compiled = {};

    for (const id of activeIds) {
      const pack = packs[id];
      if (!pack || !pack.entries || typeof pack.entries !== "object" || Array.isArray(pack.entries)) continue;

      for (const [k, v] of Object.entries(pack.entries)) {
        const src = String(k || "").trim().toLowerCase();
        const dst = String(v || "").trim();
        if (!src || !dst) continue;
        compiled[src] = dst;
      }
    }

    return compiled;
  }

  function getDictionaryPackType(pack) {
    return String(pack?.meta?.type || "custom").trim().toLowerCase();
  }

  function getDictionaryPackLang(pack) {
    return String(pack?.meta?.lang || "und").trim().toLowerCase() || "und";
  }

  function normalizeActivePackIds(packs, desiredIds, preferredLang = "") {
    const safePacks = packs && typeof packs === "object" && !Array.isArray(packs) ? packs : {};
    const desired = Array.isArray(desiredIds)
      ? desiredIds.map((id) => String(id || "").trim()).filter(Boolean)
      : [];

    const desiredSet = new Set(desired);
    let activeLang = String(preferredLang || "").trim().toLowerCase();

    if (!activeLang) {
      for (const id of desired) {
        const pack = safePacks[id];
        if (!pack) continue;
        if (getDictionaryPackType(pack) === "core") {
          activeLang = getDictionaryPackLang(pack);
          break;
        }
      }
    }

    if (!activeLang) {
      for (const id of desired) {
        const pack = safePacks[id];
        if (!pack) continue;
        activeLang = getDictionaryPackLang(pack);
        break;
      }
    }

    if (!activeLang) activeLang = "und";

    const active = [];
    const add = (id) => {
      if (!id || active.includes(id)) return;
      const pack = safePacks[id];
      if (!pack) return;
      if (getDictionaryPackLang(pack) !== activeLang) return;
      active.push(id);
    };

    const desiredCoreId = desired.find((id) => {
      const pack = safePacks[id];
      return pack && getDictionaryPackType(pack) === "core" && getDictionaryPackLang(pack) === activeLang;
    });

    const fallbackCoreId = Object.keys(safePacks).find((id) => {
      const pack = safePacks[id];
      return pack && getDictionaryPackType(pack) === "core" && getDictionaryPackLang(pack) === activeLang;
    });

    add(desiredCoreId || fallbackCoreId);

    for (const id of desired) {
      const pack = safePacks[id];
      if (!pack) continue;
      const type = getDictionaryPackType(pack);
      if (type === "core" || type === "user") continue;
      add(id);
    }

    for (const [id, pack] of Object.entries(safePacks)) {
      if (!pack) continue;
      if (getDictionaryPackType(pack) !== "user") continue;
      if (getDictionaryPackLang(pack) !== activeLang) continue;
      if (desiredSet.has(id)) add(id);
    }

    return active;
  }

  function saveDictionaryPackOnly(meta, entries) {
    const safeMeta = meta && typeof meta === "object" ? { ...meta } : {};
    const safeEntries = entries && typeof entries === "object" && !Array.isArray(entries) ? entries : {};

    const lang = String(safeMeta.lang || "und").trim().toLowerCase() || "und";
    const type = String(safeMeta.type || "core").trim().toLowerCase() || "core";
    const fallbackId = lang && lang !== "und" ? lang + "-" + type : "legacy-local";
    const id = String(safeMeta.id || fallbackId).trim() || fallbackId;

    const pack = {
      meta: {
        ...safeMeta,
        id,
        name: safeMeta.name || safeMeta.label || "Local dictionary",
        lang,
        type,
        dictVersion: safeMeta.dictVersion || "0",
        scriptVersion: safeMeta.scriptVersion || SCRIPT_VERSION,
        updatedAt: new Date().toISOString()
      },
      entries: safeEntries
    };

    const packs = loadDictionaryPacks();
    packs[id] = pack;
    saveDictionaryPacks(packs);

    return pack;
  }

  function saveCurrentDictionaryAsActivePack(meta, entries) {
    const safeMeta = meta && typeof meta === "object" ? { ...meta } : {};
    const safeEntries = entries && typeof entries === "object" && !Array.isArray(entries) ? entries : {};

    const lang = String(safeMeta.lang || "und").trim().toLowerCase() || "und";
    const fallbackId = lang && lang !== "und" ? lang + "-core" : "legacy-local";
    const id = String(safeMeta.id || fallbackId).trim() || fallbackId;

    const pack = {
      meta: {
        ...safeMeta,
        id,
        name: safeMeta.name || safeMeta.label || "Local dictionary",
        lang,
        type: safeMeta.type || "core",
        dictVersion: safeMeta.dictVersion || "0",
        scriptVersion: safeMeta.scriptVersion || SCRIPT_VERSION,
        updatedAt: new Date().toISOString()
      },
      entries: safeEntries
    };

    const packs = loadDictionaryPacks();
    packs[id] = pack;

    const savedType = String(pack.meta.type || "core").trim().toLowerCase();
    const savedLang = String(pack.meta.lang || "und").trim().toLowerCase();
    const previousActiveIds = loadActivePackIds();
    const desiredActiveIds = savedType === "core"
      ? [id, ...previousActiveIds]
      : [...previousActiveIds, id];

    saveDictionaryPacks(packs);
    saveActivePackIds(normalizeActivePackIds(packs, desiredActiveIds, savedLang));

    return pack;
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

    if (!core.enabled) {
      core.scheduleApplyTouched();
      return;
    }

    core.ensureObserver();
    core.scheduleApplyTouched();

    if (core.dict.size > 0 && document.body) {
      setTimeout(() => {
        if (!core.enabled) return;
        core.scanTranslate(document.body);
      }, 0);
    }
  }

  function toggleCore(on) {
    core.setEnabled(!!on);
  }

  function inspectPageText(keys = []) {
    const requestedKeys = Array.isArray(keys) ? keys : [];
    const normalizedKeys = requestedKeys
      .map((key) => core._normUserText(key))
      .filter(Boolean);
    const wanted = new Set(normalizedKeys);
    const results = [];

    if (!document.body || wanted.size === 0) return results;

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;

    while ((node = walker.nextNode())) {
      const raw = node.nodeValue || "";
      const norm = core._normUserText(raw);
      if (!wanted.has(norm)) continue;

      const el = node.parentElement;
      results.push({
        text: raw,
        normalized: norm,
        translation: core.translateString(raw),
        storedOriginal: core.textOrig.get(node) || null,
        userTextProtected: core.userTexts.has(norm) && !core.dict.has(norm),
        dictionaryKey: core.dict.has(norm),
        inEditableText: core._isInEditableText(node),
        inChatUserMessage: core._isInChatUserMessage(node),
        inNotesItem: core._isInNotesItem(node),
        recentUserValue: core._isRecentUserValue(node),
        parent: el
          ? {
              tag: el.tagName,
              id: el.id || "",
              className: String(el.className || "").slice(0, 180),
              role: el.getAttribute?.("role") || "",
              ariaLabel: el.getAttribute?.("aria-label") || ""
            }
          : null
      });

      if (results.length >= 50) break;
    }

    return results;
  }

  function getDebugState(keys = []) {
    const packs = loadDictionaryPacks();
    const activeIds = loadActivePackIds();
    const normalizedActiveIds = normalizeActivePackIds(packs, activeIds);
    const compiled = compileActiveDictionary(packs, normalizedActiveIds);
    const requestedKeys = Array.isArray(keys) ? keys : [];

    return {
      enabled: core.enabled,
      activeIds,
      normalizedActiveIds,
      storedPackIds: Object.keys(packs),
      packSummary: Object.fromEntries(
        Object.entries(packs).map(([id, pack]) => [
          id,
          {
            type: getDictionaryPackType(pack),
            lang: getDictionaryPackLang(pack),
            entries: Object.keys(pack?.entries || {}).length
          }
        ])
      ),
      compiledEntries: Object.keys(compiled).length,
      requested: Object.fromEntries(
        requestedKeys.map((key) => {
          const normalized = String(key || "").trim().toLowerCase();
          return [key, compiled[normalized] || null];
        })
      ),
      userTextHits: Object.fromEntries(
        requestedKeys.map((key) => {
          const normalized = core._normUserText(key);
          return [key, normalized ? core.userTexts.has(normalized) : false];
        })
      ),
      translated: Object.fromEntries(
        requestedKeys.map((key) => [key, core.translateString(String(key || ""))])
      )
    };
  }

  function exportDict(entriesOverride = null, metaOverride = null) {
  const entries =
    entriesOverride && typeof entriesOverride === "object" && !Array.isArray(entriesOverride)
      ? entriesOverride
      : loadDictionary();
  const meta =
    metaOverride && typeof metaOverride === "object" && !Array.isArray(metaOverride)
      ? metaOverride
      : loadMeta();

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
            type: String(dict.type || "custom").trim().toLowerCase(),
            system: String(dict.system || "").trim().toLowerCase(),
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
    localStorage.removeItem(KEY_DICT_PACKS);
    localStorage.removeItem(KEY_ACTIVE_PACK_IDS);

    try { delete window.AlchemyTranslate; } catch (_) {}
    try { delete window.__AlchemyTranslateCore__; } catch (_) {}

    console.log("[A-Translator] uninstalled. Reloading…");
    setTimeout(() => location.reload(), 50);
  }

  function resetDictionary() {
    localStorage.removeItem(KEY_DICT);
    localStorage.removeItem(KEY_DICT_META);
    localStorage.removeItem(KEY_META_LEGACY);
    localStorage.removeItem(KEY_DICT_PACKS);
    localStorage.removeItem(KEY_ACTIVE_PACK_IDS);

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

    function loadDictionaryWithoutUserOverrides() {
      const packs = loadDictionaryPacks();
      const activeIds = loadActivePackIds();
      const idsWithoutUser = activeIds.filter((id) => {
        const pack = packs[id];
        const type = String(pack?.meta?.type || "").trim().toLowerCase();
        return type !== "user";
      });

      if (Object.keys(packs).length > 0 && idsWithoutUser.length > 0) {
        return compileActiveDictionary(packs, idsWithoutUser);
      }

      return loadDictionary();
    }

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

        if (cancelLabel) actions.append(btnCancel);
        actions.append(btnConfirm);
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

    const initialEnabled = loadEnabledFlag();
    let draftEnabled = initialEnabled;
    let editorHasUnsavedChanges = false;
    let draftTextEditedByUser = false;

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
    toggle.checked = draftEnabled;
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
      draftEnabled = toggle.checked;
      syncToggleUI(draftEnabled);
      updateUnsavedChangesState();
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

    const legalNote = document.createElement("div");
    legalNote.innerHTML =
      "Alchemy is © 2025 Arboreal, LLC. All rights reserved<br>" +
      "Community-driven Alchemy translator by La Brioche Masquée";
    legalNote.style.cssText = css(
      "width:100%;",
      "margin-top:auto;",
      "padding-top:4px;",
      "font-size:10px;",
      "line-height:1.35;",
      "opacity:.52;",
      "color:rgba(255,255,255,.76);",
      "text-align:center;"
    );

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

    const btnExport = makeDictionaryActionButton("Export active modules", EXPORT_SVG);
    btnExport.addEventListener("click", () => {
      const activeDraftEntries = Object.keys(draftPacks).length > 0
        ? compileActiveDictionary(draftPacks, draftActivePackIds)
        : draftDict;
      exportDict(activeDraftEntries, draftMeta);
    });

    const btnImport = makeDictionaryActionButton("Import (local)", IMPORT_LOCAL_SVG);

    const btnImportGithub = makeDictionaryActionButton("Import (GitHub)", IMPORT_GITHUB_SVG);


    async function loadGithubDictionaryDraft(url, sourceInfo = null) {
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

      let data;
      try {
        data = JSON.parse(await response.text());
      } catch (e) {
        console.error("[A-Translator] GitHub import: invalid JSON", e);
        return { ok: false, error: "Invalid JSON" };
      }

      let importedMeta = null;
      if (data && typeof data === "object" && !Array.isArray(data) && data.entries && typeof data.entries === "object") {
        importedMeta = data.meta && typeof data.meta === "object" ? data.meta : null;
        data = data.entries;
      }

      if (!data || typeof data !== "object" || Array.isArray(data)) {
        console.error("[A-Translator] GitHub import: JSON must be an object");
        return { ok: false, error: "JSON must be an object" };
      }

      const cleaned = {};
      for (const [k, v] of Object.entries(data)) {
        const src = String(k || "").trim().toLowerCase();
        const dst = String(v || "").trim();
        if (!src || !dst) continue;
        cleaned[src] = dst;
      }

      const previousMeta = draftMeta && typeof draftMeta === "object" ? draftMeta : loadMeta();
      const nextMeta = {
        ...previousMeta,
        ...(importedMeta || {}),
        id: sourceInfo?.id || previousMeta.id || "",
        name: sourceInfo?.name || sourceInfo?.label || previousMeta.name || "",
        lang: sourceInfo?.lang || importedMeta?.lang || previousMeta.lang || "und",
        dictVersion: sourceInfo?.dictVersion || importedMeta?.dictVersion || previousMeta.dictVersion || "0",
        type: sourceInfo?.type || importedMeta?.type || previousMeta.type || "custom",
        system: sourceInfo?.system || importedMeta?.system || previousMeta.system || "",
        description: sourceInfo?.description || previousMeta.description || "",
        source: "github",
        sourceLabel: "A-Translator official GitHub",
        sourceUrl: usedUrl || sourceInfo?.url || url,
        manifestUpdatedAt: sourceInfo?.manifestUpdatedAt || null,
        importedAt: new Date().toISOString()
      };

      return {
        ok: true,
        count: Object.keys(cleaned).length,
        entries: cleaned,
        meta: nextMeta
      };
    }

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
          "max-height:220px;",
          "overflow-y:auto;",
          "display:flex;",
          "flex-direction:column;",
          "gap:6px;",
          "padding:6px;",
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
            "padding:7px 10px;",
            "border-radius:10px;",
            "border:1px solid rgba(255,255,255,.10);",
            "background:rgba(255,255,255,.045);",
            "color:rgba(255,255,255,.92);",
            "cursor:pointer;",
            "display:flex;",
            "flex-direction:row;",
            "align-items:center;",
            "justify-content:space-between;",
            "gap:10px;",
            "text-align:left;",
            "white-space:nowrap;"
          );

          const itemTitle = document.createElement("span");
          itemTitle.textContent = dict.label || dict.name || dict.id || "Dictionary";
          itemTitle.style.cssText = css(
            "font-size:12px;",
            "font-weight:600;",
            "overflow:hidden;",
            "text-overflow:ellipsis;",
            "white-space:nowrap;"
          );

          const itemMeta = document.createElement("span");
          itemMeta.textContent = "v" + String(dict.dictVersion || "0");
          itemMeta.style.cssText = css(
            "font-size:11px;",
            "opacity:.62;",
            "flex-shrink:0;"
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
                message: dict.label || dict.name || dict.id || "Dictionary",
                confirmLabel: "Import",
                cancelLabel: "Cancel"
              });

            if (!ok) return;

            try {
              const res = await loadGithubDictionaryDraft(dict.url, dict);

              if (!res || res.ok === false) {
                await openConfirmDialog({
                  title: "GitHub import failed",
                  message: "The selected dictionary could not be imported. Check the console for details.",
                  confirmLabel: "OK",
                  cancelLabel: "Close"
                });
                return;
              }

              draftDict = res.entries;
              draftMeta = res.meta;
              draftBaseDict = { ...draftDict };
              draftTextEditedByUser = false;

              const importedPackId = String(draftMeta?.id || "").trim();
              const importedPackType = String(draftMeta?.type || "core").trim().toLowerCase();
              const importedPackLang = String(draftMeta?.lang || "und").trim().toLowerCase();

              if (importedPackId) {
                draftPacks = {
                  ...draftPacks,
                  [importedPackId]: {
                    meta: draftMeta,
                    entries: draftBaseDict
                  }
                };
                const desiredIds = importedPackType === "core"
                  ? [importedPackId, ...(draftActivePackIds || [])]
                  : [...(draftActivePackIds || []), importedPackId];
                draftActivePackIds = normalizeActivePackIds(draftPacks, desiredIds, importedPackLang);
              }

              filterQuery = "";
              searchInput.value = "";
              refreshTextarea();
              refreshCurrentDictionaryInfo();
              setUnsavedChanges(true);
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
      panel.style.height = dictionaryEditorVisible ? "88vh" : "auto";

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
        setTimeout(() => {
          body.scrollTop = 0;
          panel.scrollTop = 0;
          searchInput?.focus();
        }, 0);
      }
    });

    btnImport.addEventListener("click", (e) => {
      e.preventDefault();

      openConfirmDialog({
        title: "Import local dictionary",
        message: "Choose a local JSON dictionary module.",
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
    let draftMeta = loadMeta();
    let draftBaseDict = loadDictionaryWithoutUserOverrides();
    let fullText = dictToLines(draftDict);
    let currentFilteredKeys = null;
    let hasUnsavedChanges = false;

    const serializePackIds = (ids) => JSON.stringify(
      (Array.isArray(ids) ? ids : [])
        .map((id) => String(id || "").trim())
        .filter(Boolean)
        .sort()
    );

    let draftActivePackIds = loadActivePackIds();
    let draftPacks = loadDictionaryPacks();
    let savedActivePackIdsSnapshot = serializePackIds(draftActivePackIds);

    function saveUserOverridesFromDraft(meta, baseEntries, nextEntries) {
      const safeMeta = meta && typeof meta === "object" ? meta : {};
      const lang = String(safeMeta.lang || "und").trim().toLowerCase() || "und";
      const id = lang !== "und" ? lang + "-user" : "user-overrides";

      const packs = loadDictionaryPacks();
      const existingPack = packs[id] && typeof packs[id] === "object" ? packs[id] : null;
      const existingEntries = existingPack?.entries && typeof existingPack.entries === "object" && !Array.isArray(existingPack.entries)
        ? existingPack.entries
        : {};

      const entries = { ...existingEntries };
      const base = baseEntries && typeof baseEntries === "object" && !Array.isArray(baseEntries) ? baseEntries : {};
      const next = nextEntries && typeof nextEntries === "object" && !Array.isArray(nextEntries) ? nextEntries : {};

      for (const [k, v] of Object.entries(next)) {
        const src = String(k || "").trim().toLowerCase();
        const dst = String(v || "").trim();
        if (!src || !dst) continue;

        const baseDst = String(base[src] || "").trim();
        if (dst !== baseDst) entries[src] = dst;
        else delete entries[src];
      }

      for (const k of Object.keys(existingEntries)) {
        const src = String(k || "").trim().toLowerCase();
        if (!src) continue;
        if (!Object.prototype.hasOwnProperty.call(next, src)) delete entries[src];
      }

      for (const k of Object.keys(base)) {
        const src = String(k || "").trim().toLowerCase();
        if (!src) continue;
        if (!Object.prototype.hasOwnProperty.call(next, src)) delete entries[src];
      }

      if (Object.keys(entries).length === 0) {
        delete packs[id];
        draftActivePackIds = (draftActivePackIds || []).filter((packId) => packId !== id);
        saveDictionaryPacks(packs);
        return "";
      }

      packs[id] = {
        meta: {
          ...(existingPack?.meta || {}),
          id,
          name: existingPack?.meta?.name || "User overrides",
          lang,
          type: "user",
          dictVersion: existingPack?.meta?.dictVersion || "0",
          scriptVersion: SCRIPT_VERSION,
          source: "user",
          sourceLabel: "User overrides",
          updatedAt: new Date().toISOString()
        },
        entries
      };

      saveDictionaryPacks(packs);
      return id;
    }

    function updateUnsavedChangesState() {
      hasUnsavedChanges =
        editorHasUnsavedChanges ||
        draftEnabled !== initialEnabled ||
        serializePackIds(draftActivePackIds) !== savedActivePackIdsSnapshot;
      if (typeof unsavedChangesLabel !== "undefined") {
        unsavedChangesLabel.textContent = hasUnsavedChanges ? "Unsaved changes" : "";
      }
      if (typeof btnSave !== "undefined") {
        btnSave.disabled = !hasUnsavedChanges;
        btnSave.style.opacity = hasUnsavedChanges ? "1" : ".45";
        btnSave.style.cursor = hasUnsavedChanges ? "pointer" : "default";
      }
    }

    function setUnsavedChanges(value) {
      editorHasUnsavedChanges = !!value;
      updateUnsavedChangesState();
    }

    function refreshTextarea() {
      fullText = dictToLines(draftDict);
      renderTextarea();
    }

    function loadLocalDictionaryDraft(jsonText, mode = "replace", sourceInfo = {}) {
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
        importedMeta = data.meta && typeof data.meta === "object" ? data.meta : null;
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

      let addedCount = 0;
      if (mode === "merge") {
        for (const k of Object.keys(cleaned)) {
          if (!Object.prototype.hasOwnProperty.call(draftDict, k)) addedCount++;
        }
      } else {
        addedCount = Object.keys(cleaned).length;
      }

      const nextEntries = mode === "merge" ? { ...draftDict, ...cleaned } : cleaned;
      const previousMeta = draftMeta && typeof draftMeta === "object" ? draftMeta : loadMeta();
      const metaSource = importedMeta && typeof importedMeta === "object" ? importedMeta : {};

      const lang = String(metaSource.lang || previousMeta.lang || "und").trim().toLowerCase() || "und";
      const rawType = String(metaSource.type || "user").trim().toLowerCase();
      const importedType = ["core", "system", "custom", "user"].includes(rawType) ? rawType : "user";
      const fileStem = String(sourceInfo?.fileName || "")
        .replace(/\.[^.]+$/i, "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "");
      const userPackId = lang !== "und" ? lang + "-user" : "user-overrides";
      const fallbackId = importedType === "user"
        ? userPackId
        : fileStem || (lang !== "und" ? lang + "-" + importedType : importedType + "-local");
      let localId = String(metaSource.id || fallbackId).trim();

      if (importedType !== "user" && (localId === userPackId || localId === "user-overrides")) {
        localId += "-" + importedType;
      }

      const nextMeta = {
        ...metaSource,
        id: localId,
        name: metaSource.name || metaSource.label || (importedType === "user" ? "User overrides" : "Local " + importedType + " pack"),
        lang,
        type: importedType,
        dictVersion: metaSource.dictVersion || previousMeta.dictVersion || "0",
        scriptVersion: metaSource.scriptVersion || SCRIPT_VERSION,
        source: importedType === "user" ? "user" : "local",
        sourceLabel: importedType === "user" ? "User overrides" : "Local import",
        sourceUrl: "",
        importedAt: new Date().toISOString()
      };

      return {
        ok: true,
        count: addedCount,
        mode,
        entries: nextEntries,
        meta: nextMeta
      };
    }

    importInput.addEventListener("change", async () => {
      const file = importInput.files && importInput.files[0];
      if (!file) return;

      try {
        exportHint.textContent = "Importing…";
        const text = await file.text();
        const res = loadLocalDictionaryDraft(text, importMode, { fileName: file.name });

        if (!res || res.ok === false) {
          exportHint.textContent = "Import failed";
          return;
        }

        draftDict = res.entries;
        draftMeta = res.meta;
        draftBaseDict = { ...draftDict };
        draftTextEditedByUser = false;

        const importedPackId = String(draftMeta?.id || "").trim();
        const importedPackType = String(draftMeta?.type || "user").trim().toLowerCase();
        const importedPackLang = String(draftMeta?.lang || "und").trim().toLowerCase();

        if (importedPackId) {
          draftPacks = {
            ...draftPacks,
            [importedPackId]: {
              meta: draftMeta,
              entries: draftBaseDict
            }
          };
          const desiredIds = importedPackType === "core"
            ? [importedPackId, ...(draftActivePackIds || [])]
            : [...(draftActivePackIds || []), importedPackId];
          draftActivePackIds = normalizeActivePackIds(draftPacks, desiredIds, importedPackLang);
        }

        filterQuery = "";
        searchInput.value = "";
        refreshTextarea();
        refreshCurrentDictionaryInfo();
        setUnsavedChanges(true);

        exportHint.textContent = "Imported " + res.count + " new entries (" + res.mode + ")";
        setTimeout(() => (exportHint.textContent = ""), 2500);
      } catch (e) {
        console.error("[A-Translator] import error", e);
        exportHint.textContent = "Import error (see console)";
      } finally {
        importInput.value = "";
      }
    });

    dictActions.append(btnImportGithub, btnImport, btnExport, btnEditDictionary);
    exportRow.append(dictLabel, dictActions, legalNote, exportHint);

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
    currentDictionaryTitle.textContent = "Dictionary stack";
    currentDictionaryTitle.style.cssText = css(
      "font-size:13px;",
      "font-weight:700;",
      "opacity:.95;",
      "user-select:none;",
      "text-transform:uppercase;",
      "letter-spacing:.35px;"
    );

    const dictionaryPacksInfo = document.createElement("div");
    dictionaryPacksInfo.style.cssText = css(
      "width:100%;",
      "font-size:11px;",
      "line-height:1.45;",
      "opacity:.92;",
      "display:flex;",
      "flex-direction:column;",
      "gap:8px;"
    );

    function escapeHtml(value) {
      return String(value || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    }

    function getDictionaryPackDisplayName(pack, id) {
      const meta = pack && pack.meta && typeof pack.meta === "object" ? pack.meta : {};
      return String(meta.name || meta.label || id || "Dictionary pack").trim();
    }

    function getDictionaryPackSecondaryLabel(pack, id, countOverride = null) {
      const count = Number.isFinite(countOverride)
        ? countOverride
        : Object.keys(pack?.entries || {}).length;
      const entriesLabel = count === 1 ? "1 entry" : count + " entries";
      return entriesLabel;
    }

    function getDictionaryPackVersionLabel(pack) {
      const raw = String(pack?.meta?.dictVersion || "0").trim().replace(/^v\s*/i, "");
      return "v " + (raw || "0");
    }

    let updateAvailablePackIds = new Set();
    let pendingDictionaryUpdatesByPackId = new Map();

    function renderDictionaryPacksInfo() {
      const packs = draftPacks && typeof draftPacks === "object" && !Array.isArray(draftPacks)
        ? draftPacks
        : loadDictionaryPacks();
      const activeIds = Array.isArray(draftActivePackIds) ? draftActivePackIds : loadActivePackIds();
      const activeSet = new Set(activeIds);

      const allPacks = Object.entries(packs || {})
        .map(([id, pack]) => ({ id, pack }))
        .filter(({ pack }) => !!pack);

      const activePacks = allPacks.filter(({ id }) => activeSet.has(id));
      const inactivePacks = allPacks.filter(({ id }) => !activeSet.has(id));

      const getPackType = getDictionaryPackType;
      const getPackLang = getDictionaryPackLang;

      const preferredLang = String(draftMeta?.lang || "").trim().toLowerCase();
      const fallbackCorePack = allPacks.find(({ pack }) => {
        if (getPackType(pack) !== "core") return false;
        if (!preferredLang) return true;
        return getPackLang(pack) === preferredLang;
      });
      const corePacks = activePacks.filter(({ pack }) => getPackType(pack) === "core");
      const activeLang = getPackLang(corePacks[0]?.pack || activePacks[0]?.pack || fallbackCorePack?.pack || null);

      const sameLanguage = ({ pack }) => getPackLang(pack) === activeLang;

      const languagePacks = allPacks
        .filter(sameLanguage)
        .filter(({ pack }) => getPackType(pack) === "core");

      const systemPacks = activePacks.filter(({ pack }) => getPackType(pack) === "system");
      const customPacks = activePacks.filter(({ pack }) => getPackType(pack) === "custom");
      const userPacks = activePacks.filter(({ pack }) => getPackType(pack) === "user");

      const availableSystemPacks = inactivePacks
        .filter(sameLanguage)
        .filter(({ pack }) => getPackType(pack) === "system");

      const availableCustomPacks = inactivePacks
        .filter(sameLanguage)
        .filter(({ pack }) => getPackType(pack) === "custom");

      const availableUserPacks = inactivePacks
        .filter(sameLanguage)
        .filter(({ pack }) => getPackType(pack) === "user");

      const sortPackItems = (items) =>
        [...items].sort((a, b) =>
          getDictionaryPackDisplayName(a.pack, a.id).localeCompare(
            getDictionaryPackDisplayName(b.pack, b.id),
            undefined,
            { sensitivity: "base" }
          )
        );

      const getEffectiveEntryCount = ({ id, pack }) => {
        const entries = pack?.entries && typeof pack.entries === "object" && !Array.isArray(pack.entries)
          ? pack.entries
          : {};
        const rawCount = Object.keys(entries).length;
        const type = getPackType(pack);

        if (type === "core" || type === "user") return rawCount;

        const baseTypes = type === "system" ? new Set(["core"]) : new Set(["core", "system"]);
        const baseIds = activeIds.filter((otherId) => {
          if (otherId === id) return false;
          const otherPack = packs[otherId];
          if (!otherPack) return false;
          return baseTypes.has(getPackType(otherPack));
        });

        if (baseIds.length === 0) return rawCount;

        const baseDict = compileActiveDictionary(packs, baseIds);
        let count = 0;

        for (const [k, v] of Object.entries(entries)) {
          const src = String(k || "").trim().toLowerCase();
          const dst = String(v || "").trim();
          if (!src || !dst) continue;
          if (baseDict[src] !== dst) count++;
        }

        return count;
      };

      const renderPackLine = ({ id, pack }, active = true, config) => {
        const name = getDictionaryPackDisplayName(pack, id);
        const type = getPackType(pack);
        const packId = String(id || "").trim();
        const opacity = active ? "1" : ".62";
        const supportsUpdateStatus = type === "core" || type === "system";
        const hasUpdate = updateAvailablePackIds.has(packId);
        const statusHtml = active && supportsUpdateStatus
          ? hasUpdate
            ? "<button type='button' class='at-pack-update' data-pack-id='" + escapeHtml(packId) + "' style='appearance:none;padding:0;margin:0;border:0;background:transparent;color:rgba(255,95,95,.95);font:inherit;font-size:9.5px;font-weight:800;line-height:1;cursor:pointer;text-transform:lowercase;'>update</button>"
            : "<span style='font-size:9.5px;font-weight:600;color:rgba(255,255,255,.42);'>up to date</span>"
          : "";
        const entryCount = getEffectiveEntryCount({ id, pack });
        const secondaryHtml = type === "user"
          ? ""
          : "<span style='font-size:9.5px;font-weight:600;color:rgba(255,255,255,.42);'>· " + escapeHtml(getDictionaryPackSecondaryLabel(pack, id, entryCount)) + "</span>" +
            (statusHtml ? "<span style='font-size:9.5px;font-weight:600;color:rgba(255,255,255,.42);'>·</span>" + statusHtml : "");
        const label = type === "user" ? getDictionaryPackSecondaryLabel(pack, id, entryCount) : getDictionaryPackVersionLabel(pack);
        const toggleBg = active ? "rgba(70,190,110,.09)" : "rgba(255,255,255,.018)";
        const toggleBorder = active ? "rgba(90,220,135,.36)" : "rgba(255,255,255,.10)";
        const toggleColor = active ? "rgba(95,220,140,.68)" : "rgba(255,255,255,.22)";

        return "<div class='at-pack-row' data-pack-id='" + escapeHtml(id) + "' style='display:grid;grid-template-columns:18px minmax(0,1fr) auto;column-gap:8px;align-items:center;width:100%;min-width:0;cursor:default;opacity:" + opacity + ";text-align:left;'>" +
          "<button type='button' class='at-pack-toggle' aria-label='" + (active ? "Disable " : "Enable ") + escapeHtml(name) + "' style='appearance:none;padding:0;margin:0;width:16px;height:16px;border-radius:5px;border:1px solid " + toggleBorder + ";background:" + toggleBg + ";color:" + toggleColor + ";font-size:10px;font-weight:800;line-height:14px;display:inline-flex;align-items:center;justify-content:center;box-shadow:inset 0 1px 0 rgba(255,255,255,.06);cursor:pointer;'>" + (active ? "&#10003;" : "") + "</button>" +
          "<span style='min-width:0;display:flex;align-items:baseline;justify-content:flex-start;gap:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:left;'>" +
            "<span style='font-size:11.5px;font-weight:700;color:rgba(255,255,255,.92);overflow:hidden;text-overflow:ellipsis;text-align:left;'>" + escapeHtml(name) + "</span>" +
            "<span style='display:inline-flex;align-items:baseline;gap:5px;min-width:0;overflow:hidden;text-overflow:ellipsis;text-align:left;'>" + secondaryHtml + "</span>" +
          "</span>" +
          "<span style='padding:2px 7px;border-radius:5px;background:" + config.badgeBg + ";color:rgba(255,255,255,.88);font-size:10.5px;font-weight:700;white-space:nowrap;justify-self:end;'>" + escapeHtml(label) + "</span>" +
        "</div>";
      };

      const renderSection = (config, items, emptyText) => {
        const infoButton = config.info
          ? "<button type='button' class='at-section-info' data-info-title='" + escapeHtml(config.title) + "' data-info-text='" + escapeHtml(config.info) + "' aria-label='About " + escapeHtml(config.title) + "' style='appearance:none;padding:0;margin:0;width:13px;height:13px;border-radius:999px;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.03);color:rgba(255,255,255,.50);font-size:8px;font-weight:800;line-height:11px;display:inline-flex;align-items:center;justify-content:center;cursor:help;position:absolute;right:0;top:50%;transform:translateY(-50%);'>?</button>"
          : "";
        const titlePadding = config.info ? "18px" : "0";
        let body = "";
        if (!items.length) {
          body += "<div style='font-size:11.5px;color:rgba(255,255,255,.55);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;'>" +
            escapeHtml(config.unavailableText || emptyText) +
          "</div>";
        } else {
          body += items
            .map((item) => renderPackLine(item, activeSet.has(item.id), config))
            .join("");
        }

        return "<div style='display:grid;grid-template-columns:34px minmax(0,1fr);column-gap:8px;align-items:center;min-height:58px;padding:10px 12px;border-radius:10px;border:1px solid rgba(255,255,255,.10);border-left:2px solid " + config.color + ";background:linear-gradient(135deg," + config.bg + ",rgba(255,255,255,.025));box-shadow:inset 0 1px 0 rgba(255,255,255,.04);text-align:left;'>" +
          "<div style='width:24px;height:24px;display:flex;align-items:center;justify-content:center;color:" + config.color + ";'>" + config.icon + "</div>" +
          "<div style='min-width:0;display:flex;flex-direction:column;align-items:flex-start;gap:3px;text-align:left;'>" +
            "<div style='min-width:0;text-align:left;line-height:16px;height:16px;'>" +
              "<span style='position:relative;display:inline-block;padding-right:" + titlePadding + ";font-size:12px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:" + config.color + ";text-align:left;white-space:nowrap;line-height:16px;'>" + config.title + infoButton + "</span>" +
            "</div>" +
            "<div style='display:flex;flex-direction:column;align-items:stretch;gap:7px;width:100%;min-width:0;'>" + body + "</div>" +
          "</div>" +
        "</div>";
      };

      const icons = {
        language:
          "<svg width='28' height='28' viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg'>" +
          "<circle cx='12' cy='12' r='9' stroke='currentColor' stroke-width='2'/>" +
          "<path d='M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9S14.5 18.4 12 21c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/>" +
          "</svg>",
        system:
          "<svg width='28' height='28' viewBox='0 0 24 24' fill='currentColor' xmlns='http://www.w3.org/2000/svg'>" +
          "<path d='M9 3a3 3 0 0 1 6 0v2h3a2 2 0 0 1 2 2v3h-2a3 3 0 1 0 0 6h2v3a2 2 0 0 1-2 2h-4v-2a3 3 0 1 0-6 0v2H6a2 2 0 0 1-2-2v-4h2a3 3 0 1 0 0-6H4V7a2 2 0 0 1 2-2h3V3z'/>" +
          "</svg>",
        custom:
          "<svg width='28' height='28' viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg'>" +
          "<path d='M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z' stroke='currentColor' stroke-width='2' stroke-linejoin='round'/>" +
          "<path d='M4.5 8L12 12.2 19.5 8M12 12.2V21' stroke='currentColor' stroke-width='2' stroke-linejoin='round'/>" +
          "</svg>",
        user:
          "<svg width='28' height='28' viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg'>" +
          "<path d='M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z' stroke='currentColor' stroke-width='2'/>" +
          "<path d='M4 21a8 8 0 0 1 16 0' stroke='currentColor' stroke-width='2' stroke-linecap='round'/>" +
          "</svg>"
      };

      dictionaryPacksInfo.innerHTML =
        renderSection({ title: "Language", type: "core", color: "#5fa2ff", bg: "rgba(65,140,255,.13)", badgeBg: "rgba(65,120,190,.55)", icon: icons.language, unavailableText: "No language available", info: "Base Alchemy UI translation for one language. Disable it to turn off the active translation stack." }, sortPackItems(languagePacks), "No active language") +
        renderSection({ title: "Game systems", type: "system", color: "#b978ff", bg: "rgba(170,95,255,.13)", badgeBg: "rgba(115,70,160,.55)", icon: icons.system, unavailableText: "No system dictionary available", info: "Translations for the interface of a specific game system. It does not translate that system's rules or content." }, sortPackItems([...systemPacks, ...availableSystemPacks]), "No system dictionary active") +
        renderSection({ title: "Custom packs", type: "custom", color: "#ff9440", bg: "rgba(255,145,65,.13)", badgeBg: "rgba(170,95,40,.55)", icon: icons.custom, unavailableText: "No custom pack available", info: "Optional add-on dictionaries for homebrew, table-specific vocabulary, or extra UI terms." }, sortPackItems([...customPacks, ...availableCustomPacks]), "No custom pack active") +
        renderSection({ title: "User overrides", type: "user", color: "#48c879", bg: "rgba(70,190,110,.13)", badgeBg: "rgba(50,130,75,.55)", icon: icons.user, unavailableText: "No user overrides available", info: "Your personal edits. These entries are applied after other modules and can override them." }, sortPackItems([...userPacks, ...availableUserPacks]), "No user overrides");

      dictionaryPacksInfo.querySelectorAll(".at-section-info").forEach((button) => {
        const showInfo = () => {
          setCurrentDictionaryStatus(button.dataset.infoText || "", "rgba(255,255,255,.68)", true);
        };
        const hideInfo = () => {
          restoreCurrentDictionaryStatus();
        };

        button.addEventListener("mouseenter", showInfo);
        button.addEventListener("mouseleave", hideInfo);
        button.addEventListener("focus", showInfo);
        button.addEventListener("blur", hideInfo);
      });

      dictionaryPacksInfo.querySelectorAll(".at-pack-update").forEach((button) => {
        button.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          updateDictionaryPack(button.dataset.packId || "");
        });
      });

      dictionaryPacksInfo.querySelectorAll(".at-pack-toggle").forEach((button) => {
        button.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();

          const row = button.closest(".at-pack-row");
          const packId = row.dataset.packId;
          if (!packId) return;

          const pack = packs[packId];
          if (!pack) return;

          const type = getPackType(pack);

          if (type === "core") {
            if (activeSet.has(packId)) {
              draftActivePackIds = [];
              draftEnabled = false;
            } else {
              draftEnabled = true;
              draftActivePackIds = normalizeActivePackIds(packs, [packId], getPackLang(pack));
            }

            updateUnsavedChangesState();
            renderDictionaryPacksInfo();
            return;
          }

          const nextActiveIds = new Set(draftActivePackIds);

          if (nextActiveIds.has(packId)) {
            nextActiveIds.delete(packId);
          } else {
            nextActiveIds.add(packId);
            draftEnabled = true;
          }

          draftActivePackIds = draftEnabled
            ? normalizeActivePackIds(packs, Array.from(nextActiveIds), activeLang)
            : [];
          updateUnsavedChangesState();
          renderDictionaryPacksInfo();
        });
      });
    }

    function refreshCurrentDictionaryInfo() {
      updateAvailablePackIds = new Set();
      renderDictionaryPacksInfo();
      refreshCurrentDictionaryStatus();
    }

    const currentDictionaryFooter = document.createElement("div");
    currentDictionaryFooter.style.cssText = css(
      "width:100%;",
      "margin-top:auto;",
      "padding-top:0;",
      "border-top:0;",
      "display:flex;",
      "flex-direction:row;",
      "align-items:center;",
      "justify-content:space-between;",
      "gap:10px;"
    );

    const currentDictionaryStatus = document.createElement("div");
    currentDictionaryStatus.textContent = "Status: Up to date";
    currentDictionaryStatus.style.cssText = css(
      "font-size:11px;",
      "line-height:1.25;",
      "opacity:.82;",
      "white-space:normal;",
      "min-width:0;",
      "flex:1 1 auto;",
      "color:rgba(255,255,255,.78);"
    );

    let currentDictionaryStatusBase = {
      text: currentDictionaryStatus.textContent,
      color: currentDictionaryStatus.style.color || "rgba(255,255,255,.78)"
    };

    function setCurrentDictionaryStatus(text, color = "rgba(255,255,255,.78)", temporary = false) {
      currentDictionaryStatus.textContent = text;
      currentDictionaryStatus.style.color = color;
      if (!temporary) {
        currentDictionaryStatusBase = { text, color };
      }
    }

    function restoreCurrentDictionaryStatus() {
      currentDictionaryStatus.textContent = currentDictionaryStatusBase.text;
      currentDictionaryStatus.style.color = currentDictionaryStatusBase.color;
    }

    async function refreshCurrentDictionaryStatus() {
      pendingDictionaryUpdatesByPackId = new Map();
      updateAvailablePackIds = new Set();

      const packs = draftPacks && typeof draftPacks === "object" && !Array.isArray(draftPacks)
        ? draftPacks
        : {};
      const activeSet = new Set(Array.isArray(draftActivePackIds) ? draftActivePackIds : []);
      const candidates = Object.entries(packs).filter(([id, pack]) => {
        if (!activeSet.has(id)) return false;
        const type = getDictionaryPackType(pack);
        if (type !== "core" && type !== "system") return false;
        const meta = pack?.meta && typeof pack.meta === "object" ? pack.meta : {};
        return String(meta.source || "").toLowerCase() === "github" && !!meta.id;
      });

      if (Object.keys(packs).length === 0) {
        setCurrentDictionaryStatus("Status:", "rgba(255,255,255,.55)");
        return;
      }

      if (candidates.length === 0) {
        setCurrentDictionaryStatus("Status: Local dictionary", "rgba(255,255,255,.62)");
        return;
      }

      setCurrentDictionaryStatus("Status: Checking…", "rgba(120,190,255,.92)");

      try {
        const dictionaries = await listGithubDictionaries();

        for (const [id, pack] of candidates) {
          const meta = pack?.meta && typeof pack.meta === "object" ? pack.meta : {};
          const remote = dictionaries.find((dict) => {
            if (meta.id && dict.id === meta.id) return true;
            if (meta.sourceUrl && dict.url === meta.sourceUrl) return true;
            return false;
          });
          if (!remote) continue;

          const localVersion = String(meta.dictVersion || "0");
          const remoteVersion = String(remote.dictVersion || "0");
          if (compareDictionaryVersions(remoteVersion, localVersion) > 0) {
            const packId = String(id || "").trim();
            updateAvailablePackIds.add(packId);
            pendingDictionaryUpdatesByPackId.set(packId, remote);
          }
        }

        if (updateAvailablePackIds.size > 0) {
          renderDictionaryPacksInfo();
          setCurrentDictionaryStatus("Status: Update available", "rgba(255,190,120,.95)");
        } else {
          renderDictionaryPacksInfo();
          setCurrentDictionaryStatus("Status: Up to date", "rgba(120,210,150,.95)");
        }
      } catch (e) {
        console.warn("[A-Translator] Version check failed", e);
        setCurrentDictionaryStatus("Status: Check failed", "rgba(255,140,140,.95)");
      }
    }

    async function updateDictionaryPack(packId) {
      const pendingDictionaryUpdate = pendingDictionaryUpdatesByPackId.get(String(packId || "").trim());
      if (!pendingDictionaryUpdate) return;

      const ok = await openConfirmDialog({
        title: "Update module",
        message:
          (pendingDictionaryUpdate.label || pendingDictionaryUpdate.name || pendingDictionaryUpdate.id || "Dictionary") +
          "\n\nThis will update this module to the latest GitHub version.",
        confirmLabel: "Update",
        cancelLabel: "Cancel"
      });

      if (!ok) return;

      try {
        const res = await loadGithubDictionaryDraft(
          pendingDictionaryUpdate.url,
          pendingDictionaryUpdate
        );

        if (!res || res.ok === false) {
          await openConfirmDialog({
            title: "Update failed",
            message: "The dictionary could not be updated. Check the console for details.",
            confirmLabel: "OK",
            cancelLabel: "Close"
          });
          return;
        }

        const oldPackId = String(packId || "").trim();
        const nextPackId = String(res.meta?.id || oldPackId).trim() || oldPackId;

        draftPacks = { ...draftPacks };
        if (oldPackId && oldPackId !== nextPackId) delete draftPacks[oldPackId];
        draftPacks[nextPackId] = {
          meta: res.meta,
          entries: res.entries
        };

        draftActivePackIds = (draftActivePackIds || []).map((id) =>
          id === oldPackId ? nextPackId : id
        );
        draftActivePackIds = normalizeActivePackIds(
          draftPacks,
          draftActivePackIds,
          String(res.meta?.lang || "").trim().toLowerCase()
        );

        draftDict = compileActiveDictionary(draftPacks, draftActivePackIds);
        draftMeta = res.meta;
        draftBaseDict = { ...res.entries };
        draftTextEditedByUser = false;
        filterQuery = "";
        searchInput.value = "";
        refreshTextarea();
        refreshCurrentDictionaryInfo();
        setUnsavedChanges(true);
      } catch (e) {
        console.error("[A-Translator] Dictionary update error", e);
        await openConfirmDialog({
          title: "Update error",
          message: String(e && e.message ? e.message : e),
          confirmLabel: "OK",
          cancelLabel: "Close"
        });
      }
    }

    const currentDictionaryControls = document.createElement("div");
    currentDictionaryControls.style.cssText = css(
      "margin-left:auto;",
      "display:flex;",
      "flex-direction:row;",
      "align-items:center;",
      "justify-content:flex-end;",
      "gap:10px;",
      "white-space:nowrap;"
    );

    currentDictionaryFooter.append(currentDictionaryStatus, currentDictionaryControls);
    refreshCurrentDictionaryInfo();
    currentDictionaryCard.append(currentDictionaryTitle, dictionaryPacksInfo, currentDictionaryFooter);
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
      "overflow:hidden;",
      "min-height:0;",
      "flex:1 1 auto;",
      "max-height:none;"
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
      "text-align:left;",
      "flex:0 0 auto;"
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

    const entryCountLabel = document.createElement("div");
    entryCountLabel.style.cssText = css(
      "font-size:11px;",
      "opacity:.55;",
      "white-space:nowrap;"
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
      "height:auto;",
      "min-height:0;",
      "max-height:none;",
      "flex:1 1 auto;",
      "resize:none;",
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

    function updateEntryCount() {
      const count = Object.keys(draftDict || {}).length;
      entryCountLabel.textContent = count + " entries";
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
      draftTextEditedByUser = true;
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

    const btnResetDictionary = makePillButton("Delete all modules", [
      "background:rgba(120,40,40,.55);",
      "color:#f3f3f3;",
      "font-weight:500;"
    ]);
    btnResetDictionary.removeAttribute("title");
    hoverBg(btnResetDictionary, "rgba(120,40,40,.55)", "rgba(150,50,50,.7)");

    btnResetDictionary.addEventListener("click", () => {
      openConfirmDialog({
        title: "Delete all modules",
        message: "This will delete every stored dictionary module and all dictionary metadata. A-Translator will remain installed.",
        confirmLabel: "Delete all",
        cancelLabel: "Cancel",
        danger: true
      }).then((ok) => {
        if (!ok) return;

        resetDictionary();
        draftDict = {};
        draftPacks = {};
        draftActivePackIds = [];
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
      if (editorHasUnsavedChanges && typeof applyEditsFromTextarea === "function") {
        applyEditsFromTextarea();
      }

    const nextMeta = { ...(draftMeta || {}) };
    if (!nextMeta.lang) {
      const guessed = String(navigator.language || "undefined")
        .split("-")[0]
        .toLowerCase();
      nextMeta.lang = guessed || "undefined";
    }
    if (!nextMeta.dictVersion) {
      nextMeta.dictVersion = "1";
    }

    const nextType = String(nextMeta.type || "core").trim().toLowerCase();
    const nextLang = String(nextMeta.lang || "und").trim().toLowerCase();
    const desiredActivePackIds = Array.isArray(draftActivePackIds) ? [...draftActivePackIds] : [];
    const entriesForPack = nextType === "user" ? draftDict : draftBaseDict;
    const shouldSaveCurrentPack = editorHasUnsavedChanges;
    const shouldUpdateUserOverrides = draftTextEditedByUser;

    const savedPack = shouldSaveCurrentPack
      ? saveDictionaryPackOnly(nextMeta, entriesForPack)
      : { meta: nextMeta, entries: entriesForPack };

    const savedPackId = String(savedPack?.meta?.id || nextMeta.id || "").trim();
    const packsAfterSave = loadDictionaryPacks();
    const normalizedDesiredIds =
      shouldSaveCurrentPack && savedPackId && desiredActivePackIds.length === 0
        ? [savedPackId]
        : desiredActivePackIds;

    draftActivePackIds = draftEnabled
      ? normalizeActivePackIds(packsAfterSave, normalizedDesiredIds, nextLang)
      : [];

    if (nextType !== "user" && shouldUpdateUserOverrides) {
      const userPackId = saveUserOverridesFromDraft(savedPack.meta, draftBaseDict, draftDict);
      if (userPackId && draftEnabled) {
        draftActivePackIds = Array.from(new Set([...(draftActivePackIds || []), userPackId]));
      }
    }

    draftActivePackIds = draftEnabled
      ? normalizeActivePackIds(loadDictionaryPacks(), draftActivePackIds, nextLang)
      : [];
    saveActivePackIds(draftActivePackIds);

    const compiledDict = compileActiveDictionary(loadDictionaryPacks(), draftActivePackIds);

    saveMeta(savedPack.meta);
    saveDictionary(compiledDict);
    draftDict = compiledDict;
    draftBaseDict = loadDictionaryWithoutUserOverrides();
    draftMeta = savedPack.meta;
    draftPacks = loadDictionaryPacks();
    savedActivePackIdsSnapshot = serializePackIds(draftActivePackIds);
    setUnsavedChanges(false);

    toggleCore(draftEnabled);
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
      "<circle cx='12' cy='12' r='9' stroke='currentColor' stroke-width='2'/>" +
      "<path d='M3 12h18' stroke='currentColor' stroke-width='2' stroke-linecap='round'/>" +
      "<path d='M12 3c2.4 2.6 3.6 5.6 3.6 9S14.4 18.4 12 21c-2.4-2.6-3.6-5.6-3.6-9S9.6 5.6 12 3z' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/>" +
      "<path d='M7 7h10M7 17h10' stroke='currentColor' stroke-width='1.8' stroke-linecap='round'/>" +
      "</svg>";

    const bTranslations = mkIconBtn("Open A-Translator", TRANSLATE_SVG);
    bTranslations.addEventListener("click", openEditor);

    box.append(bTranslations);
    document.documentElement.appendChild(box);
  }

  window.AlchemyTranslate = {
    openEditor,
    uninstall,
    debug: getDebugState,
    inspect: inspectPageText,
    apply: applyTranslations
  };
  mountButtons();
})();
