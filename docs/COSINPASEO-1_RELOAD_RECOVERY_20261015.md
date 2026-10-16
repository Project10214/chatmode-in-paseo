# COSINPASEO-1 插件更新后发送失败：实机排查与窄范围修复（2026-10-15）

## 现场证据（只读）
- CIP v5 Runtime `/hello` 正常响应，服务未整体宕机。
- 受影响 Runtime session 尾号 `d2679e15`：`status=idle`、`turn.origin=browser`、`turn.outcome=failed`、`error=STOP_UNCONFIRMED`。
- 同一轮已经有可信的原生用户消息 ID，且 `turn.nativeMessageId === lastNativeMessageId`；这里不保存或披露 ID 值。
- 失败命令按时间依次包括 `CONTENT_UNAVAILABLE`、`NATIVE_BUSY`、`REOPEN_IDENTITY_UNPROVEN`。
- 排查时另有两条非本验收会话正在运行；未触碰、停止或刷新。

## 原因及边界
1. 扩展更新后原 ChatGPT 标签页的内容脚本可能失效；`background.identity()` 在无法取得同版本文档身份时返回 `CONTENT_UNAVAILABLE`。这类存量标签页需在空闲时刷新才能验证新版脚本。
2. `NATIVE_BUSY` 是原生页面仍认为正在生成的安全拒绝；不能通过强行发下一条消息绕开。
3. `server/broker.mjs::ensurePage()` 曾在**所有**失败轮次上清空 previousNativeMessageId。对于已确认发送、但 Stop 未被确认的网页源轮次，关闭旧标签页后扩展的 `execute(ensure)` 无法证明重开身份，返回 `REOPEN_IDENTITY_UNPROVEN`。

## 已实现（源码；生产 Runtime 未重载）
- 仅当上轮错误是 `STOP_UNCONFIRMED`，并且当前失败轮次的 nativeMessageId 与已验证最后消息 ID **完全一致**，且能证明本轮由 Paseo 原生回执接收或浏览器原生轮次导入，才保留重开锚点。
- 新网页仍须证明**同一 ChatGPT Conversation 且最新原生用户 ID 完全一致**，否则不得重新认领。
- 一般 `binding_lost`、不确定的 Send 回执、未确认网页点击仍不使用可能过期的旧 ID；绝不自动重发，保留已有身份/接管防护。
- 改动仅 `server/broker.mjs` 和 `tests/conversation-binding.test.mjs`；原件备份于 `.local-backups/reopen-anchor-20261015/`。

## 验证结果
- 定向 Provider/绑定/重开回归：38/38 PASS。
- 全量 Node：**254/254 PASS**。
- JS/JSON 检查：450 个 JavaScript 文件解析通过；无 cookie/debugger 权限。
- CoS 来源模块检查：12/12 PASS。
- 新增 LINK9（已证实原生回执的 Stop 失败后安全关页重开）、LINK10（一般观察丢失仍清空锚点）、LINK11（网页源轮次的 Stop 失败保留验证过的原生锚点）。
- 已只读对照真实故障会话元数据，确认满足 LINK11 的安全保留条件；**尚未在新版本生产 Runtime + 登录 ChatGPT 页面复验新轮发送。**

## 上线与实机验收
1. 等正在运行的其他 Agent 轮次全部完成后，再重载项目对应的 Paseo Provider / Runtime；不要重启或取消进行中的任务。
2. 仅刷新发生过 `CONTENT_UNAVAILABLE` 的、**确定空闲**的 ChatGPT 标签页；不要强刷仍生成、工具等待或有草稿的页面。
3. 使用全新测试消息重新验证原 Conversation、原生 ID 绑定、一次发送、Paseo 状态回到 idle/completed。旧失败消息不重发。
4. 还须复验 COSINPASEO-2 真实公开工具/思考事件；本轮没有更改该模块。

**状态：修复代码与离线回归通过；生产升级及实机复验未完成，COSINPASEO-1 保留 In Progress。**
