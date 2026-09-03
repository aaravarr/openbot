# AGENTS.md

Instructions for coding agents working in this repository.

## Product

OpenBot attaches to stock Grok Bot 0.30 on the **Computer**, not the Mac. Chat routing is `node /home/box/sand-host/host-main.cjs`. Do not patch the Mac asar. Do not write bindings under `~/Library/Application Support/Grok Bot` or `~/.grokbot`.

## Language

Code, comments, commits, PRs, and docs are English. `README.md` is English. `README.zh-CN.md` is Chinese. Link both at the top of each file.

## Architecture

The domain is a box supervisor. Callers parse input into `DesiredState`, then `reconcile(desired)`. They do not sequence wrap, hop start, and host bounce themselves.

`DesiredState` is `OfficialBox | CustomBox` in `src/domain/types.ts`.

- Official: chat uses stock Grok. Leftover hop-only processes are stopped. The loopback service stays so the user can switch back. DesiredState has no catalog, hop URL, or upstream. The plan file on disk stays unless the user removed the last provider. Secrets stay. `openbot-mode` is `official`. Wrap is stock (gone) when request logging is off. When logging is on, the host may stay marked: `attachSession` / `wrapSession` delegates to `tapSession`, which calls stock Grok and records host-format messages, tools, stream parts, and `response.messages`. That tap is not a hop and is not `IdentityOfficialWrap`.
- Custom: wrap is marked `/* openbot-stock-wrap */`. One loopback service on `127.0.0.1:9280` serves the control UI, `/api/*`, and hop `POST /v1/chat/completions`. Catalog holds providers, models, and bindings. `openbot-mode` is `custom`. Custom wrap also records a `custom-host` row (what we yield to the harness) beside the hop OpenAI row.

A known `/* opengrok-stock-wrap */` header is peeled back to stock before official restore or custom wrap. `python …/hop-server.py` leftovers are SIGTERM'd. A leftover `hop-server.cjs` pid is stopped. Any other foreign listener on `:9280` is refused, not adopted.

`align(desired, wrap)` returns `needs-reinstall` when desired is custom and the host file is stock unmarked. That is not official. Infer desired from `openbot-mode`, not from plan-file existence. Official keeps the plan.

Bindings are `{ conversation, modelId }`. Derive `hopBaseUrl` with `hopBaseUrl(LOOPBACK_HOP)`. Secret field names are unrepresentable on `Binding`.

The generic hop unwraps `{ jsonSchema }`, maps OpenAI `tool_calls` to host `tool-call` parts, maps `finish_reason: "tool_calls"` to `finishReason: "tool-calls"`, and honors the model's `stop`. Custom wrap emits `tool-call-streaming-start` then `tool-call-delta` then `tool-call`, and settles `response.messages` as host content parts (reasoning text, text, and tool-call together). Do not invent `reasoning-signature` or official-only fields. Do not map leftover assistant text onto SendToUser. Do not add a SendToUser-drop or a forced `finish=stop` on `GenericHop`. Named opt-in strategies are a separate union.

Outbound hop requests send `x-openbot-version` with `OPENBOT_COMMIT`, then the install stamp in `payload/version.json`, then git HEAD. Tarball installs have no `.git`; `install.sh` stamps the commit. Do not commit `payload/version.json`. Do not invent or replace `User-Agent`; copy the inbound value if present.

Host→OpenAI (`toOpenAIMessages`) is a structural conversion only: tool-call parts become `tool_calls`, tool-result becomes `role: tool`. Do not peel `<system_reminder>` or `[SAND_HIDDEN_PROMPT]`. Do not drop a reminder-only user turn. Do not insert a reminder. The official harness hides those strings from the user; the hop model must still see them.

`wrapSession` exists only in a marked host. It is sync. Do not return a Promise. Do not add `wrapBareHop`. Official turns never hop: `wrapSession` / `attachSession` must delegate to `tapSession` when `openbot-mode` is official. `tapSession` is sync, calls stock, and must yield the original stream parts.

Default agent `max_tokens` is `HIGH_AGENT_MAX_TOKENS` (65536). Do not default to 8192. Do not write GLM `fast: true` as an installer default. Live maps file is `provider-maps.cjs` only.

## UI

Before changing `ui/`, read `DESIGN.md`. It comes from `npx getdesign@latest add cursor`. Light cream canvas, hairline cards, Cursor Orange only on the primary save CTA. Do not add drop shadows.

## Git

The first commit is on `main`. Every later change is a PR, then merge. Conventional Commits: `type(scope): subject`.

## OpenBot config skill

Path: `skills/openbot-config/` (`SKILL.md` plus `reference.md`) at the repository root. Grok Bot loads **project-root `skills/`**, not `.cursor/skills/`. The control page can copy that tree into `/home/box/agent-data/workflows/<slug>/` so Grok Bot loads it as a user skill.

Grok Bot on the Computer uses this project skill to configure the box: providers, models, keys, official vs custom, tunnel, and logs. Prefer sand-data JSON when wrap is already custom; reconcile for wrap and tunnel.

Whenever sand-data files, save commands, hop reload behavior, wrap/mode, reasoning universe, presets, or hop maps **change**, the skill must be updated **in the same change or a follow-up PR**.

### How to update

The parent/coordinator agent must **not** rewrite the skill itself. Dispatch a subagent with:

1. The diff of the product change
2. Instruction to Read `skills/openbot-config/SKILL.md` and `skills/openbot-config/reference.md`
3. No StrReplace (Read full files, Write whole files as UTF-8)
4. Keep `SKILL.md` under 500 lines; put schemas in `reference.md`
5. No secrets in examples
6. Tests not required unless TypeScript changed

### Updater checklist

- Disk paths
- JSON shapes
- JSON-vs-reconcile rule
- `/api/save` kinds
- Hop per-request reload
- Do-not list
- Reasoning order `high · xhigh · max`

## Tests

`npm test` and `npm run typecheck` must stay green. Prefer Node's test runner. Verify UI in a browser when you change it. Verify install on a Computer when you change wrap or hop. A typecheck is not proof that chat routes.

## Do not

- Fork opengrok into this tree
- Put keys in bindings, git, chat, or README examples
- Spawn `hop-server.cjs` next to the UI. Hop is a route on the same process.
- Adopt a foreign process on `:9280` as ours
- `kill -9` sand-host or start `node host-main.cjs` without gateway tokens
- Treat `--census-only` as proof that wrap would succeed
- Delete the plan file on Official. Official is a wrap mode, not a catalog reset.
