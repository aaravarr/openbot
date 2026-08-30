# OpenBot

[English](README.md) · [中文](README.zh-CN.md)

Bring your own models to [Grok Bot](https://grok.x.ai/). Install on the Bot Computer, open a local control UI, paste an API key, and chat. Switch **Official** when you want stock Grok again. That switch restores the vendor host. It does not leave a wrapper that pretends to be stock.

Grok Bot 0.30 routes chat on the Computer, not on your Mac. A hop bound to `127.0.0.1` on the laptop never sees a turn. OpenBot runs on the box.

## Status

`install.sh` copies the tree, leaves chat official, and starts one loopback service for the control UI and chat hop. Tests cover that path against a fake Computer host file, plus census, wrap/restore, hop mapping, and provider upsert.

The installer has run on a live Grok Bot Computer. Official keeps saved providers. Desktop chat still has to be proven in the Grok Bot app.

## Install

Run this **in the Computer terminal**, not on the Mac. Node 22 or newer. If the box only has Node 20, the script fetches Node 22 into `sand-data` and does not replace system Node.

```bash
curl -fsSL https://raw.githubusercontent.com/aaravarr/openbot/main/install.sh | bash
```

Then open `http://127.0.0.1:9280` in the Computer browser.

1. Bare install stays official. Chat is still stock Grok.
2. Save a provider, model, and API key in the UI. That wraps `createProtoSessionProvider`. Chat POSTs `/v1/chat/completions` on the same loopback service.
3. Use switches the wildcard model. Bindings never hold keys. The hop injects the key from `/home/box/sand-data/secrets.json`.
4. Official peels our wrap (and a leftover `/* opengrok-stock-wrap */` if present), keeps the UI so you can switch back, and does not delete saved providers.

Do not put a key on the command line. `OPENBOT_API_KEY` is the env var if you install from the CLI with `--origin` and `--model`.

`--census-only` prints host symbols. It is not proof that wrap would succeed. `--dry-run` runs the wrap transform on a copy.

An unknown listener on `:9280` is refused. A leftover `python …/hop-server.py` is stopped.

## What it does

- One-line install on the Grok Bot Computer
- Control UI and chat hop on `127.0.0.1:9280`
- Provider list, model list, model switch
- API-key mode and BYOK in this UI
- Official mode: stock factory, no wrap
- Custom mode: wrap only `executor.stream`, POST OpenAI-compatible `/v1/chat/completions`

Per-conversation model override is out of v1.

## Design rules

- Official is wrap-gone. A vendor host rewrite while you still wanted custom is `needs-reinstall`, not official.
- Bindings map a conversation to a model id. They cannot hold `apiKey` or any hop URL. The hop URL is always `http://127.0.0.1:9280/v1`.
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

Node 22 or newer. Tests inject a fake host file and fake processes. They do not prove that a Bot message hits box `:9280`.

## License

MIT. See [LICENSE](LICENSE).
