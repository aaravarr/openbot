# OpenBot Web UI — Feature Inventory (Phase 1: Rebuild Input)

> Source of truth: the backend code (`src/`, `payload/`) and the functional behavior of the
> current UI source (`web/src/`, built into `ui/` by Vite). This document inventories **what the
> product can do**, not how the current UI looks. Every claim below was verified against code.

---

## 1. Product summary

OpenBot is a **single-user, localhost control tool** that runs on the "Computer" (a Linux box)
where the desktop app **Grok Bot 0.30** executes its chat turns. It lets the owner reroute Grok
Bot's chat from the stock xAI model ("Official Grok") to **any OpenAI-compatible Chat Completions
provider** (OpenAI, DeepSeek, Zhipu GLM, Kimi/Moonshot, Qwen, OpenRouter, Groq, xAI, or a custom
endpoint) without leaving the Grok Bot app. It works by wrapping one factory function in the
Computer-side host file (`/home/box/sand-host/host-main.cjs`) and serving an OpenAI-compatible
"hop" endpoint on `127.0.0.1:9280` that forwards turns to the configured upstream with the stored
API key. A single loopback web service serves both the control UI (`GET /`, `/api/*`) and the hop
(`POST /v1/chat/completions`). API keys are stored locally (`secrets.json`, mode `0600`), never
sent to the browser, never accepted on the command line, and redacted from all logs. The user can
switch back to Official Grok at any time; saved providers and keys survive the switch.

---

## 2. Backend API inventory

One Node process (`src/ui/server.ts`) binds `127.0.0.1:9280` (env-overridable via
`OPENBOT_UI_HOST`/`OPENBOT_UI_PORT`, but the domain model fixes loopback:9280). It serves three
things: static UI files, the JSON control API, and the hop. All API responses are JSON with
`Cache-Control: no-store`.

### 2.1 Control API (`/api/*`)

| Method | Path | Purpose | Request payload | Response |
|---|---|---|---|---|
| GET | `/api/state` | Full UI state: live supervisor `Snapshot` + catalog + secret presence + active model + log settings | — | `{ snapshot, providers, models, keyedProviders, activeModelId, logSettings }` |
| GET | `/api/snapshot` | **Alias of `/api/state`** (identical handler) | — | same as above |
| POST | `/api/save` | **The single mutation endpoint.** Parses a UI command into `DesiredState`, runs `reconcile()` (wrap/unwrap host, write plan/mode files, restart services, tunnel), writes secrets if present. Saves are serialized server-side through a promise chain | One of 8 command objects (§2.2) | `200 { ok:true, wrapBytesChanged, snapshot, providers, models, keyedProviders, activeModelId, logSettings }`; `409 { kind:"refused", error }` on reconcile refusal; `500 { error }` on validation/parse errors (note: **validation errors are 500, not 400**) |
| GET | `/api/logs/settings` | Read hop request-logging settings | — | `LogSettings` (defaults filled) |
| PUT | `/api/logs/settings` | Save log settings (validated, normalized; triggers a prune) | partial `LogSettings` JSON | `200` normalized `LogSettings`; `400 { error }` on invalid JSON or out-of-range value |
| GET | `/api/logs` | List hop request records, newest first | Query: `q` (substring over id/model/error/provider/endpoint), `model` (exact), `from`,`to` (ISO date range on `startedAt`), `ok=true|false`, `page` (≥1), `pageSize` (1–100, default 50) | `{ items: LogRecord[], total, page, pageSize }` |
| GET | `/api/logs/{id}` | One record incl. captured request/response bodies (redacted, possibly truncated) | id is URL-encoded path segment, `[A-Za-z0-9._-]+` | `200 LogRecord & { request?, response? }`; `404 { error }` |
| POST | `/api/logs/clear` | Delete all log records and body files | — | `{ ok: true }` |
| GET | `/api/grok-skills` | Compare OpenBot repo `skills/` (GitHub Contents, then local `skills/`) with Grok Bot **user** skills under `/home/box/agent-data/workflows`. Does not create directories. Never reads or writes managed-skills or plugins | — | `{ dest, source, ref?, skills[] }` where `source` is github / local / none and each skill `state` is missing / stale / current / unavailable / blocked |
| POST | `/api/grok-skills/install` | Install or update one slug or all source slugs into `workflows/<slug>/`. Overwrites source files only; extra user files stay. GitHub first, local `skills/` fallback | optional `slug` | `200 { ok:true, dest, source, ref?, skills }`; `400` invalid/unknown slug; `403` cannot write workflows; `503` source unavailable |

### 2.2 `POST /api/save` command union (the write surface)

Verified in `src/parse/ui.ts` (`parseUiCommand` + `applyUiCommand`):

| `kind` | Fields | Effect |
|---|---|---|
| `official` | — | Switch to OfficialBox: restore stock host wrap, stop leftover hop, keep plan/secrets on disk, write mode file `official` |
| `upsert-provider` (alias: `custom`) | `name`, `origin`, `modelSlug`, `secret` (all required strings) + optional model limits (`contextTokens`, `maxOutputTokens`, `reasoningLevels`, `modalities`, `activeReasoning`) | Creates/updates provider (id = slugified name) + first model (id = `providerId:modelSlug`), sets wildcard binding to that model, stores the secret, reconciles to custom mode |
| `upsert-model` | `providerId`, `slug` + optional model limits (same as above) | Adds/updates a model on an existing provider; if no wildcard binding exists yet, binds it |
| `use-model` | `modelId`, optional `reasoning` | Sets the wildcard binding to this model and optionally updates the model's `activeReasoning` |
| `remove-provider` | `providerId` | Removes provider + its models; rebinds wildcard to a remaining model or, if none remain, empties the catalog (plan file is deleted) and reconciles to official |
| `set-secret` | `providerId`, `secret` | Writes/replaces the provider's API key (requires the provider + ≥1 model to exist) |
| `update-provider` | `providerId`, `name`, `origin`, optional `secret` | Renames provider / changes base URL; optionally rotates the key in the same call |
| `set-expose` | `expose`: string token — `"cloudflare"`/`"cloudflare-quick"`/`"cf"`/`"on"` or `"off"`/`"loopback"`/`"no"`/`"false"` | Starts/stops the Cloudflare quick tunnel exposing the control page; persists the choice in the expose file. Reuses a live cached tunnel; probes and replaces a dead one |

Reconcile refusal kinds surfaced as HTTP 409: `host-missing`, `foreign-hop`, `foreign-ui`,
`foreign-opengrok`, `census-refused` (with `reason`), `syntax-check-failed` (with `stderr`),
`listen-failed` (port 9280 could not be bound).

### 2.3 Hop + health (same port, machine-facing)

| Method | Path | Purpose | Notes |
|---|---|---|---|
| GET | `/healthz` | Liveness probe | `200 { ok:true, service:"openbot" }` |
| POST | `/v1/chat/completions` | OpenAI-compatible hop. Reads `openbot-plan.json`, routes by requested model (wildcard binding first, then any catalog model by id or slug), translates host messages to OpenAI format, caps `max_tokens` to the model's `maxOutputTokens` (default 65536), applies per-provider reasoning controls (`provider-maps.cjs`), adds `Authorization: Bearer <secret>`, forwards to `provider.origin` + `/chat/completions` (origin may already end in `/v1`, `/v4`, `/paas/v4`, or `/chat/completions`) | Body cap 64 MB. Upstream timeout 30 min (`OPENBOT_HOP_TIMEOUT`). Response is a **raw passthrough incl. SSE streaming** (`stream:true` preserved; upstream content-type echoed). Errors: `400` invalid JSON / unknown model slug, `503` plan missing / no secret, `502` upstream failure. Every call is recorded to the request log (best-effort, never throws into chat path) |

### 2.4 Static UI

`GET /` → `ui/index.html`; any other non-`/api`, non-hop path serves a file under `ui/`
(html/css/js/svg/json known types, else octet-stream). Path traversal outside `ui/` is refused
(403). `ui/` is the Vite build output of `web/` (`vite.config.ts`: `web/src` → `ui/app.js` +
`ui/styles.css`).

### 2.5 CLI surface (same backend, no HTTP)

The `openbot` CLI (`src/cli.ts`) exposes the same reconcile engine: `status`, `official`/`disable`,
`tunnel on|off|status`, `--dry-run` (wrap proof), `--census-only` (host census), install with
`--origin --model --name --tunnel` (key only via `OPENBOT_API_KEY` env — `--api-key` on argv is
rejected), `--json`, `--host-main`/`--sand-data` overrides. The web UI does not need to wrap these,
but they are the same domain operations.

---

## 3. Domain entities and what they mean for the UI

All types from `src/domain/types.ts` unless noted.

### 3.1 Box mode — `DesiredState = OfficialBox | CustomBox`

- **OfficialBox**: stock wrap (none), hop-owned processes stopped, **loopback UI stays up** so the
  user can switch back. No catalog/hop/upstream. Plan file and secrets stay on disk. Mode file =
  `official`.
- **CustomBox**: host file carries the `/* openbot-stock-wrap */` marker; one loopback service
  serves UI + `/api/*` + hop; `catalog` holds providers/models/bindings. Mode file = `custom`.
- The **mode file** (`openbot-mode`) is the source of truth for desired mode — not plan-file
  existence. `align(desired, wrap)` can report `needs-reinstall` (desired custom but host file is
  stock-unmarked) — a distinct, UI-relevant state.
- Switching modes bounces the Grok Bot host process (SIGTERM) when wrap bytes changed; the app
  restarts it. Chat switches on the **next new message**.

### 3.2 Catalog

```
Catalog = { providers: Provider[], models: Model[], bindings: Binding[] }
```

- **Provider**: `{ id, name, origin, maxTokensDefault: 65536, mapFile: "provider-maps.cjs" }`.
  `id` is a slug derived from the name (`slugify`, `/^[a-z0-9][a-z0-9._-]{0,63}$/i`).
  `origin` is an http(s) base URL, trailing slash stripped.
- **Model**: `{ id: "providerId:slug", providerId, slug, contextTokens, maxOutputTokens,
  reasoningLevels[], activeReasoning, modalities[], parameters[] }`.
  - `contextTokens`: default 128 000, hard cap 10 000 000.
  - `maxOutputTokens`: default 65 536 (`HIGH_AGENT_MAX_TOKENS`), cap 10 000 000; enforced by the
    hop as the ceiling for upstream `max_tokens`.
  - `reasoningLevels`: per-model **allow-list** from universe
    `default | none | low | medium | high | xhigh | max`; default allow-list is
    `[default, none, low, medium, high]`. `default` = omit thinking fields upstream; `none` = send
    an explicit disable. `default` is always present after normalization.
  - `activeReasoning`: the level actually sent on the next turn; must be in the allow-list
    (server coerces). Only changeable via `use-model … reasoning` or model upsert.
  - `modalities`: subset of `text | image | video | audio`, default `[text]`. **Stored metadata
    only** — the hop still sends text; they exist for future use.
  - `parameters`: `{ id, value }[]` provider-specific extras (e.g. `fast`, `thinking`).
    **Loaded from the plan file and preserved on save, but no UI command can edit them.**
- **Binding**: `{ conversation: ConversationKey, modelId }` where `ConversationKey` is
  `{kind:"wildcard"}` or `{kind:"agent", id}`. Only the **wildcard** binding is used by every
  write path today ("one model at a time; per-conversation overrides are not in this release" —
  README). The per-agent kind exists in the domain and in the compiled plan's `agents` map, and
  the hop only ever reads `agents["*"]`. Secret field names are type-level unrepresentable on
  `Binding`.

### 3.3 Secrets

- File `secrets.json` = `{ providers: { [providerId]: secret } }`, written mode `0600`.
- **Write-only from the UI's perspective**: the API never returns secret values. `GET /api/state`
  returns `keyedProviders: string[]` — which providers have a key stored, nothing more.
- Validation: non-empty after trim. Provider id must be a slug.
- The hop loads the key per request and sets `Authorization: Bearer`.
- Log redaction (`payload/request-log.cjs`): stored secret values, `Bearer …` tokens, and
  `sk-`/`sk-or-`/`ocg_…` token patterns are replaced with `[redacted]`; `authorization`,
  `api-key`, `x-api-key` object keys are redacted.

### 3.4 Snapshot (live status, from `observe()`)

```
Snapshot = { wrap, hopListen, uiListen, host, alignment, tunnel }
```

- `wrap`: `stock-unmarked | openbot-marked | foreign-opengrok | private-lane | gap |
  ambiguous-factory` — census of the host file. The UI must at least distinguish
  "stock", "ours", "foreign overlay present" (blocked), and "unknown host layout" (refused).
- `hopListen` / `uiListen`: `ours(pid) | foreign(pid) | absent` for port 9280. A **foreign**
  listener is never adopted — reconcile refuses (`foreign-ui`/`foreign-hop`).
- `host`: `running-owned(pid) | absent` (the type union also allows `running-unowned`,
  `needs-term`, but `observe()` currently emits only the first two).
- `alignment`: `ok(desired, wrap)` or `needs-reinstall` (desired custom, wrap stock-unmarked).
- `tunnel`: `off | cloudflare-quick { url, internal, pid, qr? } | error { message }`.
  The server pre-renders an **ASCII QR** of the tunnel URL (`qr` field) for phone scanning.

### 3.5 Log entities

- `LogSettings`: `loggingEnabled` (default **false**), `logBodies` (false),
  `logBodiesOnError` (true), `logRetentionDays` (7; 1–365), `maxBodyCaptureBytes`
  (65 536; 1 024–1 048 576), `maxRecords` (2 000; 1–10 000). Stored in `openbot-logs.json`;
  saving prunes the log immediately.
- `LogRecord`: `id, startedAt, completedAt, ok, status, latencyMs?, model?, providerId?,
  providerName?, inboundEndpoint?, upstreamEndpoint?` (query/credentials stripped)`, stream,
  error?` (redacted, ≤500 chars)`, promptTokens?, completionTokens?, totalTokens?, hasRequest,
  hasResponse, requestTruncated?, responseTruncated?`. Bodies live in per-id files under
  `openbot-request-bodies/`, redacted, truncated at `maxBodyCaptureBytes` (8 000-char preview kept
  in the index row). Retention: rows older than `logRetentionDays` and beyond `maxRecords` are
  pruned; orphan body files are unlinked.

### 3.6 Persistence map (all under `/home/box/sand-data/`, overridable)

| File | Content | Written by |
|---|---|---|
| `openbot-plan.json` | Compiled custom plan: `{ kind:"custom", hop, hopBaseUrl, agents:{"*":{modelId,providerId}}, catalog }` | every custom reconcile |
| `openbot-mode` | `official` or `custom` | reconcile |
| `secrets.json` | provider secrets (0600) | save commands with a secret |
| `openbot-expose` | `loopback` or `cloudflare-quick` | `reconcileExpose` |
| `openbot-logs.json` | log settings | PUT `/api/logs/settings` |
| `openbot-requests.jsonl` + `openbot-request-bodies/` | request log | hop handler |
| `openbot-ui.pid` / `openbot-hop.pid` | owned process pids | service start / legacy hop |
| `openbot-ui.log` / `openbot-hop.log` | service stdout/stderr | service |
| `openbot-tunnel.pid` / `.log` / `.json` | cloudflared process, its log, cached public URL | tunnel reconcile |
| `host-main.cjs.pre-openbot` | pristine backup of the host file | first custom wrap |
| `bin/cloudflared` | downloaded tunnel binary (from GitHub releases, arch-aware) | on first tunnel start |
| `payload/provider-maps.cjs` (repo) | live-reloaded per-request provider quirks (GLM thinking/effort, Grok `reasoning_effort`, generic OpenAI) | hop requires it fresh every call |

---

## 4. Functional requirements

Legend: **[UI]** = exposed in the current UI (`web/src`); **[B]** = backend capability with no
current UI exposure.

### 4.1 Mode management (official ↔ custom)

- **FR-1** [UI] View the current chat mode: Official Grok vs. the active custom model
  (`snapshot.wrap.kind`, `alignment.desired`, `activeModelId`).
- **FR-2** [UI] Switch back to Official Grok (`{kind:"official"}`). Providers, models, and keys
  are preserved; chat returns to stock on the next message; a running tunnel stays up.
- **FR-3** [UI] Switch to a custom model (`use-model`), which implicitly (re)enters custom mode,
  wraps the host if needed, and binds the wildcard conversation.
- **FR-4** [UI] See a blocking banner when the host carries a foreign opengrok wrap or is not
  recognizable stock (`foreign-opengrok`, `private-lane`, `gap`, `ambiguous-factory` →
  `hostBlocked()`), because reconcile will refuse to touch it.
- **FR-5** [B] Surface `alignment: needs-reinstall` (desired custom but host file is stock —
  e.g. Grok Bot updated and restored its host). Currently inferred indirectly; not displayed as
  its own state.
- **FR-6** [B] Surface live process/port health from the snapshot: `host` running vs. absent,
  port 9280 `ours` vs. `foreign` vs. `absent` (`hopListen`/`uiListen`). The snapshot carries this;
  the current UI does not display it.
- **FR-7** [B] Surface reconcile refusals structurally (409 `error.kind`): `host-missing`,
  `foreign-hop`, `foreign-ui`, `foreign-opengrok`, `census-refused`, `syntax-check-failed`,
  `listen-failed`. (The current UI shows only the raw message text in a toast.)

### 4.2 Provider & model catalog

- **FR-8** [UI] First-run onboarding: pick a provider preset (OpenAI, DeepSeek, Zhipu GLM, Kimi,
  Qwen, OpenRouter, Groq, xAI) or "Custom" (any OpenAI-compatible base URL), then enter name,
  base URL, and API key (`upsert-provider` with empty `modelSlug`). Presets prefill name/origin
  and show a per-preset hint. Models are fetched or added on the Models page after activation.
- **FR-9** [UI] Add further providers after the first (same command, "Add provider" flow).
- **FR-10** [UI] List providers with a live indicator on the provider whose model is active.
- **FR-11** [UI] Edit a provider's name and base URL (`update-provider`).
- **FR-12** [UI] Remove a provider with confirmation; its models disappear; if it was the last
  provider, the box returns to official and the plan file is deleted.
- **FR-13** [UI] Add a model to a provider (`upsert-model`) with limits.
- **FR-14** [UI] Edit a model's limits: context tokens, max output tokens, reasoning-level
  allow-list (chips from `default/none/low/medium/high/xhigh/max`), input modalities
  (text/image/video/audio). Server-side coercion: positive ints ≤ 10 000 000; `default` always
  kept in the allow-list; unknown values dropped.
- **FR-15** [UI] See per-model meta: formatted context/output sizes and modalities.
- **FR-16** [UI] Choose the active reasoning level for the live model from its allow-list
  (`use-model` with `reasoning`); takes effect on the next Grok Bot message.
- **FR-17** [B] Edit arbitrary provider `parameters` (`{id,value}` pairs, e.g. GLM `fast`,
  explicit `thinking`) — preserved by the backend but not settable through any UI command.
- **FR-18** [B] Per-conversation / per-agent bindings (`ConversationKey {kind:"agent"}`) — domain
  and compiled plan support them; no UI/API write path exists. Explicitly out of scope for this
  release per README.
- **FR-19** [B] The hop itself can route to **any catalog model by id or slug** in the request
  body's `model` field (not just the wildcard-bound one) — relevant if the UI ever offers a
  per-request model picker or a chat tester.

### 4.3 Secrets

- **FR-20** [UI] See which providers have a stored key (`keyedProviders`) — never the key itself
  (badge: "Key saved" / "No API key").
- **FR-21** [UI] Set or replace a provider's API key (password-style field with show/hide; sent
  via `update-provider … secret`).
- **FR-22** [UI] Key-required guidance: choosing a model whose provider has no key routes the
  user to that provider's key field instead of failing.
- **FR-23** [B] `set-secret` as a standalone command (key rotation without touching name/origin).
  Declared in the current UI client type but never dispatched by any screen.
- **FR-24** [UI, implied by design] Keys must never be displayed, echoed back, logged, or put in
  URLs — enforced server-side (write-only secrets, log redaction); the rebuilt UI must preserve
  this contract.

### 4.4 Exposure / phone access (tunnel)

- **FR-25** [UI] Show where the control page is reachable: `http://127.0.0.1:9280` always;
  the public trycloudflare URL when a tunnel is live.
- **FR-26** [UI] Start a Cloudflare quick tunnel (`set-expose cloudflare`): downloads
  `cloudflared` on first use, starts it, captures the public URL, renders an **ASCII QR code**
  (server-provided `tunnel.qr`) for phone scanning.
- **FR-27** [UI] Stop the tunnel (`set-expose off`).
- **FR-28** [UI] Refresh a dead tunnel URL (re-issue `set-expose cloudflare`; the backend probes
  the cached URL — 404/410/530 means dead — and mints a new one).
- **FR-29** [UI] Show tunnel errors (`tunnel.kind === "error"` with message, e.g. no URL within
  12 s) and allow retry.
- **FR-30** [UI, copy-level] Warn that anyone with the public URL can open the control page;
  keys stay on the Computer. There is **no auth** on the tunnel URL.

### 4.5 Hop / chat path (machine-facing, but UI-relevant)

- **FR-31** [B] `POST /v1/chat/completions` is available on the same origin — the rebuilt UI
  *could* offer a built-in chat/ping tester against the active model without any backend change.
  The current UI has no such feature.
- **FR-32** [B] `GET /healthz` liveness endpoint — available for a status indicator; unused
  today.
- **FR-33** [B] Hop behavior the UI may want to surface: `max_tokens` capping per model,
  reasoning translation per provider family (GLM/Grok/generic), 30-minute upstream timeout,
  streaming passthrough. (Log records expose `stream`, `latencyMs`, token usage.)
- **FR-34** [UI] Communicate the operational rule: after switching model or reasoning, the change
  applies to the **next new message** in Grok Bot; one model is active at a time.

### 4.6 Logs & diagnostics

- **FR-35** [UI] Enable/disable hop request recording (`loggingEnabled`, default off).
- **FR-36** [UI] Configure body capture: keep bodies on errors only (default) or keep all bodies;
  set retention days (1–365).
- **FR-37** [UI] List request records: time, model, HTTP status, latency, error snippet; search
  by free text (`q`); filter all/errors (`ok=false`); refresh.
- **FR-38** [UI] Open a record's detail: status, latency, provider name, upstream endpoint,
  error, token usage (prompt/completion/total), full request/response bodies when kept, with
  truncation notices.
- **FR-39** [UI] Clear all logs.
- **FR-40** [B] Backend log filters not exposed today: filter by exact `model`, date range
  (`from`/`to`), and **pagination beyond page 1** (current UI hard-codes `page=1, pageSize=50`;
  backend supports `page`/`pageSize` up to 100).
- **FR-41** [B] Log settings not exposed today: `maxBodyCaptureBytes` (1 KB–1 MB) and
  `maxRecords` (1–10 000).
- **FR-42** [UI, contract] Logs are privacy-safe by construction: redaction of keys/tokens is
  server-side and always on; bodies default off. The rebuilt UI should communicate this.

### 4.7 Status & health reporting

- **FR-43** [UI] Load full state in one call and render: mode, active model + provider, key
  presence, wrap/alignment status, tunnel status, log settings.
- **FR-44** [UI] Handle service-unreachable (initial load failure) with retry.
- **FR-45** [UI] Busy/disabled states and serialized saves: every mutation goes through one
  queued `POST /api/save`; the server also serializes. Success feedback includes the post-save
  snapshot and a human message (e.g. "Grok Bot will use X (High) on the next message").
- **FR-46** [B] `wrapBytesChanged` is returned by save (implies the host process was bounced);
  not surfaced today — could explain "Grok Bot will restart its session" messaging.

### 4.8 Frontend platform

- **FR-47** [UI] Hash-based client routing: chat (default), logs, add-provider, provider detail,
  model detail (`#/`, `#/logs`, `#/add`, `#/p/:id`, `#/p/:id/m/:modelId`), with guarded fallback
  to chat when a referenced provider/model disappears.
- **FR-48** [UI] Static-served SPA from the same origin as the API (no CORS, no separate dev
  server in production; `vite build` → `ui/`).
- **FR-49** [UI] Accessibility basics already encoded functionally: skip link, aria-live toasts,
  labelled controls. (Keep as requirements, restyle freely.)

### 4.9 Grok Bot user skills

- **FR-56** [UI] Dashboard hairline card installs OpenBot Grok Bot skills from the OpenBot repo
  `skills/` tree into Grok Bot **user** skills (`/home/box/agent-data/workflows/<slug>/`) only —
  never managed-skills or plugins. GitHub Contents API first (`ref` = `OPENBOT_COMMIT` or
  `payload/version.json`, else `main`), local `repoRoot/skills/` fallback. Compare SHA-256 of
  `relativePath + "\n" + file bytes` (source paths only). **Install** when missing, **Update**
  (confirm) when stale, quiet **Installed** badge when current; no buttons when source-unavailable
  or dest is not writable. Secondary / ink / ghost CTA — not Cursor Orange.

---

## 5. User flows implied by the backend

1. **First connect (official → custom).** No providers → UI shows setup. User picks a preset or
   custom endpoint, enters name/origin/API key → `upsert-provider` with empty `modelSlug` →
   provider id is slugified, secret stored (0600), no first model yet, host file censused + wrapped
   with marker (backup written, `node --check` syntax gate), mode file → `custom`, plan written,
   service ensured, host bounced. Fetch or add models on the Models page after activation. Failure
   modes: 409 refusals (foreign wrap, non-stock host, port conflict, syntax check) must be
   communicable.
2. **Switch model.** User picks another catalog model on Chat → `use-model` → wildcard rebind.
   If the provider has no key, UI detours to the key field first (client-side check against
   `keyedProviders`; the hop would otherwise 503 "no secret for this provider").
3. **Change thinking intensity.** User picks a level from the active model's allow-list →
   `use-model` with `reasoning` → `activeReasoning` updated; hop translates it per provider
   family (`effort`/`thinking` params → GLM `thinking`/`reasoning_effort`, Grok
   `reasoning_effort`, generic `reasoning_effort`/`thinking` disabled).
4. **Return to official.** User clicks Official Grok → `{kind:"official"}` → wrap stripped or
   restored from backup, mode file → `official`, leftover hop-only processes stopped, **plan and
   secrets kept**, host bounced. Catalog remains visible in the UI for an instant re-enable.
5. **Add another provider / model.** `upsert-provider` / `upsert-model`; adding a model when no
   wildcard exists auto-binds it. Editing limits re-upserts the model with preserved `parameters`.
6. **Rotate a key / change endpoint.** `update-provider` (optionally with `secret`) or
   `set-secret`.
7. **Remove a provider.** Confirm → `remove-provider` → models cascade; wildcard rebinds to a
   survivor; removing the last provider empties the catalog, deletes the plan file, and returns
   the box to official. Secrets file keeps the orphan key (no delete path exists).
8. **Phone access.** `set-expose cloudflare` → tunnel starts (binary downloaded once), public URL
   + ASCII QR shown; refresh probes the old URL and rotates it when expired; `off` stops the
   tunnel and clears its cache. Choice persists across saves and reinstalls via the expose file.
9. **Debug a stalled turn.** Enable recording (optionally bodies) → reproduce in Grok Bot →
   inspect the record (status, upstream, error, token usage, bodies) → clear logs / tighten
   retention. All key material is redacted.
10. **Recover from a foreign port/wrap.** Reconcile refuses with 409 (`foreign-ui`,
    `foreign-opengrok`, …); the UI must present these as actionable blockers, not generic errors.
11. **Install Grok Bot skill.** Dashboard card → Install / Update from the OpenBot repo → files
    land in `/home/box/agent-data/workflows/<slug>/` so Grok Bot can configure OpenBot. Extra files
    in that folder are left alone.

---

## 6. Non-functional requirements

- **NFR-1 Single-user local tool.** No accounts, no auth, no multi-tenancy. The service binds
  loopback by default; the only remote access is the opt-in Cloudflare tunnel, which is
  unauthenticated-by-URL (anyone with the URL can operate the page — must be messaged).
- **NFR-2 Single process, single port.** UI + API + hop share `127.0.0.1:9280`. A foreign
  listener is refused, never adopted. Hop must remain a route on the same process (no sidecar).
- **NFR-3 Secret hygiene.** Keys are write-only over the API, stored `0600`, never in
  bindings/plan/git/chat, rejected on the CLI argv, redacted in all log output (values, Bearer
  tokens, common key patterns, sensitive header keys).
- **NFR-4 Safety rails on mutation.** Every save re-observes and reconciles; host-file writes are
  gated by census + `node --check`; a pristine backup is kept; unknown host layouts refuse.
  Saves are serialized both client- and server-side (no concurrent writes).
- **NFR-5 Streaming chat.** The hop passes SSE through untouched (`stream:true`, upstream
  content-type, 64 MB request cap, 30 min upstream timeout). Any UI chat tester must handle SSE.
- **NFR-6 Stateless-ish UI with fresh state.** All API responses are `no-store`; the UI refetches
  `/api/state` after every save (save response already contains the new snapshot + catalog).
  No websockets/SSE from server to UI — polling/manual refresh only.
- **NFR-7 Error contract.** Save errors: 409 (structured refusal `error.kind`) or 500 (validation
  message string) — a rebuilt UI should handle both, and a rebuild of the *API* could legitimately
  normalize validation to 400. Logs API uses 400 with `{error}` for bad settings.
- **NFR-8 Platform.** Runs on the Grok Bot Computer (Linux primary; installer also knows
  Darwin), Node ≥ 22 (`--experimental-strip-types`), Unix absolute paths only. UI is a static
  SPA built with Vite from `web/` into `ui/`; no server-side rendering.
- **NFR-9 Offline tolerance.** Everything except upstream chat, cloudflared download, the
  tunnel itself, and (optional) GitHub Contents for Grok Bot skills is local. Skills fetch has a
  10 s budget and falls back to the installed `skills/` tree. Tunnel start has a 12 s URL budget;
  probe timeout 2.5 s.
- **NFR-10 Idempotent saves.** Repeating a command is safe (upsert semantics; wrap no-ops when
  already marked; tunnel reuses a live URL).

---

## 7. Open questions / ambiguities for the PRD phase

1. **`GET /api/state` vs `/api/snapshot`** — two names, one handler. Keep one canonical route in
   the rebuild?
2. **Save validation errors return HTTP 500** (throws bubble to the server catch-all), while
   reconcile refusals are 409 and log-settings validation is 400. Should the rebuilt API normalize
   this (e.g. 400/422 with structured codes)?
3. **`set-secret` vs `update-provider … secret`** — two ways to rotate a key; the current UI uses
   only the latter. Consolidate?
4. **`upsert-provider` alias `custom`** — `kind:"custom"` is accepted by the parser but unused by
   the UI. Keep for compatibility?
5. **Orphaned secrets** — removing a provider leaves its key in `secrets.json` (no delete-secret
   command). Intentional ("secrets stay") or a gap the rebuild should close?
6. **Model `parameters`** are preserved but not editable via any UI command — only by hand-editing
   the plan file. Should the rebuild expose them (e.g. GLM `fast`)?
7. **Modalities are stored but unused** — chat sends text only ("saved on the model for later").
   Should the rebuilt UI present them as informational, or hide until supported?
8. **Per-agent bindings** exist in the domain (`ConversationKey agent`) and compiled plan but have
   no write path; README says "not in this release". Confirm exclusion for the rebuild.
9. **No chat/test facility** — the only way to verify routing is to send a message in Grok Bot
   and inspect Logs. The hop endpoint would support a UI-side ping/test chat; is that in scope?
10. **Snapshot fields unused by UI** (`hopListen`, `uiListen`, `host`, `alignment.kind",
    "needs-reinstall"`) — should the rebuild surface service/host health and the "reinstall
    needed" state explicitly?
11. **Log pagination** — backend supports `page`/`pageSize` (≤100) and `model`/`from`/`to`
    filters; current UI shows only the newest 50 with text/ok filters. How much of this should the
    rebuild expose?
12. **`maxBodyCaptureBytes` / `maxRecords`** settings exist in the backend but not in the UI.
    Expose as advanced settings?
13. **Tunnel security model** — the public URL is bearer-secret access to the whole control page
    (including provider management, though not key readback). Should the rebuild add a token or
    keep the current trust model with stronger warnings?
14. **`/healthz`** exists but nothing consumes it. Keep as the UI's service indicator?
15. **Duplicate UI trees** — `ui/` is the build artifact of `web/` (Vite `outDir: ../ui`). The
    rebuild should treat `web/` as the source of truth and `ui/` as disposable output.
16. **`agent-box/`** is a separate sub-product (agent remote-access service over Cloudflare
    tunnel) sharing only the repo. Assumed **out of scope** for the control-UI rebuild — confirm.
