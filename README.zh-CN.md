# OpenBot

[English](README.md) · [中文](README.zh-CN.md)

把你自己的模型接到 [Grok Bot](https://grok.x.ai/)。在 Bot 的 Computer 上安装，打开本机控制界面，粘贴 API Key，然后聊天。要恢复官方 Grok 时切到 **Official**。这一步会还原厂商的 host，不会留一个假装官方的包装层。

Grok Bot 0.30 的聊天路由在 Computer 上，不在 Mac 上。笔记本上绑 `127.0.0.1` 的 hop 收不到回合。OpenBot 跑在盒子里。

## 现状

`install.sh` 会拷仓库、保持聊天 official，并拉起一个 loopback 服务（控制界面和聊天 hop 共用）。测试用假 Computer host 覆盖了这条安装路径，以及 census、wrap/restore、hop 映射和 provider upsert。

安装脚本已在真实的 Grok Bot Computer 上跑过。切 Official 会保留已保存的 provider。桌面端 Grok Bot 聊天仍需在 App 里证明。

## 安装

在 **Computer 终端**里跑，不要在 Mac 上跑。需要 Node 22 或更新。如果盒子只有 Node 20，脚本会把 Node 22 装进 `sand-data`，不替换系统 Node。

```bash
curl -fsSL https://raw.githubusercontent.com/aaravarr/openbot/main/install.sh | bash
```

然后用 Computer 浏览器打开 `http://127.0.0.1:9280`。

1. 裸安装保持 official，聊天仍是官方 Grok。
2. 在界面里保存 provider、模型和 API Key。这时才会 wrap `createProtoSessionProvider`。聊天在同一个 loopback 服务上 POST `/v1/chat/completions`。
3. Use 会切换通配模型。bindings 里不会出现 Key。hop 从 `/home/box/sand-data/secrets.json` 注入。
4. Official 会剥掉我们的 wrap（如果还有 `/* opengrok-stock-wrap */` 也会剥），控制界面留着方便再切回去，已保存的 provider 不会删。

不要把 Key 写在命令行上。CLI 带 `--origin` 和 `--model` 安装时，用环境变量 `OPENBOT_API_KEY`。

`--census-only` 只打印 host 符号，不能证明 wrap 会成功。`--dry-run` 才是在副本上跑 wrap。

`:9280` 上不明进程会拒绝。残留的 `python …/hop-server.py` 会被停掉。

## 会做什么

- 在 Grok Bot Computer 上一行安装
- 控制界面和聊天 hop 都绑 `127.0.0.1:9280`
- Provider 列表、模型列表、切模型
- API-key 模式和 BYOK 都在这个界面里
- Official：官方 factory，无 wrap
- Custom：只劫持 `executor.stream`，经 loopback POST OpenAI 兼容的 `/v1/chat/completions`

按会话覆盖模型不在 v1。

## 规则

- Official 是拆掉 wrap。你还想用 custom、厂商却把 host 写回 stock 时，状态是 `needs-reinstall`，不是 Official。
- Binding 只把会话映射到模型 id。不能带 `apiKey`，也不能带 hop URL。hop URL 永远是 `http://127.0.0.1:9280/v1`。
- 通用 hop 展开 AI SDK 的 `jsonSchema`，并忠实映射 `tool_calls`。不会靠丢掉后续 `SendToUser` 来强行结束回合。
- Agent 的 `max_tokens` 默认是 65536，不是 8192。
- 调用方把输入解析成 `DesiredState`，再 `reconcile`。不要自己串 wrap、启动 hop、bounce host。

见 `src/domain/types.ts` 和 `AGENTS.md`。

## 开发

```bash
npm install
npm test
npm run typecheck
```

需要 Node 22 或更新。测试用假 host 文件和假进程。它们不能证明 Bot 消息打到了盒子的 `:9280`。

## 许可

MIT。见 [LICENSE](LICENSE)。
