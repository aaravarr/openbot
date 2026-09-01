# Agent box

[English](README.md) · [中文](README.zh-CN.md)

一个脚本，一条 Cloudflare URL。Agent 用它操作**这台 Computer**。

Cloudflare 快隧道只代理 HTTP，所以这是本机 HTTP 服务，不是 `sshd`。GET 打印出来的 URL 就是 API 说明。

拿到这个 URL 的人可以在这台机器上执行命令、读写文件。把它当密钥。

## 一行安装

在 **Computer** 上运行，不要在 Mac 上运行。

```bash
curl -fsSL https://raw.githubusercontent.com/aaravarr/openbot/main/agent-box/install.sh | bash
```

标准输出是 URL（token 在路径里）。标准错误是一句警告。Agent 应先 `GET` 这个 URL。

```bash
curl -fsSL …/agent-box/install.sh | bash -s status
curl -fsSL …/agent-box/install.sh | bash -s stop
curl -fsSL …/agent-box/install.sh | bash -s restart
```

已经在跑时，`start` 会再次打印同一条 URL。`restart` 会换新的 trycloudflare 主机名。

pid 文件旁边还会写一个停止脚本：`/home/box/sand-data/agent-box/stop`。

## 这不是什么

- 不是 OpenBot 控制页 `127.0.0.1:9280`。本服务占用 **9281**，并拒绝 9280。
- 不是 OpenBot 的 wrap、hop 或 Chat。模型 Key 仍在 OpenBot 的密钥库。
- 不是 Cloudflare 命名隧道，也不是 TCP/SSH。trycloudflare 过期后：再跑一次脚本（还活着就复用，或 `restart`）。

## 路由

全部挂在 `/v/<token>` 下（就是打印出来的 URL）。以 GET 正文为准。

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/` 或 `/help` | API 说明（`text/plain`） |
| GET | `/health` | 用户、cwd、主机名 |
| POST | `/exec` | `{"cmd":"…"}` 或 `{"argv":["ls","-la"]}` |
| GET | `/fs?path=` | 读文件（8MB） |
| PUT | `/fs?path=` | 写文件 |
| POST | `/fs` | `stat` / `list` / `mkdir` / `rm` |

`cmd` 走 `/bin/bash -lc`。不需要 shell 时优先用 `argv`。默认 cwd 是 `$HOME`。

## 环境变量

| 变量 | 含义 |
| --- | --- |
| `AGENT_BOX_DATA` | 状态目录（默认 `/home/box/sand-data/agent-box`） |
| `AGENT_BOX_PORT` | 本机端口（默认 `9281`） |
| `AGENT_BOX_SKIP_TUNNEL=1` | 不走 Cloudflare，打印 `http://127.0.0.1:<port>/v/<token>` |
| `AGENT_BOX_JSON=1` | 标准输出一条 JSON：`{url, internal}` |

如果 OpenBot 已经下载过 `cloudflared`，会复制过来；否则从 GitHub release 拉到状态目录。

## 许可

与 OpenBot 相同（MIT）。
