# OpenBot

[English](README.md) · [中文](README.zh-CN.md)

**Use any model in Grok Bot.**

Grok Bot 0.30 already has a Computer. OpenBot lets that Computer talk to the models you already pay for — OpenAI, GLM, DeepSeek, Kimi, Groq, OpenRouter, or any OpenAI-compatible API — without leaving the Grok Bot app. Official Grok is one click away when you want it back.

```bash
curl -fsSL https://raw.githubusercontent.com/aaravarr/openbot/main/install.sh | bash
```

Then open [http://127.0.0.1:9280](http://127.0.0.1:9280) in the **Computer** browser. The installer prints that address in plain language. Pass `--json` if a script needs the snapshot.

## What you get

- **The Grok Bot app, with a brain you choose.** Same chat. Same tools. Your model answers.
- **Official Grok whenever you want it.** Switching back restores stock chat. Saved providers stay, so you can switch forward again without re-pasting a key.
- **Keys stay on the Computer.** They never go in chat, never go on the command line, and never leave this box.
- **A local control page, not another app.** One install. One page on `127.0.0.1`. Pick a provider, pick a model, go back to Grok Bot.
- **Optional phone access.** Cloudflare Tunnel can print a public URL and a QR. Anyone with that URL can open the control page. Keys stay on this Computer. Hop is on the same port.

## Install

Run the command **in the Computer terminal**, not on your Mac. Grok Bot routes chat on the Computer. A proxy on your laptop never sees a turn.

Needs Node 22 or newer. If the box only has Node 20, the installer puts Node 22 in `sand-data` and leaves system Node alone.

```bash
curl -fsSL https://raw.githubusercontent.com/aaravarr/openbot/main/install.sh | bash
```

When it prints `OpenBot is ready` and `This Computer`, open `http://127.0.0.1:9280` on the Computer.

Re-run that same command to **update** OpenBot. Chat stays Official or custom. A saved Cloudflare Tunnel stays on. The installer does not switch you back to official Grok.

The Cloudflare prompt is **first install only** (no saved expose yet). Type `y` then Enter for a phone URL and QR. Enter alone stays on this Computer. Later installs keep what you already chose. Override with `--tunnel off`, `--tunnel cloudflare`, or `OPENBOT_TUNNEL=off`.

Chat stays on official Grok until you connect a provider. That is on purpose.

```bash
openbot tunnel on      # public URL + QR; also replaces a dead trycloudflare link
openbot tunnel off     # this Computer only
openbot tunnel status
```

trycloudflare URLs expire. On update, `openbot tunnel on`, or **Refresh URL** on Chat, OpenBot probes the saved link and starts a new tunnel when it is gone.

## Connect a model

1. Open the control page.
2. Choose a provider, or pick **Custom** and paste any OpenAI-compatible base URL.
3. Paste an API key and a model id.
4. Click **Start chatting**.
5. Go back to Grok Bot and send a **new** message.

The next turn uses the model you just connected. Context, max output, reasoning levels, and input types use defaults until you open that model on its provider and change them.

## Thinking intensity

On **Chat**, a **Thinking** module sits between Now and the model list. It shows chips for the **active** custom model’s allow-list. Official Grok has no module. A model that still needs a key has no module. Grok Bot sends the selected value on the next message.

The model dialog only chooses which levels Chat may offer — it does not pick the live value.

- **Default** — omit thinking fields. The upstream model uses its own default.
- **Off** — send an explicit disable (`thinking: { type: "disabled" }` on GLM and generic OpenAI; Grok has no standard off field).
- **Low / Medium / High / …** — send that effort.

Older catalogs stored `none` for “leave it to the model.” OpenBot migrates that to **Default**. After Default exists on a model, **Off** is a real disable.

## The control page

Three panes. Limits open as dialogs, not a third page of stacked forms.

- **Chat** — which model Grok Bot uses on this Computer. Official Grok or one custom model. **Thinking** is its own module for the model that is On. A quiet list switches `slug · provider`. No keys, no limits. Not per-conversation — one model at a time.
- **Provider** — the account. The header always shows **Edit** (accessible name **Edit endpoint**), **Key**, and a Key saved badge. **Edit** opens name and base URL in a dialog. **Key** opens the API key dialog. **Add model** opens a **New model** dialog (model ID plus limits). Click a model row to edit limits in a dialog. **Use** puts that model on Chat. Thinking is chosen on Chat, not here.
- **Logs** — hop request records for this Computer. Recording is **off by default**.

If a model still needs a key, Chat takes you to that provider instead of failing silently. You can still open a model dialog and set limits before a key exists.

Image, video, and audio are stored on the model for later. Chat still sends text.

## Logs

The **Logs** pane is for stalled Grok Bot turns that have no inspectable hop record (for example DeepSeek `missing field tool_call_id`). Enable **Record requests** to capture hop metadata and errors. Keys are never stored. Bodies stay off unless you keep them on errors or keep all bodies.

Reinstall or reload OpenBot on the Computer so hop-handler picks up the change.

## Back to official Grok

On **Chat**, click **Official Grok** in the list. Stock chat comes back. Providers and keys remain on the Computer, so you can return to a custom model without setting it up again. A running tunnel stays until you stop it. Updating OpenBot does not click Official for you.

## Good to know

- Do not put a key on the command line. If you install from the CLI with `--origin` and `--model`, set `OPENBOT_API_KEY` in the environment.
- One model is active at a time. Per-conversation overrides are not in this release.
- If something else is already bound to port `9280`, OpenBot refuses to take it over.
- OpenBot is for Grok Bot **0.30 on the Computer**. It does not patch the Mac app.
- Tailscale is not in this release.

## License

MIT. See [LICENSE](LICENSE). OpenBot is an independent project and is not affiliated with xAI.
