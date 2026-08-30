const modeStatus = document.getElementById("mode-status");
const catalogEl = document.getElementById("catalog");
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
    throw new Error(data.error?.message || data.error?.kind || text);
  }
  return data;
}

function describeSnapshot(snapshot) {
  const wrap = snapshot?.wrap?.kind ?? "unknown";
  const hop = snapshot?.hopListen?.kind ?? "unknown";
  const align = snapshot?.alignment?.kind ?? "unknown";
  if (wrap === "stock-unmarked") {
    return `Official. Stock factory is in the host file. Hop is ${hop}. Alignment ${align}.`;
  }
  if (wrap === "openbot-marked") {
    return `Custom. Host wrap is marked. Hop is ${hop}. Alignment ${align}.`;
  }
  if (align === "needs-reinstall") {
    return "Desired custom, but the vendor rewrote the host. Save again to re-wrap.";
  }
  return `Wrap ${wrap}. Hop ${hop}. Alignment ${align}.`;
}

async function refresh() {
  const snap = await getJson("/api/snapshot");
  modeStatus.textContent = describeSnapshot(snap.snapshot);
  const catalog = await getJson("/api/catalog");
  catalogEl.textContent = JSON.stringify(catalog, null, 2);
}

document.getElementById("btn-refresh").addEventListener("click", () => {
  refresh().catch((err) => {
    modeStatus.textContent = err.message;
  });
});

document.getElementById("btn-official").addEventListener("click", () => {
  getJson("/api/save", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "official" }),
  })
    .then(refresh)
    .catch((err) => {
      modeStatus.textContent = err.message;
    });
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const data = new FormData(form);
  formNote.textContent = "Reconciling…";
  getJson("/api/save", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      kind: "custom",
      name: String(data.get("name") || ""),
      origin: String(data.get("origin") || ""),
      modelSlug: String(data.get("modelSlug") || ""),
      secret: String(data.get("secret") || ""),
    }),
  })
    .then(() => {
      formNote.textContent = "Saved. Chat on the Bot now uses this model.";
      form.secret.value = "";
      return refresh();
    })
    .catch((err) => {
      formNote.textContent = err.message;
    });
});

refresh().catch((err) => {
  modeStatus.textContent = err.message;
});
