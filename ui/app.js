const navStatus = document.getElementById("nav-status");
const nowHeading = document.getElementById("now-heading");
const nowCopy = document.getElementById("now-copy");
const nowOrigin = document.getElementById("now-origin");
const nowActions = document.getElementById("now-actions");
const listEl = document.getElementById("provider-list");
const addDetails = document.getElementById("add-provider");
const form = document.getElementById("provider-form");
const formNote = document.getElementById("form-note");

let expandedProviderId = null;
let addOpenOverride = null;

function modelsFor(state, providerId) {
  return (state.models || []).filter((row) => row.providerId === providerId);
}

function ownerOfActive(state) {
  const active = state.activeModelId;
  if (!active) {
    return null;
  }
  const model = (state.models || []).find((row) => row.id === active);
  return model?.providerId ?? null;
}

function setNote(el, text, isError) {
  if (!el) {
    return;
  }
  el.textContent = text;
  el.classList.toggle("error", Boolean(isError) && Boolean(text));
}

function wireSecretToggle(root) {
  root.querySelectorAll("[data-toggle-secret]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const input = document.getElementById(btn.getAttribute("data-toggle-secret"));
      if (!input) {
        return;
      }
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      btn.textContent = show ? "Hide" : "Show";
    });
  });
}

function renderNow(state) {
  const custom = state.snapshot?.wrap?.kind === "openbot-marked";
  navStatus.textContent = custom ? "Custom" : "Official";
  nowActions.replaceChildren();
  nowHeading.classList.remove("mono");
  nowOrigin.hidden = true;
  nowOrigin.textContent = "";
  nowCopy.classList.remove("error");

  if (!custom) {
    nowHeading.textContent = "Official Grok";
    nowCopy.textContent = "Chat uses stock Grok.";
    return;
  }

  const active = (state.models || []).find((row) => row.id === state.activeModelId);
  const provider = (state.providers || []).find((row) => row.id === active?.providerId);
  nowHeading.classList.add("mono");
  nowHeading.textContent = active?.slug || "Custom model";
  nowCopy.textContent = provider?.name || "Using a custom model.";
  if (provider?.origin) {
    nowOrigin.hidden = false;
    nowOrigin.textContent = provider.origin;
  }
  const official = document.createElement("button");
  official.type = "button";
  official.className = "button-secondary";
  official.textContent = "Switch to Official";
  official.addEventListener("click", () => {
    official.disabled = true;
    post({ kind: "official" }).catch((err) => {
      setNote(nowCopy, err.message, true);
      official.disabled = false;
    });
  });
  nowActions.append(official);
}

function shouldOpenProvider(providerId, activeOwner) {
  if (expandedProviderId === "") {
    return false;
  }
  if (expandedProviderId) {
    return expandedProviderId === providerId;
  }
  return activeOwner === providerId;
}

function nestedDetails(title, body) {
  const wrap = document.createElement("details");
  wrap.className = "nested";
  const summary = document.createElement("summary");
  const label = document.createElement("span");
  label.textContent = title;
  const chevron = document.createElement("span");
  chevron.className = "chevron";
  chevron.setAttribute("aria-hidden", "true");
  summary.append(label, chevron);
  const panel = document.createElement("div");
  panel.className = "panel";
  panel.append(body);
  wrap.append(summary, panel);
  return wrap;
}

function renderProvider(state, provider, keyed, active, activeOwner) {
  const details = document.createElement("details");
  details.className = "provider-row";
  details.open = shouldOpenProvider(provider.id, activeOwner);
  details.addEventListener("toggle", () => {
    expandedProviderId = details.open ? provider.id : expandedProviderId === provider.id ? "" : expandedProviderId;
  });

  const models = modelsFor(state, provider.id);
  const inUse = models.find((row) => row.id === active);
  const summary = document.createElement("summary");
  const main = document.createElement("div");
  main.className = "summary-main";
  const name = document.createElement("h3");
  name.className = "summary-name";
  name.textContent = provider.name;
  const meta = document.createElement("p");
  meta.className = "summary-meta";
  const keyBit = keyed.has(provider.id) ? "API Key saved" : "No API Key";
  meta.textContent = inUse
    ? `${inUse.slug} in use · ${keyBit}`
    : `${models.length} model${models.length === 1 ? "" : "s"} · ${keyBit}`;
  main.append(name, meta);
  const chevron = document.createElement("span");
  chevron.className = "chevron";
  chevron.setAttribute("aria-hidden", "true");
  summary.append(main, chevron);

  const panel = document.createElement("div");
  panel.className = "panel";
  const note = document.createElement("p");
  note.className = "fine";
  note.setAttribute("aria-live", "polite");

  const modelList = document.createElement("div");
  for (const model of models) {
    const row = document.createElement("div");
    row.className = "model-row";
    const id = document.createElement("span");
    id.className = "model-id";
    id.textContent = model.slug;
    const actions = document.createElement("div");
    actions.className = "row-actions";
    if (model.id === active) {
      const badge = document.createElement("span");
      badge.className = "badge badge-live";
      badge.textContent = "In use";
      actions.append(badge);
    } else {
      const use = document.createElement("button");
      use.type = "button";
      use.className = "button-secondary";
      use.textContent = "Use";
      use.addEventListener("click", () => {
        expandedProviderId = provider.id;
        use.disabled = true;
        post({ kind: "use-model", modelId: model.id }).catch((err) => {
          setNote(note, err.message, true);
          use.disabled = false;
        });
      });
      actions.append(use);
    }
    row.append(id, actions);
    modelList.append(row);
  }
  panel.append(modelList, note);

  const addForm = document.createElement("form");
  const addLabel = document.createElement("label");
  addLabel.append("Model ID");
  const addInput = document.createElement("input");
  addInput.name = "modelId";
  addInput.required = true;
  addInput.autocomplete = "off";
  addInput.setAttribute("aria-label", "Model ID");
  addLabel.append(addInput);
  const addBtn = document.createElement("button");
  addBtn.type = "submit";
  addBtn.className = "button-secondary";
  addBtn.textContent = "Add";
  addForm.append(addLabel, addBtn);
  addForm.addEventListener("submit", (event) => {
    event.preventDefault();
    expandedProviderId = provider.id;
    addBtn.disabled = true;
    post({ kind: "upsert-model", providerId: provider.id, slug: addInput.value }).catch((err) => {
      setNote(note, err.message, true);
      addBtn.disabled = false;
    });
  });

  const secretId = `secret-${provider.id}`;
  const secretForm = document.createElement("form");
  const secretLabel = document.createElement("label");
  secretLabel.append("API Key");
  const secretField = document.createElement("span");
  secretField.className = "password-field";
  const secret = document.createElement("input");
  secret.type = "password";
  secret.required = true;
  secret.autocomplete = "new-password";
  secret.id = secretId;
  secret.setAttribute("aria-label", "API Key");
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "button-tertiary";
  toggle.setAttribute("data-toggle-secret", secretId);
  toggle.textContent = "Show";
  secretField.append(secret, toggle);
  secretLabel.append(secretField);
  const secretBtn = document.createElement("button");
  secretBtn.type = "submit";
  secretBtn.className = "button-primary";
  secretBtn.textContent = "Save API Key";
  secretForm.append(secretLabel, secretBtn);
  secretForm.addEventListener("submit", (event) => {
    event.preventDefault();
    expandedProviderId = provider.id;
    secretBtn.disabled = true;
    post({ kind: "set-secret", providerId: provider.id, secret: secret.value })
      .then(() => {
        secret.value = "";
      })
      .catch((err) => {
        setNote(note, err.message, true);
        secretBtn.disabled = false;
      });
  });

  const removeWrap = document.createElement("div");
  const ask = document.createElement("button");
  ask.type = "button";
  ask.className = "button-tertiary";
  ask.textContent = "Remove provider";
  const confirmRow = document.createElement("div");
  confirmRow.className = "confirm-row";
  confirmRow.hidden = true;
  ask.addEventListener("click", () => {
    ask.hidden = true;
    confirmRow.hidden = false;
  });
  const warn = document.createElement("p");
  warn.className = "fine";
  warn.textContent = "Remove this provider?";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "button-secondary";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => {
    confirmRow.hidden = true;
    ask.hidden = false;
  });
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "button-danger";
  remove.textContent = "Remove";
  remove.addEventListener("click", () => {
    remove.disabled = true;
    post({ kind: "remove-provider", providerId: provider.id }).catch((err) => {
      setNote(note, err.message, true);
      remove.disabled = false;
    });
  });
  confirmRow.append(warn, cancel, remove);
  removeWrap.append(ask, confirmRow);

  panel.append(
    nestedDetails("Add model", addForm),
    nestedDetails("API Key", secretForm),
    nestedDetails("Remove", removeWrap),
  );
  details.append(summary, panel);
  wireSecretToggle(details);
  return details;
}

function render(state) {
  const providers = state.providers || [];
  const keyed = new Set(state.keyedProviders || []);
  const active = state.activeModelId;
  const activeOwner = ownerOfActive(state);
  const custom = state.snapshot?.wrap?.kind === "openbot-marked";
  renderNow(state);
  listEl.replaceChildren();
  if (!providers.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No providers yet. Chat stays official until you add one.";
    listEl.append(empty);
  } else {
    for (const provider of providers) {
      listEl.append(renderProvider(state, provider, keyed, custom ? active : null, custom ? activeOwner : null));
    }
  }
  if (addOpenOverride === null) {
    addDetails.open = providers.length === 0;
  } else {
    addDetails.open = addOpenOverride;
  }
}

async function getJson(url, options) {
  const res = await fetch(url, options);
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(text || res.statusText);
  }
  if (!res.ok) {
    throw new Error(data.error?.message || data.error?.kind || data.error || text);
  }
  return data;
}

async function post(body) {
  setNote(formNote, "Saving…", false);
  try {
    const state = await getJson("/api/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (body.kind === "upsert-provider") {
      const created = (state.providers || []).find((row) => row.name === body.name);
      expandedProviderId = created?.id ?? expandedProviderId;
      addOpenOverride = false;
    }
    if (body.kind === "official") {
      expandedProviderId = "";
    }
    setNote(formNote, "", false);
    render(state);
    return state;
  } catch (err) {
    setNote(formNote, err.message, true);
    throw err;
  }
}

async function refresh() {
  const state = await getJson("/api/state");
  render(state);
}

addDetails.addEventListener("toggle", () => {
  addOpenOverride = addDetails.open;
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const data = new FormData(form);
  const submit = form.querySelector('button[type="submit"]');
  if (submit) {
    submit.disabled = true;
  }
  post({
    kind: "upsert-provider",
    name: String(data.get("name") || ""),
    origin: String(data.get("origin") || ""),
    modelSlug: String(data.get("modelSlug") || ""),
    secret: String(data.get("secret") || ""),
  })
    .then(() => {
      form.secret.value = "";
    })
    .finally(() => {
      if (submit) {
        submit.disabled = false;
      }
    });
});

wireSecretToggle(document);
refresh().catch((err) => {
  nowCopy.textContent = err.message;
  nowCopy.classList.add("error");
});
