# COSINPASEO-3 · alpha.3.16 原生工具多选面板（已回滚）

> **2026-10-15：用户已要求回滚单选。本文仅供历史追溯，不是当前部署方案。当前代码和安装步骤请看 [单选回滚记录](ROLLBACK_TO_SINGLE_20261015.md)。**

> **最新修复版本 alpha.3.17：** 用户实测首轮 `APP_CATALOG_UNAVAILABLE`、随后 `DELIVERY_UNCONFIRMED` 与工具勾选不可改。已在后续版本修复首轮配置的可恢复性与原生 @ 菜单备用发现。最新版部署、测试和限制以 [修复记录](COSINPASEO-3_ALPHA3_17_REPAIR.md) 为准；下文是 alpha.3.16 的历史验收记录。

## 用户操作
- Chatmode Agent 输入区出现 **工具 · N** 原生 Composer Pill（按钮）。
- 点击后桌面使用 Paseo anchored popover，紧凑布局使用原生 bottom sheet。面板内是可连续点击的复选框；例如勾选 mymac、Presure，按钮显示「工具 · 2」。取消任意勾选、清空均不会影响其他工具。
- 工具仅限该 Chatmode 会话、已在 ChatGPT 端授权的应用；网络配置不自动授权。配置保存按浏览器实际确认执行；运行中的轮次禁止修改，以免改变正在发送的消息。
- 应用列表多于 8 项时显示搜索，最多同时启用 8 个工具（现有浏览器回执的上限）。

## 实现与边界
- 用 Paseo SDK `client.addComposerPill({behavior:{kind:'popover',Content}})`，由原生宿主负责定位、滚动、移动端底部面板和关闭。Pill 只注册到 `provider='chatmode'` 且拥有 workspaceId 的 Agent。
- `client/tools-pill.tsx` 使用 SDK `agents.ref(id).refresh()` 读取当前 Paseo Agent 的持久会话标识（`agent.persistence.sessionId`），`client/tool-identity.mjs` 仅解析 `plugin:{"version":1,"data":{"id":UUID}}`；拒绝非 Chatmode 或不完整身份。源码核对确认：此高层方法发送只读 `fetch_agent_request`，**不是**会中断 Agent 的底层 `refresh_agent_request`；加载面板或更新数量都不会重启任务。
- 新增 RPC `bridge.session-tools`、`bridge.save-session-tools`，借用现有 Broker/Provider 绑定。**只有正被 Provider 连接持有的 session 可以写入**；旧配置比较失败拒绝覆盖，未知工具拒绝，准备中/运行中/断联拒绝，底层通过原有 `broker.configure/deferConfigure` 与网页确认，完成后发 `session.config`。
- `configState().settings=[]`，不再展示旧 `ProviderSetting.select` 或多枚 toggle；`selectionFrom` 的旧 `app:quick`、旧 per-app bool、`none/all/defaults` 解析仍保留，以兼容持久会话/SDK 老调用。
- 不改变 ChatGPT Chrome 扩展脚本、CIP 协议、用户真实状态文件、账号或工具权限。原有图像、消息回执、并发、恢复与超时策略均保留。
- 保存失败时保留上次确认值；只有明确调用重试才再次提交，无消息自动重发。

## 代码变更
- `index.client.tsx`、`client/tools-pill.tsx`、`client/tool-identity.mjs`
- `index.server.ts`、`shared/rpc.ts`、`server/tool-selection.mjs`、`server/provider.mjs`
- `client/settings.tsx`、`package.json`、`extension/manifest.json`（只更新显示版本号）
- 更新 `tests/provider.test.mjs`、`tests/sdk-contract.mjs`、`tests/quick-tools-mv3.py`，新增 `tests/tool-selection.test.mjs`、`tests/tools-pill-ui.py`；更新本地隔离 UI Fixture。

## 实际验收（2026-10-14）
- Node 全量：**227/227 PASS**，包括原会话恢复、双会话隔离、旧配置、CAS 防覆盖、忙碌拒绝、真实浏览器确认前不提交和失联拒绝。
- 完整 TypeScript 检查：**21 文件 / 0 diagnostics**，基于已安装的 Paseo 0.11.2 SDK。
- 已安装 Paseo 0.11.2 `ProviderInputSchema / ProviderEventSchema` 合约：**1/1 PASS**。
- Chrome MV3 + 实际临时 Runtime/Provider + 离线 ChatGPT 测试页：**10/10 PASS**，其中双应用同时出现在网页原生 `@` 标记。
- 桌面与手机宽度下的实际 React/RN-web 面板内容：**8/8 PASS**，包含多选/移除、失败后重试、全部清空、ARIA 勾选状态、无水平溢出；宿主弹层定位与底部手势属于模拟宿主，仍需实机验证。
- `scripts/check.mjs`：**408 个 JS 文件**与清单语法/权限通过（新增版本变更后再跑一次）。
- `node .test-tools/ui/build.cjs`：UI Fixture Bundle PASS。

## 部署与最终验收
1. 当前 Paseo 会话及网页任务结束后，重载本项目 Paseo 插件为 `0.1.0-alpha.3.16`。Chrome 扩展内容未变，不需要重载；其实际通信引擎仍 `cos-native-alpha3.15`。
2. 打开一个 Chatmode 会话，确认旧的「工具」单选下拉消失、出现「工具 · N」按钮。桌面与手机分别打开面板，连续勾选 mymac、Presure，关闭并重新打开应保留两项；在另一会话改选工具，原会话不变。
3. 在真实已授权 ChatGPT 账号用**新的唯一测试消息**验证两个 `@` 工具、原生发送回执及回答回传。对结果不明的旧消息绝不重复发送；任务进行中勾选不可操作。

**未完成：** 真实已安装 Paseo 的弹层表现与 ChatGPT 登录账号端到端验收，因此尚不把实机环节标为 PASS。
