---
name: openbot-config
description: Configures OpenBot on the Computer from Grok Bot — providers, models, API keys, official vs custom wrap, Cloudflare tunnel, and request logs. Prefers editing /home/box/sand-data JSON (openbot-plan.json, secrets.json, openbot-logs.json, openbot-mode, openbot-expose) when wrap is already custom. Use when the user asks to set up OpenBot, switch models, add a key, go official, turn on tunnel, or edit those files.
---

# OpenBot config (Grok Bot on the Computer)

Audience: **Grok Bot 0.30 on the Computer** — the same box as `node /home/box/sand-host/host-main.cjs`. Not the Mac. Do not patch Mac asar. Do not write `~/Library/Application Support/Grok Bot` or `~/.grokbot`.

OpenBot is a box supervisor. Mutations that wrap or unwrap the host or start or stop tunnel go through `DesiredState` plus `reconcile()`. Loopback `127.0.0.1:9280` is the control UI, `/api/*`, and hop `POST /v1/chat/completions`. `openbot-mode` is the source of truth for official vs custom, **not** plan-file existence. Official **keeps** the plan. Bindings are `{ conversation, modelId }` only — **no keys on Binding**.

Prefer Computer JSON files when wrap is already custom. That is faster than the control UI. Hop reads the plan, secrets, live maps (`payload/provider-maps.cjs` only), and log settings **per request**.

Hop request behavior: host image parts (user attachments, typically `{ "type": "image", "image": <data URL or raw bytes>, "mimeType": … }`) become standard OpenAI `image_url` content; a Read-style tool call targeting an image file (`.png`/`.jpg`/`.jpeg`/`.webp`/`.gif`) whose tool result carries no image data gets a `data:image/…` user message injected after that tool result (20 MB cap; missing/oversize files are skipped). When the harness already returned the image bytes on the tool result (`experimental_content`), those bytes are mapped through directly — the disk is never re-read and nothing is injected twice. Every data-URI image is auto-compressed (JPEG q85, long edge ≤1568; images ≤600 KB pass through) and the request is held under an 8 MiB byte budget — the fusion gateway edge allows 10 MiB but its upstream has 413'd real ~9.2 MB payloads, so the budget sits below that. Over budget, images degrade then omit **oldest history first**; the newest (current-turn) image is touched last, worst case replaced by the text `[image omitted: budget]`. Details and guards: [reference.md](reference.md) § "Image handling on the custom hop path".

Never print, commit, or paste API keys. Show `secrets.json` shape with `"<stored locally>"` only.

## When to use

Apply this skill when the user wants to configure OpenBot: set up a provider, switch models or thinking, add or rotate a key, go official or custom, turn the tunnel on/off, change log settings, or edit `/home/box/sand-data` files (`openbot-plan.json`, `secrets.json`, `openbot-logs.json`, `openbot-mode`, `openbot-expose`).

## JSON vs API save vs CLI

| Change | Path | Takes effect |
|---|---|---|
| Active model / thinking | Edit `openbot-plan.json` (`catalog.models[].activeReasoning` plus `agents["*"]`) | Next Grok Bot message, if wrap is already custom and loopback is up |
| Model limits, allow-list, modalities, extra `parameters` | Edit plan JSON | Same |
| Add/edit/remove models and providers **inside the catalog object** | Edit plan JSON; keep `model.id` = `providerId:slug`, bindings, and `agents["*"]` in sync | Same |
| API key | Edit `secrets.json`, then `chmod 0600` | Same (hop loads secrets per request) |
| Hop/request log flags (custom already wrapped) | Edit `openbot-logs.json` | Hop re-reads settings from disk |
| First custom wrap / `needs-reinstall` (desired custom, host stock-unmarked) | **Must** `POST /api/save` or `openbot` CLI | After reconcile; then a **new Grok Bot message** |
| Switch Official (`kind: official`) or back to custom when wrap is missing | **Must** reconcile | Same |
| Tunnel on/off (`openbot-expose` plus cloudflared) | **Must** `set-expose` / `openbot tunnel on` or `off` | Same |
| Official host tap (logging on while mode is official) | Prefer `PUT /api/logs/settings` so prune plus wrap/reconcile run | Same |
| Wrap bytes change (host bounce) | Reconcile only. SIGTERM sand-host; **never** `kill -9`. Do not start `node host-main.cjs` without gateway tokens | Same |

Do **not** write `openbot-mode` or `openbot-expose` by hand to change wrap or tunnel. File edit alone will not wrap/unwrap the host or start/stop cloudflared.

JSON-enough requires **all** of: `openbot-mode` is `custom`, `/home/box/sand-host/host-main.cjs` starts with `/* openbot-stock-wrap */`, and `127.0.0.1:9280` answers.

## Read current config first

Default sand-data is `/home/box/sand-data/` (override with `OPENBOT_SAND_DATA` / `OPENBOT_PLAN` / `OPENBOT_MODE` / `OPENBOT_SECRETS`).

1. Read `openbot-mode` (`official` or `custom`, plus newline).
2. Read `openbot-plan.json` if present. Official still keeps this file.
3. Head the host: `head -n 1 /home/box/sand-host/host-main.cjs` — custom (or official+logging tap) is `/* openbot-stock-wrap */`.
4. If port 9280 is up: `GET http://127.0.0.1:9280/api/state`. Use `snapshot.alignment` (`ok` vs `needs-reinstall`), `snapshot.wrap`, `activeModelId`, providers/models, `keyedProviders` (ids that have a secret — not the secret), `logSettings`, `snapshot.tunnel`.
5. Do not dump `secrets.json` into chat. You may check that a provider id exists under `providers` without printing values.
6. Do not treat `openbot-requests.jsonl` as config. Do not hand-edit `openbot-model-catalog.json`. Do not invent a URL in `openbot-tunnel.json`.

CLI (install tree is usually `/home/box/sand-data/openbot`):

```bash
node --experimental-strip-types /home/box/sand-data/openbot/src/cli.ts status
```

If `openbot` is on `PATH`, `openbot status` is the same.

## Cookbook

### Official / custom

**Official** (stock Grok; plan stays; secrets stay):

```bash
curl -sS -X POST http://127.0.0.1:9280/api/save \
  -H 'Content-Type: application/json' \
  -d '{"kind":"official"}'
```

Or: `openbot official`. Do **not** delete the plan.

**Custom when wrap is missing** (`alignment.kind` is `needs-reinstall`, or the host file is stock unmarked): reconcile with a provider. Empty `modelSlug` is a zero-model provider (setup wizard). Example:

```bash
curl -sS -X POST http://127.0.0.1:9280/api/save \
  -H 'Content-Type: application/json' \
  -d '{"kind":"upsert-provider","name":"Zhipu GLM","origin":"https://open.bigmodel.cn/api/paas/v4","modelSlug":"glm-5.3-flash","secret":"<from user; do not echo>"}'
```

First-time CLI install (key via env only, never `--api-key`):

```bash
OPENBOT_API_KEY='<from user>' node --experimental-strip-types /home/box/sand-data/openbot/src/cli.ts \
  --origin 'https://open.bigmodel.cn/api/paas/v4' --name 'Zhipu GLM' --model 'glm-5.3-flash'
```

If 9280 is down, start it through CLI/reconcile, not by adopting a foreign listener.

### Add or rotate a key

If wrap is already custom: merge `secrets.json` and `chmod 0600`. Shape only:

```json
{
  "providers": {
    "zhipu": "<stored locally>"
  }
}
```

Write via a short script that reads the key from the environment; never echo it. Then `chmod 0600`.

Or `POST /api/save` with `kind` `set-secret`, `providerId`, and `secret` from the user (do not echo).

### Switch model / thinking

Plan rules: `agents["*"].modelId` is the **slug**; `bindings[].modelId` is **`providerId:slug`**. Keep them in sync. Hop routes wildcard first, then catalog model by id or slug.

JSON (custom wrap already up): set `agents["*"]` to `{ "modelId": "<slug>", "providerId": "<id>" }`, set the wildcard binding `modelId` to `"<id>:<slug>"`, set that model's `activeReasoning`. Write valid JSON plus a trailing newline.

Or: `{ "kind": "use-model", "modelId": "zhipu:glm-5.3-flash", "reasoning": "high" }`.

Reasoning universe order: `default`, `none`, `low`, `medium`, `high`, `xhigh`, `max` (`xhigh` is one step below `max`). Default allow-list if omitted: `default`, `none`, `low`, `medium`, `high`. Always keep `default` in an edited allow-list.

### Limits, modalities, parameters

Edit the model row: `contextTokens` (default 128000), `maxOutputTokens` (default **65536**, cap 10_000_000 — do not default 8192), `reasoningLevels`, `modalities` (`text` / `image` / `video` / `audio`), `parameters` (`{ "id", "value" }`).

`parameters` are preserved; no UI command edits them — you **may** set them in JSON (for example GLM `fast`). Do **not** set GLM `fast: true` as a default.

`mapFile` must stay `"provider-maps.cjs"`. Provider `id` = slugify(name), `/^[a-z0-9][a-z0-9._-]{0,63}$/i`. No keys in the plan or on bindings.

Or `upsert-model` / `update-provider` via `/api/save`.

### Tunnel

Must reconcile. Do not fake `openbot-tunnel.json`.

```bash
curl -sS -X POST http://127.0.0.1:9280/api/save \
  -H 'Content-Type: application/json' \
  -d '{"kind":"set-expose","expose":"cloudflare"}'
```

Off: `"expose":"off"`. CLI: `openbot tunnel on`, `openbot tunnel off`, `openbot tunnel status`.

### Logs

`openbot-logs.json`: `loggingEnabled` (default false), `logBodies` (false), `logBodiesOnError` (true), `logRetentionDays` (7; 1–365), `maxBodyCaptureBytes` (65536; 1024–1048576), `maxRecords` (200; 1–10000).

Custom wrap: a JSON edit is enough for hop logging. **Official** host tap may keep wrap marked (`tapSession`) — prefer `PUT http://127.0.0.1:9280/api/logs/settings` so prune and reconcile side effects run.

## Disk, JSON, API, CLI

Schemas, env overrides, `/api/save` kinds, 409 refusals, presets (origins only), and hop reasoning maps: [reference.md](reference.md).

## Aftercare

After wrap or mode change, tell the user: **send a new Grok Bot message**. If wrap is missing (`needs-reinstall` or stock unmarked host) and they wanted custom, reconcile — do not stop at a JSON edit.

## Do not

- Fork opengrok into this tree
- Put keys in bindings, git, chat, or README examples
- Spawn `hop-server.cjs` next to the UI (hop is a route on the same process)
- Adopt a foreign process on `:9280` as ours
- `kill -9` sand-host or start `node host-main.cjs` without gateway tokens
- Treat `--census-only` as proof that wrap would succeed
- Delete the plan file on Official (Official is a wrap mode, not a catalog reset)
- Patch the Mac asar or write Mac Grok Bot paths
- Hand-edit `openbot-model-catalog.json` (refresh with `POST /api/model-catalog/refresh`)
- Patch `host-main.cjs.pre-openbot` as the wrap source
