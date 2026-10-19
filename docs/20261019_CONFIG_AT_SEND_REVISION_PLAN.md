# Chatmode · Paseo 发送时应用配置（最小开发版）

- 日期：2026-10-19
- 基线：已部署插件 `0.1.0-alpha.4.44` / Chrome `0.2.48` / CIP v8
- 本地开发候选：插件 `0.1.0-alpha.4.45` / Chrome `0.2.49` / CIP v9
- 当前状态：**开发代码与离线/隔离测试已完成；已在本地开发分支提交、未替换在线插件、未完成真实登录账号验收**。
- 对抗复核：`20261019_CONFIG_AT_SEND_ADVERSARIAL_REVIEW.md`。
- 用户确认的范围：**Paseo 改模型、Thinking、工具只存本地；发第一条或之后改配置时才在网页应用；同一网页文档且 Paseo 配置不变时不再重复操作模型选择器。** 不做每轮无菜单读取 PoC 或持续检测网页外部手动修改。

## 核心流程

1. **配置/能力发现**：当前网页目录用于展示可选模型、effort、工具；用户在 Paseo 改设置仅写本地 `s.config`。不会自动唤醒 Chrome，不会立即打开网页，不排新的 `configure` 控制命令。`request.completed` 只表示**本地保存成功**。
2. **消息进入 Provider**：收到 `session.prompt(clientMessageId)` 后，先在现有 Store 串行事务中登记唯一 ID 和冻结的模型/effort/工具快照，再等待旧轮次、Chrome 和并发 slot；中途改设置不会改变该消息。
3. **确认/恢复网页**：新会话 `open`、已绑定会话 `ensure` 只验证页面/Conversation 的身份与有效性，不再提前切换模型或工具。旧标签页确认已关闭时按保存的 Conversation 恢复；其他页面、多个候选或归属不明时拒绝接管。
4. **一个 Send 内准备**：`D.send` 复用已有 `configure`。若**同一脚本实例/同一 Conversation 路由**已成功应用同样的模型及 effort，则直接跳过模型菜单操作；若首次使用、Paseo 选择变化、document 更新/导航或配置失效，则执行现有严格的选择器切换及读回。工具清单可在当前文档缓存，但**每条消息仍独立确认并准备自己的 `@` 工具标记**。
5. **发送/回执**：复用现有 draft、文档/route、工具、原生 Stop、消息 ID、单次 Send 和送达回执防护。配置/工具准备失败且确定未点击 Send：返回真实原因和 `notSent`；一旦点击或可能已点击后回执不明，标记“送达未确认”，绝不自动重发。
6. **下一条消息**：Paseo 配置和页面实例未变化则不重复操作模型菜单；再次选择模型/effort 后仅在下一次 Send 时应用。网页标签页刷新/重建使内存中的模型成功记录失效。

## 最小化数据结构

沿用 `s.config` 为 Paseo 当前期望值，`command.payload.config` 为已授权 Send 的冻结值；为了排队期间模型不漂移，`s.prompts[clientMessageId]` 在进入异步等待之前额外存一个尚未发送的快照和消息原始指纹。**不新造 `desiredConfig` / `appliedConfig` 持久数据库、配置版本号、轮询器和同步调度系统。**

网页侧仅在 `extension/dom-adapter.js` 同一文档实例中保留一个可丢弃的 `appliedModel` 记录。路由变化会清空，Chrome 页面/扩展重新加载会自然清空，首次已确认的新对话路由可由本条真实成功发送继续记录。工具用已有原生 mark 按消息确认，不把清单缓存当作授权证明。

### 已明确接受的边界

**如果有人绕过 Paseo，直接在同一个 ChatGPT 页面手动修改模型，而 Paseo 设置没有改变且页面没有刷新/导航，插件不会主动发现或纠正。** 这是用户为减少重复网页交互而确认接受的取舍，不把它当成这轮必须解决的问题。不能宣称“始终与网页实际模型一致”；仅能宣称“第一次/变更时已严格应用成功，之后在同一页面按 Paseo 配置复用”。如果真实 ChatGPT 页面因为账号/配额/策略等拒绝第一次或新的模型选择，则原样报错，不偷偷降级或继续按旧模型发送。

## 修改位置

| 文件 | 改动 |
|---|---|
| `server/provider.mjs` | 配置仅本地保存；以 Provider 接受顺序冻结发送意图；不再提前下发浏览器配置，不因网页不存在直接对设置报 `TAB_NOT_OWNED` |
| `server/broker.mjs` / `server/store.mjs` | 复用冻结命令配置校验正常与迟到回执；持久化待发消息的配置快照与指纹；迁移旧 `pendingConfig` 为下轮期望，不动已发送命令 |
| `extension/content.js` / `extension/dom-adapter.js` | `open/ensure` 不修改网页模型/工具；网页模型匹配记录在同一页面内复用；模型变化触发原生严格选择器；本条工具 mark 仍重新确认 |
| `server/protocol.mjs` / `extension/background.js` | CIP v9 成套握手，拒绝与老版本混用 |
| 文档和测试 | 更新配置语义、版本与隔离回归 |

## 已有证据（本地开发工作区，非线上）

- `npm test`：771 项，770 通过、0 失败、1 项跳过（上游可选对照）。
- `npm run check`、`npm run typecheck`、`npm run verify:upstream`、`npm run test:sdk`：通过。
- 固定 `@getpaseo/server@0.12.0-beta.2` 宿主类回归：4/4 通过。
- 真实 MV3 + 隔离 Chrome + 合成 ChatGPT / Node Runtime：6/6 通过；两轮准确 Send，一次恢复不重发。
- 专门缓存测试 `tests/config-at-send-browser.py`：6/6 通过；同一页面连续相同模型两次 Send 不重复打开模型选择器；选择变化后才打开；只改工具不打开模型选择器。
- 其他相关离线 Chromium 回归：授权按钮、正文、应用标记、附件、Stop、回执和未知送达均已通过，原始日志在开发工作区 `../logs/config-at-send-v2-*.log`。
- **未测**：已登录真实 ChatGPT 页面 + 用户 Paseo Agent 的全链路；当前安装的 Paseo 客户端是 `0.12.0`，以前针对 `0.12.0-beta.2` 的原生 Metro renderer 源码哈希已变化，旧的完整原版渲染器等价性测试需重新审计后才能运行，不得冒称 PASS。

## 发布条件

在共享 Runtime 的活跃会话、待授权和未知回执都安全结清后，备份退出状态，成套更新插件与扩展，核对 CIP 9、真实 Chrome 扩展版本、原 Agent 绑定，最后只在独立测试 Agent / 专用 ChatGPT 对话进行首次发送、同配置连续发送、模型切换/工具切换和错误回执验收。**不清空活锁、不强退其他 Agent、不重发未知消息**。
