# OpenBot

[English](README.md) · [中文](README.zh-CN.md)

**Use any model in Grok Bot.**

Grok Bot 0.30 already has a Computer. OpenBot lets that Computer talk to OpenAI, OpenRouter, OpenCode Zen (sign up once, paste a key, use the $0 models), or any OpenAI-compatible API through Custom — without leaving the Grok Bot app. Official Grok is one click away when you want it back.

## Install

Run this on the **Grok Bot Computer**, not on your Mac:

```bash
curl -fsSL https://raw.githubusercontent.com/aaravarr/openbot/main/install.sh | bash
```

OpenBot needs Node 22 or newer. If the Computer only has Node 20, the installer puts Node 22 in `sand-data` without replacing system Node. On the first install, type `y` at the Cloudflare prompt for a phone URL and QR code, or press Enter to stay local. Then open [http://127.0.0.1:9280](http://127.0.0.1:9280) in the Computer browser.

Run the same command again to update. It keeps the current Official/custom mode and saved tunnel choice.

<details>
<summary>Grok Bot: automatic install</summary>

Run this in a Bot turn on the Computer:

```bash
curl -fsSL https://raw.githubusercontent.com/aaravarr/openbot/main/install.sh | bash -s -- --bot-mode
```

Follow the `OPENBOT_BOT_INSTRUCTION` printed by each command; that output is the authority. In short: start the command, then follow its printed `--bot-status` instruction. Installation usually takes 15–60 seconds. Poll at most twice; if it is still stuck after 3 minutes, send the log tail to the user and stop.

The Bot's own turn runs inside the Grok Bot host, so the update never restarts that host while the turn is talking: a changed payload is written immediately and the restart is deferred to `openbot-pending-bounce.json`, applied by a detached finalizer once the host is idle. `--bot-status` reports this as `OPENBOT_HOST_BOUNCE=pending` (then `done`); nothing needs rerunning and no message is lost.

</details>

## Uninstall

When run through curl | bash, the script reads the confirmation from the terminal.

On the Grok Bot Computer, run:

```bash
curl -fsSL https://raw.githubusercontent.com/aaravarr/openbot/main/uninstall.sh | bash
```

The interactive uninstaller keeps provider secrets by default. Add `--purge-secrets` to delete them. Bot mode is also available with `bash -s -- --bot-mode`.

## Connect a model

1. Open the control page.
2. Choose a provider, or pick **Custom** and paste any OpenAI-compatible base URL.
3. Paste an API key and activate. The wizard saves the provider and key only.
4. On the **Models** page, fetch or add a model, then use it.
5. Go back to Grok Bot and send a **new** message.

The next turn uses the model you just connected. Context, max output, reasoning levels, and input types use defaults until you open that model on its provider and change them.

## Tunnel

Cloudflare Tunnel is optional. It exposes the control page through a temporary public URL; anyone with that URL can open it, while keys stay on the Computer.

```bash
openbot tunnel on      # start or refresh the public URL + QR code
openbot tunnel off     # local Computer only
openbot tunnel status
```

trycloudflare URLs expire. `openbot tunnel on`, the Dashboard’s **Refresh URL**, and an update can replace an expired saved link. Stop the tunnel with `openbot tunnel off` or from the Dashboard.

## Thinking intensity

On **Chat**, **Thinking** shows the allow-list for the active custom model. Official Grok and models that still need a key have no Thinking module. The selected value is sent on the next message.

The model dialog configures which levels Chat may offer; Chat chooses the live value:

- **Default** — omit thinking fields and use the upstream default.
- **Off** — explicitly disable thinking where the upstream supports it.
- **Low / Medium / High / …** — send that effort.

Older catalogs stored `none` for “leave it to the model”; OpenBot migrates that to **Default**. Once Default exists, **Off** is a real disable.

## The control page

The control page has four main areas:

- **Chat** — choose Official Grok or the one global custom model, and choose its Thinking value.
- **Provider / Models** — manage endpoints, keys, model IDs, limits, and activation. Images, video, and audio capabilities are stored on the model for later; current chat still sends text.
- **Bots** — see bot profiles from the Computer, pause or resume individual bots, and assign a model per bot. A bot without an override uses the global model; selections can also be applied in batches.
- **Logs** — view request records for this Computer. Recording is off by default.

On **Dashboard**, **Install from the OpenBot repo** copies the OpenBot config skill into Grok Bot user skills at `/home/box/agent-data/workflows`, not into the plugin directory.

## Logs

Enable **Record requests** to capture records. API keys are never stored. Bodies stay off unless you choose to keep bodies on errors or keep all bodies.

Custom chat records **Hop** (`POST /v1/chat/completions`) and **Host** rows. Official Grok records **Official** host rows; it still uses stock Grok and does not hop. Enabling recording while Official is active installs the tap and may restart the host once.

## Back to official Grok

On **Chat**, click **Official Grok**. Stock chat comes back; providers, models, and keys remain on the Computer so you can switch back later. A running tunnel stays up until you stop it. Updating OpenBot does not switch modes for you.

## Good to know

- Do not put a key on the command line. For CLI installs with `--origin` and `--model`, use `OPENBOT_API_KEY`.
- If another program already owns port `9280`, OpenBot refuses to take it over.
- OpenBot is for Grok Bot **0.30 on the Computer**. It does not patch the Mac app.
- Tailscale is not included.

## License

MIT. See [LICENSE](LICENSE). OpenBot is an independent project and is not affiliated with xAI.
