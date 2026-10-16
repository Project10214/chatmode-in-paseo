# COSINPASEO-3 · alpha.3.17 实机反馈返修记录（已回滚）

> **2026-10-15：用户取消多选尝试并回滚至 alpha.3.15。本文属于历史记录，不能用作当前升级说明。请看 [单选回滚记录](ROLLBACK_TO_SINGLE_20261015.md)。**

## 问题与边界
2026-10-14 用户实机截图：Chatmode 会话显示 `APP_CATALOG_UNAVAILABLE`，继续发消息出现 `DELIVERY_UNCONFIRMED`，原生「工具 · 2」面板能打开但无法修改勾选。截图不能证明消息究竟是否发出；项目代码和隔离复现确认了“首轮配置/应用目录失败 → 会话被当作不可继续的控制失败 → 后续发送被阻断”的一条实际路径。没有访问生产 `~/.cos-in-paseo` 数据，也没有读取用户真实消息、账号凭据或自动重发。

## 修复 A：原生应用发现的双通道
- 原流程只被动监听网页自己的 `GET /backend-api/system_hints?mode=plugins`，再进行一次受控原生 `@` 输入。网页不请求这个端点时，18 秒后失败。
- 现在先观察 5.5 秒；**仅**当得到 `APP_CATALOG_UNAVAILABLE` 且无其他明确拒绝时，使用 `extension/app-menu.js` 的原生 `@` 菜单读取；每个候选必须带可证明的 `asdk_app_` 身份（DOM 属性或已提交 React Fiber），有歧义一律拒绝。登录/权限拒绝、用户输入变化和身份冲突不通过备用路线绕过。
- 备用读取完成后，严格删除本次探测的 `@`，核对原有已选标签未改变。清理失败不视为成功；不发送消息，不直接请求认证接口，不自动授予权限。
- 修复已选 App 标签位于输入框末尾时，探测 `@` 被错误插入标签内部导致 `APP_PROBE_INTERRUPTED` 的问题：临时创建标签外的光标锚点，探测结束安全移除。
- 当网页两种来源都不提供可靠身份时继续拒绝发送，而不是使用目录缓存冒充本页授权。

## 修复 B：精确区分预发送失败与真实回执不明
- `server/broker.mjs` 的 `canRetryPreparation` 只认：当前是 `CONTROL_UNCONFIRMED`、没有 ChatGPT 对话链接、没有已绑定标签页、没有消息轮次、没有任何 Send/Stop 指令，且最近一次完整结束的 `open` 指令确为明确的应用/模型准备失败（而非断线/超时/未确认状态）。任一条件缺失则仍锁定。
- 对符合条件的状态，`server/tool-selection.mjs` 允许在原生面板重新勾选，`broker.deferConfigure` 只保存新的期望配置并恢复空闲；**不会开启网页或发送旧消息**。也可以由用户显式发送一条具有全新消息 ID 的消息，再次执行首次配置核验。
- 真正发出过 Send、绑定了不明会话、控制状态未确认或程序中有运行中的命令，仍保持阻断；不把 `DELIVERY_UNCONFIRMED` 静默改成已成功。
- `server/slots.mjs` / `broker.prompt` 将被阻断但未证实有 Send 的状态报告为 `CONTROL_UNCONFIRMED`，只有真正已授权 Send 的不确定状态使用 `DELIVERY_UNCONFIRMED`。
- 面板明确展示“上次配置失败但尚未发送，可调整后发新消息”或“此前网页状态尚未确认，不能修改/重发”，不再统称“会话执行中”。

## 代码
- Paseo Provider/持久逻辑：`server/broker.mjs`、`server/slots.mjs`、`server/provider.mjs`、`server/tool-selection.mjs`、`shared/rpc.ts`
- UI：`client/tools-pill.tsx`
- Chrome 发现：`extension/app-catalog.js`（未修改，保留被动来源）、`extension/app-discovery.js`、`extension/app-menu.js`、`extension/dom-adapter.js`、`extension/manifest.json`；`extension/content.js` / `extension/background.js` 及 `server/runtime.mjs` 只调整引擎身份版本。
- 测试：`tests/tool-selection.test.mjs`、`tests/catalog-browser-regression.py`、`tests/binding-mv3-flow.py`、`tests/tools-pill-ui.py`；`.test-tools/ui/` 的模拟宿主用于 UI 测试。

## 已通过的验证
- `node --test tests/*.test.mjs`：**231/231 PASS**。特别覆盖：首轮明确配置失败（尚无 Send）→ 工具修正 → 只有新的用户消息能触发一次 Send；不修改工具的新消息显式恢复；较新的不确定控制/已有真实 Send 不得使用历史失败解锁。
- Paseo 0.11.2 本地真实 SDK 合约：**1/1 PASS**；完整 TypeScript：**21 文件 / 0 诊断**。
- 真实 Chrome MV3 扩展 + 后台 Service Worker + 临时 Runtime 与原生页面模拟：`quick-tools-mv3.py` **10/10 PASS**，设置 `CIP_FIXTURE_NO_HINTS=1` 后再次 **10/10 PASS**；第二组覆盖整个缺失 `system_hints` 情况下第一次发送、已选 A 再增加 B、取消 A、第二轮及多标签隔离。
- `catalog-browser-regression.py`：**14/14 PASS**，严格拒绝没有 ID 的菜单、已确认的 403、用户输入/页面跳转与无来源情况。
- React Native Web 模拟桌面/手机：`tools-pill-ui.py` **12/12 PASS**，补齐可恢复/不可恢复的勾选状态差异。
- `node scripts/check.mjs`：**408 JavaScript 文件及 JSON/权限检查通过**；UI 测试构建通过。
- **边界：** 全部为本地代码及隔离浏览器/Runtime；没有登录真实 ChatGPT 用户账号的端到端验收，也未在当前已运行的 Paseo Agent 上改状态。

## 版本与安全部署
- Paseo 插件：`0.1.0-alpha.3.17`；Chrome 清单：`0.1.18`，展示版本相同；浏览器/Runtime 引擎 `cos-native-alpha3.17`。Provider v1、CIP v3 不变。
- 等所有正在执行的 ChatGPT/Paseo 任务结束后，**先重载 Paseo 插件，再重新加载 Chrome 解压扩展，刷新已空闲的 ChatGPT 标签页**。不删除数据、不重置配对、不清空会话、不自动补发旧消息。
- 新建一个 Chatmode 测试 Agent，确认「工具 · N」能增删且保留勾选。先选择“无工具”用全新消息测试发送，再选 mymac + presure 用另一条全新标记测试本页多工具配置与回传，最后验证另一个会话互不影响。若旧会话确为首次尚未发送的配置失败，可在同一 Agent 中修正；若旧消息投递不明，**禁止重发同一条消息**，先核对网页结果。
- 最终验收必须以真实登录账号的原生发送回执、回答到 Paseo、允许的工具 ID 和权限行为为准；目前状态维持 **In Progress**，不标 Done。
