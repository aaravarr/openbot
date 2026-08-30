# AGENTS.md

Instructions for coding agents working in this repository.

## Product

OpenBot attaches to stock Grok Bot 0.30 on the **Computer**, not the Mac. Chat routing is `node /home/box/sand-host/host-main.cjs`. Do not patch the Mac asar. Do not write bindings under `~/Library/Application Support/Grok Bot` or `~/.grokbot`.

## Language

Code, comments, commits, PRs, and docs are English. `README.md` is English. `README.zh-CN.md` is Chinese. Link both at the top of each file.

## Architecture

The domain is a box supervisor. Callers parse input into `DesiredState`, then `reconcile(desired)`. They do not sequence wrap, hop start, and host bounce themselves.

`DesiredState` is `OfficialBox | CustomBox` in `src/domain/types.ts`.

- Official: wrap is stock (gone), hop is stop-owned, UI stays on loopback so the user can switch back. No catalog, no hop URL, no upstream.
- Custom: wrap is marked `/* openbot-stock-wrap */`, hop is adopt-or-start on `127.0.0.1:18790`, UI on `127.0.0.1:18791`. Catalog holds providers, models, and bindings.

`align(desired, wrap)` returns `needs-reinstall` when desired is custom and the host file is stock unmarked. That is not official.

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
- `Popen` a second hop on a live `:18790`
- Adopt a foreign process on `:18790` as ours
- `kill -9` sand-host or start `node host-main.cjs` without gateway tokens
- Treat `--census-only` as proof that wrap would succeed
