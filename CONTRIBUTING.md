# Contributing / 贡献指南

Thank you for your interest in Chatmode in Paseo! Issues and pull requests are welcome, in **English or 中文**.
感谢关注 Chatmode in Paseo！欢迎用**中文或英文**提交 Issue 和 Pull Request。

[English](#english) · [中文](#中文)

---

## English

### Before you start

- Search existing [issues](https://github.com/Project10214/chatmode-in-paseo/issues) and pull requests first.
- For anything bigger than a small fix, open an issue to discuss it before writing code.
- Security problems: do **not** open a public issue. See [SECURITY.md](SECURITY.md).

### Development setup

- Node.js ≥ 22.6. Chrome and the Paseo daemon must run on the same machine (see the README).
- The first three checks need no dependencies:

  ```sh
  npm run check            # syntax and manifest checks
  npm run verify:upstream  # Chat On Steroids provenance and hashes
  npm test                 # unit and integration tests (node:test)
  ```

- Type checking and the SDK contract tests need the pinned dev dependencies:

  ```sh
  npm install --ignore-scripts --no-audit --no-fund
  npm run typecheck
  npm run test:sdk
  ```

- Browser tests (`npm run test:dom`, `test:browser`, …) need Python, Playwright and Chromium; see section 3 of the README. They load in-memory pages and never log in to ChatGPT.
- See [docs/TESTING.md](docs/TESTING.md) for which tests to run for each kind of change and how to do real-account acceptance.

### Project rules

- `extension/upstream/*.js` are adapted from [Chat On Steroids](https://github.com/totec448-spec/chat-on-steroids) (MIT). If you change one, update its hash and notes in `vendor/cos/provenance.json` and `vendor/cos/README.md` (`npm run verify:upstream` enforces the hash) and keep the notices in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
- Keep the safety principles: queued is not delivered; never auto-resend a message whose delivery is unknown; never expose hidden reasoning, cookies, tokens or account objects; never auto-click ChatGPT authorization prompts; the local service listens on 127.0.0.1 only.
- Never commit credentials, pairing codes, runtime state (`.state/`, `~/.chatmode-in-paseo/`) or real ChatGPT conversation content. Redact logs and screenshots before attaching them to issues or pull requests.
- Keep a single Provider, a single shared Runtime and a single Chrome extension; do not add parallel services. Chatmode UI changes must only affect Chatmode: do not take over Paseo's global message components.
- Changes that can only be verified with a real logged-in ChatGPT session are not covered by CI. Describe how you tested them by hand in the pull request.

### Pull requests

1. Fork the repository and create a branch from `main`.
2. Keep each pull request focused. For a bug fix, add a test that reproduces the original problem, plus a negative or edge-case test.
3. Run the checks above locally. CI runs `check`, `verify:upstream`, `test`, `typecheck` and `test:sdk`.
4. Fill in the pull request template. Pull requests are squash-merged.
5. [Conventional Commits](https://www.conventionalcommits.org/) style messages (for example `fix(extension): …`) are appreciated but not required.

### License of contributions

By submitting a contribution you agree that it is licensed under the repository's [MIT License](LICENSE). GitHub's Terms of Service apply the same "inbound = outbound" rule by default, so no CLA is required.

---

## 中文

### 开始之前

- 请先搜索现有的 [Issue](https://github.com/Project10214/chatmode-in-paseo/issues) 和 Pull Request，避免重复。
- 除小修小补外，较大的改动请先开 Issue 讨论，再动手写代码。
- 安全问题**不要**公开提 Issue，请见 [SECURITY.md](SECURITY.md)。

### 开发环境

- Node.js ≥ 22.6。Chrome 与 Paseo 后台必须在同一台机器上（见 README）。
- 前三项检查无需安装依赖：

  ```sh
  npm run check            # 语法与清单检查
  npm run verify:upstream  # Chat On Steroids 来源与哈希校验
  npm test                 # 单元与集成测试（node:test）
  ```

- 类型检查与 SDK 契约测试需要安装固定版本的开发依赖：

  ```sh
  npm install --ignore-scripts --no-audit --no-fund
  npm run typecheck
  npm run test:sdk
  ```

- 浏览器测试（`npm run test:dom`、`test:browser` 等）需要 Python、Playwright 和 Chromium，见 README 第 3 节。它们加载内存页面，不会登录 ChatGPT。
- 各类改动该跑哪些测试、真实账号验收怎么做，见 [docs/TESTING.md](docs/TESTING.md)。

### 项目约定

- `extension/upstream/*.js` 改编自 [Chat On Steroids](https://github.com/totec448-spec/chat-on-steroids)（MIT）。修改这些文件时，请同步更新 `vendor/cos/provenance.json` 中的哈希和 `vendor/cos/README.md` 中的说明（`npm run verify:upstream` 会校验哈希），并保留 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 中的声明。
- 守住安全原则：已排队不等于已送达；送达结果不明的消息绝不自动重发；绝不暴露隐藏思考、Cookie、令牌或账号对象；绝不自动点击 ChatGPT 的授权提示；本机服务只监听 127.0.0.1。
- 切勿提交凭据、配对码、运行状态（`.state/`、`~/.chatmode-in-paseo/`）或真实的 ChatGPT 对话内容。在 Issue 或 PR 中附日志、截图前请先脱敏。
- 保持一套 Provider、一套共享 Runtime、一个 Chrome 扩展，不要另起并行服务。Chatmode 的界面改动只能影响 Chatmode，不要接管 Paseo 全局的消息组件。
- 只能用真实登录的 ChatGPT 会话验证的改动，CI 无法覆盖。请在 PR 中说明你是如何手动验证的。

### Pull Request 流程

1. Fork 本仓库，从 `main` 新建分支。
2. 每个 PR 只做一件事。修复问题时，请补一条能复现原问题的测试，以及相应的反向/异常测试。
3. 在本地运行上述检查。CI 会运行 `check`、`verify:upstream`、`test`、`typecheck` 与 `test:sdk`。
4. 按模板填写 PR 说明。PR 以 Squash 方式合并。
5. 提交信息推荐使用 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/v1.0.0/) 风格（如 `fix(extension): …`），但不强制。

### 贡献的许可

提交贡献即表示你同意以本仓库的 [MIT 许可证](LICENSE)授权你的贡献。GitHub 服务条款默认同样适用"入站即出站"，因此无需签署 CLA。
