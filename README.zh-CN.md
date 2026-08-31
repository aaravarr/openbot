# OpenBot

[English](README.md) · [中文](README.zh-CN.md)

**在 Grok Bot 里用你自己的模型。**

Grok Bot 0.30 已经有一台 Computer。OpenBot 让这台 Computer 去调用你已经在付费的模型 —— OpenAI、GLM、DeepSeek、Kimi、Groq、OpenRouter，或任何 OpenAI 兼容接口 —— 不用离开 Grok Bot。想用回官方 Grok 时，一键即可。

```bash
curl -fsSL https://raw.githubusercontent.com/aaravarr/openbot/main/install.sh | bash
```

然后用 **Computer 的浏览器** 打开 [http://127.0.0.1:9280](http://127.0.0.1:9280)。

## 你能得到什么

- **还是 Grok Bot，只是脑子换成你选的。** 同一个聊天窗口，同一套工具，由你的模型来回答。
- **随时回到官方 Grok。** 切回去就是原厂聊天。已保存的服务商还在，再切回来不用重新粘贴 Key。
- **Key 留在 Computer 上。** 不会进聊天，不会出现在命令行，也不会离开这台盒子。
- **本机一页控制，不是再装一个 App。** 装一次，打开 `127.0.0.1` 上的页面，选服务商、选模型，回到 Grok Bot 继续聊。

## 安装

在 **Computer 终端**里运行，不要在 Mac 上运行。Grok Bot 的聊天走 Computer；笔记本上的代理收不到回合。

需要 Node 22 或更新。如果盒子里只有 Node 20，安装脚本会把 Node 22 放到 `sand-data`，不替换系统 Node。

```bash
curl -fsSL https://raw.githubusercontent.com/aaravarr/openbot/main/install.sh | bash
```

看到 `OpenBot UI: http://127.0.0.1:9280` 后，用 Computer 浏览器打开这个地址。

在你接入服务商之前，聊天仍是官方 Grok。这是故意的。

## 接入一个模型

1. 打开控制页。
2. 选一个服务商；或选 **Custom**，粘贴任何 OpenAI 兼容的 Base URL。
3. 粘贴 API Key 和模型 ID。
4. 点 **Start chatting**。
5. 回到 Grok Bot，发一条**新消息**。

下一回合就会走你刚接上的模型。

## 之后怎么切换

每个已接入的模型都会出现在列表里，和 **Official Grok** 排在一起。点一行即可。Grok Bot 的下一条消息会跟着这个选择走。

如果某个模型还没有 Key，OpenBot 会带你去填 Key，而不是悄悄失败。

## 回到官方 Grok

点 **Official Grok**（或顶部的 **Use official Grok**）。聊天回到原厂。服务商和 Key 仍留在 Computer 上，之后还能切回自定义模型，不用重配。

## 使用前请知道

- 不要把 Key 写在命令行上。如果用 CLI 带 `--origin` 和 `--model` 安装，请用环境变量 `OPENBOT_API_KEY`。
- 同一时间只有一个模型在生效。按会话覆盖模型不在当前版本。
- 如果 `9280` 端口已经被别的程序占用，OpenBot 不会抢过去。
- OpenBot 面向 **Computer 上的 Grok Bot 0.30**，不会改 Mac 上的应用。

## 许可

MIT。见 [LICENSE](LICENSE)。OpenBot 是独立项目，与 xAI 无关。
