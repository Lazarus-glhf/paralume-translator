# Paralume

[English](./README.md) | **简体中文**

Paralume（并译）是一款面向 Chrome 和 Edge 的本地优先双语网页翻译扩展。
它提取页面中的可读文本块，在后台服务工作线程中执行经过验证的翻译请求与
批处理，并把译文放在对应原文旁边。它不会重写网页的 `innerHTML`，不会替换
原始链接、事件监听器或框架拥有的节点，服务返回内容始终作为纯文本插入。

当前版本目标为 Alpha `0.0.2`，面向测试者反馈。此版本支持显式选择 Mock、
OpenAI 兼容服务或 Microsoft Translator，并新增可恢复错误自动重试、逐段手动
重试、仅作用于 Paralume 界面的外观设置，以及简体中文/英语界面。Paralume
绝不会在真实服务失败后自动回退到 Mock。

## 从 GitHub Releases 安装测试版

1. 打开仓库的
   [GitHub Releases](https://github.com/Lazarus-glhf/paralume-translator/releases)
   页面，选择需要测试的预发布版本。
2. 下载对应浏览器的 ZIP，例如
   `paralume-translator-0.0.2-chrome.zip` 或
   `paralume-translator-0.0.2-edge.zip`，同时下载配套的
   `SHA256SUMS.txt`。
3. 根据校验文件验证 ZIP 的 SHA-256。Linux 可使用 `sha256sum <zip>`，macOS
   可使用 `shasum -a 256 <zip>`，PowerShell 可使用
   `Get-FileHash <zip> -Algorithm SHA256`。
4. 将 ZIP 解压到一个固定的本地目录。浏览器需要选择包含 `manifest.json` 的
   解压目录，而不是 ZIP 文件本身；扩展安装期间不要删除该目录。
5. Chrome 打开 `chrome://extensions`，启用“开发者模式”，点击
   **“加载未打包的扩展程序”**，选择解压目录。Edge 打开
   `edge://extensions`，启用开发人员模式，并加载解压后的扩展目录。

未打包测试版不会自动更新。安装新预发布版本时，请重新下载、校验、解压并
加载新目录。

## 密钥与本地存储安全

Paralume 使用 BYOK（自带密钥）模式。真实服务的 API 密钥保存在当前浏览器
配置文件的 `chrome.storage.local` 中。该存储是本地的，但**不是加密保险库**；
能够访问浏览器配置文件的软件或人员可能恢复其中内容。建议使用用途受限的
密钥，配置服务商的额度与账单限制，并在不再使用时从“选项”中清除密钥。

密钥只能由后台设置/服务代码读取：

- “选项”页面只接收 `apiKeyConfigured` 布尔值，密钥输入框始终为空并使用
  密码类型显示；留空保存会保留原密钥。
- 内容脚本只接收外观、界面语言和非敏感重试设置，不接收服务端点、服务商
  配置或密钥。
- 运行时消息、错误响应和日志不得包含密钥、上游响应正文或完整敏感页面文本。

Mock 服务不需要密钥，也不会联系外部翻译服务。

## 使用方式

打开扩展弹窗后，可以显式执行以下操作：

- **翻译页面**：按需注入页面运行时，提取尚未处理的可读文本块并翻译。
- **显示 / 隐藏**：只改变现有译文的可见性，不调用翻译服务。
- **清除**：同步移除 Paralume 拥有的译文、失败提示、重试控件和来源标记，
  恢复原始页面结构，并且不等待设置 IPC 就向正在进行的页面翻译发送取消消息。

重复注入、翻译、显示/隐藏和清除操作都是幂等的。并发“翻译页面”操作共享
同一项进行中的页面任务。每次页面翻译或手动重试都使用经过验证的不透明 UUID。
后台使用“发送方作用域 + 操作 UUID”的组合键管理活动任务和有界的提前取消
状态，因此另一个标签页或文档即使使用相同 UUID，也不能与当前发送方发生冲突、
取消或消耗其任务，也不能通过容量压力逐出其取消状态。“显示 / 隐藏”不等待
设置加载，也不会调用翻译服务。

## 自动重试与逐段手动重试

默认启用自动重试，最多进行 **2 次额外的整批尝试**。只有以下可恢复错误会
自动重试：

- `RATE_LIMITED`
- `REQUEST_TIMEOUT`
- `NETWORK_ERROR`
- `SERVER_UNAVAILABLE`

重试使用带抖动的有界指数退避。若服务返回合法的 `Retry-After`，Paralume 会
在安全上限内采用该提示。自动重试始终重复相同的整个批次，保持文本段 ID 和
顺序；不会自动拆分为逐段请求，也不会切换到 Mock。

身份验证、权限、配置、验证、请求上限、文本段过大、格式错误 JSON、格式错误
结构化输出、缺失/重复结果和内部契约错误不会自动重试。自动重试可能增加服务
用量或费用，请结合服务商额度与账单限制使用。

只有服务结果数组中真实返回的逐段失败，才会获得位于右下角、可通过辅助技术
识别的“重试”按钮。身份验证、权限、配置、验证、格式错误输出、无效消息和
内部错误等整项请求失败，只通过安全的弹窗/状态错误边界报告一次，不会生成逐段
重试请求。手动重试只提交该文本段；重复点击会去重，进行中显示“正在重试…”，
成功后在原失败节点中就地替换为译文。

“清除”会同步移除 Paralume 界面、推进内容端任务代次，并在不等待取消 IPC 的
情况下请求取消。后台监听器会在进行中的处理 Promise 完成前保持一次性消息响应
通道开启；监听器返回字面量 `true`，运行中的消息事件会在处理 Promise 完成前维持
工作线程活动，但仍受 Chromium 常规生命周期上限约束。只要工作线程仍处于活动
上下文，取消会中止重试等待、服务请求和响应正文读取。如果 Chromium 强制终止
工作线程进程或执行上下文，其中的请求、计时器、重试和 `AbortController` 也随
上下文一起终止；重启后的处理器只有新的内存状态，无法、也无需中止已经不存在的
旧上下文控制器。若取消先到达新处理器、随后才到达乱序的翻译请求，后台会按发送方
有界保留该取消。内容端代次检查会拒绝任何迟到响应，因此不能覆盖已清除或更新后的
界面。

Chromium 仍会执行扩展工作线程的常规生命周期上限。若上游在取消或工作线程终止
前已经接受请求，该请求仍可能完成或产生费用。取消只能减少可避免的工作，不能
保证绝对避免计费；仍应配置服务商额度与账单限制。

## 外观设置

外观设置只影响 Paralume 拥有的译文、失败提示、进行中状态和重试控件，绝不
修改原网页样式。可配置项包括：

- 字体：受限枚举（系统默认、无衬线、衬线、等宽）；
- 字号；
- 文字颜色；
- 背景颜色；
- 行高；
- 不透明度；
- 垂直间距。

所有值都会验证和规范化。数值被限制在已审查范围内，颜色只接受安全的十六
进制格式；任意 CSS 声明、URL、脚本或可执行值都会被拒绝。“重置外观”恢复
安全默认值。新设置用于后续渲染，并在页面运行时下一次刷新设置时应用到现有
Paralume 节点。

## 界面语言

可选语言为：

- `system`：默认，安全解析浏览器界面语言；无法匹配时回退英语；
- `zh-CN`：简体中文；
- `en`：英语。

弹窗、选项、页面失败/重试/等待界面、状态、验证错误和固定错误信息都会在
显示边界本地化。跨上下文协议使用稳定的消息标识符和错误代码，不把英语字符串
当作业务逻辑键。

## 翻译服务

### Mock

Mock 提供确定性的开发输出，必须由用户显式选择。它不会自动成为回退服务。
普通输出带有 `【Mock zh-CN】` 前缀，避免被误认为真实翻译。

### OpenAI 兼容服务

需要 HTTPS 基础 URL、模型、API 密钥、推理强度和协议选择：

- Responses：`/responses`
- Chat Completions：`/chat/completions`

端点必须支持严格 `json_schema` 输出及所选协议的推理字段。Paralume 要求每个
输入 ID 恰好返回一次，缺失、重复、未知或附加结构字段会明确失败，不会静默
退化为逐段调用。

### Microsoft Translator

需要 HTTPS 端点、API 密钥和区域。默认端点为
`https://api.cognitive.microsofttranslator.com`，调用 Translator v3：
`/translate?api-version=3.0&to=zh-Hans`。

连接测试会发送短文本 `Paralume connection test.`，可能消耗服务额度。

## 设置迁移

Alpha `0.0.2` 将存储模式从 v1 升级到 v2。首次读取旧设置时会原地迁移：

- 保留当前服务选择；
- 保留 OpenAI 兼容与 Microsoft 的端点、模型、协议、推理强度和区域；
- 保留两个 API 密钥；
- 添加默认自动重试设置（启用，2 次额外尝试）；
- 添加安全外观默认值；
- 添加默认界面语言 `system`。

公开设置响应不会包含 API 密钥，只包含是否已配置密钥的布尔值。

## 页面内容筛选与安全渲染

候选整块元素为：

```text
p, li, blockquote, h1-h6, td, th, figcaption
```

Paralume 会排除代码与预格式化区域、脚本和样式、表单与按钮、导航与页脚、
SVG/canvas、可编辑区域、隐藏内容、扩展拥有的节点以及已处理文本块。`li`、
`td` 和 `th` 作为结构容器优先于内部候选项，避免破坏列表编号和表格结构。

普通文本块的译文作为紧邻的 `div` 插入；`li`、`td` 和 `th` 的译文追加到原
容器内部。服务输出使用 `textContent`，不会作为 HTML 执行。运行时私有注册表
才是节点所有权依据；网页伪造的 `data-paralume-*` 属性不会被信任或擅自删除。

## 架构与权限

- WXT + Manifest V3 + 严格 TypeScript。
- React 只用于弹窗和选项页面。
- 提取、资格判断、消息验证、批处理、重试策略、本地化、外观验证/应用、渲染、
  清理和页面控制器均为与框架无关的 TypeScript。
- 后台服务工作线程独占服务选择、密钥读取、网络访问和整批自动重试。
- 内容脚本按需注入，使用稳定文本段 ID，并按 ID 映射结果。

安装时权限只有：

- `activeTab`：用户显式点击扩展后，临时访问当前标签页；
- `scripting`：按需注入 `paralume.js`；
- `storage`：保存版本化设置和本地 BYOK 密钥。

没有已授予的 `host_permissions`，也没有静态 `content_scripts`。清单只声明未
授予的 `optional_host_permissions: ["https://*/*"]`，因为 Chrome 需要预先覆盖
可能配置的 HTTPS 来源。保存真实服务时，运行时只请求精确来源，例如
`https://api.example.com/*`；更换端点后会尝试移除旧来源权限。后台每次调用前
都会重新检查权限。

## 开发环境

要求：

- Node.js 20.19+，或 Node.js 22.12+
- pnpm 11.9+（由 `packageManager` 固定）

```sh
corepack enable
pnpm install
pnpm exec playwright install chromium
```

开发与构建：

```sh
pnpm dev
pnpm dev:edge
pnpm build
pnpm build:edge
```

WXT 输出位于 `.output/chrome-mv3` 和 `.output/edge-mv3`。

## 测试与验证

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm build:edge
pnpm test:e2e
```

`pnpm verify` 执行完整格式、lint、类型检查、单元/集成测试、Chrome/Edge 构建和
Playwright 测试。测试不使用真实服务密钥：

- Vitest 使用可注入时钟和随机数验证 0/1/2 次重试、退避、`Retry-After`、全部
  错误分类、按发送方限定的任务 ID、有界取消隔离、处理器重启模拟、迟到响应代次
  拒绝、重试等待/请求/正文读取取消、设置竞态、迁移、密钥边界、外观、本地化和
  取消安全性；
- 本地回环服务器验证 OpenAI Responses、Chat Completions 和 Microsoft v3；
- Playwright 通过真实扩展弹窗验证 `activeTab` + `scripting` 路径；
- Playwright 通过“选项”配置中文、重试和外观，停止并重启服务工作线程，验证
  设置持久化、两次自动重试、逐段手动重试、就地替换及完整 DOM 清理；
- 发布打包检查 Chrome/Edge 清单、ZIP 路径和 SHA-256 校验文件。

构建后应确认清单权限严格等于 `activeTab`、`scripting`、`storage`，可选来源
严格等于 `https://*/*`，且不存在 `host_permissions` 或 `content_scripts`。

## 版本与预发布打包

`package.json` 是唯一版本来源。当前目标为数字版本 `0.0.2`，尚未在本实现中
创建标签或发布。WXT 从该值生成 Chrome/Edge 清单版本。

本地模拟打包：

```sh
pnpm verify
pnpm release:metadata
pnpm release:package
```

`pnpm release:package` 构建两个浏览器 ZIP，验证清单和归档内容，并在
`release-assets/` 中生成稳定文件名及 SHA-256 校验文件。商店发布不在当前范围。

## 当前限制

- 源语言固定为自动检测，目标语言固定为简体中文。
- 自定义服务端点仅允许 HTTPS。
- API 密钥是本地 BYOK 值，不是加密保险库条目。
- 只在用户请求翻译时提取内容，不自动观察动态 DOM。
- 受浏览器保护的页面不可翻译；本地 `file:` 页面还取决于浏览器的文件访问开关。
- PDF、视频/字幕、OCR、账户、云同步、支付和 Firefox 不在当前范围。

参与开发前请阅读 [CONTRIBUTING.md](./CONTRIBUTING.md) 和
[AGENTS.md](./AGENTS.md)。

## 许可证

项目尚未选择开源许可证，详见 [LICENSE.md](./LICENSE.md)。
