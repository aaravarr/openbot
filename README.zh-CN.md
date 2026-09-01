# OpenBot

[English](README.md) · [中文](README.zh-CN.md)

**在 Grok Bot 里用你自己的模型。**

Grok Bot 0.30 已经有一台 Computer。OpenBot 让这台 Computer 去调用你已经在付费的模型 —— OpenAI、GLM、DeepSeek、Kimi、Groq、OpenRouter，或任何 OpenAI 兼容接口 —— 不用离开 Grok Bot。想用回官方 Grok 时，一键即可。

```bash
curl -fsSL https://raw.githubusercontent.com/aaravarr/openbot/main/install.sh | bash
```

然后用 **Computer 的浏览器** 打开 [http://127.0.0.1:9280](http://127.0.0.1:9280)。安装脚本会用普通句子打印这个地址。脚本需要快照时再加 `--json`。

## 你能得到什么

- **还是 Grok Bot，只是脑子换成你选的。** 同一个聊天窗口，同一套工具，由你的模型来回答。
- **随时回到官方 Grok。** 切回去就是原厂聊天。已保存的服务商还在，再切回来不用重新粘贴 Key。
- **Key 留在 Computer 上。** 不会进聊天，不会出现在命令行，也不会离开这台盒子。
- **本机一页控制，不是再装一个 App。** 装一次，打开 `127.0.0.1` 上的页面，选服务商、选模型，回到 Grok Bot 继续聊。
- **可选的手机入口。** Cloudflare Tunnel 会打印公网 URL 和二维码。拿到这个 URL 的人都能打开控制页。Key 仍留在 Computer 上。Hop 和控制页共用同一端口。

## 安装

在 **Computer 终端**里运行，不要在 Mac 上运行。Grok Bot 的聊天走 Computer；笔记本上的代理收不到回合。

需要 Node 22 或更新。如果盒子里只有 Node 20，安装脚本会把 Node 22 放到 `sand-data`，不替换系统 Node。

```bash
curl -fsSL https://raw.githubusercontent.com/aaravarr/openbot/main/install.sh | bash
```

看到 `OpenBot is ready` 和 `This Computer` 后，用 Computer 浏览器打开 `http://127.0.0.1:9280`。

安装时会在 Computer 键盘上等待 `Use Cloudflare Tunnel? [y/N]`（`curl | bash` 也会等）。输入 `y` 再回车会打印手机 URL 和二维码；只按回车则只在本机。可用 `--tunnel off`、`--tunnel cloudflare` 或 `OPENBOT_TUNNEL=off` 跳过提问。

在你接入服务商之前，聊天仍是官方 Grok。这是故意的。

```bash
openbot tunnel on      # 公网 URL + 二维码
openbot tunnel off     # 只在这台 Computer
openbot tunnel status
```

## 接入一个模型

1. 打开控制页。
2. 选一个服务商；或选 **Custom**，粘贴任何 OpenAI 兼容的 Base URL。
3. 粘贴 API Key 和模型 ID。
4. 点 **Start chatting**。
5. 回到 Grok Bot，发一条**新消息**。

下一回合就会走你刚接上的模型。上下文、最大输出、推理等级和输入类型先用默认值；之后在对应服务商里打开该模型再改。

## 思考强度

在 **Chat** 上，**Thinking** 模块在 Now 和模型列表之间。它显示**当前启用**的自定义模型允许列表。官方 Grok 没有这个模块。还缺 Key 的模型也没有。Grok Bot 会在下一条消息带上你选的值。

模型弹窗只配置 Chat 可以选择的等级，不选正在用的强度。

- **Default** —— 不带 thinking 字段，用上游自己的默认。
- **Off** —— 明确关闭（GLM 和通用 OpenAI 发送 `thinking: { type: "disabled" }`；Grok 没有标准关闭字段）。
- **Low / Medium / High / …** —— 发送对应强度。

旧目录里的 `none` 表示「交给模型」。OpenBot 会把它迁成 **Default**。模型上已经有 Default 之后，**Off** 才是真正的关闭。

## 控制页怎么分层

三层屏幕。限额在弹窗里改，不会再开第三页把表单平铺下去。

- **Chat** —— 这台 Computer 上 Grok Bot 用哪个模型。官方 Grok，或一个自定义模型。**Thinking** 是独立模块，只针对当前 On 的模型。下面一行列表用来切换 `slug · 服务商`。不是按会话配置——同一时间只有一个模型。这里不填 Key，也不改限额。
- **Provider** —— 账号。页眉始终有 **Edit**（无障碍名称 **Edit endpoint**）、**Key**，以及 Key saved 标记。**Edit** 弹出名称和 Base URL。**Key** 弹出 API Key。**Add model** 弹出 **New model**（模型 ID 加限额）。点模型行会弹出限额编辑。**Use** 把它放到 Chat。思考强度在 Chat 上选，不在这里选。
- **Logs** —— 这台 Computer 上的 hop 请求记录。默认关闭，不记录。

如果某个模型还没有 Key，Chat 会带你去对应的服务商页，而不是悄悄失败。没有 Key 也可以先打开模型弹窗改限额。

图片、视频、音频会记在模型配置里，供以后使用。当前聊天仍只发送文本。

## 请求日志

**Logs** 用来排查卡住、又看不到 hop 记录的 Grok Bot 回合（例如 DeepSeek 报 `missing field tool_call_id`）。打开 **Record requests** 后才会记下 hop 请求和错误。API Key 不会写入日志。除非你选择在出错时保留正文，或保留全部正文，否则只存元数据。

在 Computer 上重新安装或 reload OpenBot 后，才会用到新的 hop-handler。

## 回到官方 Grok

在 **Chat** 里点列表中的 **Official Grok**。聊天回到原厂。服务商和 Key 仍留在 Computer 上，之后还能切回自定义模型，不用重配。正在跑的 Tunnel 会一直保留，直到你关掉它。

## 使用前请知道

- 不要把 Key 写在命令行上。如果用 CLI 带 `--origin` 和 `--model` 安装，请用环境变量 `OPENBOT_API_KEY`。
- 同一时间只有一个模型在生效。按会话覆盖模型不在当前版本。
- 如果 `9280` 端口已经被别的程序占用，OpenBot 不会抢过去。
- OpenBot 面向 **Computer 上的 Grok Bot 0.30**，不会改 Mac 上的应用。
- 这一版不含 Tailscale。

## 许可

MIT。见 [LICENSE](LICENSE)。OpenBot 是独立项目，与 xAI 无关。
