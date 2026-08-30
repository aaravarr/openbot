# OpenBot

[English](README.md) · [中文](README.zh-CN.md)

把你自己的模型接到 [Grok Bot](https://grok.x.ai/)。在 Bot 的 Computer 上安装，打开本机控制界面，粘贴 API Key，然后聊天。要恢复官方 Grok 时切到 **Official**。这一步会还原厂商的 host，不会留一个假装官方的包装层。

Grok Bot 0.30 的聊天路由在 Computer 上，不在 Mac 上。笔记本上绑 `127.0.0.1` 的 hop 收不到回合。OpenBot 跑在盒子里。

## 现状

仓库刚建。这次提交是领域模型和仓库结构。一行安装、host wrap、hop、Web UI 会走后续 PR。现在不要 `curl` 安装脚本。

## 会做什么

- 在 Grok Bot Computer 上一行安装
- 控制界面绑 `127.0.0.1`（在 Computer 浏览器里打开）
- Provider 列表、模型列表、切模型
- Key 只放盒子上的 secret store，不进 bindings，不进 git
- BYOK 是我们界面里粘贴 Key
- Official：走官方 `createProtoSessionProvider`，无 hop，无 wrap
- Custom：只劫持 `executor.stream`，经 loopback hop POST OpenAI 兼容的 `/v1/chat/completions`

按会话覆盖模型不在 v1。

## 已经写进类型的规则

- Official 是拆掉 wrap。你还想用 custom、厂商却把 host 写回 stock 时，状态是 `needs-reinstall`，不是 Official。
- Binding 只把会话映射到模型 id。不能带 `apiKey`，也不能带 hop URL。hop URL 永远是 `http://127.0.0.1:18790/v1`。
- 通用 hop 展开 AI SDK 的 `jsonSchema`，并忠实映射 `tool_calls`。不会靠丢掉后续 `SendToUser` 来强行结束回合。
- Agent 的 `max_tokens` 默认是 65536，不是 8192。

见 `src/domain/types.ts` 和 `AGENTS.md`。

## 安装（尚未发布）

以后在 **Computer 终端**里跑，不要在 Mac 上跑：

```bash
curl -fsSL https://raw.githubusercontent.com/aaravarr/openbot/main/install.sh | bash
```

然后在 Computer 浏览器里打开打印出的 `http://127.0.0.1:<ui-port>`。

## 开发

```bash
npm install
npm test
npm run typecheck
```

需要 Node 22 或更新。

## 许可

MIT。见 [LICENSE](LICENSE)。
