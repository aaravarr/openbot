# OpenBot config reference

Read this from [SKILL.md](SKILL.md) when you need disk shapes, HTTP/CLI contracts, presets, or hop maps. Do not put secrets in examples.

## Architecture

OpenBot is a box supervisor. Callers parse input into `DesiredState` (`OfficialBox | CustomBox` in `src/domain/types.ts`), then `reconcile(desired)`. They do not sequence wrap, hop start, and host bounce themselves.

- Chat routing: `node /home/box/sand-host/host-main.cjs` on the **Computer**.
- Loopback `127.0.0.1:9280`: control UI, `/api/*`, hop `POST /v1/chat/completions`.
- Custom wrap marker: `/* openbot-stock-wrap */`. A known `/* opengrok-stock-wrap */` header is peeled back to stock before official restore or custom wrap.
- `align(desired, wrap)` returns `needs-reinstall` when desired is custom and the host file is stock unmarked. That is not official.
- Infer desired from `openbot-mode`, not from plan-file existence. Official keeps the plan.
- Bindings are `{ conversation, modelId }`. Derive `hopBaseUrl` with `hopBaseUrl(LOOPBACK_HOP)` → `http://127.0.0.1:9280/v1`. Secret field names are unrepresentable on `Binding`.
- Live maps file is repo `payload/provider-maps.cjs` only, reloaded per hop call (`delete require.cache` then `require`).
- `python …/hop-server.py` leftovers are SIGTERM'd. A leftover `hop-server.cjs` pid is stopped. Any other foreign listener on `:9280` is refused, not adopted.

## Disk map

Default root: `/home/box/sand-data/` (see env below).

| Path | Kind | Shape / values |
|---|---|---|
| `openbot-plan.json` | JSON | Compiled custom plan (`planToJson(compileCustomPlan)`). Trailing newline. |
| `openbot-mode` | text | `official` or `custom` plus newline. Do not delete the plan on official. |
| `openbot-audit.jsonl` | JSONL, append-only | Audit trail of reconcile writes to mode / plan / wrap / backup (see below). Best-effort; diagnostics only. |
| `secrets.json` | JSON, **0600** | `{ "providers": { "<providerId>": "<stored locally>" } }` |
| `openbot-expose` | text | `loopback` or `cloudflare-quick` plus newline. Written by reconcile. |
| `openbot-logs.json` | JSON | LogSettings (see below). Trailing newline. |
| `openbot-model-catalog.json` | JSON | Source B cache — **do not hand-edit**; `POST /api/model-catalog/refresh` |
| `openbot-tunnel.json` | JSON | Cached public tunnel URL — do not fake a URL; use `set-expose` / `openbot tunnel on` |
| `openbot-requests.jsonl` + `openbot-request-bodies/` | logs | Not config |
| `host-main.cjs.pre-openbot` | backup | Read-only dump; do not patch as the source of wrap |
| `openbot-hop.pid`, `openbot-ui.pid`, `openbot-tunnel.pid` | pids | Supervisor-owned; do not impersonate |
| `bin/cloudflared` | binary | Downloaded by tunnel reconcile |

Host file: `/home/box/sand-host/host-main.cjs`.

## Env overrides

| Env | Role |
|---|---|
| `OPENBOT_SAND_DATA` | Sand-data directory (default `/home/box/sand-data`) |
| `OPENBOT_PLAN` | Plan JSON path; hop-handler and runtime also use this |
| `OPENBOT_MODE` | Mode file path (runtime) |
| `OPENBOT_SECRETS` | Secrets JSON path |
| `OPENBOT_LOGS` | Log settings path |
| `OPENBOT_MAPS` | Maps module path (default `payload/provider-maps.cjs` next to hop) |
| `OPENBOT_HOST_MAIN` | Host file |
| `OPENBOT_REPO` | Install / repo root for the loopback service |
| `OPENBOT_API_KEY` | CLI install secret only (never argv `--api-key` / `--secret` / `-k`) |
| `OPENBOT_TUNNEL` | Install expose token (`cloudflare` or `off`) |

If `OPENBOT_SAND_DATA` is unset, hop/runtime may infer the directory from `OPENBOT_PLAN`.

## `openbot-plan.json`

Written by `planToJson(compileCustomPlan)` in `src/supervisor/plan.ts`:

```json
{
  "kind": "custom",
  "hop": { "host": "127.0.0.1", "port": 9280 },
  "hopBaseUrl": "http://127.0.0.1:9280/v1",
  "agents": {
    "*": { "modelId": "<slug not providerId:slug>", "providerId": "<provider id>" }
  },
  "catalog": {
    "providers": [{
      "id": "zhipu",
      "name": "Zhipu GLM",
      "origin": "https://open.bigmodel.cn/api/paas/v4",
      "maxTokensDefault": 65536,
      "mapFile": "provider-maps.cjs"
    }],
    "models": [{
      "id": "zhipu:glm-5.3-flash",
      "providerId": "zhipu",
      "slug": "glm-5.3-flash",
      "contextTokens": 128000,
      "maxOutputTokens": 65536,
      "reasoningLevels": ["default", "none", "low", "medium", "high"],
      "activeReasoning": "default",
      "modalities": ["text"],
      "parameters": []
    }],
    "bindings": [{
      "conversation": { "kind": "wildcard" },
      "modelId": "zhipu:glm-5.3-flash"
    }]
  }
}
```

Rules:

- `agents["*"].modelId` is the **slug**; `bindings[].modelId` is **`providerId:slug`**. Keep them in sync.
- `model.id` must equal `providerId:slug`.
- Hop `lookupRoute`: wildcard first (match requested against bound slug, id, or `agents["*"].modelId`), then catalog model by id, then by slug.
- `mapFile` must stay `"provider-maps.cjs"`.
- Provider `id` = slugify(name) (`toLowerCase`, non-alphanumerics → `-`, trim dashes, empty → `provider`), `/^[a-z0-9][a-z0-9._-]{0,63}$/i`.
- Reasoning universe order: `default`, `none`, `low`, `medium`, `high`, `xhigh`, `max` (`xhigh` is one step below `max`).
- Default allow-list if omitted: `default`, `none`, `low`, `medium`, `high`. Always keep `default` in an edited allow-list.
- `maxOutputTokens` default 65536 (`HIGH_AGENT_MAX_TOKENS`), cap 10_000_000. Do not default 8192. `contextTokens` default 128000. `maxTokensDefault` on providers is 65536.
- Do not put keys on bindings or in the plan.
- Invalid or missing plan JSON → hop **503** (`openbot plan missing; save a provider in the UI`); runtime `loadPlan()` failure logs and falls back. Write valid JSON plus a trailing newline.
- `parameters` are `{ "id": string, "value": string }[]`, preserved in the plan. No UI command edits them — Grok Bot may edit them in JSON (e.g. GLM `fast`). Do **not** set GLM `fast: true` as a default.
- Keep `hop` / `hopBaseUrl` as loopback 9280 / `http://127.0.0.1:9280/v1`.

## `secrets.json`

Mode **0600**. Shape:

```json
{
  "providers": {
    "<providerId>": "<stored locally>"
  }
}
```

Hop `loadKey(providerId)` reads this file **per request**. Missing key → hop **503** `no secret for this provider`. Never print values.

## `openbot-mode` and `openbot-expose`

- Mode file: `official\n` or `custom\n`. Source of truth for wrap mode. Reconcile writes it (`writeMode`). Do not flip this file to wrap or unwrap. The UI reads it **strictly**: only the literal token `official` (after trimming) means official; missing, empty, or garbage resolves to **custom** — never official (users own custom state and often have zero official quota, so an unreadable mode file must never reconcile chat back to official). Repair a corrupted token by writing `custom` and reconciling from the control page (`POST /api/save`); check `openbot-audit.jsonl` to see what changed it.
- Expose file: `loopback\n` or `cloudflare-quick\n`. Tokens `cloudflare` / `on` / `cf` parse to `cloudflare-quick`; `off` / `loopback` / `no` / `false` parse to `loopback`. Tailscale is not in this release.

## `openbot-audit.jsonl`

Append-only audit trail next to `openbot-mode`. Every reconcile write to the mode file, the plan file, the wrapped host file, or the known backup appends one line. Writes are best-effort: an audit failure is swallowed and never breaks or blocks a reconcile. Diagnostics only — do not hand-edit.

```json
{"ts":"2026-09-05T12:00:00.000Z","action":"mode","from":"official","to":"custom","source":"ui:save:upsert-provider"}
```

- `action`: `mode` | `plan` | `wrap` | `backup`
- `from` / `to`: short state descriptors
  - mode: `official`, `custom`, `absent`, or the previous garbage token it replaces
  - wrap: `stock-unmarked`, `openbot-marked`, `foreign-opengrok`
  - backup / plan: `absent` / `present`
- `source`: the caller — `ui:save:<kind>` (UI `POST /api/save`), `ui:logs-settings` (UI `PUT /api/logs/settings`), `cli:install` / `cli:official` / `cli:tunnel` (CLI), or `unknown`

Use it when diagnosing "the box fell back to official": the `mode` and `wrap` lines show who changed what, from what, to what, and when.

## `openbot-logs.json`

```json
{
  "loggingEnabled": false,
  "logBodies": false,
  "logBodiesOnError": true,
  "logRetentionDays": 7,
  "maxBodyCaptureBytes": 65536,
  "maxRecords": 2000
}
```

Ranges: `logRetentionDays` 1–365; `maxBodyCaptureBytes` 1024–1048576; `maxRecords` 1–10000.

`payload/request-log.cjs` `loadSettings()` reads the file each time. Enabling logging **on** for official host tap may keep wrap marked (`attachSession` / `wrapSession` → `tapSession`, not a hop). Prefer `PUT /api/logs/settings` so prune plus official reconcile run. Custom hop logging can take a JSON edit.

`PUT /api/logs/settings` JSON body uses the same fields; response includes `wrapBytesChanged` and optional `wrapError`. Also: `GET /api/logs/settings`, `GET /api/logs`, `GET /api/logs/:id`, `POST /api/logs/clear`.

## Hop per-request reload

On each `POST /v1/chat/completions`:

- Plan: `readJson(OPENBOT_PLAN || /home/box/sand-data/openbot-plan.json)`
- Secrets: `secrets.json` via `loadKey`
- Maps: `require.cache` deleted, then `provider-maps.cjs`
- Log settings: `loadSettings()` from disk

Runtime wrap (`payload/runtime.cjs`) `loadPlan()` / `readMode()` also hit disk per turn. A JSON edit while custom wrap is live applies on the **next** Grok Bot message. It does not wrap a stock host.

## Image handling on the custom hop path

The custom path (hop + custom wrap runtime, both share `payload/openai-messages.cjs`) never drops an image. The official tap path is untouched.

### Host image parts (user attachments)

`toOpenAIMessages` converts a host `{ "type": "image", … }` part into a standard OpenAI `image_url` content part instead of the old `"[image]"` placeholder. The part's field shape is unspecified, so it probes tolerantly:

1. `image` — the observed attachment shape is `{ "type": "image", "image": <payload>, "mimeType": … }`. The payload may be a `data:image/…;base64,…` URI (used as-is), bare base64, raw bytes (`Buffer`/`TypedArray`, sniffed), a nested record (e.g. `{ "data": …, "mimeType": … }`), or an array of those. A `mime` / `mimeType` sibling is honored, otherwise magic bytes are sniffed.
2. `data` / `base64` (raw base64) — paired with a `mime` / `mimeType` field, or sniffed from magic bytes (png/jpeg/webp/gif).
3. `url` — `http(s)://` or `data:` URI, used as-is.
4. `path` / `file` — a local file, read from disk and sniffed to a `data:image/<mime>;base64,…` URI.

Any hit becomes `{ "type": "image_url", "image_url": { "url": … } }`. If **all** probes fail, it falls back to the old `"[image]"` placeholder. Guards: missing / unreadable / non-file / over **20 MB** → fall back, never throw.

### Read tool-call image injection (hop path only)

On each `POST /v1/chat/completions`, after `toOpenAIMessages` converts host parts to OpenAI messages, the hop dispatch path (and **only** the hop path — never the official tap) runs an image-read enrichment pass:

- **Detect**: an assistant `tool_calls` entry whose `function.name` is case-insensitively `read` or a `read_image`-style variant (`read_image`, `read-image`, `read image`, `readImage`, …), and whose `function.arguments` (JSON) has a `path` or `file_path` value ending in `.png`, `.jpg`, `.jpeg`, `.webp`, or `.gif` (case-insensitive).
- **Match**: the `role: "tool"` result with the same `tool_call_id`. If that result already contains image data (`image_url` or a `data:` URI), do nothing (no double-inject).
- **Inject**: read the file from disk and insert a follow-up `role: "user"` message **immediately after that tool result**:

  ```json
  {
    "role": "user",
    "content": [
      { "type": "text", "text": "[Image attached from Read: <path>]" },
      { "type": "image_url", "image_url": { "url": "data:<mime>;base64,<bytes>" } }
    ]
  }
  ```

  MIME comes from the extension. Multiple images in one turn each get their own user message, each placed right after its own tool result.
- **Guards**: missing / unreadable / non-file / over **20 MB** → skip that image, log a warning to stderr, and leave the tool result as-is. Never throw, never block the chat request. Text reads (non-image paths) and non-Read tools pass through untouched.

### Harness image bytes on tool results (`experimental_content`)

The official Read tool returns inline base64 image bytes on the tool result under `experimental_content` (aliases `experimentalContent` and plural forms are probed; entries may be a single object or an array, shaped roughly like `{ "type": "image", "data": "<base64>", "mimeType": … }`; a `data:` URI or raw bytes under `image` are accepted too). Behavior:

- **Carry**: the conversion carries that raw value verbatim on the emitted `role: "tool"` row so it survives the runtime → hop round-trip. `enrichImageReads` then strips every carried alias from every row before anything can reach upstream — the harness's own field is never forwarded as an invented upstream field.
- **Map**: harness image bytes win. The same injected `role: "user"` message shape as a disk Read is inserted right after the tool result (label `[Image attached from Read: <path>]` when the tool call is a Read of an image file, else `[Image attached from tool result]`). This applies to **any** tool result that carries image bytes, not only Read calls — the model sees exactly what the harness produced, and the file is never re-read from disk (short-circuit).
- **Never double-inject**: if the tool result text already contains image data (`image_url` / a `data:` URI), nothing is injected. A second conversion pass over already-injected messages does not duplicate the image. Identical duplicate URLs inside one `experimental_content` value are collapsed to one image.
- **Fallback**: `experimental_content` present but with no usable image entries (e.g. only text items, or undecodable bytes) → normal behavior resumes: a Read-style call still gets the disk-read injection, other tools are untouched.
- **Guards**: entries whose own `type` is not `image` are skipped; decoded bytes over **20 MB** are skipped; remote `http(s)` URLs are passed through only when a sibling mime or the file extension says image — the hop never fetches.

### Image compression, image governance & request wire budget

The upstream limit was pinned in three on-the-box rounds: the fusion gateway edge allows **10 MiB** (the old assumption), a **4.43 MB** wire succeeded while a ~9.2 MB body came back **413 "Request Entity Too Large"** (2026-09-04, request `a16ed054…`), and post-#53 bodies of **4.6–4.8 MB still 413'd** — so the binding upstream threshold lives in **[4.43, 4.6) MB** of wire and the budget sits at **4 MiB** full-wire with >0.2 MB of margin. That incident body never tripped a budget check at all: 1,146 messages carried 45 data-URI JPEGs (~8.3 MB of base64) of which only ~26 were distinct — the same screenshot had been re-read turn after turn and every round re-uploaded the whole history, and a messages-only check passed by a few KB before the ~230 KB of tools were added. So the wire budget is the last-resort net; `payload/image-read.cjs` first governs the body down in a fixed order (every step logs one stderr line):

1. **Byte-level dedup**: the decoded bytes of every image part (injected or user-attached, any message, several per message included) are hashed (SHA-1). Byte-identical copies collapse to the **most recent** occurrence (closest to the current turn — so a current-turn attachment wins over an identical history copy); every earlier copy becomes the plain text `[image omitted: identical copy appears later in conversation]`. Distinct images are never touched. Runs before any compression or budget check.
2. **Per-image history quota**: every **history-turn** image is held under `HISTORY_IMAGE_TARGET_BYTES` (**88 KB decoded**; calibrated against the 4.2 MB worst-case target for the incident shape: 26 distinct history images at the target ≈ 3.1 MB of data-URL + ~0.6 MB text + ~0.23 MB tools + the small current-turn image ≈ 4.0 MB, itself >0.2 MB under the proven 4.43 MB success sample; real screenshots usually land far below on the first ladder rung). Images above the target step down the ladder (q85→q70→q50, then 1568→1024→768) until they fit or the ladder bottoms out. The **current turn** — the last user message that is not one of the hop's own `[Image attached from …]` injections, plus everything after it, so several same-turn Read injections all count — keeps the pre-existing behavior (≤600 KB passes through untouched).
3. **Current-turn cap**: `CURRENT_TURN_IMAGE_BUDGET_BYTES` (**3 MiB**, the summed data-URL bytes of the current turn's live images). Over the cap, the turn's own images step down the existing degrade chain oldest-first inside the turn; still over, they are omitted oldest-first — and the **last live current-turn image is never dropped**: a fresh screenshot is the model's evidence, so a single-image turn always keeps exactly one copy (squeezed, if the ladder helps). Calibration: a maxed-out turn (3 MiB) plus ~0.84 MB of text/tools/envelope stays ≈3.9 MB, under the 4.43 MB success sample before any history is counted; the wire net below then trims history (never the current turn, short of the last resort) to close the remaining gap. Placeholder: `[image omitted: current turn over image budget]`.
4. **4 MiB wire budget** (final net): the hop measures the **full outbound wire** — serialized messages **plus** `tools` plus the rest of the request envelope (`outboundEnvelopeBytes`) plus 4 KiB of headroom for the envelope fields applied after governance (`max_tokens`, provider parameter maps) — and passes the difference to `enforceImageBudget` as `extraWireBytes`. Over budget, images degrade **oldest history first** (each rung at most once), then are omitted oldest-first as `[image omitted: budget]` — the newest/current-turn image is dropped last; the request never 413s. If the post-governance wire is still over 4 MiB (non-image content too large), one advisory stderr line names it.

**Compress** (shared by the passes): images ≤ **600 KB** pass through untouched (keeps small PNGs sharp). Larger png/jpeg are re-encoded to **JPEG q≈85, long edge ≤1568** (alpha flattened onto white). webp/gif cannot be decoded in pure JS: the box is probed once for ImageMagick `convert` / `ffmpeg` and used if present, otherwise they pass through (stderr note). The compressed result is used only when smaller than the original. Re-encode results are cached across requests by source bytes + ladder rung, so the same history images are not re-encoded every round.

- **Deps on the box**: `pngjs` 7.0.0 and `jpeg-js` 0.4.4 are **vendored** in `payload/vendor/` (MIT / BSD-3-Clause, pure JS, upstream `package.json` + `LICENSE` kept verbatim). The lazy loader resolves the **vendored copies first**, npm `node_modules` second — an install without `node_modules` (the tarball shape) still compresses. This mattered: the incident box's best-effort `npm install` had silently failed (`Cannot find module 'pngjs'`), so compression never ran until the vendor tree shipped. `install.sh` skips its best-effort `npm install --omit=dev` when both vendored packages are present; otherwise it tries the default registry, then `--registry=https://registry.npmmirror.com`, and if both fail prints a prominent `WARN` block with a remediation hint (the hop still routes; oversized images degrade to omit placeholders). `OPENBOT_SKIP_NPM_INSTALL=1` skips the npm step (tests / offline mirrors).

## `POST /api/save` kinds

`src/parse/ui.ts`. Base `http://127.0.0.1:9280`. Header `Content-Type: application/json`. Each kind runs `reconcile` (recorded in `openbot-audit.jsonl` as `source: "ui:save:<kind>"`).

| kind | Body fields | Notes |
|---|---|---|
| `official` | (none) | Stock wrap when logging off; tap wrap possible if logging on. Plan stays. |
| `upsert-provider` or `custom` | `name`, `origin`, `modelSlug`, `secret`; optional limits | Empty `modelSlug` = zero-model provider. Provider id = slugify(name). Sets wildcard to the new model when slug is nonempty. |
| `upsert-model` | `providerId`, `slug`; optional limits | Provider must exist. `model.id` = `providerId:slug`. |
| `use-model` | `modelId` (`providerId:slug`); optional `reasoning` | Sets wildcard binding. |
| `remove-provider` | `providerId` | Last provider/model → official + empty catalog write (plan removed only in that path). |
| `remove-model` | `modelId` | Wildcard falls back to another model when possible. |
| `set-secret` | `providerId`, `secret` | Provider must exist; custom needs at least one model. |
| `update-provider` | `providerId`, `name`, `origin`; optional `secret` | Keeps existing id. |
| `set-expose` | `expose`: `cloudflare` or `off` | Also accepts parse tokens listed above. |

Optional model limits on upsert: `contextTokens`, `maxOutputTokens`, `reasoningLevels`, `modalities`, `activeReasoning`.

Success `200`: `{ ok: true, wrapBytesChanged, snapshot, providers, models, keyedProviders, activeModelId, logSettings }`.

## Other HTTP

| Method | Path | Role |
|---|---|---|
| GET | `/api/state` or `/api/snapshot` | `{ snapshot, providers, models, keyedProviders, activeModelId, logSettings }` |
| POST | `/api/providers/:id/fetch-models` | Source A list for that provider (needs secret) |
| GET | `/api/model-catalog` | Source B cache snapshot; `?modelId=` lookup |
| POST | `/api/model-catalog/refresh` | `202 { ok, status: "loading", startedAt }` |
| POST | `/v1/chat/completions` | Hop (not a config API) |

`GET /api/state` `snapshot.alignment.kind` is `needs-reinstall` when desired custom and wrap is `stock-unmarked`.

## 409 refusals

Reconcile refusals (`src/supervisor/reconcile.ts`):

| kind | Meaning |
|---|---|
| `host-missing` | `host-main.cjs` not found |
| `foreign-hop` | Foreign process owns `:9280` while desired is custom |
| `foreign-ui` | Foreign process owns `:9280` while desired is official |
| `foreign-opengrok` | Foreign opengrok wrap still present after peel |
| `census-refused` | Host layout not wrappable (`private-lane`, `gap`, `ambiguous-factory`, …) |
| `syntax-check-failed` | Wrapped host failed `node --check` |
| `listen-failed` | Port 9280 could not be bound |

Do not adopt the foreign pid. `--census-only` is observe, not proof that wrap would succeed (`--dry-run` is `proveWrap`).

## CLI

From `/home/box/sand-data/openbot` (or `openbot` on `PATH`):

```bash
node --experimental-strip-types src/cli.ts status
node --experimental-strip-types src/cli.ts official
node --experimental-strip-types src/cli.ts tunnel on
node --experimental-strip-types src/cli.ts tunnel off
node --experimental-strip-types src/cli.ts tunnel status
```

Install / update (reconcile from disk or new provider): `--origin` and `--model` together require `OPENBOT_API_KEY`. `--tunnel cloudflare|off`. `--host-main`, `--sand-data`, `--json`. `--census-only` is not wrap proof. `--dry-run` is.

## Presets (origins only)

From `web/src/lib/presets.ts`. Use for filling plan/API `origin` (and a suggested slug). Do not copy keys.

| Name | origin |
|---|---|
| OpenAI | `https://api.openai.com/v1` |
| DeepSeek | `https://api.deepseek.com` |
| Zhipu GLM | `https://open.bigmodel.cn/api/paas/v4` |
| Kimi | `https://api.moonshot.cn/v1` |
| Qwen | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| OpenRouter | `https://openrouter.ai/api/v1` |
| Groq | `https://api.groq.com/openai/v1` |
| xAI | `https://api.x.ai/v1` |

Custom: any OpenAI-compatible base URL.

## Hop reasoning maps

Do **not** retell these as UI display order. Display/allow-list order is `default · none · low · medium · high · xhigh · max`.

`payload/provider-maps.cjs` `applyProviderReasoningControls`:

- GLM (`glm*` slug or `bigmodel.cn` origin): `xhigh` → upstream `max`; `max` → `max`. `fast: true` disables thinking.
- Grok (`grok*` slug or `api.x.ai`): `max` → upstream `xhigh`; `xhigh` → `xhigh`.
- Generic: pass-through (`xhigh` stays `xhigh`, `max` stays `max`).

Hop injects `effort` / `thinking` parameters from `activeReasoning` (`default` omits; `none` → thinking false; else effort = level). Extra plan `parameters` except `effort`/`thinking` are forwarded.

## JSON-enough check

All three:

1. `openbot-mode` trims to `custom`
2. Host file contains `/* openbot-stock-wrap */` (first line after a successful custom wrap)
3. `GET http://127.0.0.1:9280/api/state` succeeds (loopback service up, ours — not foreign)

Then catalog/secret/log JSON edits apply on the next message. Otherwise reconcile.
