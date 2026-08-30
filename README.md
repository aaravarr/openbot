# OpenBot

[English](README.md) · [中文](README.zh-CN.md)

Bring your own models to [Grok Bot](https://grok.x.ai/). Install on the Bot Computer, open a local control UI, paste an API key, and chat. Switch **Official** when you want stock Grok again. That switch restores the vendor host. It does not leave a wrapper that pretends to be stock.

Grok Bot 0.30 routes chat on the Computer, not on your Mac. A hop bound to `127.0.0.1` on the laptop never sees a turn. OpenBot runs on the box.

## Status

`install.sh` copies the tree, leaves chat official, and starts the cream control UI. Tests cover that path against a fake Computer host file, plus census, wrap/restore, hop mapping, and catalog upsert.

A live Grok Bot Computer has not run the curl line. Chat routing still has to be proven on the box.

The UI follows `DESIGN.md` from `npx getdesign@latest add cursor`: warm cream canvas, hairline cards, Cursor Orange on the primary save button.

## Install

Run this **in the Computer terminal**, not on the Mac. Node 22 or newer.

```bash
curl -fsSL https://raw.githubusercontent.com/aaravarr/openbot/main/install.sh | bash
```

Then open `http://127.0.0.1:18791` in the Computer browser.

1. Bare install stays official. Chat is still stock Grok.
2. Save a provider, model, and API key in the UI. That wraps `createProtoSessionProvider` and starts hop on `127.0.0.1:18790`.
3. Use switches the wildcard model. Bindings never hold keys. The hop injects the key from `/home/box/sand-data/secrets.json`.
4. Official peels our wrap (and a leftover `/* opengrok-stock-wrap */` if present), stops hop, and keeps the UI so you can switch back.

Do not put a key on the command line. `OPENBOT_API_KEY` is the env var if you install from the CLI with `--origin` and `--model`.

`--census-only` prints host symbols. It is not proof that wrap would succeed. `--dry-run` runs the wrap transform on a copy.

An unknown listener on `:18790` is refused. A leftover `python …/hop-server.py` is stopped.

## What it does

- One-line install on the Grok Bot Computer
- Control UI on `127.0.0.1:18791`
- Provider list, model list, model switch
- API-key mode and BYOK in this UI
- Official mode: stock factory, no hop, no wrap
- Custom mode: wrap only `executor.stream`, POST OpenAI-compatible `/v1/chat/completions`

Per-conversation model override is out of v1.

## Design rules

- Official is wrap-gone. A vendor host rewrite while you still wanted custom is `needs-reinstall`, not official.
- Bindings map a conversation to a model id. They cannot hold `apiKey` or any hop URL. The hop URL is always `http://127.0.0.1:18790/v1`.
- The generic hop unwraps AI SDK `jsonSchema` and maps `tool_calls` faithfully. It does not drop later `SendToUser` calls to force a stop.
- Agent `max_tokens` default is 65536, not 8192.
- Callers parse input into `DesiredState`, then `reconcile`. They do not sequence wrap, hop start, and host bounce themselves.

See `src/domain/types.ts` and `AGENTS.md`.

## Development

```bash
npm install
npm test
npm run typecheck
```

Node 22 or newer. Tests inject a fake host file and fake processes. They do not prove that a Bot message hits box `:18790`.

## License

MIT. See [LICENSE](LICENSE).
