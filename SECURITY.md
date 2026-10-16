# Security Policy / 安全策略

## English

### Supported versions

This project is alpha software. Only the latest commit on `main` and the latest tagged release receive security fixes.

### Reporting a vulnerability

**Please do not open a public issue for security problems.**

Use GitHub's private reporting: open the repository's **Security** tab and choose **Report a vulnerability**, or go directly to <https://github.com/Project10214/cos-in-paseo/security/advisories/new>.

Please include:

- the affected versions (plugin version from `package.json`, Chrome extension version);
- steps to reproduce and the impact you observed;
- logs or screenshots **after redacting** tokens, pairing codes, cookies, account details and private conversation content.

This is a volunteer-run project: we aim to acknowledge a report within about 7 days and to keep you informed, on a best-effort basis without a guaranteed SLA.

### Scope

In scope: the local runtime and HTTP service (`127.0.0.1:17843`, the CIP protocol, pairing, bearer token and extension-origin checks), the Chrome extension (permissions, page ↔ extension messaging, identity and nonce checks), the Paseo plugin and its on-disk state (`~/.cos-in-paseo/`), and anything that could leak credentials or hidden reasoning, or cause a message to be sent or re-sent unintentionally.

Out of scope: vulnerabilities in ChatGPT / OpenAI services, in Paseo itself, or in the upstream Chat On Steroids project (please report those to their owners); issues that require an already compromised machine or browser profile; social engineering.

---

## 中文

### 受支持版本

本项目处于 alpha 阶段，仅 `main` 的最新提交和最新打标签的发布版本会获得安全修复。

### 报告漏洞

**安全问题请不要公开提 Issue。**

请使用 GitHub 的私密报告：打开仓库的 **Security** 标签页，选择 **Report a vulnerability**，或直接访问 <https://github.com/Project10214/cos-in-paseo/security/advisories/new>。

请附上：

- 受影响的版本（`package.json` 中的插件版本、Chrome 扩展版本）；
- 复现步骤和你观察到的影响；
- **脱敏后**的日志或截图（删除令牌、配对码、Cookie、账号信息和私人对话内容）。

本项目由志愿者维护：我们会尽力在约 7 天内确认收到报告并持续同步进展，但不提供有保证的 SLA。

### 范围

范围内：本机 Runtime 与 HTTP 服务（`127.0.0.1:17843`、CIP 协议、配对、Bearer 令牌与扩展 Origin 校验）、Chrome 扩展（权限、网页与扩展之间的消息、身份与 nonce 校验）、Paseo 插件及其磁盘状态（`~/.cos-in-paseo/`），以及任何可能泄露凭据或隐藏思考、或导致消息被意外发送或重发的问题。

范围外：ChatGPT / OpenAI 服务、Paseo 本身、上游 Chat On Steroids 项目的漏洞（请向各自的维护方报告）；需要机器或浏览器配置文件已被攻陷才能利用的问题；社会工程。
