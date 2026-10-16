# 2026-10-14 · 回执漏读与错误状态诊断（未发布）

## 现场证据（alpha.3.9）
- Paseo 截图显示 `RECEIPT_UNCONFIRMED`，随后重试显示 `SESSION_BUSY`；ChatGPT 页面确实收到用户消息、开始执行搜索/工具流程，并显示本机 Mac 工具授权待确认。
- 本机 **12:25:20** Send 命令启动，**12:25:46** 以 `RECEIPT_UNCONFIRMED` 失败：`nativeClicked=true`、`transcriptAvailable=true`、`routeKnown=true`、`rowCount=0`、`matchingUserCount=0`、`refusal=not-accepted`。这次是原生用户消息未被读取，不是仅仅正文不匹配。
- **12:27** 的 `SESSION_BUSY` 源于 SlotQueue 对 blocked 会话统一返回该错误；绝不应视为消息没发送。

## 原因与修复草稿
- 对照 CoS 上游 `fiber.js` 的 `turnsOf`（约 2314–2360 行）：`[data-chatgpt-search-unit-key$=":user"]` 走 `turnViewOf(fiber)`；当前 CIP `sourceFor` 在存在 shell `entry` 时先走 `shellTurnSource`，该锚点没有 shell 的 `turnId`，即使同一 committed Fiber 中有用户 `turn.items`，也会得到空消息。增加定向夹具后，alpha.3.9 **修订前稳定复现 `[]`**。
- **当前磁盘草稿** `extension/upstream/cos-shell-public.js`：搜索用户锚点优先走 CoS 的精确 `turnViewOf`；不使用布局键、DOM 文本或 URL 单独确认 Send。冲突的原生 user message ID 仍拒绝。
- `server/slots.mjs`：已 blocked 的会话返回 `DELIVERY_UNCONFIRMED`，而不是含糊的 `SESSION_BUSY`。不解除阻断、不自动重发、不改原有消息和配对。
- 已同步 `vendor/cos/provenance.json` 的精确哈希与新增回归测试。

## 已核验与限制
- `tests/binding-identity-browser.py` **7/7**（含搜索锚点和原生身份冲突）。
- `tests/receipt-shell-browser.py` **14/14**。
- Node 全套 **163/163**；CoS 来源/哈希 9 模块 PASS；JS/JSON 语法检查 PASS。
- 已安装 Paseo SDK + 实际 MV3 扩展（隔离模拟网页）`tests/binding-mv3-flow.py` **7/7**。
- 并发/关页续聊的完整 MV3 新一轮重跑被工具安全检查拦截；**不得声称已完成本轮全量回归**。之前 alpha.3.9 的 11 项受控联动记录仍在 `docs/evidence-alpha3-9/`。
- **没有登录账号真实收发验收。**本机生产 state/凭据不修改；没有停止用户任务或重发消息。
- 当前 `package.json` / Chrome manifest **仍显示 alpha.3.9 / 0.1.11**；尝试封装 alpha.3.10 被安全检查拒绝，未绕过。**不要按新版已发布重载。**

## 后续
在安全检查允许后完成版本号与 runtime engine 联动升级并重跑全量检查。真实账号测试必须用**全新消息**；失败旧会话保持 blocked。待处理的 Mac 授权由用户在自己的授权界面决定，不由桥接插件自动点击。
