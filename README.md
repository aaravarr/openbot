# OpenBot

[English](README.md) · [中文](README.zh-CN.md)

Bring your own models to [Grok Bot](https://grok.x.ai/). Install on the Bot Computer, open a local control UI, paste an API key, and chat. Switch **Official** when you want stock Grok again. That switch restores the vendor host. It does not leave a wrapper that pretends to be stock.

Grok Bot 0.30 routes chat on the Computer, not on your Mac. A hop bound to `127.0.0.1` on the laptop never sees a turn. OpenBot runs on the box.

## Status

The public repo is new. This first commit lands the domain model and the repo layout. The one-line installer, host wrap, hop, and Web UI ship as follow-up PRs. Do not curl an install script yet.

## What it will do

- One-line install on the Grok Bot Computer
- Control UI on `127.0.0.1` (open it in the Computer browser)
- Provider list, model list, model switch
- API keys in a secret store on the box, never in bindings or git
- BYOK as paste-a-key in our UI
- Official mode: stock `createProtoSessionProvider`, no hop, no wrap
- Custom mode: wrap only `executor.stream`, POST OpenAI-compatible `/v1/chat/completions` through a loopback hop

Per-conversation model override is out of v1.

## Design rules (already in types)

- Official is wrap-gone. A vendor host rewrite while you still wanted custom is `needs-reinstall`, not official.
- Bindings map a conversation to a model id. They cannot hold `apiKey` or any hop URL. The hop URL is always `http://127.0.0.1:18790/v1`.
- The generic hop unwraps AI SDK `jsonSchema` and maps `tool_calls` faithfully. It does not drop later `SendToUser` calls to force a stop.
- Agent `max_tokens` default is 65536, not 8192.

See `src/domain/types.ts` and `AGENTS.md`.

## Install (not shipped yet)

Will look like this, run **in the Computer terminal**, not on the Mac:

```bash
curl -fsSL https://raw.githubusercontent.com/aaravarr/openbot/main/install.sh | bash
```

Then open the printed `http://127.0.0.1:<ui-port>` URL in the Computer browser.

## Development

```bash
npm install
npm test
npm run typecheck
```

Node 22 or newer.

## License

MIT. See [LICENSE](LICENSE).
