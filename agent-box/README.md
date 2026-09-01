# Agent box

[English](README.md) · [中文](README.zh-CN.md)

One script. One Cloudflare URL. Agents can operate **this Computer**.

Cloudflare quick tunnels only proxy HTTP, so this is a loopback HTTP service — not `sshd`. GET the printed URL for the API.

Anyone who has the URL can run commands and read or write files. Treat it as a secret.

## One line

Run this **on the Computer**, not on a Mac.

```bash
curl -fsSL https://raw.githubusercontent.com/aaravarr/openbot/main/agent-box/install.sh | bash
```

Stdout is the URL (token is in the path). Stderr is a short warning. An agent should `GET` that URL first.

```bash
curl -fsSL …/agent-box/install.sh | bash -s status
curl -fsSL …/agent-box/install.sh | bash -s stop
curl -fsSL …/agent-box/install.sh | bash -s restart
```

If the process is already live, `start` prints the same URL again. `restart` mints a new trycloudflare hostname.

A stop helper is also written next to the pid files: `/home/box/sand-data/agent-box/stop`.

## What it is not

- Not the OpenBot control page on `127.0.0.1:9280`. This binds **9281** and refuses 9280.
- Not OpenBot wrap, hop, or Chat. Keys for models stay in the OpenBot secret store.
- Not a named Cloudflare tunnel and not TCP/SSH. Expired trycloudflare links: run the script again (reuse if still live, or `restart`).

## Routes

All routes hang under `/v/<token>` (the printed URL). See the GET body for the live document.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/` or `/help` | This API, as `text/plain` |
| GET | `/health` | User, cwd, hostname |
| POST | `/exec` | `{"cmd":"…"}` or `{"argv":["ls","-la"]}` |
| GET | `/fs?path=` | Read a file (8MB) |
| PUT | `/fs?path=` | Write a file |
| POST | `/fs` | `stat` / `list` / `mkdir` / `rm` |

`cmd` is `/bin/bash -lc`. Prefer `argv` when you do not need a shell. Default cwd is `$HOME`.

## Environment

| Variable | Meaning |
| --- | --- |
| `AGENT_BOX_DATA` | State directory (default `/home/box/sand-data/agent-box`) |
| `AGENT_BOX_PORT` | Loopback port (default `9281`) |
| `AGENT_BOX_SKIP_TUNNEL=1` | No Cloudflare; print `http://127.0.0.1:<port>/v/<token>` |
| `AGENT_BOX_JSON=1` | One JSON object on stdout: `{url, internal}` |

If OpenBot already downloaded `cloudflared`, this script copies it. Otherwise it fetches the GitHub release into the state directory.

## License

Same as OpenBot (MIT).
