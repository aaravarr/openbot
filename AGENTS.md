# AGENTS.md

Instructions for coding agents working in this repository.

## Product

OpenBot attaches to stock Grok Bot 0.30 on the **Computer**, not the Mac. Chat routing is `node /home/box/sand-host/host-main.cjs`. Do not patch the Mac asar. Do not write bindings under `~/Library/Application Support/Grok Bot` or `~/.grokbot`.

## Language

Code, comments, commits, PRs, and docs are English. `README.md` is English. `README.zh-CN.md` is Chinese. Link both at the top of each file.

## Architecture

The domain is a box supervisor. Callers parse input into `DesiredState`, then `reconcile(desired)`. They do not sequence wrap, hop start, and host bounce themselves.

`DesiredState` is `OfficialBox | CustomBox` in `src/domain/types.ts`.

- Official: wrap is stock (gone). Leftover hop-only processes are stopped. The loopback service stays so the user can switch back. DesiredState has no catalog, hop URL, or upstream. The plan file on disk stays unless the user removed the last provider. Secrets stay. `openbot-mode` is `official`.
- Custom: wrap is marked `/* openbot-stock-wrap */`. One loopback service on `127.0.0.1:9280` serves the control UI, `/api/*`, and hop `POST /v1/chat/completions`. Catalog holds providers, models, and bindings. `openbot-mode` is `custom`.

A known `/* opengrok-stock-wrap */` header is peeled back to stock before official restore or custom wrap. `python …/hop-server.py` leftovers are SIGTERM'd. A leftover `hop-server.cjs` pid is stopped. Any other foreign listener on `:9280` is refused, not adopted.

`align(desired, wrap)` returns `needs-reinstall` when desired is custom and the host file is stock unmarked. That is not official. Infer desired from `openbot-mode`, not from plan-file existence. Official keeps the plan.

Bindings are `{ conversation, modelId }`. Derive `hopBaseUrl` with `hopBaseUrl(LOOPBACK_HOP)`. Secret field names are unrepresentable on `Binding`.

The generic hop unwraps `{ jsonSchema }`, maps OpenAI `tool_calls` to host `tool-call` parts, maps `finish_reason: "tool_calls"` to `finishReason: "tool-calls"`, and honors the model's `stop`. Do not add a SendToUser-drop or a forced `finish=stop` on `GenericHop`. Named opt-in strategies are a separate union.

`wrapSession` exists only in a marked host. Official turns never enter it. It is sync. Do not return a Promise. Do not add `wrapBareHop`.

Default agent `max_tokens` is `HIGH_AGENT_MAX_TOKENS` (65536). Do not default to 8192. Do not write GLM `fast: true` as an installer default. Live maps file is `provider-maps.cjs` only.

## UI

Before changing `ui/`, read `DESIGN.md`. It comes from `npx getdesign@latest add cursor`. Light cream canvas, hairline cards, Cursor Orange only on the primary save CTA. Do not add drop shadows.

## Git

The first commit is on `main`. Every later change is a PR, then merge. Conventional Commits: `type(scope): subject`.

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
