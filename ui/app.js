const modeStatus = document.getElementById("mode-status");
const navStatus = document.getElementById("nav-status");
const listEl = document.getElementById("provider-list");
const form = document.getElementById("provider-form");
const formNote = document.getElementById("form-note");

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

function describeSnapshot(snapshot) {
  const wrap = snapshot?.wrap?.kind ?? "unknown";
  const hop = snapshot?.hopListen?.kind ?? "unknown";
  const align = snapshot?.alignment?.kind ?? "unknown";
  if (wrap === "stock-unmarked") {
    return `Official. Stock factory is in the host file. Hop is ${hop}.`;
  }
  if (wrap === "openbot-marked") {
    return `Custom. Host wrap is marked. Hop is ${hop}. Alignment ${align}.`;
  }
  if (align === "needs-reinstall") {
    return "Desired custom, but the vendor rewrote the host. Save a provider again to re-wrap.";
  }
  return `Wrap ${wrap}. Hop ${hop}. Alignment ${align}.`;
}

function modelsFor(catalog, providerId) {
  return (catalog.models || []).filter((row) => row.providerId === providerId);
}

function render(state) {
  const catalog = state.catalog || { providers: [], models: [], bindings: [] };
  const keyed = new Set(state.keyedProviders || []);
  const active = state.activeModelId;
  navStatus.textContent = state.snapshot?.wrap?.kind === "openbot-marked" ? "Custom" : "Official";
  modeStatus.textContent = describeSnapshot(state.snapshot);
  listEl.replaceChildren();
  if (!catalog.providers.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No providers yet. Add one below. Chat stays official until you do.";
    listEl.append(empty);
    return;
  }
  for (const provider of catalog.providers) {
    const card = document.createElement("article");
    card.className = "provider-card";
    const title = document.createElement("h3");
    title.className = "title-md";
    title.textContent = provider.name;
    const origin = document.createElement("p");
    origin.className = "code";
    origin.textContent = provider.origin;
    const keyLine = document.createElement("p");
    keyLine.className = "fine";
    keyLine.textContent = keyed.has(provider.id) ? "API key on disk" : "No API key yet";
    card.append(title, origin, keyLine);
    for (const model of modelsFor(catalog, provider.id)) {
      const row = document.createElement("div");
      row.className = "model-row";
      const label = document.createElement("span");
      label.className = "model-slug";
      label.textContent = model.slug;
      const actions = document.createElement("div");
      actions.className = "card-actions";
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
          post({ kind: "use-model", modelId: model.id }).catch((err) => {
            formNote.textContent = err.message;
          });
        });
        actions.append(use);
      }
      row.append(label, actions);
      card.append(row);
    }
    const addModel = document.createElement("form");
    addModel.className = "model-add";
    const slug = document.createElement("input");
    slug.name = "slug";
    slug.required = true;
    slug.placeholder = "another-model-slug";
    slug.autocomplete = "off";
    slug.setAttribute("aria-label", "Model slug");
    const addBtn = document.createElement("button");
    addBtn.type = "submit";
    addBtn.className = "button-secondary";
    addBtn.textContent = "Add model";
    addModel.append(slug, addBtn);
    addModel.addEventListener("submit", (event) => {
      event.preventDefault();
      post({ kind: "upsert-model", providerId: provider.id, slug: slug.value }).catch((err) => {
        formNote.textContent = err.message;
      });
    });
    const foot = document.createElement("div");
    foot.className = "card-foot";
    const secretForm = document.createElement("form");
    const secret = document.createElement("input");
    secret.type = "password";
    secret.required = true;
    secret.placeholder = "update API key";
    secret.setAttribute("aria-label", "API key");
    const secretBtn = document.createElement("button");
    secretBtn.type = "submit";
    secretBtn.className = "button-tertiary";
    secretBtn.textContent = "Save key";
    secretForm.append(secret, secretBtn);
    secretForm.addEventListener("submit", (event) => {
      event.preventDefault();
      post({ kind: "set-secret", providerId: provider.id, secret: secret.value }).then(() => {
        secret.value = "";
      }).catch((err) => {
        formNote.textContent = err.message;
      });
    });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "button-tertiary";
    remove.textContent = "Remove provider";
    remove.addEventListener("click", () => {
      post({ kind: "remove-provider", providerId: provider.id }).catch((err) => {
        formNote.textContent = err.message;
      });
    });
    foot.append(secretForm, remove);
    card.append(addModel, foot);
    listEl.append(card);
  }
}

async function post(body) {
  formNote.textContent = "Reconciling…";
  const state = await getJson("/api/save", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  formNote.textContent = "";
  render(state);
  return state;
}

async function refresh() {
  const state = await getJson("/api/state");
  render(state);
}

document.getElementById("btn-refresh").addEventListener("click", () => {
  refresh().catch((err) => {
    modeStatus.textContent = err.message;
  });
});

document.getElementById("btn-official").addEventListener("click", () => {
  post({ kind: "official" }).catch((err) => {
    modeStatus.textContent = err.message;
  });
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const data = new FormData(form);
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
    .catch((err) => {
      formNote.textContent = err.message;
    });
});

refresh().catch((err) => {
  modeStatus.textContent = err.message;
});
