# OpenBot Web UI Rebuild — Product Requirements Document (PRD)

> Phase 2 of the frontend rebuild. Input: `docs/rebuild/FEATURES.md` (feature inventory, 49 FRs).
> Output: the brief the UI/UX designer prototypes against.
> Constraint honored: this document is derived **only** from the functional requirements and the
> backend domain (`src/`, `payload/`). The previous UI design is rejected and is not referenced.

---

## 1. Product positioning & principles

OpenBot's web UI is a **single-user developer console** that runs on the same Linux box ("Computer")
as the Grok Bot desktop app. Its owner uses it to answer one question continuously — *"what is my
Grok Bot chatting through right now, and is that path healthy?"* — and occasionally to reconfigure
it: add an OpenAI-compatible provider, swap the active model, change thinking intensity, expose the
console to a phone, or debug a failed turn from the request log. The user is technical, tolerant of
density, intolerant of hand-holding, and afraid of exactly one thing: silently breaking their box.
Design principles:

1. **Status at a glance.** Within one screen, without scrolling or clicking, the user can read:
   mode (official/custom), active model + reasoning level, host/service health, tunnel state.
2. **Destructive actions are deliberate.** Mode switches, provider deletion, log clearing, and
   tunnel exposure always state their consequences and require explicit confirmation. No destructive
   action is ever a single accidental click, and none is buried in a menu either.
3. **Every save is explicit and confirmed.** No auto-save, no optimistic UI. Each mutation is a
   button press → serialized save → visible result ("Grok Bot will use X (high) on the next
   message"). The UI never pretends a change happened before the server confirms it.
4. **Secrets are write-only, visually and behaviorally.** Keys are entered blind, never echoed,
   never displayed again, never in a URL. Presence is shown ("Key saved"), content never.
5. **Errors are actionable, not apologetic.** Every failure maps to a named condition with a next
   step (stop the foreign listener, restore the backup, re-enter the key). Raw error text is
   available but never the primary message.
6. **Density is a feature.** This is an operator console, not a marketing site: compact rows,
   monospace identifiers, one-screen task completion. Whitespace is spent on scannability, not mood.

---

## 2. Information architecture

### 2.1 Decision: multi-page SPA with a persistent status header

Three pages behind a persistent top navigation bar, plus a first-run setup wizard and full-screen
shell states. Justification from the FR list:

- The three dominant task modes have **different mental contexts and different screen economies**:
  *operate* (Dashboard: FR-1–7, 25–30, 43–46), *configure* (Models: FR-8–24, 50–55), *debug* (Logs:
  FR-35–42). Logs needs full-width tables (FR-37–38); Models is a dense master–detail catalog; the
  Dashboard is a status board. A single scrolling dashboard would force the user to hunt for the
  log table or the model list every time.
- Frequency supports it: the Dashboard is the every-visit surface; Models is heavily used during
  setup then occasionally for changes; Logs is burst-heavy during debugging. Pages let each
  frequency class get the space it deserves without penalizing the others.
- Deep links are a real requirement: log records must be linkable (FR-38). Hash routes already
  exist (FR-47) and stay.

What stays **global** (visible on every page, because principle 1 outranks page boundaries):
mode pill, health dots, save/busy indicator, toast stack, and the blocking banner for a hostile
host (FR-4, FR-7).

### 2.2 Navigation structure

| # | Page | Route | One-line purpose |
|---|------|-------|------------------|
| 1 | **Dashboard** | `#/` | Is my box working? What is active right now? |
| 2 | **Models** | `#/models`, `#/models/:providerId` | Configure providers, models, limits, keys; fetch + auto-fill models |
| 3 | **Logs** | `#/logs` (detail drawer deep-links `#/logs?id=…`) | What did the hop actually do? |
| — | **Setup wizard** | `#/setup` | First-run: provider → credentials → activate |
| — | App shell | — | Header, status strip, toasts, blocked/unreachable states |

Nav order mirrors the lifecycle: operate → configure → debug. The wizard is a route, not a modal,
so bookmarking and the phone (tunnel) both work.

---

## 3. Page-by-page specification

Global conventions used below (normative for every page):
**Loading** = skeleton rows, never spinners-only for lists; **mutations** disable their trigger
button and show the global "Saving…" pill until the save resolves; **success feedback** is a toast
that quotes the post-save human message (FR-45); **refusals** render as structured blockers (FR-7).

### 3.0 App shell & global chrome

- **Purpose:** carry status everywhere; own the error/toast/busy contracts.
- **Primary question:** "Is anything globally wrong, and is a save in flight?"
- **Data / actions:**
  - Mode pill (OFFICIAL / CUSTOM + active model name) — FR-1, FR-43.
  - Health dots: host process, port 9280 owner, wrap state, alignment — FR-6 (rendered compactly
    here, explained on Dashboard); service liveness dot polled from `/healthz` every 30 s — FR-32.
  - "Saving…" pill + queued-save serialization — FR-45.
  - Toast stack (aria-live) with post-save snapshot messages and `wrapBytesChanged` explanation
    ("Grok Bot was restarted to apply the wrap") — FR-45, FR-46.
  - Blocking banner on hostile host (`foreign-opengrok`, `private-lane`, `gap`,
    `ambiguous-factory`): red, page-wide, lists the exact refusal kind and remedy, disables all
    mutating controls — FR-4.
  - Structured refusal renderer for all 409 kinds (`host-missing`, `foreign-hop`, `foreign-ui`,
    `foreign-opengrok`, `census-refused` + reason, `syntax-check-failed` + stderr, `listen-failed`)
    and 500 validation strings — FR-7.
  - Full-screen unreachable state when `/api/state` fails: "Can't reach the openbot service…" +
    Retry button — FR-44.
  - Hash routing with guarded fallback (unknown or dangling route → Dashboard) — FR-47; static SPA
    from the same origin — FR-48; skip link, labelled controls, aria-live toasts — FR-49.
- **Empty:** none (shell). **Error:** the unreachable screen is the shell's error state.

### 3.1 Dashboard (`#/`)

- **Purpose:** the control room. Default landing page.
- **Primary questions:** "Is my box working?" · "Which model is active, at what reasoning level?" ·
  "Can I reach this page from my phone?"
- **Data:**
  - **Mode hero card** — current mode; if custom: active model, provider, reasoning level, key
    presence; if official with a saved catalog: "Ready to re-enable" with the last active model —
    FR-1, FR-3, FR-20, FR-43.
  - **Health strip** — host process running/absent; port 9280 `ours/foreign/absent`; wrap
    `stock / openbot / foreign / unknown`; alignment `ok / needs-reinstall` (with explanation and
    re-enable action) — FR-5, FR-6.
  - **Tunnel card** — off / starting / live URL + copy button + QR / error + retry; the
    unauthenticated-URL warning whenever live — FR-25, FR-29, FR-30.
  - **Grok Bot skill card** — full-width under health (also on the empty dashboard, beside the
    orange setup CTA but not using orange). Installs OpenBot config skills into Grok Bot user
    skills (`workflows`), not plugins — FR-56.
  - The operational rule rendered as persistent microcopy under the hero: "Changes apply to the
    next new message in Grok Bot. One model is active at a time." — FR-34.
- **Actions:**
  - Switch to Official Grok (confirm dialog) — FR-2.
  - Quick model switcher (dropdown of catalog models; detours to key entry if the provider has no
    key) — FR-3, FR-22.
  - Reasoning level selector for the active model (chips from its allow-list) — FR-16.
  - Start / stop / refresh tunnel — FR-26, FR-27, FR-28.
  - Copy loopback URL — FR-25.
  - Install / Update Grok Bot skill from the OpenBot repo (secondary; confirm on Update; hidden
    when current) — FR-56.
- **Empty (no providers):** hero is replaced by a setup call-to-action → `#/setup`. The Grok Bot
  skill card still shows (secondary Install, not the orange setup CTA).
- **Error states:** health strip turns each dot into a labeled fault with remedy (e.g. "foreign
  process on :9280 — stop it before switching modes"); tunnel error card with retry — FR-29; all
  refusals via the shell renderer — FR-7.
- **Loading:** skeleton hero + dots; auto-refresh `/api/state` every 30 s while the tab is visible.

### 3.2 Models (`#/models`, `#/models/:providerId`) — includes Setup wizard

- **Purpose:** the catalog. Everything about providers, models, limits, and keys.
- **Primary questions:** "What have I configured?" · "How do I add/fix a provider or model?" ·
  "Does this provider have a key?"
- **Data:** master–detail: provider list (left) with active-model indicator and key badge; selected
  provider's model table (right) with per-model meta — formatted context/output sizes, reasoning
  allow-list, modalities ("metadata only — chat sends text today") — FR-10, FR-15, FR-20.
- **Actions:**
  - **Add provider** (also the engine behind the `#/setup` wizard): preset picker (OpenAI,
    DeepSeek, Zhipu GLM, Kimi, Qwen, OpenRouter, Groq, xAI, Custom) with prefills and hints, then
    name / base URL / API key — FR-8, FR-9. Models are fetched or added on the Models page after
    activation.
  - Edit provider name / base URL, rotate key in the same dialog or standalone ("Replace key" uses
    the dedicated key-only command) — FR-11, FR-21, FR-23.
  - Remove provider (confirm; cascade copy spells out model loss and, for the last provider, the
    return to official) — FR-12.
  - Add / edit model: slug, context tokens, max output tokens, reasoning allow-list chips
    (`default/none/low/medium/high/xhigh/max`; `default` always kept), modalities — FR-13, FR-14.
  - Per-row **Use** button (secondary affordance for FR-3; key-missing detour applies — FR-22).
  - Key-required guidance: choosing/using a model whose provider has no key routes to that
    provider's key field with an explanation, never a dead 503 — FR-22, FR-24.
  - **Fetch models (Source A)** button on the provider detail panel → `POST /api/providers/{providerId}/fetch-models`.
    idle → loading (spinner, button disabled) → the **Import models dialog** opens showing the
    fetched list (the result is never rendered as an inline list) — FR-50, FR-54. The dialog owns
    every outcome: a **partial-failure notice** (valid rows stay selectable + a non-blocking warning
    naming what was skipped), an **empty-result** state, and hard failures rendered as a structured
    error inside the dialog (`unreachable` / `unauthorized` / `not-supported` / `no-secret` /
    `provider-not-found`) with a remedy; `no-secret` routes to the key field — FR-51.
  - In the dialog the user **checks which models to import** (checkbox list, select-all/none, search
    filter when the list is long) and confirms with **"Import selected (N)"**; only the chosen rows
    are appended to the provider's model table + a success toast. Rows already in the catalog are
    shown **disabled with an "Already added" tag** (not selectable). When a chosen id matches a
    Source B catalog entry, context window, max output, modalities, and reasoning support are
    **auto-filled** and the row carries a "catalog" badge in the dialog; the user can still edit
    after import. Unmatched models import with manual fields only — FR-53.
  - **Model catalog (Source B) card** in the Models page settings area: status (ready / loading /
    failed) + last-fetched time + source counts + **Refresh** button
    (`POST /api/model-catalog/refresh`). Placed on Models, **not Logs** — Logs keeps only recording
    settings — FR-52, FR-55.
- **Empty:** no providers → full-page setup CTA (the wizard handles it).
- **Error states:** field-level validation from 500 messages (invalid slug, non-integer limits,
  out-of-range tokens with the 10 000 000 cap called out); refusal kinds via the shell renderer —
  FR-7; secret field never echoes and rejects empty-after-trim values inline — FR-24.
- **Loading:** skeleton list; the detail pane keeps stale content while refreshing.

**Setup wizard (`#/setup`)** — 3 steps, same `upsert-provider` save at the end:
1. **Provider** — preset cards or Custom (FR-8).
2. **Credentials** — prefilled name/origin (editable), blind API key entry (FR-21). The wizard
   saves provider + key only (`modelSlug: ""`). A provider can be saved with zero models. Fetch
   models on the Models page after activation (FR-50, FR-53, FR-54).
3. **Review & activate** — summary, explicit "Wrap host and activate" button. Review shows model
   as "— (none)" and a non-blocking notice "No model yet — you can fetch models from the Models
   page after activation"; activation proceeds (provider in custom mode with zero models) —
   FR-45, FR-46.
Redirect here automatically from any page when the catalog is empty and mode is official.

### 3.3 Logs (`#/logs`)

- **Purpose:** the audit trail of the hop. Burst-use debugging surface.
- **Primary question:** "What happened to my requests — and why did that one fail?"
- **Data:** settings panel (enable recording — default off; bodies: errors-only vs all; retention
  days 1–365) — FR-35, FR-36; table of records: time, model, status, latency, error snippet — FR-37;
  privacy note: "Keys are always redacted server-side; bodies default off" — FR-42; record drawer
  (deep-link `#/logs?id=…`): full header, provider name, upstream endpoint, error, token usage,
  request/response bodies with truncation notices, and a copy button on each body that puts the
  raw captured payload (exactly as returned by the API, redaction included) on the clipboard —
  FR-38.
- **Actions:** refresh; free-text search; errors-only filter — FR-37; model filter — FR-40;
  pagination — FR-40; clear all logs (confirm) — FR-39. Date range (`from`/`to`) remains P1.
- **Pagination:** a footer below the table shows the total record count ("N records"), previous /
  next ghost chevron buttons, and "Page X of Y" (Y = ⌈total / pageSize⌉, min 1). Per-page size is
  25 / 50 / 100 via the custom listbox (default 50). Changing any filter (search, errors-only,
  model, channel) resets to page 1; changing page keeps the filters. Between-page loading reuses the
  skeleton rows. Page is reflected in the hash (`#/logs?page=N`) and read back on load. An
  out-of-range page (e.g. logs pruned while deep-linked) clamps to the last valid page; clearing
  logs returns to page 1. The pager fits a 375px viewport (prev/next at 44px touch targets).
- **Empty:** recording disabled → prominent explainer "Turn on recording to capture future turns";
  enabled but empty → "No requests yet — send a message in Grok Bot."
- **Error states:** settings validation (out-of-range retention) inline at the field — FR-36; API
  errors via the shell renderer; drawer 404 → "record pruned by retention" notice.
- **Loading:** skeleton table rows; drawer shows its own skeleton.

### 3.4 New functional requirements — model list fetching & auto-fill (FR-50–FR-55)

- **FR-50** [UI+B] Fetch a provider's model list from its own `/v1/models` (**Source A**). A "Fetch
  models" action on the provider detail panel (Models page, after activation) calls
  `POST /api/providers/{providerId}/fetch-models`; the backend performs the upstream call
  **server-side using the stored secret** (secrets are write-only and never sent to the browser), so
  this must be a backend endpoint, never a browser fetch. On success the result is presented in the
  **Import models dialog** (see FR-53/FR-54), never as an inline list. *Owner: Models.*
- **FR-51** [B] The fetch endpoint returns a normalized model list (`id`, optional `name`,
  `contextLength`, `maxOutputTokens`, `modalities`, `reasoningLevels`) or a **structured error**
  distinguishing `unreachable` / `unauthorized` / `not-supported` / `no-secret` /
  `provider-not-found`. Normalization drops entries without an id and reports them as `skipped` (the
  source of the UI partial-failure state). *Owner: Models.*
- **FR-52** [B] **Public model catalogs (Source B).** At process startup the backend fetches
  `https://openrouter.ai/api/v1/models` and `https://models.dev/api.json` **asynchronously
  (non-blocking)**, merges them, and **persists the cache to disk**. It serves
  `GET /api/model-catalog` (status `ready|loading|failed`, `lastFetched`, per-source counts, and
  lookup by model id) and `POST /api/model-catalog/refresh` (re-fetch now). *Owner: Models.*
- **FR-53** [UI] **Select-and-import with auto-fill.** The fetch result opens in the **Import models
  dialog**: a scrollable checkbox list of the fetched models. The user checks the models to import
  (select-all/none, search filter when the list is long) and confirms with **"Import selected (N)"**;
  only the chosen rows are appended to the provider's model table. Rows already in the catalog are
  shown **disabled with an "Already added" tag**. When an id matches a Source B catalog entry, the
  row carries a "catalog" badge and the model form pre-fills context window, max output, modalities,
  and reasoning support on import (each auto-filled field is marked). The field-fill mapping rule:
  context/output tokens use the catalog value when present, else the Source A fetch value, else the
  backend default; modalities use the catalog's non-empty list, else the fetch list; reasoning uses
  the catalog effort list when present; a boolean-only (legacy) catalog keeps `true` →
  `default·none·high` and `false` → `default` only, and must not wipe nonempty Source A levels;
  else the fetch's levels. Unmatched models still import,
  with manual fields. *Owner: Models.*
- **FR-54** [UI] **Fetch button states.** `idle → loading → dialog | partial-failure | empty |
  error`. Success opens the Import models dialog with the fetched list. Partial-failure opens the
  same dialog with a non-blocking warning naming what was skipped (the valid rows remain selectable).
  An empty result shows the dialog's empty state. Hard failures render the structured error inside
  the dialog with a remedy (`no-secret` routes to the key field). *Owner: Models.*
- **FR-55** [UI] **Catalog cache status + refresh.** The Models page settings area shows the Source B
  cache status (ready/loading/failed) with last-fetched time and a Refresh button
  (`POST /api/model-catalog/refresh`). *Owner: Models.*

### 3.5 FR traceability matrix (FR-1–55; primary owner listed first)

| FR | Owner | Note |
|----|-------|------|
| 1, 2, 3, 5, 6, 16, 22, 25–30, 34, 46, 56 | Dashboard | FR-22 is a shared behavior wherever "use" happens; FR-56 is the Grok Bot skill card |
| 4, 7, 32, 43, 44, 45, 47, 48, 49 | App shell | global contracts; FR-32 service liveness dot |
| 8–15, 17 (read-only, P2), 20, 21, 23, 24, 50–55 | Models + Setup wizard | FR-17 display-only; FR-50–55 fetch/auto-fill |
| 35–39, 40 (P1), 41 (P2), 42 | Logs | |
| 19, 31, 33 | Out of scope (v1) | Chat Test page removed — hop stays machine-facing, observable via Logs (§5) |
| 18 | Deferred — out of scope | per-agent bindings (§5) |

No FR is unassigned; none is assigned to two primary owners.

---

## 4. Core user flows

1. **First-time setup (official → custom).** Dashboard empty-state CTA → `#/setup` → pick preset
   (prefill + hint) → enter/adjust name, base URL, blind key → review (model "— (none)"; "No model
   yet — you can fetch models from the Models page after activation") → **Activate** (explicit
   save with empty `modelSlug`). *Feedback:* saving pill → success toast "Provider activated.";
   host bounce noted if wrap bytes changed. *Failure:* refusal banner with remedy (e.g. foreign
   listener on :9280); wizard retains input. *Verify:* fetch or add a model on Models, send a
   message in Grok Bot, and confirm the model in Logs.
2. **Switch active model.** Dashboard quick switcher → pick model. *Decision point:* provider has
   no key → detour to its key field with explanation ("the hop would fail with no key") → key entry
   → save → then the switch proceeds. *Feedback:* toast "Grok Bot will use X (level) on the next
   message."
3. **Change thinking intensity.** Dashboard reasoning chips (only the model's allow-list;
   `default` always present) → click = explicit save. *Feedback:* chip becomes active after server
   confirm; same next-message toast.
4. **Switch back to Official.** Dashboard → "Switch to Official Grok" → **confirm dialog** listing
   consequences: chat returns to stock on the next message; host process restarts; providers,
   models, and keys are kept; tunnel stays. *Feedback:* mode pill flips to OFFICIAL; hero shows
   "Ready to re-enable (last model: X)".
5. **Populate models automatically.** Models page → open a provider → **Fetch models** (Source A) →
   loading → the **Import models dialog** opens. *Select:* check the models to import (select-all/none,
   search filter when long); rows already in the catalog show a disabled "Already added" tag; matched
   ids show a "catalog" badge with pre-filled context/output/modalities/reasoning. *Confirm:*
   **"Import selected (N)"** → the chosen rows append to the model table + success toast. *Decision
   points:* `no-secret` error → "Add key first" routes to the key field; `not-supported` /
   `unreachable` → add models manually; partial-failure → a notice names what was skipped and the
   valid rows remain selectable; empty result → the dialog shows its empty state. *Verify:* the model
   appears in the table and is usable via Use / the Dashboard switcher. Catalog data (Source B)
   refreshes from the Models page "Model catalog" card (status + Refresh).
6. **Investigate a failed request.** Grok Bot turn misbehaves → Logs → errors-only filter → open
   record drawer (status, upstream endpoint, error, tokens, bodies if kept). *Decision points:*
   bodies missing → copy explains errors-only default and links settings; recording was off →
   enable, reproduce in Grok Bot, refresh. *Remedies:* fix key/origin in Models, or clear logs
   (confirm) when done.
7. **Expose console to phone.** Dashboard tunnel card → "Start tunnel" → **confirm dialog** with
   the unauthenticated-URL warning → starting (cloudflared download on first run) → live URL +
   copy + QR. *Failure:* error card (e.g. no URL in 12 s) → Retry (probes and mints a new URL).
   *Ongoing:* live card always shows the warning line; Stop is confirm-gated.
8. **Recover from a hostile box.** Foreign wrap or listener detected → blocking banner names the
   exact refusal kind with remedy text; all mutations disabled; "View diagnostics" expands the raw
   snapshot (wrap kind, pids, endpoints) for manual repair. Once the host is clean, the banner
   clears on next refresh and saves re-enable.
9. **Install Grok Bot skill.** Dashboard skill card → **Install from the OpenBot repo** (or
   **Update** with confirm when stale). Files write to `/home/box/agent-data/workflows/<slug>/`.
   Extra files in that folder stay. No Install when already present; no Update when missing; quiet
   Installed badge when current.

---

## 5. Prioritization

**P0 — v1 must have**
App shell (routing FR-47/48, unreachable+retry FR-44, toasts+serialized saves FR-45/46, blocked-host
banner FR-4, refusal renderer FR-7, a11y FR-49); Dashboard (FR-1, 2, 3, 5, 6, 16, 22, 25–30, 32,
34, 43, 56); Models + Setup wizard (FR-8–16, 20–24, 50–55); Logs (FR-35–39, 42). Model list fetching +
auto-fill (FR-50–54) and the model-catalog cache + refresh (FR-52, FR-55) are **P0** (explicit user
request).

**P1 — should have**
Logs date filters (`from`/`to`) — FR-40 (model filter + pagination shipped in v1); Dashboard "recent
requests" mini-widget (link into Logs); `needs-reinstall` guided recovery action (FR-5 enhancement);
phone-layout polish for tunnel access.

**P2 — nice to have**
Logs advanced settings: `maxBodyCaptureBytes`, `maxRecords` (FR-41); model `parameters` read-only
display (FR-17); light/dark theme extras beyond the two core themes.

**Out of scope (with reason)**
Chat Test / hop-tester page (FR-19, 31, 33 — page removed per design review; the hop remains
machine-facing via Grok Bot and observable in Logs; FR-32 `/healthz` stays in scope as the shell's
service dot) · per-agent / per-conversation bindings (FR-18 — no backend write path; README excludes
this release) · editing provider `parameters` (hand-edit of the plan file remains the power-user
path) · any multi-user/auth on loopback · tunnel token auth (backend change; stronger warnings
instead) · secret deletion on provider removal (backend has no delete path; accepted behavior,
backlog item) · i18n (English per repo convention) · chat history persistence · `agent-box/`
sub-product · CLI wrapping in the UI.

---

## 6. UX requirements for the designer

- **Density:** developer console. Base type 13–14 px; table rows 32–36 px; 8 px spacing grid;
  monospace for ids, slugs, URLs, endpoints, latencies, token counts. One-screen task completion on
  the Dashboard is a hard goal.
- **Navigation:** persistent top bar, 3 items, current page evident; status strip beneath it (mode
  pill + health dots + saving pill) visible on every page. Left sidebar is explicitly rejected
  (wastes width for 3 destinations).
- **Secrets:** write-only. Password-style entry, blind by default, show/hide toggles only the
  *draft* text; after save, only "Key saved •••••" badge; replace requires fresh entry; keys never
  appear in URLs, toasts, logs, or confirm dialogs. No exception.
- **Danger gating:** mode switch to official, remove provider (last provider = strongest copy),
  clear logs, and tunnel start/stop all open confirm dialogs that enumerate consequences in plain
  language. No double-click hazards: destructive buttons live in dialogs, not inline.
- **Feedback:** toast stack (top-right), aria-live polite; success toasts quote the post-save human
  message incl. the "next message" rule and host-restart note; failure toasts lead with the remedy.
  Buttons disable + inline spinner during saves; a global "Saving…" pill covers queued saves.
- **Responsiveness:** desktop-first; design at 1440, fully usable ≥ 1152, functional floor 1024.
  Because the tunnel serves this page to phones, 390 px must not break (single column, bottom tab
  nav) — P0 to not break, P1 to polish.
- **Theming:** dark-first (operator tool, terminal heritage), full light theme parity; toggle
  persisted in localStorage; system preference as default; both themes meet AA contrast.
- **Accessibility:** WCAG 2.1 AA intent — full keyboard path for every flow, visible focus, skip
  link, labelled controls, aria-live toasts, status conveyed by text+shape (never color alone),
  interactive targets ≥ 28 px despite density, `prefers-reduced-motion` respected.
- **Surface style:** flat panels, hairline borders; elevation reserved for overlays (drawers,
  dialogs). No decorative imagery. Every status has an icon + word pair.

---

## 7. Open questions resolved (from FEATURES.md §7)

| # | Decision |
|---|----------|
| 1 | `/api/state` is canonical; UI never calls `/api/snapshot`. Backend may drop the alias later. |
| 2 | UI must handle today's 409-structured / 500-string contract (P0). Recommend backend normalize validation to 400 as a separate P1 task; UI renders both. **Assumption:** API changes are allowed but not required for v1. |
| 3 | Both wired: key-only rotation dispatches `set-secret`; name/origin edits dispatch `update-provider` (optional secret in the same save). One "Replace key" control in the UI. |
| 4 | Keep the `custom` alias in the parser for compatibility; the UI always sends `upsert-provider`. No backend change. |
| 5 | Orphaned secrets accepted for v1 (they make official round-trips seamless); UI copy must never claim "key deleted". Backend backlog: delete key with provider. |
| 6 | `parameters` become a read-only chip list in the model editor (P2). Editing stays out of scope. |
| 7 | Modalities shown as informational, editable in the model form, labeled "metadata only — chat sends text today". |
| 8 | Per-agent bindings confirmed out of scope for the rebuild. |
| 9 | Chat Test page removed from scope (v1). Routing is verified by sending a message in Grok Bot and inspecting Logs; the hop endpoint stays machine-facing. |
| 10 | Yes: health strip + `needs-reinstall` are first-class Dashboard states (FR-5, FR-6). |
| 11 | P0: text + errors-only. P1: model filter, date range, pagination. |
| 12 | Expose `maxBodyCaptureBytes` / `maxRecords` in an "Advanced" accordion — P2. |
| 13 | Keep the URL-as-bearer trust model; add confirm-on-start and a persistent warning line while live. Token auth is backend backlog. |
| 14 | `/healthz` becomes the shell's service dot (30 s poll). |
| 15 | Confirmed: `web/` is the source of truth; `ui/` is disposable Vite output and is never hand-edited. |
| 16 | Confirmed: `agent-box/` is out of scope for this rebuild. |

---

## 8. Appendix A — API additions (model fetching & auto-fill)

Normative contract for the three new backend surfaces behind model fetching + auto-fill. All live
on the **same single loopback process** at `127.0.0.1:9280` as the existing `/api/*` routes
(FEATURES.md §2). Conventions honored: JSON-only, `Cache-Control: no-store`, secrets are
**write-only** — these endpoints use the stored secret server-side and never return or accept it.
Developers build backend and frontend against this contract in parallel; treat field names and
error kinds as literal.

### 8.1 `POST /api/providers/{providerId}/fetch-models` — Source A (provider's own `/v1/models`)

Fetches a provider's model list from its own base URL + `/v1/models`, server-side, using the stored
secret. `POST` (an action with a network side effect, consistent with `POST /api/save` and
`POST /api/logs/clear`).

**Request**

```json
{}
```

No fields required. `providerId` is a URL-encoded path segment (the provider slug).

**Server behavior (normative)**

1. Resolve `providerId` → provider. Not found → `404` (below).
2. Require a stored secret. None → `409 no-secret` (below).
3. Build the URL from `provider.origin` (trailing slash stripped) + `/v1/models`. Reuse the hop's
   base-URL normalization (FEATURES.md §2.3): an origin already ending in `/v1`, `/v4`,
   `/paas/v4`, or `/chat/completions` is treated as the base path and `/models` is appended after it.
4. `GET` with `Authorization: Bearer <secret>`; connect timeout 10 s, total timeout 30 s. The secret
   is never logged; all error text is redacted per the existing log-redaction rules.

**Success — `200 OK`**

```json
{
  "ok": true,
  "providerId": "zhipu-glm",
  "source": "provider",
  "fetchedAt": "2026-09-02T14:05:00.000Z",
  "skipped": 0,
  "skippedReasons": [],
  "models": [
    {
      "id": "glm-5.3",
      "name": "GLM 5.3",
      "contextLength": 128000,
      "maxOutputTokens": 65536,
      "modalities": ["text"],
      "reasoningLevels": ["default", "none", "low", "medium", "high", "xhigh", "max"]
    }
  ]
}
```

`models[]` field contract (all metadata optional; `null`/empty = "unknown, leave to defaults"):

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes | non-empty; entries without a usable id are dropped and counted in `skipped` |
| `name` | string \| null | no | human name, may be absent |
| `contextLength` | int \| null | no | context window in tokens; 0/null = unknown |
| `maxOutputTokens` | int \| null | no | max output in tokens; 0/null = unknown |
| `modalities` | string[] | no | subset of `text`/`image`/`video`/`audio`; empty = unknown |
| `reasoningLevels` | string[] | no | subset of `default`/`none`/`low`/`medium`/`high`/`xhigh`/`max`; empty = use defaults |

**Partial failure** = `200` with `ok: true` and `skipped > 0` (some entries dropped, e.g.
`missing-id`). This is the UI "partial-failure" state: valid rows remain addable.

**Structured errors (non-2xx)**

Every error body is `{ "error": { "kind": "<kind>", "message": "<human text>" } }` (plus the noted
extra fields). HTTP status + `kind` are the machine contract.

| HTTP | `kind` | Meaning | Extra fields |
|---|---|---|---|
| `404` | `provider-not-found` | providerId not in the catalog | — |
| `409` | `no-secret` | provider has no stored key; UI routes to key entry | — |
| `401` | `unauthorized` | upstream returned 401/403 (bad or expired key) | `upstreamStatus` |
| `502` | `unreachable` | DNS/connect/timeout to the upstream | `upstreamStatus?` |
| `502` | `not-supported` | upstream returned 404/405/501 (no `/v1/models`) | `upstreamStatus` |
| `502` | `parse-error` | upstream 200 but body is not a `{ data: [...] }` / `{ models: [...] }` object | — |
| `500` | `internal` | any other failure | — |

### 8.2 `GET /api/model-catalog` — Source B status + lookup

The merged cache of public catalogs (`https://openrouter.ai/api/v1/models` +
`https://models.dev/api.json`), fetched **asynchronously at process startup** (non-blocking) and
**persisted to disk** (`openbot-model-catalog.json` under the sand-data dir). This endpoint never
returns the full list — the JSONs are large; the UI polls status and looks up ids.

**Status only — `GET /api/model-catalog`**

```json
{
  "status": "ready",
  "lastFetched": "2026-09-02T13:10:00.000Z",
  "totalModels": 614,
  "sources": [
    { "name": "openrouter", "url": "https://openrouter.ai/api/v1/models", "modelCount": 348, "lastFetched": "2026-09-02T13:10:00.000Z" },
    { "name": "models.dev", "url": "https://models.dev/api.json", "modelCount": 512, "lastFetched": "2026-09-02T13:10:00.000Z" }
  ]
}
```

`status` is `ready | loading | failed`. `loading` = a fetch is in flight (startup or refresh);
`lastFetched` is `null` on the first-ever load and the previous value during a refresh. `failed`
adds `"error": { "kind": "unreachable", "message": "..." }` and only occurs when **no** cached copy
exists (a failed refresh keeps the previous cache and reports `ready` with the stale timestamp).

**Lookup — `GET /api/model-catalog?modelId=glm-5.3`**

Same as above plus a `lookup` object:

```json
{
  "status": "ready",
  "lastFetched": "2026-09-02T13:10:00.000Z",
  "lookup": {
    "found": true,
    "model": {
      "id": "glm-5.3",
      "name": "GLM 5.3",
      "contextLength": 128000,
      "maxOutputTokens": 65536,
      "modalities": ["text"],
      "reasoning": true,
      "pricing": { "input": 0.4, "output": 1.1, "currency": "USD" }
    }
  }
}
```

`lookup.found === false` → omit `model`. `modelId` is a URL-encoded query param. Always `200` —
catalog state is never an HTTP error; failure is encoded in `status`/`lookup.found`.

### 8.3 `POST /api/model-catalog/refresh` — re-fetch Source B now

**Request**

```json
{}
```

**Response — `202 Accepted`**

```json
{ "ok": true, "status": "loading", "startedAt": "2026-09-02T14:05:00.000Z" }
```

Triggers a re-fetch of both sources on the same async path as startup. A refresh already in flight
returns `202` again without starting a second concurrent fetch (idempotent). The UI polls
`GET /api/model-catalog` until `status` is `ready`/`failed`, then updates the status card.

### 8.4 Persistence

| File | Content | Written by |
|---|---|---|
| `openbot-model-catalog.json` | merged Source B cache + per-source fetch timestamps | startup fetch + refresh |

The catalog cache is **disposable** — deleting it just causes a fresh fetch at next startup.

### 8.5 Grok Bot skill install

`GET /api/grok-skills` and `POST /api/grok-skills/install` copy OpenBot `skills/` into Grok Bot
**user** skills at `/home/box/agent-data/workflows/<slug>/` (override `OPENBOT_AGENT_DATA` /
`OPENBOT_WORKFLOWS`). Source is GitHub Contents (`aaravarr/openbot`, `ref` from `OPENBOT_COMMIT`
or `payload/version.json`, else `main`) with a ~10 s timeout, then the installed tree
`repoRoot/skills/`. Dest never includes managed-skills or plugins. GET does not create
directories. Install overwrites source-relative files only.

```json
{
  "dest": "/home/box/agent-data/workflows",
  "source": "github",
  "ref": "main",
  "skills": [
    {
      "slug": "openbot-config",
      "name": "openbot-config",
      "state": "missing",
      "destPath": "/home/box/agent-data/workflows/openbot-config"
    }
  ]
}
```

`state` is `missing` | `stale` | `current` | `unavailable` | `blocked`. POST body `{ "slug": "openbot-config" }`
or `{}` for every source slug. Success `200 { ok: true, ...same shape }`.
