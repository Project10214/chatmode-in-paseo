# COSINPASEO-7 · Paseo 图片与文档发送到 ChatGPT（2026-10-16）

## 结论和版本
已实现 **候选源码**：Paseo `0.1.0-alpha.4.7` + Chrome 扩展 `0.2.12`，CIP v5 及网页引擎 `cos-native-alpha4.3` 不变。**尚未加载用户生产 Chrome/Paseo；已登录 ChatGPT 真实文件上传/发送尚未验收。**

## 需求、原因和流程
此前 `server/provider.mjs` 仅支持文字：协商中没有 `prompt.image`，`promptText` 对图片/已上传文件一律返回 `ATTACHMENT_UNSUPPORTED`。经本机安装的 Paseo SDK 0.11.2 确认，原生消息内容包括：
- `{type:"text",text}`
- `{type:"image",data,mimeType}`，`data` 为 base64
- `{type:"uploaded_file",id,fileName,mimeType,size,path}`，`path` 指本机已上传文件

新的完整通道：**Paseo 原生附件 → Provider 校验 → Runtime 私有临时文件（仅保留哈希和文件名的任务描述）→ 已授权/已认领的受管 Chrome 扩展请求文件分块 → 校验完整 SHA-256 → 构造浏览器 File 并设置 ChatGPT 原生文件输入框 → 核实页面附件展示和上传结束 → 原有一次性发送授权、点击、原生消息回执。**

支持：PNG、JPEG、WebP、GIF、PDF、DOC/DOCX、XLS/XLSX、PPT/PPTX、TXT、Markdown、CSV、JSON、RTF。支持文字+附件、仅图片/文件、多文件。每轮最多 **4 个**、单个最多 **12 MiB**、总计 **24 MiB**；上传方式、文件类型与限制取决于 ChatGPT 当前网页和账号，遇不支持的情况明确失败，不伪造已发送。

## 安全和现有任务保护
- 不读取 Paseo 工作区任意文件：仅使用用户消息中明确提供的 uploaded_file 路径；拒绝符号链接、错误 MIME/文件头、超限、路径穿越。
- 源文件**不写进**消息记录和队列 JSON；仅本机权限 0600 暂存。文件块请求绑定准确的命令 ID、lease、documentKey、受管 tab 和 Conversation，逐块校验哈希。暂存文件在消息结算时删除，服务启动及运行中每小时清理超过 24 小时的异常残留；对结果不明的原生 Send **不重复发送**。
- 旧版 Chrome 扩展不支持文件读写：Runtime 不向其返回带附件任务，且不允许其 Claim；绝不退化成“只发送文字”。
- 页面附件不存在、上传未完成、被用户改变、文件不匹配、网页跳转或旧对话被占用：不执行新的原生点击。原有账户/工具授权、浏览器绑定和一次性消息门禁不变。
- 不主动重启 Paseo、不重新加载日常 Chrome、不刷新当前 Agent 标签。

## 代码清单
- `server/provider.mjs`、`server/broker.mjs`、`server/runtime.mjs`、新增 `server/input-files.mjs`
- `extension/background.js`、`extension/content.js`、`extension/dom-adapter.js`、新增 `extension/file-upload.js`、适配 `extension/upstream/cos-native.js`
- `extension/manifest.json`、`package.json`、`vendor/cos/provenance.json`
- `tests/outbound-files.test.mjs`、`tests/outbound-upload-browser.py`、现有 Provider/协议/更新恢复回归

## 已执行验证
- 新增 FILE1–FILE9：9/9 PASS（文件内容、类型、SHA、路径与 lease、HTTP 门禁、仅附件消息、同名文件拒绝）。
- 全量 Node 回归：337/337 PASS（2026-10-16 最终复测）。
- 安装的原生 Paseo SDK TypeScript 检查：23 文件，0 diagnostics。
- CoS 12 模块哈希/来源校验：PASS；491 个 JS 静态检查 PASS。
- **独立真实 Chrome 原生 input 文件对象测试：4/4 PASS**（PNG+PDF 的 File/DataTransfer、确切字节、上传展示）。这是本地隔离网页，不是 ChatGPT 已登录页面。

## 真正完成前的验收（空闲维护窗口）
1. 先停止/结算当前其他 Agent 的运行轮次并核对未确认回执，安全更新 Paseo 插件到 alpha.4.7、Chrome 已解压扩展到 0.2.12；不能仅替换一端后验证附件。
2. 专用测试 Agent 用真实 Paseo 附件发送“1 张 PNG + 1 个 PDF”，核对 ChatGPT 原生附件出现、等待上传完成、恰好一次 Send、真实原生用户消息 ID、收到答复。
3. 补测纯图片、纯文档、文字+多附件、不支持格式、大小限制、网络失败、用户修改附件、旧 Chrome 兼容、关闭页面后的下一条新消息；未核实实际上传并可供 ChatGPT 使用不能把任务标 Done。

**目前 Presure 任务 COSINPASEO-7 应保持 In Progress；不得以离线通过冒充生产验收。**

> **0.2.13 附件选择修正（2026-10-16）：** 一张 PNG 在生产出现 `ATTACHMENT_INPUT_AMBIGUOUS`，新版 Chrome 通过输入框归属与 MIME 专用性消除误拦截，隔离浏览器专项和全量回归通过；仍待已登录 ChatGPT 端到端验收。见 [0.2.13 专项报告](CIP_0213_UPLOAD_INPUT_DISAMBIGUATION_20261016.md)。

> **2026-10-16 后续更正：Chrome 0.2.14** 针对 0.2.13 依旧出现的 `ATTACHMENT_INPUT_AMBIGUOUS`，新增真正 MV3 隔离脚本下追踪原生文件控件激活事件，详见 [专项记录](CIP_0214_ATTACHMENT_NATIVE_PICKER_20261016.md)。Paseo 仍为 alpha.4.7，已修复源码未生产加载，任务仍需真实验收。
