# OpenBot

[English](README.md) · [中文](README.zh-CN.md)

**Use any model in Grok Bot.**

Grok Bot 0.30 already has a Computer. OpenBot lets that Computer talk to the models you already pay for — OpenAI, GLM, DeepSeek, Kimi, Groq, OpenRouter, or any OpenAI-compatible API — without leaving the Grok Bot app. Official Grok is one click away when you want it back.

```bash
curl -fsSL https://raw.githubusercontent.com/aaravarr/openbot/main/install.sh | bash
```

Then open [http://127.0.0.1:9280](http://127.0.0.1:9280) in the **Computer** browser.

## What you get

- **The Grok Bot app, with a brain you choose.** Same chat. Same tools. Your model answers.
- **Official Grok whenever you want it.** Switching back restores stock chat. Saved providers stay, so you can switch forward again without re-pasting a key.
- **Keys stay on the Computer.** They never go in chat, never go on the command line, and never leave this box.
- **A local control page, not another app.** One install. One page on `127.0.0.1`. Pick a provider, pick a model, go back to Grok Bot.

## Install

Run the command **in the Computer terminal**, not on your Mac. Grok Bot routes chat on the Computer. A proxy on your laptop never sees a turn.

Needs Node 22 or newer. If the box only has Node 20, the installer puts Node 22 in `sand-data` and leaves system Node alone.

```bash
curl -fsSL https://raw.githubusercontent.com/aaravarr/openbot/main/install.sh | bash
```

When it prints `OpenBot UI: http://127.0.0.1:9280`, open that address on the Computer.

Chat stays on official Grok until you connect a provider. That is on purpose.

## Connect a model

1. Open the control page.
2. Choose a provider, or pick **Custom** and paste any OpenAI-compatible base URL.
3. Paste an API key and a model id.
4. Click **Start chatting**.
5. Go back to Grok Bot and send a **new** message.

The next turn uses the model you just connected.

## Switch later

Every connected model sits in a list next to **Official Grok**. Click a row. The next message in Grok Bot follows that choice.

If a model still needs a key, OpenBot takes you to the key field instead of failing silently.

## Back to official Grok

Click **Official Grok** (or **Use official Grok** at the top). Stock chat comes back. Providers and keys remain on the Computer, so you can return to a custom model without setting it up again.

## Good to know

- Do not put a key on the command line. If you install from the CLI with `--origin` and `--model`, set `OPENBOT_API_KEY` in the environment.
- One model is active at a time. Per-conversation overrides are not in this release.
- If something else is already bound to port `9280`, OpenBot refuses to take it over.
- OpenBot is for Grok Bot **0.30 on the Computer**. It does not patch the Mac app.

## License

MIT. See [LICENSE](LICENSE). OpenBot is an independent project and is not affiliated with xAI.
