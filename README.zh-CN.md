# OpenBot

[English](README.md) · [中文](README.zh-CN.md)

**在 Grok Bot 里用你自己的模型。**

Grok Bot 0.30 已经有一台 Computer。OpenBot 让这台 Computer 调用 OpenAI、OpenRouter、OpenCode Zen（注册一次、贴入 key 即可用 $0 模型），或通过 Custom 接入任何 OpenAI 兼容接口 —— 不用离开 Grok Bot。想用回官方 Grok 时，一键即可。

## 安装

请在 **Grok Bot 的 Computer** 上运行，不要在 Mac 上运行：

```bash
curl -fsSL https://raw.githubusercontent.com/aaravarr/openbot/main/install.sh | bash
```

OpenBot 需要 Node 22 或更新。如果 Computer 里只有 Node 20，安装脚本会把 Node 22 放进 `sand-data`，不替换系统 Node。第一次安装时，Cloudflare 提示出现后输入 `y` 会启用手机 URL 和二维码；直接回车则只保留本机访问。然后用 Computer 浏览器打开 [http://127.0.0.1:9280](http://127.0.0.1:9280)。

再次运行同一条命令即可更新。当前的官方/自定义模式和已保存的 Tunnel 选择都会保留。

<details>
<summary>Grok Bot：自动安装</summary>

在 Computer 上的 Bot 回合中运行：

```bash
curl -fsSL https://raw.githubusercontent.com/aaravarr/openbot/main/install.sh | bash -s -- --bot-mode
```

按每次命令输出的 `OPENBOT_BOT_INSTRUCTION` 操作；它是权威指引。概要就是：启动命令，再按输出的 `--bot-status` 指令继续。安装通常需要 15–60 秒；最多轮询 2 次；超过 3 分钟仍卡住时，把日志尾部发给用户并停止。

</details>

## 卸载

在 Grok Bot 的 Computer 上运行：

```bash
curl -fsSL https://raw.githubusercontent.com/aaravarr/openbot/main/uninstall.sh | bash
```

交互式卸载默认保留 provider secrets。加上 `--purge-secrets` 才会删除。Bot 模式也可以使用 `bash -s -- --bot-mode`。

## 接入一个模型

1. 打开控制页。
2. 选一个服务商；或选 **Custom**，粘贴任何 OpenAI 兼容的 Base URL。
3. 粘贴 API Key 并激活。向导只保存服务商和 Key。
4. 在 **Models** 页拉取或添加模型，再启用。
5. 回到 Grok Bot，发一条**新消息**。

下一回合就会走你刚接上的模型。上下文、最大输出、推理等级和输入类型先用默认值；之后在对应服务商里打开该模型再改。

## Tunnel

Cloudflare Tunnel 是可选项。它会通过临时公网 URL 暴露控制页；拿到 URL 的人都能打开它，但 Key 仍留在 Computer 上。

```bash
openbot tunnel on      # 开启或刷新公网 URL + 二维码
openbot tunnel off     # 只允许这台 Computer 访问
openbot tunnel status
```

trycloudflare URL 会过期。`openbot tunnel on`、Dashboard 上的 **Refresh URL**，以及更新操作，都可以替换已经失效的链接。用 `openbot tunnel off` 或 Dashboard 可以关闭 Tunnel。

## 思考强度

在 **Chat** 上，**Thinking** 显示当前自定义模型的允许列表。官方 Grok 和还缺 Key 的模型没有 Thinking 模块。你选的值会在下一条消息发送。

模型弹窗只配置 Chat 可以提供哪些等级；当前使用的强度在 Chat 上选择：

- **Default** —— 不带 thinking 字段，使用上游默认值。
- **Off** —— 在上游支持时明确关闭 thinking。
- **Low / Medium / High / …** —— 发送对应强度。

旧目录里的 `none` 表示“交给模型”；OpenBot 会把它迁成 **Default**。模型上有 Default 后，**Off** 才是真正的关闭。

## 控制页怎么分层

控制页主要分为四个区域：

- **Chat** —— 选择官方 Grok 或唯一的全局自定义模型，并选择 Thinking 强度。
- **Provider / Models** —— 管理接口、Key、模型 ID、限额和启用状态。图片、视频、音频能力会记录在模型配置里，当前聊天仍只发送文本。
- **Bots** —— 查看这台 Computer 上的 bot，逐个暂停/恢复，并为每个 bot 指定模型。没有单独覆盖时使用全局模型，也可以批量应用选择。
- **Logs** —— 查看这台 Computer 的请求记录，默认关闭记录。

在 **Dashboard** 上，**Install from the OpenBot repo** 会把 OpenBot 配置技能复制到 Grok Bot 的用户技能目录 `/home/box/agent-data/workflows`，不会写入插件目录。

## 请求日志

打开 **Record requests** 后才会捕获记录。API Key 永远不会写入日志。正文默认不保存，除非你选择在出错时保留正文或保留全部正文。

自定义聊天会记录 **Hop**（`POST /v1/chat/completions`）和 **Host** 行。官方 Grok 会记录 **Official** host 行；聊天仍走原厂 Grok，不会经过 hop。Official 开启记录时会安装 tap，host 可能重启一次。

## 回到官方 Grok

在 **Chat** 里点击 **Official Grok**。聊天会回到原厂；服务商、模型和 Key 仍留在 Computer 上，之后可以再切回来。正在运行的 Tunnel 会一直保留，直到你关闭它。更新 OpenBot 不会替你切换模式。

## 使用前请知道

- 不要把 Key 写在命令行上。如果用 CLI 带 `--origin` 和 `--model` 安装，请使用环境变量 `OPENBOT_API_KEY`。
- 如果 `9280` 端口已经被其他程序占用，OpenBot 不会抢过去。
- OpenBot 面向 **Computer 上的 Grok Bot 0.30**，不会修改 Mac 上的应用。
- 这一版不包含 Tailscale。

## 许可

MIT。见 [LICENSE](LICENSE)。OpenBot 是独立项目，与 xAI 无关。
