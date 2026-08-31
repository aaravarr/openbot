(() => {
  "use strict";

  const REASONING_LEVELS = ["none", "low", "medium", "high", "max", "xhigh"];
  const DEFAULT_REASONING = ["none", "low", "medium", "high"];
  const MODALITIES = ["text", "image", "video", "audio"];
  const DEFAULT_MODALITIES = ["text"];
  const DEFAULT_CONTEXT = 128000;
  const DEFAULT_MAX_OUTPUT = 65536;

  const PRESETS = [
    {
      id: "openai",
      name: "OpenAI",
      origin: "https://api.openai.com/v1",
      model: "gpt-4.1",
      hint: "A platform API key. A ChatGPT password will not work.",
    },
    {
      id: "deepseek",
      name: "DeepSeek",
      origin: "https://api.deepseek.com/v1",
      model: "deepseek-chat",
      hint: "OpenAI-compatible Chat Completions on api.deepseek.com.",
    },
    {
      id: "zhipu",
      name: "Zhipu GLM",
      origin: "https://open.bigmodel.cn/api/paas/v4",
      model: "glm-4.6",
      hint: "GLM on the Zhipu OpenAI-compatible endpoint.",
    },
    {
      id: "moonshot",
      name: "Kimi",
      origin: "https://api.moonshot.cn/v1",
      model: "kimi-k2-0905-preview",
      hint: "Moonshot OpenAI-compatible API.",
    },
    {
      id: "qwen",
      name: "Qwen",
      origin: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      model: "qwen-plus",
      hint: "DashScope compatible-mode, not the native DashScope protocol.",
    },
    {
      id: "openrouter",
      name: "OpenRouter",
      origin: "https://openrouter.ai/api/v1",
      model: "openai/gpt-4.1",
      hint: "One key, many labs. Use the provider/model id OpenRouter shows.",
    },
    {
      id: "groq",
      name: "Groq",
      origin: "https://api.groq.com/openai/v1",
      model: "llama-3.3-70b-versatile",
      hint: "The Groq OpenAI-compatible URL includes /openai/v1.",
    },
    {
      id: "xai",
      name: "xAI",
      origin: "https://api.x.ai/v1",
      model: "grok-3",
      hint: "An xAI API key, used from this Computer — not from your Mac.",
    },
    {
      id: "custom",
      name: "Custom",
      origin: "",
      model: "",
      hint: "Any HTTPS endpoint that speaks OpenAI Chat Completions.",
    },
  ];

  let seq = 10;

  function uid(prefix) {
    seq += 1;
    return `${prefix}-${seq}`;
  }

  function seed() {
    return {
      mode: "custom",
      activeModelId: "m-gpt-41",
      hostBlocked: false,
      providers: [
        {
          id: "p-openai",
          name: "OpenAI",
          origin: "https://api.openai.com/v1",
          hasKey: true,
        },
        {
          id: "p-zhipu",
          name: "Zhipu GLM",
          origin: "https://open.bigmodel.cn/api/paas/v4",
          hasKey: false,
        },
      ],
      models: [
        {
          id: "m-gpt-41",
          providerId: "p-openai",
          slug: "gpt-4.1",
          contextTokens: 128000,
          maxOutputTokens: 65536,
          reasoningLevels: ["none", "low", "medium", "high"],
          activeReasoning: "high",
          modalities: ["text"],
        },
        {
          id: "m-o4-mini",
          providerId: "p-openai",
          slug: "o4-mini",
          contextTokens: 128000,
          maxOutputTokens: 65536,
          reasoningLevels: ["none", "low", "medium", "high"],
          activeReasoning: "none",
          modalities: ["text"],
        },
        {
          id: "m-glm-46",
          providerId: "p-zhipu",
          slug: "glm-4.6",
          contextTokens: 128000,
          maxOutputTokens: 65536,
          reasoningLevels: ["none", "low", "medium", "high"],
          activeReasoning: "none",
          modalities: ["text"],
        },
      ],
    };
  }

  const ui = {
    view: "chat",
    selectedProviderId: "p-openai",
    selectedModelId: "m-gpt-41",
    firstStep: "presets",
    addStep: "presets",
    replaceKey: false,
    confirmRemove: false,
    focusKey: false,
    modelNote: "",
    providerNote: "",
    providerNoteError: false,
    addModelSlug: "",
    secretDraft: "",
    modelDraft: null,
  };

  let catalog = seed();

  function esc(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function labelReasoning(level) {
    if (level === "xhigh") return "Extra high";
    if (level === "none") return "None";
    return level.slice(0, 1).toUpperCase() + level.slice(1);
  }

  function labelModality(item) {
    return item.slice(0, 1).toUpperCase() + item.slice(1);
  }

  function formatTokens(value) {
    if (value >= 1000 && value % 1000 === 0) {
      return `${String(value / 1000)}k`;
    }
    if (value >= 1000) {
      return `${(value / 1000).toFixed(1).replace(/\.0$/u, "")}k`;
    }
    return String(value);
  }

  function hasSelectableReasoning(levels) {
    return Array.isArray(levels) && levels.some((level) => level !== "none");
  }

  function keepOrder(universe, selected) {
    return universe.filter((item) => selected.has(item));
  }

  function toggleIn(universe, list, item) {
    const set = new Set(list);
    if (set.has(item)) {
      if (set.size === 1) return [...list];
      set.delete(item);
    } else {
      set.add(item);
    }
    return keepOrder(universe, set);
  }

  function hostOf(origin) {
    try {
      return origin ? new URL(origin).host : "OpenAI-compatible URL";
    } catch {
      return origin || "OpenAI-compatible URL";
    }
  }

  function providerById(id) {
    return catalog.providers.find((row) => row.id === id);
  }

  function modelById(id) {
    return catalog.models.find((row) => row.id === id);
  }

  function modelsFor(providerId) {
    return catalog.models.filter((row) => row.providerId === providerId);
  }

  function liveModel() {
    if (catalog.mode !== "custom") return null;
    return modelById(catalog.activeModelId);
  }

  function liveProviderId() {
    return liveModel()?.providerId ?? null;
  }

  function statusLabel() {
    const model = liveModel();
    if (!model) return "Official Grok";
    if (model.activeReasoning && model.activeReasoning !== "none") {
      return `${model.slug} · ${labelReasoning(model.activeReasoning)}`;
    }
    return model.slug;
  }

  function emptyDraft() {
    return { name: "", origin: "", modelSlug: "", secret: "" };
  }

  function draftFromPreset(preset) {
    if (preset.id === "custom") return emptyDraft();
    return {
      name: preset.name,
      origin: preset.origin,
      modelSlug: preset.model,
      secret: "",
    };
  }

  function defaultLimits() {
    return {
      contextTokens: DEFAULT_CONTEXT,
      maxOutputTokens: DEFAULT_MAX_OUTPUT,
      reasoningLevels: [...DEFAULT_REASONING],
      modalities: [...DEFAULT_MODALITIES],
    };
  }

  function clampReasoning(model) {
    if (!model.reasoningLevels.includes(model.activeReasoning)) {
      model.activeReasoning = model.reasoningLevels[0] || "none";
    }
  }

  const el = {
    body: document.body,
    firstRun: document.getElementById("view-first-run"),
    firstPresets: document.getElementById("first-presets"),
    firstForm: document.getElementById("first-form"),
    firstGrid: document.getElementById("first-preset-grid"),
    firstTitle: document.getElementById("first-form-title"),
    firstHint: document.getElementById("first-form-hint"),
    firstError: document.getElementById("first-error"),
    formFirst: document.getElementById("form-first"),
    shell: document.getElementById("view-shell"),
    railStatus: document.getElementById("rail-status"),
    navChat: document.getElementById("nav-chat"),
    navAdd: document.getElementById("nav-add"),
    railProviders: document.getElementById("rail-providers"),
    banner: document.getElementById("host-banner"),
    screenChat: document.getElementById("screen-chat"),
    screenProvider: document.getElementById("screen-provider"),
    screenModel: document.getElementById("screen-model"),
    screenAdd: document.getElementById("screen-add"),
    chatNow: document.getElementById("chat-now"),
    chatLines: document.getElementById("chat-lines"),
    addPresets: document.getElementById("add-presets"),
    addForm: document.getElementById("add-form"),
    addGrid: document.getElementById("add-preset-grid"),
    addTitle: document.getElementById("add-form-title"),
    addHint: document.getElementById("add-form-hint"),
    addError: document.getElementById("add-error"),
    formAdd: document.getElementById("form-add"),
    protoBlocked: document.getElementById("proto-blocked"),
  };

  let firstPreset = null;
  let addPreset = null;

  function setScreen(name) {
    ui.view = name;
    el.body.dataset.screen = name === "first-run" ? "first-run" : name;
    const first = name === "first-run";
    el.firstRun.hidden = !first;
    el.shell.hidden = first;
    el.screenChat.hidden = name !== "chat";
    el.screenProvider.hidden = name !== "provider";
    el.screenModel.hidden = name !== "model";
    el.screenAdd.hidden = name !== "add";
  }

  function renderPresets(container, which) {
    container.innerHTML = PRESETS.map((row) => {
      const meta = row.id === "custom" ? "OpenAI-compatible URL" : hostOf(row.origin);
      const wide = row.id === "custom" ? " preset-wide" : "";
      return `<button type="button" class="preset${wide}" data-act="pick-preset" data-which="${which}" data-id="${esc(
        row.id,
      )}">
        <span class="preset-name">${esc(row.name)}</span>
        <span class="preset-meta">${esc(meta)}</span>
      </button>`;
    }).join("");
  }

  function fillSetupForm(prefix, draft, preset) {
    const title = document.getElementById(`${prefix}-form-title`);
    const hint = document.getElementById(`${prefix}-form-hint`);
    title.textContent = preset.id === "custom" ? "Your endpoint" : preset.name;
    hint.textContent = preset.hint;
    document.getElementById(`${prefix}-name`).value = draft.name;
    document.getElementById(`${prefix}-origin`).value = draft.origin;
    document.getElementById(`${prefix}-slug`).value = draft.modelSlug;
    document.getElementById(`${prefix}-secret`).value = draft.secret;
    const secret = document.getElementById(`${prefix}-secret`);
    secret.type = "password";
    const toggle = secret.parentElement.querySelector("[data-act='toggle-secret']");
    if (toggle) toggle.textContent = "Show";
  }

  function renderRail() {
    const livePid = liveProviderId();
    const onProvider = ui.view === "provider" || ui.view === "model";
    el.railStatus.textContent = statusLabel();
    el.navChat.classList.toggle("is-current", ui.view === "chat");
    if (ui.view === "chat") el.navChat.setAttribute("aria-current", "page");
    else el.navChat.removeAttribute("aria-current");
    el.navAdd.classList.toggle("is-current", ui.view === "add");
    if (ui.view === "add") el.navAdd.setAttribute("aria-current", "page");
    else el.navAdd.removeAttribute("aria-current");

    el.railProviders.innerHTML = catalog.providers
      .map((provider) => {
        const current = onProvider && ui.selectedProviderId === provider.id;
        const on = livePid === provider.id;
        return `<button type="button" class="rail-item${current ? " is-current" : ""}" data-act="nav-provider" data-id="${esc(
          provider.id,
        )}"${current ? ' aria-current="page"' : ""}>
          <span class="rail-item-name">${esc(provider.name)}</span>
          ${on ? `<span class="rail-on">On</span>` : ""}
        </button>`;
      })
      .join("");
  }

  function renderBanner() {
    el.banner.hidden = !catalog.hostBlocked || ui.view === "first-run";
    el.protoBlocked.textContent = catalog.hostBlocked ? "Hide blocked host" : "Show blocked host";
    el.protoBlocked.classList.toggle("is-on", catalog.hostBlocked);
  }

  function renderChat() {
    const model = liveModel();
    const provider = model ? providerById(model.providerId) : null;
    const official = catalog.mode !== "custom";
    const last = modelById(catalog.activeModelId);
    const showReason = !official && model && hasSelectableReasoning(model.reasoningLevels);

    let reason = "";
    if (showReason) {
      reason = `<div class="reason-block">
        <p class="section-label">Reasoning</p>
        <div class="chip-row" role="group" aria-label="Reasoning for ${esc(model.slug)}">
          ${model.reasoningLevels
            .map((level) => {
              const on = model.activeReasoning === level;
              return `<button type="button" class="chip${on ? " chip-on" : ""}" data-act="reason-now" data-level="${esc(
                level,
              )}" aria-pressed="${on}">${esc(labelReasoning(level))}</button>`;
            })
            .join("")}
        </div>
      </div>`;
    }

    let action = "";
    if (!official) {
      action = `<div class="now-actions">
        <button type="button" class="button-secondary" data-act="use-official">Use official Grok</button>
      </div>`;
    } else if (last) {
      action = `<div class="now-actions">
        <button type="button" class="button-secondary" data-act="use-line" data-id="${esc(last.id)}">Use ${esc(
        last.slug,
      )}</button>
      </div>`;
    }

    const title = official
      ? `<h1 class="identity-title" id="now-title">Official Grok</h1>
         <p class="identity-sub">Stock xAI model in the Grok Bot app</p>`
      : `<h1 class="identity-title mono" id="now-title">${esc(model ? model.slug : "Your model")}</h1>
         <p class="identity-sub">${esc(provider ? provider.name : "")}</p>`;

    el.chatNow.innerHTML = `<p class="kicker">Now</p>${title}${reason}${action}`;

    const officialOn = official;
    const lines = [
      `<button type="button" class="line${officialOn ? " is-on" : ""}" data-act="use-official" aria-pressed="${officialOn}" role="listitem">
        <span class="line-main"><span class="line-plain">Official Grok</span></span>
        <span class="line-aside">${officialOn ? `<span class="badge badge-live">On</span>` : ""}</span>
      </button>`,
    ];

    for (const providerRow of catalog.providers) {
      for (const row of modelsFor(providerRow.id)) {
        const on = !official && catalog.activeModelId === row.id;
        const need = !providerRow.hasKey;
        lines.push(`<button type="button" class="line${on ? " is-on" : ""}" data-act="use-line" data-id="${esc(
          row.id,
        )}" aria-pressed="${on}" role="listitem">
          <span class="line-main">
            <span class="line-slug">${esc(row.slug)}</span>
            <span class="line-sep">·</span>
            <span class="line-provider">${esc(providerRow.name)}</span>
          </span>
          <span class="line-aside">${
            on
              ? `<span class="badge badge-live">On</span>`
              : need
                ? `<span class="line-need">Needs key</span>`
                : ""
          }</span>
        </button>`);
      }
    }

    el.chatLines.innerHTML = lines.join("");
  }

  function renderProvider() {
    const provider = providerById(ui.selectedProviderId);
    if (!provider) {
      goChat();
      return;
    }
    const showKey = !provider.hasKey || ui.replaceKey || ui.focusKey;
    const models = modelsFor(provider.id);
    const liveId = liveModel()?.id;

    const rows = models
      .map((row) => {
        const on = liveId === row.id;
        const use = on
          ? `<span class="badge badge-live">On</span>`
          : `<button type="button" class="button-secondary" data-act="use-line" data-id="${esc(row.id)}" ${
              provider.hasKey ? "" : "disabled"
            }>Use</button>`;
        return `<div class="model-row">
          <button type="button" class="model-row-hit" data-act="open-model" data-id="${esc(row.id)}">
            <span class="model-id">${esc(row.slug)}</span>
            <span class="model-meta">${esc(formatTokens(row.contextTokens))} context</span>
          </button>
          <div class="model-row-actions">
            ${use}
            <button type="button" class="button-tertiary" data-act="open-model" data-id="${esc(row.id)}">Configure</button>
          </div>
        </div>`;
      })
      .join("");

    const keyBlock = showKey
      ? `<form class="stack-form" id="form-key">
          <div class="field">
            <label for="provider-secret">${provider.hasKey ? "Replace API key" : "API Key"}</label>
            <div class="password-field">
              <input id="provider-secret" name="secret" type="password" required autocomplete="new-password" placeholder="sk-…" value="${esc(
                ui.secretDraft,
              )}" />
              <button type="button" class="button-tertiary" data-act="toggle-secret" data-for="provider-secret">Show</button>
            </div>
          </div>
          <div class="form-actions">
            <button type="submit" class="button-primary">Save API Key</button>
            ${
              provider.hasKey
                ? `<button type="button" class="button-tertiary" data-act="cancel-key">Cancel</button>`
                : ""
            }
          </div>
        </form>`
      : `<button type="button" class="button-tertiary" data-act="replace-key">Replace API key</button>`;

    const removeBlock = ui.confirmRemove
      ? `<div class="confirm-row">
          <p class="fine">Remove ${esc(provider.name)}? Models on it go away. Official Grok stays available.</p>
          <div class="confirm-actions">
            <button type="button" class="button-secondary" data-act="cancel-remove">Cancel</button>
            <button type="button" class="button-danger" data-act="remove-provider">Remove</button>
          </div>
        </div>`
      : `<div class="danger-zone">
          <button type="button" class="button-tertiary danger-text" data-act="confirm-remove">Remove provider</button>
        </div>`;

    const note = ui.providerNote
      ? `<p class="fine${ui.providerNoteError ? " error" : ""}" role="${ui.providerNoteError ? "alert" : "status"}">${esc(
          ui.providerNote,
        )}</p>`
      : "";

    el.screenProvider.innerHTML = `
      <div class="detail">
        <header class="detail-head">
          <div class="detail-head-copy">
            <h2 id="provider-title">${esc(provider.name)}</h2>
            <p class="caption-mono">${esc(provider.origin)}</p>
          </div>
          <span class="${provider.hasKey ? "badge" : "badge badge-warn"}">${
            provider.hasKey ? "Key saved" : "No API key"
          }</span>
        </header>
        <div>
          <p class="section-label">Models</p>
          <div class="model-rows">${rows || `<p class="fine" style="padding:12px 14px">No models yet.</p>`}</div>
        </div>
        <form class="add-model" id="form-add-model">
          <div class="field">
            <label for="add-model-slug">Add model</label>
            <input id="add-model-slug" class="mono-input" name="slug" autocomplete="off" placeholder="Model ID" value="${esc(
              ui.addModelSlug,
            )}" />
          </div>
          <button type="submit" class="button-secondary">Add</button>
        </form>
        ${keyBlock}
        ${removeBlock}
        ${note}
      </div>`;
  }

  function renderModel() {
    const model = modelById(ui.selectedModelId);
    const provider = model ? providerById(model.providerId) : null;
    if (!model || !provider) {
      goChat();
      return;
    }
    if (!ui.modelDraft) {
      ui.modelDraft = {
        contextTokens: model.contextTokens,
        maxOutputTokens: model.maxOutputTokens,
        reasoningLevels: [...model.reasoningLevels],
        modalities: [...model.modalities],
      };
    }
    const draft = ui.modelDraft;
    const on = liveModel()?.id === model.id;

    const reasonChips = REASONING_LEVELS.map((level) => {
      const selected = draft.reasoningLevels.includes(level);
      return `<button type="button" class="chip${selected ? " chip-on" : ""}" data-act="reason-cfg" data-level="${esc(
        level,
      )}" aria-pressed="${selected}">${esc(labelReasoning(level))}</button>`;
    }).join("");

    const modalityChips = MODALITIES.map((item) => {
      const selected = draft.modalities.includes(item);
      return `<button type="button" class="chip${selected ? " chip-on" : ""}" data-act="modality-cfg" data-item="${esc(
        item,
      )}" aria-pressed="${selected}">${esc(labelModality(item))}</button>`;
    }).join("");

    const use = on
      ? `<span class="badge badge-live">On</span>`
      : `<button type="button" class="button-secondary" data-act="use-this-model">Use this model</button>`;

    const note = ui.modelNote ? `<p class="fine" role="status">${esc(ui.modelNote)}</p>` : "";

    el.screenModel.innerHTML = `
      <div class="detail">
        <header class="detail-head">
          <div class="detail-head-copy">
            <nav class="crumb" aria-label="Breadcrumb">
              <button type="button" class="crumb-link" data-act="nav-provider" data-id="${esc(provider.id)}">${esc(
                provider.name,
              )}</button>
              <span aria-hidden="true">/</span>
              <span class="crumb-current">Model</span>
            </nav>
            <h2 class="model-heading" id="model-title">${esc(model.slug)}</h2>
          </div>
          ${use}
        </header>
        <form id="form-model">
          <div class="limits-grid">
            <div class="field">
              <label for="model-context">Context</label>
              <input id="model-context" name="context" type="number" min="1" max="10000000" value="${esc(
                draft.contextTokens,
              )}" />
            </div>
            <div class="field">
              <label for="model-output">Max output</label>
              <input id="model-output" name="output" type="number" min="1" max="10000000" value="${esc(
                draft.maxOutputTokens,
              )}" />
            </div>
          </div>
          <div>
            <p class="section-label" id="reasoning-cfg-label">Reasoning levels</p>
            <div class="chip-row" role="group" aria-labelledby="reasoning-cfg-label">${reasonChips}</div>
          </div>
          <div>
            <p class="section-label" id="modality-cfg-label">Input types</p>
            <div class="chip-row" role="group" aria-labelledby="modality-cfg-label">${modalityChips}</div>
            <p class="hint-soft">Image, video, and audio are saved on the model. Chat still sends text.</p>
          </div>
          <div class="form-actions">
            <button type="submit" class="button-primary">Save model</button>
            ${note}
          </div>
        </form>
      </div>`;
  }

  function paint() {
    if (ui.view === "first-run") {
      setScreen("first-run");
      el.firstPresets.hidden = ui.firstStep !== "presets";
      el.firstForm.hidden = ui.firstStep !== "form";
      renderBanner();
      return;
    }
    setScreen(ui.view);
    renderRail();
    renderBanner();
    if (ui.view === "chat") renderChat();
    if (ui.view === "provider") renderProvider();
    if (ui.view === "model") renderModel();
    if (ui.view === "add") {
      el.addPresets.hidden = ui.addStep !== "presets";
      el.addForm.hidden = ui.addStep !== "form";
    }
  }

  function goChat() {
    ui.view = "chat";
    ui.focusKey = false;
    ui.confirmRemove = false;
    ui.modelNote = "";
    paint();
  }

  function goProvider(id, opts = {}) {
    const provider = providerById(id);
    if (!provider) return;
    ui.view = "provider";
    ui.selectedProviderId = id;
    ui.replaceKey = Boolean(opts.replaceKey);
    ui.focusKey = Boolean(opts.focusKey) || !provider.hasKey;
    ui.confirmRemove = false;
    ui.addModelSlug = "";
    ui.secretDraft = "";
    ui.providerNote = "";
    ui.providerNoteError = false;
    paint();
    if (ui.focusKey || ui.replaceKey) {
      document.getElementById("provider-secret")?.focus();
    }
  }

  function goModel(id) {
    const model = modelById(id);
    if (!model) return;
    ui.view = "model";
    ui.selectedModelId = id;
    ui.selectedProviderId = model.providerId;
    ui.modelDraft = {
      contextTokens: model.contextTokens,
      maxOutputTokens: model.maxOutputTokens,
      reasoningLevels: [...model.reasoningLevels],
      modalities: [...model.modalities],
    };
    ui.modelNote = "";
    paint();
  }

  function goAdd() {
    ui.view = "add";
    ui.addStep = "presets";
    addPreset = null;
    el.addError.hidden = true;
    paint();
  }

  function useOfficial() {
    catalog.mode = "official";
    goChat();
  }

  function useModel(modelId, reasoning) {
    const model = modelById(modelId);
    if (!model) return;
    const provider = providerById(model.providerId);
    if (!provider) return;
    if (!provider.hasKey) {
      goProvider(provider.id, { focusKey: true });
      return;
    }
    catalog.mode = "custom";
    catalog.activeModelId = model.id;
    if (reasoning) {
      model.activeReasoning = reasoning;
    }
    if (ui.view === "model" || ui.view === "provider") {
      paint();
      return;
    }
    goChat();
  }

  function connectFromForm(form, asFirstRun) {
    const name = form.name.value.trim();
    const origin = form.origin.value.trim();
    const modelSlug = form.modelSlug.value.trim();
    const secret = form.secret.value.trim();
    const errorNode = asFirstRun ? el.firstError : el.addError;
    if (!name || !origin || !modelSlug || !secret) {
      errorNode.hidden = false;
      errorNode.textContent = "Name, base URL, model ID, and API key are required.";
      return;
    }
    errorNode.hidden = true;
    const limits = defaultLimits();
    const provider = {
      id: uid("p"),
      name,
      origin,
      hasKey: true,
    };
    const model = {
      id: uid("m"),
      providerId: provider.id,
      slug: modelSlug,
      ...limits,
      activeReasoning: "none",
    };
    catalog.providers.push(provider);
    catalog.models.push(model);
    catalog.mode = "custom";
    catalog.activeModelId = model.id;
    ui.firstStep = "presets";
    ui.addStep = "presets";
    firstPreset = null;
    addPreset = null;
    form.reset();
    goChat();
  }

  function resetFirstRun() {
    catalog = {
      mode: "official",
      activeModelId: null,
      hostBlocked: catalog.hostBlocked,
      providers: [],
      models: [],
    };
    ui.view = "first-run";
    ui.firstStep = "presets";
    ui.selectedProviderId = null;
    ui.selectedModelId = null;
    firstPreset = null;
    el.firstError.hidden = true;
    el.formFirst.reset();
    paint();
  }

  function readModelDraftFromDom() {
    if (!ui.modelDraft) return;
    const context = document.getElementById("model-context");
    const output = document.getElementById("model-output");
    if (context) {
      const next = Number(context.value);
      if (Number.isFinite(next) && next > 0) ui.modelDraft.contextTokens = Math.floor(next);
    }
    if (output) {
      const next = Number(output.value);
      if (Number.isFinite(next) && next > 0) ui.modelDraft.maxOutputTokens = Math.floor(next);
    }
  }

  function saveModel() {
    readModelDraftFromDom();
    const model = modelById(ui.selectedModelId);
    if (!model || !ui.modelDraft) return;
    model.contextTokens = ui.modelDraft.contextTokens;
    model.maxOutputTokens = ui.modelDraft.maxOutputTokens;
    model.reasoningLevels = [...ui.modelDraft.reasoningLevels];
    model.modalities = [...ui.modelDraft.modalities];
    clampReasoning(model);
    ui.modelNote = "Saved.";
    paint();
  }

  document.addEventListener("click", (event) => {
    const target = event.target.closest("[data-act]");
    if (!target) return;
    const act = target.dataset.act;

    if (act === "toggle-secret") {
      const input = document.getElementById(target.dataset.for);
      if (!input) return;
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      target.textContent = show ? "Hide" : "Show";
      return;
    }

    if (act === "pick-preset") {
      const preset = PRESETS.find((row) => row.id === target.dataset.id);
      if (!preset) return;
      const draft = draftFromPreset(preset);
      if (target.dataset.which === "first") {
        firstPreset = preset;
        ui.firstStep = "form";
        paint();
        fillSetupForm("first", draft, preset);
        document.getElementById(preset.id === "custom" ? "first-name" : "first-secret")?.focus();
      } else {
        addPreset = preset;
        ui.addStep = "form";
        paint();
        fillSetupForm("add", draft, preset);
        document.getElementById(preset.id === "custom" ? "add-name" : "add-secret")?.focus();
      }
      return;
    }

    if (act === "first-change") {
      ui.firstStep = "presets";
      firstPreset = null;
      el.firstError.hidden = true;
      paint();
      return;
    }

    if (act === "add-change") {
      ui.addStep = "presets";
      addPreset = null;
      el.addError.hidden = true;
      paint();
      return;
    }

    if (act === "add-cancel") {
      goChat();
      return;
    }

    if (act === "nav-chat") {
      goChat();
      return;
    }

    if (act === "nav-add") {
      goAdd();
      return;
    }

    if (act === "nav-provider") {
      goProvider(target.dataset.id);
      return;
    }

    if (act === "back") {
      if (ui.view === "model") {
        goProvider(ui.selectedProviderId);
        return;
      }
      if (ui.view === "add" && ui.addStep === "form") {
        ui.addStep = "presets";
        paint();
        return;
      }
      goChat();
      return;
    }

    if (act === "use-official") {
      useOfficial();
      return;
    }

    if (act === "use-line") {
      useModel(target.dataset.id);
      return;
    }

    if (act === "use-this-model") {
      useModel(ui.selectedModelId);
      return;
    }

    if (act === "reason-now") {
      const model = liveModel();
      if (!model) return;
      model.activeReasoning = target.dataset.level;
      paint();
      return;
    }

    if (act === "open-model") {
      goModel(target.dataset.id);
      return;
    }

    if (act === "replace-key") {
      ui.replaceKey = true;
      ui.focusKey = true;
      ui.secretDraft = "";
      paint();
      document.getElementById("provider-secret")?.focus();
      return;
    }

    if (act === "cancel-key") {
      ui.replaceKey = false;
      ui.focusKey = false;
      ui.secretDraft = "";
      paint();
      return;
    }

    if (act === "confirm-remove") {
      ui.confirmRemove = true;
      paint();
      return;
    }

    if (act === "cancel-remove") {
      ui.confirmRemove = false;
      paint();
      return;
    }

    if (act === "remove-provider") {
      const id = ui.selectedProviderId;
      const active = modelById(catalog.activeModelId);
      const removedActive = active?.providerId === id;
      catalog.models = catalog.models.filter((row) => row.providerId !== id);
      catalog.providers = catalog.providers.filter((row) => row.id !== id);
      if (removedActive || !modelById(catalog.activeModelId)) {
        catalog.mode = "official";
        catalog.activeModelId =
          catalog.models.find((row) => providerById(row.providerId)?.hasKey)?.id ??
          catalog.models[0]?.id ??
          null;
      }
      if (catalog.providers.length === 0) {
        resetFirstRun();
        return;
      }
      goChat();
      return;
    }

    if (act === "reason-cfg") {
      readModelDraftFromDom();
      ui.modelDraft.reasoningLevels = toggleIn(
        REASONING_LEVELS,
        ui.modelDraft.reasoningLevels,
        target.dataset.level,
      );
      paint();
      return;
    }

    if (act === "modality-cfg") {
      readModelDraftFromDom();
      ui.modelDraft.modalities = toggleIn(MODALITIES, ui.modelDraft.modalities, target.dataset.item);
      paint();
      return;
    }

    if (act === "reset-first-run") {
      resetFirstRun();
      return;
    }

    if (act === "toggle-blocked") {
      catalog.hostBlocked = !catalog.hostBlocked;
      paint();
    }
  });

  el.formFirst.addEventListener("submit", (event) => {
    event.preventDefault();
    connectFromForm(el.formFirst, true);
  });

  el.formAdd.addEventListener("submit", (event) => {
    event.preventDefault();
    connectFromForm(el.formAdd, false);
  });

  document.addEventListener("submit", (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    if (form.id === "form-key") {
      event.preventDefault();
      const input = form.querySelector("#provider-secret");
      const secret = input?.value.trim() ?? "";
      const provider = providerById(ui.selectedProviderId);
      if (!provider) return;
      if (!secret) {
        ui.providerNote = "Paste an API key to save it on this Computer.";
        ui.providerNoteError = true;
        paint();
        return;
      }
      provider.hasKey = true;
      ui.replaceKey = false;
      ui.focusKey = false;
      ui.secretDraft = "";
      ui.providerNote = "API key saved.";
      ui.providerNoteError = false;
      paint();
      return;
    }
    if (form.id === "form-add-model") {
      event.preventDefault();
      const input = form.querySelector("#add-model-slug");
      const slug = input?.value.trim() ?? "";
      if (!slug) return;
      const existing = modelsFor(ui.selectedProviderId).find((row) => row.slug === slug);
      if (existing) {
        goModel(existing.id);
        return;
      }
      const limits = defaultLimits();
      const model = {
        id: uid("m"),
        providerId: ui.selectedProviderId,
        slug,
        ...limits,
        activeReasoning: "none",
      };
      catalog.models.push(model);
      ui.addModelSlug = "";
      ui.providerNote = `Added ${slug}.`;
      ui.providerNoteError = false;
      paint();
      return;
    }
    if (form.id === "form-model") {
      event.preventDefault();
      saveModel();
    }
  });

  document.addEventListener("input", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    if (target.id === "add-model-slug") ui.addModelSlug = target.value;
    if (target.id === "provider-secret") ui.secretDraft = target.value;
    if (target.id === "model-context" || target.id === "model-output") readModelDraftFromDom();
  });

  renderPresets(el.firstGrid, "first");
  renderPresets(el.addGrid, "add");

  if (location.hash === "#first-run") {
    resetFirstRun();
  } else {
    paint();
  }
})();
