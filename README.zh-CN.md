# Paralume

[English](./README.md) | **简体中文**

Paralume（并译）是一款面向 Chrome 和 Edge 的开源、本地优先双语网页翻译扩展。
它保留原始网页，并把译文插入对应原文旁边，让两种语言在同一页面并行阅读。

`0.1.0` 新增默认显示的页内悬浮控制、紧凑的边缘停靠形态、准确的页面级进度、
按网站控制显示状态，以及新的 Parallel P 扩展图标。翻译仍然只会在用户明确点击
**“翻译页面”**后开始。

## 主要功能

- 保留原网页的双语并行阅读。
- 普通 HTTP/HTTPS 网页打开后自动显示悬浮控制。
- 小型边缘停靠按钮，点击后展开翻译、重试、显示、清除及网站控制。
- **在此页面隐藏**：隐藏到本次页面重新加载为止。
- **在此网站停用**：按域名持久保存；点击扩展图标仍可在当前页面临时恢复。
- 支持 OpenAI 兼容服务和 Microsoft Translator 的 BYOK（自带密钥）模式。
- Mock 只用于显式选择的开发和测试，真实服务失败时绝不自动回退。
- 渐进式视口优先批处理、有限并发、流式结果、可恢复错误自动重试及逐段手动重试。
- 简体中文和英语界面。
- 只影响 Paralume 自有界面的译文外观设置。

## 从 GitHub Releases 安装

1. 打开 [GitHub Releases](https://github.com/Lazarus-glhf/paralume-translator/releases)，
   选择 `v0.1.0`。
2. 下载 `paralume-translator-0.1.0-chrome.zip` 或
   `paralume-translator-0.1.0-edge.zip`，同时下载
   `paralume-translator-0.1.0-SHA256SUMS.txt`。
3. 使用 `sha256sum`、`shasum -a 256` 或 PowerShell
   `Get-FileHash -Algorithm SHA256` 验证 ZIP 校验值。
4. 将 ZIP 解压到固定的本地目录。
5. 打开 `chrome://extensions` 或 `edge://extensions`，启用“开发者模式”，选择
   “加载未打包的扩展程序”，并选中包含 `manifest.json` 的解压目录。

未打包安装不会自动更新。新版本发布后需要重复以上步骤。

## 使用方式

支持的网页会自动显示悬浮停靠按钮，无需先打开工具栏弹窗。点击停靠按钮展开面板：

- **翻译页面**：翻译符合条件且尚未处理的文本块。
- **批量重试失败项**：重新翻译失败的文本块。
- **显示 / 隐藏**：只改变已有译文的可见性，不调用翻译服务。
- **清除**：移除 Paralume 自有译文，并取消当前页面的活动任务。
- **在此页面隐藏**：本次加载期间移除悬浮窗。
- **在此网站停用**：本地保存当前域名，之后访问该网站时不再自动显示。

点击浏览器工具栏中的扩展图标会打开弹窗，并可在已停用网站上临时恢复页面运行时。
浏览器内部页及其他受保护页面无法运行扩展内容脚本。

## 翻译服务与本地密钥安全

Paralume 使用 BYOK 模式：

- **OpenAI 兼容服务**：支持 Responses（`/responses`）和 Chat Completions
  （`/chat/completions`），使用用户配置的 HTTPS 端点和严格结构化输出。
- **Microsoft Translator**：支持配置 HTTPS 端点、API Key 和 Region，调用
  Translator v3。
- **Mock**：仅在显式选择时产生确定性的开发输出。

API 密钥存储于当前浏览器配置文件的 `chrome.storage.local`。该存储**不是加密
保险库**。建议使用用途受限的密钥，并配置服务商额度或账单限制。“选项”页面只
接收 `apiKeyConfigured` 状态；内容脚本永远不会收到服务密钥。

## 安全模型

- 不重写来源页面的 `innerHTML`。
- 保留原始节点、链接、事件监听器、列表编号、表格结构和框架所有权。
- 服务输出通过惰性的 `textContent` 插入，绝不会作为 HTML 执行。
- 排除代码、表单、可编辑区域、导航/页脚、隐藏内容及扩展自有节点。
- 跨上下文消息经过结构校验，并使用稳定文本段 ID。
- 如果来源已修改、脱离文档或属于旧任务代次，迟到结果会被拒绝。
- “清除”会取消页面活动任务，并阻止迟到结果重新出现。

## 权限说明

Manifest V3 扩展请求：

- `storage`：保存版本化设置、网站停用偏好及本地 BYOK 密钥。
- `activeTab` 和 `scripting`：用户点击工具栏弹窗后，在当前页面执行显式恢复或注入。
- `host_permissions`：`http://*/*` 和 `https://*/*`。这是在普通网页默认显示悬浮窗，
  以及访问用户配置的 HTTPS 翻译服务所必需的权限。

唯一的静态内容脚本会在 HTTP/HTTPS 页面 `document_idle` 时运行。它先检查本地的
网站停用列表，再安装 Shadow DOM 隔离的悬浮控制。浏览器内部页不会注册内容脚本。

## 架构

- WXT 打包 Chrome 和 Edge 的 Manifest V3 扩展。
- React 只用于弹窗和选项页面。
- 提取、资格判断、协议验证、服务、重试策略、本地化、批处理、渲染、清理、设置和
  页面控制均为严格、与框架无关的 TypeScript。
- 后台服务工作线程独占服务设置、密钥、网络请求、整批重试及取消。
- 页面运行时负责提取、安全渲染、进度和 Shadow DOM 悬浮控制。

## 开发

要求：

- Node.js 20.19+ 或 22.12+
- 通过 Corepack 使用 pnpm 11.9+

```sh
corepack enable
pnpm install
pnpm exec playwright install chromium
pnpm dev
```

构建与验证：

```sh
pnpm build
pnpm build:edge
pnpm verify
pnpm release:package
```

`pnpm verify` 执行格式、ESLint、TypeScript、Vitest、Chrome/Edge 构建及 Playwright
扩展测试。`pnpm release:package` 验证两个浏览器的清单和归档，并在
`release-assets/` 中生成 ZIP 与 SHA-256 校验文件。

## 仓库结构

```text
entrypoints/             后台、自动内容脚本、弹窗和选项入口
src/content/             提取、渲染、控制器和悬浮界面
src/messaging/           经过验证的跨上下文协议及路由
src/settings/            版本化存储和设置校验
src/translation/         Mock、OpenAI 兼容、Microsoft、批处理和重试
tests/                   Vitest 单元及集成测试
e2e/                     Playwright 扩展测试
design/                  非生产设计探索
public/icon/              正式扩展图标
```

## 当前限制

- 源语言自动检测，目标语言固定为简体中文。
- API 密钥是本地 BYOK 值，不是加密保险库条目。
- 动态新增的 DOM 会在下一次“翻译页面”操作中处理，不会持续观察。
- 浏览器受保护页面、PDF、视频/字幕、OCR、账户、云同步、支付和 Firefox 不在范围内。
- 未自动发布到扩展商店；GitHub Releases 提供未打包 ZIP。

参与开发前请阅读 [CONTRIBUTING.md](./CONTRIBUTING.md)。

## 许可证

Paralume 根据 [MIT 许可证](./LICENSE)开源。
