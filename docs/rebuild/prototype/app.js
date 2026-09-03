/* OpenBot console prototype — shared interactions (vanilla JS, no build step) */
(function () {
  "use strict";

  /* ---------------- theme ---------------- */
  const THEME_KEY = "openbot-theme";
  const root = document.documentElement;

  function systemTheme() {
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  function applyTheme(theme) {
    root.setAttribute("data-theme", theme);
    try { localStorage.setItem(THEME_KEY, theme); } catch (e) {}
    document.querySelectorAll("[data-theme-toggle]").forEach((btn) => {
      const moon = btn.querySelector(".ic-moon");
      const sun = btn.querySelector(".ic-sun");
      if (moon) moon.hidden = theme === "dark";
      if (sun) sun.hidden = theme === "light";
      btn.setAttribute("aria-label", theme === "dark" ? "Switch to light theme" : "Switch to dark theme");
    });
  }
  function initTheme() {
    let saved = null;
    try { saved = localStorage.getItem(THEME_KEY); } catch (e) {}
    applyTheme(saved || systemTheme());
  }
  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-theme-toggle]");
    if (btn) {
      applyTheme(root.getAttribute("data-theme") === "dark" ? "light" : "dark");
    }
  });

  /* ---------------- toast ---------------- */
  const ICONS = {
    success: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>',
    error:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>',
    info:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>'
  };
  function showToast(type, title, msg) {
    let stack = document.querySelector(".toast-stack");
    if (!stack) { stack = document.createElement("div"); stack.className = "toast-stack"; document.body.appendChild(stack); }
    const el = document.createElement("div");
    el.className = "toast toast--" + type;
    el.setAttribute("role", "status");
    el.innerHTML =
      '<span class="toast__icon">' + (ICONS[type] || ICONS.info) + "</span>" +
      '<div class="toast__body"><div class="toast__title"></div><div class="toast__msg"></div></div>' +
      '<button class="icon-btn toast__close" aria-label="Dismiss"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button>';
    el.querySelector(".toast__title").textContent = title;
    el.querySelector(".toast__msg").textContent = msg || "";
    stack.appendChild(el);
    let closed = false;
    const close = () => {
      if (closed) return; closed = true;
      el.classList.add("is-leaving");
      setTimeout(() => el.remove(), 150);
    };
    el.querySelector(".toast__close").addEventListener("click", close);
    let t = setTimeout(close, 5000);
    el.addEventListener("mouseenter", () => clearTimeout(t));
    el.addEventListener("mouseleave", () => { t = setTimeout(close, 5000); });
  }
  window.showToast = showToast;

  /* ---------------- overlays (dialog + drawer) ---------------- */
  let lastFocus = null;
  function openOverlay(overlay, returnFocusTo) {
    lastFocus = returnFocusTo || document.activeElement;
    overlay.classList.remove("is-hidden");
    const focusTarget = overlay.querySelector("[data-autofocus]") || overlay.querySelector("button, [tabindex]");
    if (focusTarget) setTimeout(() => focusTarget.focus(), 30);
  }
  function closeOverlay(overlay) {
    overlay.classList.add("is-hidden");
    if (lastFocus) lastFocus.focus();
  }
  function trapFocus(e, overlay) {
    const focusables = overlay.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    if (!focusables.length) return;
    const first = focusables[0], last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) { last.focus(); e.preventDefault(); }
    else if (!e.shiftKey && document.activeElement === last) { first.focus(); e.preventDefault(); }
  }

  document.addEventListener("click", (e) => {
    const opener = e.target.closest("[data-dialog-open], [data-drawer-open]");
    if (opener) {
      const id = opener.getAttribute("data-dialog-open") || opener.getAttribute("data-drawer-open");
      const overlay = document.getElementById(id);
      if (overlay) openOverlay(overlay);
      return;
    }
    const closer = e.target.closest("[data-dialog-close], [data-drawer-close]");
    if (closer) { closeOverlay(closer.closest(".overlay")); return; }
    if (e.target.classList.contains("overlay") && e.target.getAttribute("data-dismissable") !== "false") {
      closeOverlay(e.target);
      return;
    }
    const confirmer = e.target.closest("[data-confirm-toast]");
    if (confirmer) {
      const spec = confirmer.getAttribute("data-confirm-toast").split("|");
      closeOverlay(confirmer.closest(".overlay"));
      showToast(spec[0], spec[1], spec[2] || "");
      return;
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const overlays = Array.from(document.querySelectorAll(".overlay:not(.is-hidden)"));
    if (overlays.length) { closeOverlay(overlays[overlays.length - 1]); return; }
    closeAllListboxes();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Tab") return;
    const overlay = document.querySelector(".overlay:not(.is-hidden)");
    if (overlay) trapFocus(e, overlay);
  });

  /* ---------------- copy buttons ---------------- */
  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-copy]");
    if (!btn) return;
    const text = btn.getAttribute("data-copy");
    const done = () => showToast("info", "Copied", text.length > 48 ? text.slice(0, 48) + "…" : text);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
    } else fallbackCopy(text, done);
  });
  function fallbackCopy(text, done) {
    const ta = document.createElement("textarea");
    ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); done(); } catch (err) {}
    document.body.removeChild(ta);
  }

  /* ---------------- password show/hide (draft only) ---------------- */
  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-pw-toggle]");
    if (!btn) return;
    const input = document.getElementById(btn.getAttribute("data-pw-toggle"));
    if (!input) return;
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    btn.querySelectorAll("svg").forEach((s) => (s.hidden = s.classList.contains(show ? "ic-eye" : "ic-eye-off")));
    btn.setAttribute("aria-label", show ? "Hide key" : "Show key");
    btn.setAttribute("aria-pressed", String(show));
  });

  /* ---------------- reasoning chips (interactive demo) ---------------- */
  document.addEventListener("click", (e) => {
    const chip = e.target.closest(".param-chip[data-chip]");
    if (!chip || chip.classList.contains("is-pinned")) return;
    const group = chip.closest("[data-chip-group]");
    if (group && group.hasAttribute("data-single")) {
      group.querySelectorAll(".param-chip[data-chip]").forEach((c) => c.classList.remove("is-active"));
    }
    chip.classList.toggle("is-active");
  });

  /* ---------------- wizard preset cards ---------------- */
  document.addEventListener("click", (e) => {
    const preset = e.target.closest(".preset[data-preset]");
    if (!preset) return;
    preset.closest(".preset-grid").querySelectorAll(".preset").forEach((p) => p.classList.remove("is-selected"));
    preset.classList.add("is-selected");
    const hint = document.getElementById("preset-hint");
    if (hint) hint.textContent = preset.getAttribute("data-hint") || "";
    const origin = document.getElementById("f-origin");
    if (origin) origin.value = preset.getAttribute("data-origin") || "";
    const model = document.getElementById("f-model");
    if (model) model.value = preset.getAttribute("data-model") || "";
  });

  /* ==========================================================================
     Custom listbox (the only model/provider picker — no native <select>)
     ========================================================================== */
  const LISTBOX_INSTANCES = [];
  function closeAllListboxes() {
    LISTBOX_INSTANCES.forEach((inst) => inst.close());
  }

  function initListbox(lb) {
    const trigger = lb.querySelector(".listbox__trigger");
    const panel = lb.querySelector(".listbox__panel");
    const search = lb.querySelector(".listbox__search");
    const searchInput = search ? search.querySelector("input") : null;
    const list = lb.querySelector(".listbox__list");
    const valueEl = trigger.querySelector(".listbox__value");
    const chevron = trigger.querySelector(".listbox__chevron");
    if (!trigger || !panel || !list) return;

    const options = Array.prototype.slice.call(list.querySelectorAll(".listbox__option"));
    const groups = Array.prototype.slice.call(list.querySelectorAll(".listbox__group"));
    const uid = "lb-" + Math.random().toString(36).slice(2, 8);
    list.id = list.id || uid + "-list";
    panel.id = panel.id || uid + "-panel";
    options.forEach((o, i) => { o.id = o.id || uid + "-opt" + i; });
    trigger.setAttribute("aria-controls", panel.id);
    trigger.setAttribute("aria-expanded", "false");

    let open = false;
    let activeIndex = -1;

    const visibleOptions = () => options.filter((o) => !o.hidden);

    function setActive(i) {
      if (activeIndex >= 0) options[activeIndex].classList.remove("is-active");
      activeIndex = i;
      if (activeIndex >= 0 && options[activeIndex]) {
        options[activeIndex].classList.add("is-active");
        list.setAttribute("aria-activedescendant", options[activeIndex].id);
        options[activeIndex].scrollIntoView({ block: "nearest" });
      } else {
        list.removeAttribute("aria-activedescendant");
      }
    }

    function filter(q) {
      q = (q || "").toLowerCase().trim();
      let anyVisible = false;
      groups.forEach((g) => {
        let vis = 0;
        Array.prototype.forEach.call(g.querySelectorAll(".listbox__option"), (o) => {
          const label = (o.getAttribute("data-label") || o.textContent || "").toLowerCase();
          const match = !q || label.indexOf(q) !== -1;
          o.hidden = !match;
          if (match) vis++;
        });
        g.hidden = vis === 0;
        if (vis) anyVisible = true;
      });
      const emptyRow = list.querySelector(".listbox__empty");
      if (emptyRow) emptyRow.hidden = anyVisible;
      // keep the active option within the visible set
      const vis = visibleOptions();
      if (activeIndex < 0 || options[activeIndex].hidden) {
        setActive(vis.length ? options.indexOf(vis[0]) : -1);
      }
    }

    function updateSearchVisibility() {
      const show = options.length > 8;
      search.hidden = !show;
      if (!show && searchInput) searchInput.value = "";
    }

    function position() {
      const rect = trigger.getBoundingClientRect();
      const panelH = panel.offsetHeight || 320;
      const spaceBelow = window.innerHeight - rect.bottom;
      const spaceAbove = rect.top;
      if (spaceBelow < panelH && spaceAbove > spaceBelow) panel.classList.add("is-up");
      else panel.classList.remove("is-up");
    }

    function openPanel() {
      open = true;
      panel.hidden = false;
      trigger.setAttribute("aria-expanded", "true");
      if (chevron) chevron.classList.add("is-open");
      updateSearchVisibility();
      const sel = list.querySelector(".listbox__option.is-selected");
      setActive(options.indexOf(sel));
      filter(searchInput ? searchInput.value : "");
      position();
      if (searchInput && !search.hidden) { searchInput.focus(); searchInput.select(); }
      else list.focus();
    }

    function closePanel() {
      open = false;
      panel.hidden = true;
      trigger.setAttribute("aria-expanded", "false");
      if (chevron) chevron.classList.remove("is-open");
      list.removeAttribute("aria-activedescendant");
      if (activeIndex >= 0 && options[activeIndex]) options[activeIndex].classList.remove("is-active");
      activeIndex = -1;
    }

    function select(o) {
      if (!o || o.hidden) return;
      if (valueEl) valueEl.textContent = o.getAttribute("data-label") || o.getAttribute("data-value") || o.textContent.trim();
      options.forEach((x) => { x.classList.remove("is-selected"); x.setAttribute("aria-selected", "false"); });
      o.classList.add("is-selected");
      o.setAttribute("aria-selected", "true");
      closePanel();
      trigger.focus();
      lb.dispatchEvent(new CustomEvent("listbox:change", {
        detail: { value: o.getAttribute("data-value"), label: valueEl ? valueEl.textContent : "" }
      }));
    }

    function moveActive(delta) {
      const vis = visibleOptions();
      if (!vis.length) return;
      let idx = vis.indexOf(options[activeIndex]);
      idx = (idx + delta + vis.length) % vis.length;
      setActive(options.indexOf(vis[idx]));
    }
    function moveActiveTo(edge) {
      const vis = visibleOptions();
      if (!vis.length) return;
      setActive(options.indexOf(vis[edge]));
    }

    trigger.addEventListener("click", () => { open ? closePanel() : openPanel(); });
    list.addEventListener("click", (e) => {
      const opt = e.target.closest(".listbox__option");
      if (opt) select(opt);
    });
    list.addEventListener("keydown", (e) => {
      if (!open) return;
      if (e.key === "ArrowDown") { e.preventDefault(); moveActive(1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); moveActive(-1); }
      else if (e.key === "Home") { e.preventDefault(); moveActiveTo(0); }
      else if (e.key === "End") { e.preventDefault(); moveActiveTo(visibleOptions().length - 1); }
      else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(options[activeIndex]); }
      else if (e.key === "Escape") { e.preventDefault(); closePanel(); trigger.focus(); }
      else if (e.key === "Tab") { closePanel(); }
    });
    if (searchInput) {
      searchInput.addEventListener("input", () => filter(searchInput.value));
      searchInput.addEventListener("keydown", (e) => {
        if (e.key === "ArrowDown") { e.preventDefault(); moveActive(1); list.focus(); }
        else if (e.key === "Escape") { e.preventDefault(); closePanel(); trigger.focus(); }
        else if (e.key === "Enter") { e.preventDefault(); const vis = visibleOptions(); if (vis.length) select(vis[0]); }
      });
    }

    LISTBOX_INSTANCES.push({ el: lb, close: closePanel });
  }

  document.addEventListener("click", (e) => {
    LISTBOX_INSTANCES.forEach((inst) => {
      if (!inst.el.contains(e.target)) inst.close();
    });
  });

  /* ==========================================================================
     Import models dialog (Source A) — fake async fetch → modal selection → import
     ========================================================================== */
  const DB_ICON = '<svg class="ic" style="width:11px;height:11px"><use href="#i-database"/></svg>';
  const CHECK_ICON = '<svg class="ic" style="width:12px;height:12px"><use href="#i-check"/></svg>';

  const FETCH_SCENARIOS = {
    glm: {
      name: "GLM Coding Plan",
      type: "success",
      skipped: 0,
      models: [
        { id: "glm-5.3", name: "GLM 5.3", matched: true, context: "128K", out: "65,536", modalities: "text", reasoning: "default·none·low·medium·high·xhigh·max", exists: true },
        { id: "glm-5.3-flash", name: "GLM 5.3 Flash", matched: true, context: "128K", out: "65,536", modalities: "text · image", reasoning: "default·none·low·medium·high", exists: true },
        { id: "glm-5.2", name: "GLM 5.2", matched: true, context: "128K", out: "65,536", modalities: "text", reasoning: "default·none·low·medium·high", exists: false },
        { id: "glm-4.5", name: "GLM 4.5", matched: true, context: "128K", out: "32,768", modalities: "text", reasoning: "default·none·low·medium·high", exists: false },
        { id: "glm-4.5-air", name: "GLM 4.5 Air", matched: true, context: "128K", out: "32,768", modalities: "text", reasoning: "default·none·low·medium·high", exists: false },
        { id: "glm-4.5-flash", name: "GLM 4.5 Flash", matched: true, context: "128K", out: "16,384", modalities: "text", reasoning: "default·none·low·medium·high", exists: false },
        { id: "glm-4-plus", name: "GLM 4 Plus", matched: true, context: "128K", out: "8,192", modalities: "text", reasoning: "default·none·low·medium·high", exists: false },
        { id: "glm-4-air", name: "GLM 4 Air", matched: true, context: "128K", out: "8,192", modalities: "text", reasoning: "default·none·low·medium·high", exists: false },
        { id: "glm-4v", name: "GLM-4V", matched: true, context: "32K", out: "8,192", modalities: "text · image", reasoning: "default·none·low·medium·high", exists: false },
        { id: "glm-4v-flash", name: "GLM-4V Flash", matched: true, context: "32K", out: "8,192", modalities: "text · image", reasoning: "default·none·low·medium·high", exists: false },
        { id: "glm-3-turbo", name: "GLM 3 Turbo", matched: false, context: null, out: null, modalities: null, reasoning: null, exists: false },
        { id: "cogvideo-5", name: null, matched: false, context: null, out: null, modalities: null, reasoning: null, exists: false }
      ]
    },
    deepseek: {
      name: "DeepSeek",
      type: "partial",
      skipped: 2,
      skippedReason: "missing id",
      models: [
        { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", matched: true, context: "128K", out: "65,536", modalities: "text", reasoning: "default·none·low·medium·high·xhigh·max", exists: true },
        { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", matched: true, context: "128K", out: "65,536", modalities: "text", reasoning: "default·none·low·medium·high", exists: true },
        { id: "deepseek-v4-flash-vision", name: "DeepSeek V4 Flash Vision", matched: true, context: "128K", out: "65,536", modalities: "text · image", reasoning: "default·none·low·medium·high", exists: false },
        { id: "deepseek-reasoner", name: "DeepSeek Reasoner", matched: true, context: "128K", out: "32,768", modalities: "text", reasoning: "default·none·low·medium·high", exists: false },
        { id: "deepseek-coder", name: "DeepSeek Coder", matched: false, context: null, out: null, modalities: null, reasoning: null, exists: false },
        { id: "deepseek-chat", name: "DeepSeek Chat", matched: false, context: null, out: null, modalities: null, reasoning: null, exists: false }
      ]
    },
    openrouter: { name: "OpenRouter", type: "error", kind: "no-secret" }
  };

  const IMPORT = {
    providerId: null, targetId: null, providerName: "", isWizard: false,
    rows: [], skipped: 0, skippedReason: "", type: "success", kind: "",
    selected: new Set()
  };

  function importRowHTML(model) {
    const catalogBadge = model.matched ? '<span class="badge badge--info">' + DB_ICON + 'catalog</span>' : "";
    const ctxBadge = model.context ? '<span class="badge">' + model.context + '</span>' : "";
    const main =
      '<span class="import-row__main">' +
        '<span class="import-row__id mono">' + model.id + '</span>' +
        (model.name ? '<span class="import-row__name">' + model.name + '</span>' : "") +
        catalogBadge + ctxBadge +
      '</span>';
    if (model.exists) {
      return (
        '<div class="import-row is-added" data-import-id="' + model.id + '">' +
          '<span class="tag tag--added">' + CHECK_ICON + 'Already added</span>' + main +
        '</div>'
      );
    }
    return (
      '<label class="import-row" data-import-id="' + model.id + '">' +
        '<span class="checkbox"><input type="checkbox" value="' + model.id + '"><span class="checkbox__box">' + CHECK_ICON + '</span></span>' + main +
      '</label>'
    );
  }

  function selectableRows() { return IMPORT.rows.filter((m) => !m.exists); }

  function updateImportCounts() {
    const selectable = selectableRows();
    const n = selectable.filter((m) => IMPORT.selected.has(m.id)).length;
    const imp = document.getElementById("im-import");
    const all = document.getElementById("im-select-all");
    const sel = document.getElementById("im-selected");
    const count = document.getElementById("im-count");
    if (sel) sel.textContent = n + " selected";
    if (count && IMPORT.rows.length) count.textContent = IMPORT.rows.length + " model" + (IMPORT.rows.length === 1 ? "" : "s");
    if (imp && imp.dataset.loading !== "1") {
      imp.disabled = n === 0;
      imp.textContent = "Import selected (" + n + ")";
    }
    if (all) {
      all.textContent = selectable.length > 0 && n === selectable.length ? "Select none" : "Select all";
      all.disabled = selectable.length === 0;
    }
  }

  function toggleSelectAll() {
    const selectable = selectableRows();
    const allSelected = selectable.length > 0 && selectable.every((m) => IMPORT.selected.has(m.id));
    selectable.forEach((m) => { allSelected ? IMPORT.selected.delete(m.id) : IMPORT.selected.add(m.id); });
    document.querySelectorAll("#im-list .import-row:not(.is-added) input[type=checkbox]").forEach((cb) => {
      cb.checked = !allSelected;
    });
    updateImportCounts();
  }

  function applyImportFilter() {
    const q = (document.getElementById("im-search").value || "").toLowerCase().trim();
    let any = false;
    IMPORT.rows.forEach((m) => {
      const el = document.querySelector('#im-list .import-row[data-import-id="' + m.id + '"]');
      if (!el) return;
      const hay = ((m.id || "") + " " + (m.name || "")).toLowerCase();
      const hidden = q !== "" && hay.indexOf(q) === -1;
      el.classList.toggle("is-hidden", hidden);
      if (!hidden) any = true;
    });
    const noMatch = document.getElementById("im-filter-empty");
    if (noMatch) noMatch.classList.toggle("is-hidden", any);
  }

  function renderImportList() {
    const list = document.getElementById("im-list");
    if (list) {
      list.innerHTML = IMPORT.rows.map(importRowHTML).join("") +
        '<div class="import-filter-empty is-hidden" id="im-filter-empty">No models match your filter.</div>';
    }
    applyImportFilter();
    updateImportCounts();
  }

  function openImportDialog(providerId, targetId, providerName, isWizard, triggerEl) {
    const s = FETCH_SCENARIOS[providerId] || FETCH_SCENARIOS.glm;
    IMPORT.providerId = providerId;
    IMPORT.targetId = targetId || null;
    IMPORT.providerName = providerName || s.name;
    IMPORT.isWizard = !!isWizard;
    IMPORT.rows = s.models || [];
    IMPORT.skipped = s.skipped || 0;
    IMPORT.skippedReason = s.skippedReason || "";
    IMPORT.type = s.type || "success";
    IMPORT.kind = s.kind || "";
    IMPORT.selected = new Set();

    const desc = document.getElementById("im-desc");
    if (desc) desc.textContent = "Choose which of " + IMPORT.providerName + "'s models to add.";
    const search = document.getElementById("im-search");
    if (search) search.value = "";

    const list = document.getElementById("im-list");
    const partial = document.getElementById("im-partial");
    const error = document.getElementById("im-error");
    const empty = document.getElementById("im-empty");
    if (partial) partial.classList.add("is-hidden");
    if (error) error.classList.add("is-hidden");
    if (empty) empty.classList.add("is-hidden");

    if (IMPORT.type === "error") {
      if (list) { list.innerHTML = ""; list.classList.add("is-hidden"); }
      if (error) {
        error.classList.remove("is-hidden");
        const kind = IMPORT.kind;
        const remedy = kind === "no-secret"
          ? "this provider has no API key. Add a key first, then retry."
          : kind === "unauthorized" ? "the key was rejected — replace it, then retry."
          : kind === "not-supported" ? "this provider exposes no /v1/models — add models manually."
          : "couldn't reach the provider — check the base URL and retry.";
        error.innerHTML =
          '<div class="notice notice--danger"><svg class="ic"><use href="#i-triangle"/></svg>' +
          '<span class="text"><strong>' + kind + '</strong> — ' + remedy + '</span></div>';
      }
      const imp = document.getElementById("im-import");
      if (imp) { imp.disabled = true; imp.textContent = "Import selected (0)"; }
      const all = document.getElementById("im-select-all");
      if (all) all.disabled = true;
      openOverlay(document.getElementById("dialog-import-models"), triggerEl);
      return;
    }

    if (!IMPORT.rows.length) {
      if (list) { list.innerHTML = ""; list.classList.add("is-hidden"); }
      if (empty) empty.classList.remove("is-hidden");
      const imp = document.getElementById("im-import");
      if (imp) { imp.disabled = true; imp.textContent = "Import selected (0)"; }
      openOverlay(document.getElementById("dialog-import-models"), triggerEl);
      return;
    }

    if (partial && IMPORT.type === "partial" && IMPORT.skipped > 0) {
      partial.classList.remove("is-hidden");
      partial.innerHTML =
        '<div class="notice notice--warn"><svg class="ic"><use href="#i-triangle"/></svg>' +
        '<span class="text">' + IMPORT.skipped + ' of ' + (IMPORT.rows.length + IMPORT.skipped) +
        ' models were skipped (' + IMPORT.skippedReason + '). The valid models are still selectable.</span></div>';
    }

    if (list) list.classList.remove("is-hidden");
    renderImportList();
    openOverlay(document.getElementById("dialog-import-models"), triggerEl);
  }

  function buildModelTableRow(slug, matched, context, out, reasoning, modalities) {
    const catalogBadge = matched ? ' <span class="badge badge--info">' + DB_ICON + 'catalog</span>' : "";
    return (
      '<td><span class="mono">' + slug + '</span></td>' +
      '<td class="mono">' + (context || "—") + catalogBadge + '</td>' +
      '<td class="num mono">' + (out || "—") + '</td>' +
      '<td class="mono" style="color:var(--muted);font-size:11px">' + (reasoning || "default·none·low·medium·high") + '</td>' +
      '<td><span class="param-chip" style="cursor:default">default</span></td>' +
      '<td>' + (modalities || "text") + '</td>' +
      '<td style="text-align:right"><button class="btn btn--ghost-sm">Use</button> <button class="icon-btn" data-dialog-open="dialog-model" aria-label="Edit model"><svg class="ic"><use href="#i-pencil"/></svg></button></td>'
    );
  }

  function renderWizardImportSummary(chosen) {
    const box = document.querySelector("[data-wizard-fetch-result]");
    if (!box) return;
    box.hidden = false;
    const chips = chosen.map((m) =>
      '<span class="badge badge--info">' + (m.matched ? DB_ICON : "") + m.id + '</span>'
    ).join(" ");
    box.innerHTML =
      '<div class="notice notice--info" style="margin-bottom:8px"><svg class="ic"><use href="#i-info"/></svg>' +
      '<span class="text">' + chosen.length + ' model' + (chosen.length === 1 ? "" : "s") +
      ' selected — added to this provider.</span></div>' +
      '<div class="row gap-1 wrap">' + chips + '</div>';
  }

  function doImport() {
    const imp = document.getElementById("im-import");
    const chosen = IMPORT.rows.filter((m) => !m.exists && IMPORT.selected.has(m.id));
    if (!chosen.length || (imp && imp.dataset.loading === "1")) return;
    if (imp) {
      imp.dataset.loading = "1";
      imp.disabled = true;
      imp.innerHTML = '<svg class="ic spinner"><use href="#i-loader"/></svg>Importing…';
    }
    setTimeout(() => {
      if (IMPORT.targetId) {
        const target = document.getElementById(IMPORT.targetId);
        chosen.forEach((m) => {
          if (!target) return;
          const row = document.createElement("tr");
          row.innerHTML = buildModelTableRow(m.id, m.matched, m.context, m.out, m.reasoning, m.modalities);
          target.appendChild(row);
        });
      }
      if (IMPORT.isWizard) {
        renderWizardImportSummary(chosen);
      }
      const head = "Imported " + chosen.length + " model" + (chosen.length === 1 ? "" : "s");
      let msg;
      if (chosen.length === 1) {
        msg = head + " — " + (chosen[0].matched
          ? chosen[0].id + " (fields auto-filled from catalog)."
          : chosen[0].id + " (manual fields, no catalog match).");
      } else {
        const names = chosen.map((m) => m.id);
        const lead = names.slice(0, 2).join(", ");
        const rest = names.length - 2;
        msg = head + " — " + lead + (rest > 0 ? " and " + rest + " more" : "") + " added to " + IMPORT.providerName + ".";
      }
      showToast("success", "Models imported", msg);
      if (imp) { imp.dataset.loading = ""; imp.textContent = "Import selected (0)"; imp.disabled = true; }
      closeOverlay(document.getElementById("dialog-import-models"));
    }, 700);
  }

  function setupFetchModels() {
    document.querySelectorAll("[data-fetch-models]").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (btn.disabled) return;
        btn.disabled = true;
        const original = btn.innerHTML;
        btn.innerHTML = '<svg class="ic spinner"><use href="#i-loader"/></svg>Fetching…';
        setTimeout(() => {
          btn.disabled = false;
          btn.innerHTML = original;
          openImportDialog(
            btn.getAttribute("data-provider"),
            btn.getAttribute("data-target"),
            btn.getAttribute("data-provider-name"),
            btn.hasAttribute("data-wizard"),
            btn
          );
        }, 900);
      });
    });
  }

  function setupImportDialog() {
    const dialog = document.getElementById("dialog-import-models");
    if (!dialog) return;

    dialog.addEventListener("change", (e) => {
      const cb = e.target.closest("#im-list input[type=checkbox]");
      if (!cb) return;
      if (cb.checked) IMPORT.selected.add(cb.value); else IMPORT.selected.delete(cb.value);
      updateImportCounts();
    });

    dialog.addEventListener("click", (e) => {
      if (e.target.closest("#im-select-all")) { toggleSelectAll(); return; }
      if (e.target.closest("#im-import")) { doImport(); return; }
    });

    const search = document.getElementById("im-search");
    if (search) search.addEventListener("input", () => applyImportFilter());

    const list = document.getElementById("im-list");
    if (list) {
      list.addEventListener("keydown", (e) => {
        if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
        const boxes = Array.prototype.filter.call(
          list.querySelectorAll("input[type=checkbox]"),
          (cb) => !cb.closest(".import-row.is-hidden")
        );
        if (!boxes.length) return;
        const idx = boxes.indexOf(document.activeElement);
        const next = e.key === "ArrowDown" ? Math.min(idx + 1, boxes.length - 1) : Math.max(idx - 1, 0);
        e.preventDefault();
        boxes[next].focus();
      });
    }
  }

  /* ==========================================================================
     Model catalog cache status + refresh (Source B) — demo interaction
     ========================================================================== */
  function setupCatalogRefresh() {
    document.querySelectorAll("[data-catalog-refresh]").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (btn.disabled) return;
        const card = btn.closest(".catalog-card") || btn.closest(".card");
        const status = card ? card.querySelector("[data-catalog-status]") : null;
        const time = card ? card.querySelector("[data-catalog-time]") : null;
        btn.disabled = true;
        const original = btn.innerHTML;
        btn.innerHTML = '<svg class="ic spinner"><use href="#i-loader"/></svg>Refreshing…';
        if (status) {
          status.className = "badge badge--warning";
          status.innerHTML = '<svg class="ic spinner" style="width:11px;height:11px"><use href="#i-loader"/></svg>Loading';
        }
        setTimeout(() => {
          btn.disabled = false;
          btn.innerHTML = original;
          const now = new Date();
          const ts = now.toTimeString().slice(0, 8);
          if (status) {
            status.className = "badge badge--success";
            status.textContent = "Ready";
          }
          if (time) time.textContent = "Last fetched " + ts + " · 614 models · openrouter + models.dev";
          showToast("success", "Catalog refreshed", "Source B cache re-fetched at " + ts + ".");
        }, 1100);
      });
    });
  }

  /* ---------------- proto control bar ---------------- */
  function setupProtoBar() {
    const bar = document.getElementById("proto-bar");
    if (!bar) return;
    bar.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-proto]");
      if (!btn) return;
      const action = btn.getAttribute("data-proto");
      if (action === "theme") {
        applyTheme(root.getAttribute("data-theme") === "dark" ? "light" : "dark");
      } else if (action === "skeleton") {
        document.body.classList.toggle("proto-skeleton");
        btn.classList.toggle("is-on");
      } else if (action === "saving") {
        document.querySelectorAll(".saving-pill").forEach((p) => p.classList.toggle("is-hidden"));
        btn.classList.toggle("is-on");
      } else if (action === "blocked") {
        document.querySelectorAll(".blocked-banner").forEach((b) => b.classList.toggle("is-hidden"));
        btn.classList.toggle("is-on");
      } else if (action === "toast") {
        showToast("success", "Saved", "Grok Bot will use glm-5.3 (high) on the next message.");
      } else if (action === "toast-err") {
        showToast("error", "Save refused", "foreign-ui — another process owns port 9280. Stop it, then retry.");
      } else if (action === "mode") {
        setMode();
      } else if (action === "empty") {
        document.body.classList.toggle("proto-empty");
        btn.classList.toggle("is-on");
      }
    });
  }

  function setMode() {
    // toggle the status-strip mode pill between CUSTOM and OFFICIAL
    document.querySelectorAll(".status-strip .mode-pill").forEach((pill) => {
      const isCustom = pill.classList.contains("mode-pill--custom");
      pill.classList.toggle("mode-pill--custom", !isCustom);
      pill.classList.toggle("mode-pill--official", isCustom);
      if (isCustom) {
        pill.textContent = "Official";
      } else {
        pill.innerHTML = 'Custom<span class="mode-pill__divider" aria-hidden="true"></span><span class="mode-pill__model">glm-5.3</span>';
      }
    });
  }

  /* ---------------- boot ---------------- */
  initTheme();
  setupProtoBar();
  document.querySelectorAll("[data-listbox]").forEach(initListbox);
  setupFetchModels();
  setupImportDialog();
  setupCatalogRefresh();
})();
