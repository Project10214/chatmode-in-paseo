# CoS in Paseo alpha.3.11 — 四项 P1 修复与发送回执补强

日期：2026-10-14。两个插件共用本仓库。Paseo 插件版本 **0.1.0-alpha.3.11**，Chrome 扩展 **0.1.13**；CIP v3、Provider v1 未改。仅源码与隔离测试，不修改生产状态或账户。

## 本轮已修的四项 P1

1. **过早显示完成**：`server/activity.mjs` 对浏览器上报的 `completed` / `nativeStatus=complete` 先降级为 `finalizing`；只有 Broker 同一轮通过精确最终回执/图片结果事务，才将持久活动卡设置为 `completed`。状态卡不能代替真正终态。
2. **停止/失败后仍显示运行中**：集中在 `settleActivity`，覆盖 `binding_lost`、`failTurn`、终态错误、明确未发送失败、用户 Stop、看门狗超时与 Runtime 恢复；停止写 `canceled`，失败写 `failed`，卡片 `nativeStatus=null`。同一 `activity:<turnId>` 原地更新，不产生假新轮。
3. **非公开工具名称进入卡片**：`extension/upstream/cos-activity-main.js` 在父 reasoning-group 与工具 item 两级检查 analysis/private、hidden、transient、非公开 recipient/metadata；只输出经过白名单验证的服务名、工具名、callId 对应完成状态；不传 reasoning/工具参数/结果/URL/凭据。
4. **正常回答误判为 NATIVE_ERROR**：`extension/dom-adapter.js` 移除对助手自然语言 `Network error.` 等短语的故障认定；只允许与当前 native user/assistant 身份有对应关系的可见错误组件成为错误事实，忽略其他轮次/保留的旧警告。

## 补强：发送回执

- 增加 `extension/upstream/cos-send-evidence.js` (MAIN, document_start) 和 `extension/upstream/cos-request-receipt.js` (ISOLATED)。只在本次获授权且准确预置正文摘要之后暂时接收相同正文的原生 POST 请求 UUID；需要同源路径、唯一用户消息、HTTP 2xx SSE 响应、时间窗和 nonce 全部匹配。
- 与 CoS 的原生 `sentRequest` 钩子对接。实际页面尚未渲染用户气泡时，允许使用精准限定的网络请求回执；不扩展发送权限、不调用通用网页 API，也不会对历史消息执行重试。未知 transport/失败条件仍返回 `RECEIPT_UNCONFIRMED` 而非乱认。
- **边界**：HTTP 2xx SSE 是有条件的发送证据，不等同于整个 SSE 流成功或最终模型完成。网页逻辑改变时仍可能无法确认。生产账号验证前不应宣布回执问题完全解决。

## 本机验证

- 四 P1 对抗用例：`tests/strict-regression.test.mjs`，含真正 Runtime `recover()`、`tick()` 与 Stop 路径；`tests/strict-browser.py` 检查正常“Network error.”、旧 banner、当前轮真实 banner。
- `tests/send-evidence-browser.py` 8 项、`tests/send-evidence-mv3.py` 8 项，浏览器+真实扩展与 Paseo SDK 回传链路使用全部本地模拟请求和隔离 Chrome profile。
- `tests/concurrency-reopen-mv3.py` 11 项：并发 2→4→1，关页后续聊，队列取消，隔离约束。
- `tests/eight-tabs-mv3.py` 3 项：8 个真实 Chrome 测试标签页，未执行真实账号的 8 路同时 Send。
- Node、CoS 来源哈希、语法、完整 TS 类型、已安装 Paseo SDK 等全量检查另见命令输出。所有实测均为 **离线夹具/非生产**；尚未完成用户真实登录网页验收。

## 已知剩余边界

- ChatGPT 改变网络请求结构、DOM/Fiber 等关键内部实现仍可能造成证据缺失；此时必须坚持 fail-closed，不可用 URL/按钮/工具状态推断已投递。
- 若 ChatGPT 的 SSE 返回 2xx 后内部出现异步错误，仍需要后续明确的消息/最终回执，不保证模型工作成功。
- HTML 中未带可核实归属的全局提示不自动判为某轮失败，避免把旧错误归给新轮；宁可继续等待/报告不确定。
- 原生工具公开状态的 UI 在真实 Paseo+登录 ChatGPT 页面仍需验收，不能把隔离模拟的截图当成真实产品运行记录。
- 旧 `RECEIPT_UNCONFIRMED` / `BROWSER_BINDING_LOST` 会话保持阻断，不自动解封、不重发、不删除。

## 待用户验收

仅在所有进行中的网页任务结束后，**手动**重载 Paseo 根插件及 Chrome 扩展，确认 **alpha.3.11 / Chrome 0.1.13**，刷新空闲网页。使用全新会话验证发送回执、工具状态、失败恢复、并发与关闭标签页续聊。无需重新配对；不要重发过去结果不明的提示。

此轮未提交 GitHub、未触碰真实 `~/.cos-in-paseo` 数据、没有自动控制登录账号/工具授权。
