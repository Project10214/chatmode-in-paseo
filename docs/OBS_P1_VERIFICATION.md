# OBS-P1 核实记录

2026-10-18。仅验证，未修改生产逻辑、部署、重载或操作真实 Agent。

## 结论

**限制仍存在，但不是“普通同步异常都无法恢复”。**

1. 当前插件收到普通正文/观察错误时，保留原轮次的运行状态。随后取得完整回答后，原连接可以正常结束；不需要重建会话或重发任务。
2. 如果这一轮已被 Paseo 作为前台轮次正式记为失败，原连接会保留该轮的已终结标记。CIP 拒绝在同一连接中重新激活它；Paseo 原版宿主也确实丢弃该 ID 的后续完成事件。这是 OBS-P1 尚未满足的能力。
3. 在仍失败/空闲时，显式重建原 Agent 的宿主会话，然后再恢复观察，隔离测试可按原轮次完成，且不产生额外 Send 或 Stop。不得把该顺序推广为对运行中 Agent 的盲目重载。

上一轮回答对影响范围的表述过宽，应以本记录为准。

## 验证对象

- 实际部署目录：`/Users/penn/plugins/chatmode-in-paseo`，alpha.4.26。审计脚本直接导入此目录的 Store、Broker、Provider、观察屏障和 wake；不是只测试未部署的 alpha.4.27。
- 运行中的 Paseo：0.12.0-beta.2。测试使用同版官方包的原版 AgentManager、AgentRunState、PluginAgentClient/ProviderRuntime 及其 SDK。
- 从当前安装的 `Paseo.app/Contents/Resources/app.asar` 只读校验，三个关键宿主文件与测试包字节一致：
  - `agent-manager.js`：`e5a60e7a4b11691bc378196e267dfebc0d8171c26bd5427c46c067e5dc8587d4`
  - `agent-run-state.js`：`ac8b7ff61bf91350b073858c5ca10dedd1ca99dd2ae40f9f562d4bd26fc29ec0`
  - `plugin-provider.js`：`dc9948ca942d2aeef10a48c4ef1fc625819005ef28296bb386cfb9737502d475`

## 隔离执行结果

审计以 `tests/host-observation-real.mjs` 的原版类执行框架为基础，仅改导入位置以使用部署代码；使用临时 Store 和浏览器命令替身，不连接真实 ChatGPT 或 daemon，不发送真实消息。

| 场景 | 结果 |
| --- | --- |
| 注入 `ANSWER_RAW_DIVERGED`，随后提交完整回答 | 原连接保持 running，再转 idle；回答 1 次，无额外命令 |
| 注入 `TRANSCRIPT_UNCONFIRMED`，随后提交完整回答 | 同上 |
| 注入 `OBSERVATION_UNAVAILABLE`，随后提交完整回答 | 同上 |
| 通过当前 Broker 的正常入口注入终态 `TURN_CHANGED`，再尝试恢复 | 原连接返回 `OBSERVATION_HOST_SESSION_REOPEN_REQUIRED`；本地状态不变；迟到正文被拒绝为 `TURN_NOT_STOPPED`；原版宿主对同 ID 后续完成返回 false，Agent 保持 error |
| 原版 REAL-2：失败时显式重建同一 Agent 的会话，再恢复 | 原 turnId 正常运行和结束；额外 Send/Stop 为 0，后续新提示可接受 |

以上 5 项均符合预期（5/5、0 skip），其中第 4 项验证的是“限制确实存在”，不是宣称恢复已经修好。

另重跑当前仓库的 OBS-D1、D3、P1、P3：3 过、1 失败。唯一失败仍为 OBS-P1 的 `OBSERVATION_HOST_SESSION_REOPEN_REQUIRED`；未删除、跳过或改写其要求。

## 触发条件与证据边界

- OBS-P1 用 `legacyObservationFailure` 重建旧版“正文读失败即结束轮次”的状态，不能据此推断新版普通正文读取失败也会提前结束。当前 `contentSyncCode` 路径明确保持运行。
- 新审计用当前 Broker 的 `TURN_CHANGED` 终态入口验证真实的同连接恢复限制。但错误和恢复所需的新页面证明由测试注入；它不证明当前 ChatGPT 页面会误报 TURN_CHANGED，也不衡量现场发生率。
- 当前扩展仅在原用户锚点仍存在、且后面读到另一条用户消息时报告 TURN_CHANGED；随后恢复还须重新证明原用户是最新消息。普通消息暂时卸载走 TRANSCRIPT_PENDING，不应当作轮次变更。
- 只读检查本地状态时有 164 个会话、0 个正在运行。发现两条旧 ANSWER_RAW_DIVERGED 失败记录，创建于 10 月 16/17 日，当前均不满足恢复准入条件；它们不能直接证明现在有 Agent 正卡在 OBS-P1 场景。
- 这是已部署代码和原版宿主类的隔离执行，不是真实账号、跨 daemon 网络或 UI 端到端验收。

证据位于候选工作区的 `../logs/obs-p1-verify-20261018/`：`deployed-host-audit.mjs`、`deployed-host-audit.log`、`targeted-unit.log`。审计脚本依赖该次部署代码和固定 beta.2 官方包，后续复跑须先核对版本/哈希。
