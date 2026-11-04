<p align="center">
  <a href="README.md">English</a> | 中文
</p>

<p align="center">
  <img src="ccursor.png" width="120" alt="Cursor++" />
</p>

<h1 align="center">Cursor++</h1>

<p align="center">
  <strong>Bring Your Own Key for Cursor IDE</strong><br/>
  使用自己的 API Key 驱动 Cursor 的 Agent / Chat / Composer
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@cometix/ccursor"><img src="https://img.shields.io/npm/v/@cometix/ccursor" alt="npm" /></a>
  <a href="https://linux.do/t/topic/1926833"><img src="https://img.shields.io/badge/LinuxDO-Discussion-blue" alt="LinuxDO" /></a>
</p>

---

## What is Cursor++? / Cursor++ 是什么?

Cursor++ lets you use **your own LLM API keys** (Anthropic, OpenAI, Google Gemini, or any OpenAI-compatible provider) with [Cursor IDE](https://cursor.com), bypassing the official subscription. It runs a local BYOK server inside Cursor's extension host, intercepts ConnectRPC/REST traffic, and routes LLM requests to your configured providers.

Cursor++ 让你使用**自己的 LLM API Key**（Anthropic / OpenAI / Google Gemini 或任何兼容服务商）驱动 [Cursor IDE](https://cursor.com)，无需官方订阅。它在 Cursor 扩展宿主内运行本地 BYOK 服务器，拦截 ConnectRPC/REST 通信并路由到你配置的服务商。

---

## Quick Start / 快速开始

```bash
# Install / 安装
npx @cometix/ccursor install

# Restart Cursor, then open the Cursor++ sidebar panel to configure providers
# 重启 Cursor，打开侧边栏 Cursor++ 面板配置服务商

# Uninstall / 卸载
npx @cometix/ccursor uninstall

# Check installation status / 检查安装状态
npx @cometix/ccursor status
```

---

## Features / 功能特性

- **BYOK Mode Toggle** — Sidebar one-click switch between BYOK and official Cursor  
  **BYOK 模式开关** — 侧边栏一键切换 BYOK 和官方 Cursor

- **Multi-Provider** — Anthropic, OpenAI (Chat + Responses API), Google Gemini, or any compatible endpoint  
  **多服务商** — Anthropic、OpenAI（Chat + Responses API）、Google Gemini 或任何兼容端点

- **Full Agent Mode** — Tool calling, multi-turn conversations, auto-summarization, checkpoint persistence  
  **完整 Agent** — 工具调用、多轮对话、自动摘要、检查点持久化

- **Model Config UI** — Visual provider/model management with thinking level, context limits, variant display  
  **模型配置 UI** — 可视化服务商/模型管理，支持思考档位、上下文限制、变体显示

- **Error Banner** — LLM errors surface as Cursor's native retry banner with retryable/non-retryable classification  
  **错误横幅** — LLM 错误通过原生重试横幅展示，自动区分可重试/不可重试

- **Per-Window Logging** — Each window gets its own log stream, colored output in LogOutputChannel  
  **逐窗口日志** — 每个窗口独立日志流，LogOutputChannel 彩色输出

- **Hot-Reload** — Config changes take effect without restarting Cursor  
  **热重载** — 配置修改无需重启 Cursor 即可生效

- **Vision Model Routing** — Image-bearing rounds automatically use a configured multimodal model when the main model cannot read images<br/>
  **看图模型路由** — 主模型不支持图片时，含图片的轮次自动使用指定多模态模型，纯文字轮次自动切回主模型

- **22 Agent Tools** — Shell, Read, Grep, Glob, Edit, Write, Task, MCP, etc.<br/>
  **22 个 Agent 工具** — Shell、Read、Grep、Glob、Edit、Write、Task、MCP 等

- **Hub Integration** — Device authorization via LinuxDO Connect  
  **Hub 集成** — 通过 LinuxDO Connect 设备授权

---

## How It Works / 工作原理

```
Cursor IDE
  │
  ├─ inject-patch (renderer)
  │   └─ intercept ConnectRPC + REST → route to BYOK server
  │
  ├─ always-local-patch (extension host)
  │   └─ rewrite http/https.request + hot-reload from routes.json
  │
  └─ Cursor++ Extension (BYOK Server @ 127.0.0.1:39831)
      ├─ Fastify + ConnectRPC (27 services)
      ├─ LLM: Anthropic / OpenAI / Gemini SDK
      ├─ Agent: multi-round tool-calling orchestrator
      └─ Config: ~/.ccursor/providers.json + routes.json
```

All patches create backup files and are fully reversible via `uninstall`.  
所有补丁创建备份文件，可通过 `uninstall` 完全还原。

---

## Configuration / 配置

Config files in `~/.ccursor/`:

| File | Purpose / 用途 |
|---|---|
| `providers.json` | LLM providers, API keys, models, vision routing / 服务商、密钥、模型定义、看图模型路由 |
| `routes.json` | BYOK toggle + redirect whitelist / BYOK 开关 + 重定向白名单 |
| `cursor.db` | Conversation persistence / 对话持久化 |

### Provider Example / 配置示例

```json
{
  "visionModelId": "my-vision-model",
  "providers": [
    {
      "id": "my-anthropic",
      "name": "Anthropic",
      "type": "anthropic",
      "baseUrl": "https://api.anthropic.com",
      "auth": { "kind": "apiKey", "value": "sk-ant-..." },
      "models": [
        {
          "id": "claude-sonnet-4",
          "apiModel": "claude-sonnet-4-20250514",
          "displayName": "Claude Sonnet 4",
          "thinking": true,
          "thinkingLevel": "medium",
          "contextTokenLimit": 200000,
          "defaultOn": true
        }
      ]
    }
  ]
}
```

### Vision Model Routing / 看图模型路由

1. 将不支持图片的主模型配置为 `"supportsImages": false`。
2. 将备用看图模型配置为 `"supportsImages": true` 和 `"supportsAgent": true`。
3. 在 Cursor++ 侧边栏的 **Vision Routing** 中选择该模型，或者在 `providers.json` 顶层填写 `visionModelId`。

当用户加入图片、Agent 读取图片文件，或 MCP/浏览器截图工具返回图片时，只有包含新图片的 Agent 轮次会临时使用看图模型。下一轮没有新图片时自动切回主模型。切回不支持图片的模型前，历史图片二进制数据会替换成文字占位，但看图模型已经生成的文字分析会继续保留在对话里。

如果主模型不支持图片，并且没有配置有效的看图模型，Cursor++ 会显示不可重试的配置错误，不会静默忽略图片。

---

## Platform / 平台支持

| Platform | Status |
|---|---|
| macOS (ARM / Intel) | ✅ |
| Linux | ✅ |
| Windows | ✅ |

Requires **Cursor IDE** + **Node.js >= 18**.

---

## Troubleshooting / 故障排除

| Issue / 问题 | Solution / 解决 |
|---|---|
| Cannot sign in after install / 安装后无法登录 | Toggle BYOK OFF in sidebar, then sign in / 侧边栏切 OFF 后登录 |
| Model not found / 模型未找到 | Add model in sidebar panel / 在面板中添加模型 |
| LLM 401/403/404 | Check API key & base URL in providers.json / 检查密钥和地址 |

---

## Issues & Feedback / 问题与反馈

This repository is for **issue tracking and documentation only** — source code is not published.

本仓库仅用于**问题追踪和文档发布** — 源代码不公开。

- [Submit an Issue](https://github.com/CometixSpace/CCursor/issues)
- [LinuxDO Discussion](https://linux.do/t/topic/1926833)

---

<p align="center">
  <a href="https://linux.do/t/topic/1926833">LinuxDO</a> · <a href="https://ccursor.cometix.dev">Hub</a> · <a href="https://www.npmjs.com/package/@cometix/ccursor">npm</a>
</p>
