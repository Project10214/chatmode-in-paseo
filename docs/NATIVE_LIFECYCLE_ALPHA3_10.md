# CoS in Paseo alpha.3.10 — ChatGPT 原生公开状态识别

## 范围与原则

这是直接安装在 Paseo 和 Chrome 的两个插件，不依赖 CoS 桌面程序。本次以本仓库锁定的 Chat On Steroids（MIT）源码为参照，函数级移植 **公开、可核实的原生状态**，保持 CIP/Paseo 会话隔离和发送授权原有安全边界。它不是完整复制 CoS 的桌面状态机。

### 原生来源

- `extension/upstream/cos-activity-main.js`：CoS `extension/fiber.js` 中 `viewCallsOf`（1793–1827）、`shellTurnTrace`（2125–2185）和 `shellTurnSource`（2192–2274）的收敛版本。
- `cos-shell-public.js`：原生 `turn.items`、`turn.status` 和 `end_turn`；按真实搜索用户锚点或含准确 turnId 的 shell section 选择当前 native turn。
- `cos-picker-main.js`：先证明消息所属对话、精确用户消息 ID，再传 `activity`。搜索布局键不是消息身份。
- `extension/dom-adapter.js`：主世界/隔离世界之间仅投影严格筛选后的状态、用户/助手公开文字与图片描述，不导出私有思考、调用参数、结果正文、URL、凭据。
- `extension/content.js`：同一已确认 Send 的活动变化才上报；已通过的授权/归属闸门不改变，**不会根据工具活动重新发送消息**。
- `server/activity.mjs`：验证阶段、有限步数及标题；`server/broker.mjs`：按 session/turn/lease/tab/document/conversation 验证归属，活动记录使用同一行 ID 更新。活动不能结束一个 Turn。
- `server/provider.mjs`、`client/native-activity.tsx`、`shared/activity.ts`、`index.client.tsx`：Paseo 时间线卡片与独立状态提示。无 `timeline.plugin` 能力时退化为短通知，不伪造助手回答。

## 可见状态

| 类型 | Paseo 对话中的显示 | 判断证据 |
|---|---|---|
| 思考或处理 | ChatGPT 正在思考 / 网页正在处理 | 同一 user turn 的原生 `in_progress` 和公开阶段 |
| 搜索 | 正在搜索资料，带工具条目 | 原生 `mcp-tool-call` 的公开工具名称 |
| MCP 工具 | 正在调用工具；步骤显示进行中/已完成 | 同一 `turn.items` 工具 callId 和 `completed` |
| 代码 | 正在执行代码 | 原生 `dynamic-tool-call` 的 `exec` 类型 |
| 生图 | 正在生成图片，结束后继续显示图卡 | 已验证的 `generated-image` item 状态 |
| 等待授权 | 等待网页授权 | 原有 CoS 页面授权卡侦测（仅公开待决事实） |
| 最终确认 | 正在确认最终回答 | 完成尚未确认时不把页面空闲当作最终成功 |
| 已完成 | 本轮已完成 | **同一 native turn 的已确认最终回答/图片完成回执** |
| 失败 | 本轮跟踪已停止 | Runtime 原有确切失败/归属保护 |

具体状态卡是 `type=plugin,kind=native-activity,version=1`，同一轮始终使用 `activity:<turnId>`，重复状态不追加历史。停止/失败后卡片同步显示最终状态。最多12个公开步骤，不泄露工具参数和私有内容。

### 原生最终态优先级

过去即使 ChatGPT 的最终消息已经带原生完成证据，页面遗留停止按钮也会让 Paseo 多等约4秒。现在只在**同一已确认用户消息的 native turn 确认 `complete` 且最终消息有原生终态**时允许绕过残留 Stop 按钮，保留约1秒稳定检查；否则仍遵循原有严格确认。工具调用/授权进行中不会当作完成。

## 保留的限制

1. 这仍不是 CoS 完整事件/结果归属层。特别是 CoS 的网络发送请求 ID 证明 `sentRequestSince` 需要额外安全审查，**尚未接入**；仅能读取 native turn 的情形仍可能遭遇 `RECEIPT_UNCONFIRMED`。不得以发送按钮点击、URL变化或工具启动替代回执。
2. 不输出私有思考文本。CoS 的公开工具轮廓已移植，但所有内部 reasoning 文本/工具参数/工具结果/网络资源地址均被主动省略。不能显示未公开、无稳定原生归属的工具动作。
3. 页面授权卡只能由 Chrome 上实际出现的公开 UI 判断；不会自动同意授权，也不假设 MCP 权限已授予。
4. Chrome MV3 的后台节流仍会影响 750ms 轮询；这是近实时而非零延迟。当前正文仍主要发送完整快照，不是增量 Delta。
5. 现有 blocked（`RECEIPT_UNCONFIRMED`、`BROWSER_BINDING_LOST`）不解除、不会自动重发或复用失败消息。浏览器重启未获可证明状态时继续 fail-closed。
6. 本轮测试使用独立 Chrome 配置、模拟 ChatGPT 网页和真实安装的 Paseo SDK。**未对用户登录的真实 ChatGPT/Paseo UI 做完整实机验收**。

## 回归证据

- Node 测试 **169/169 PASS**，包含活动输入安全、身份隔离、进度幂等更新、实际 Provider 事件、终态/失败态。
- 完整 MV3+真实 Runtime/已安装 SDK：公开工具状态转发 **8项**；并发/关页续聊 **11项**；原生完成仍保留旧 Stop 控件 **8项**；图片 URL/blob/预览缺失各 **6项**。
- 旧浏览器回归：12支 Python 测试均退出 0，涵盖发送回执、搜索消息锚点、菜单发现、浏览器 DOM 等。
- 手机/桌面 UI **20项**；完整 TypeScript/React Native 类型检查；CoS 来源模块 SHA + MIT 声明验证。
- 保存详细记录于 `docs/evidence-native-lifecycle-alpha3-10/`（部分隔离 MV3 合同见对应测试脚本）。

## 安装与验收

不在运行中的页面上刷新：等待已有轮次全部完成，在 Paseo 手动重载根插件，Chrome 手动重载 `extension/`；版本分别是 **0.1.0-alpha.3.10**、**Chrome 0.1.12**，页面引擎 `cos-native-alpha3.10`。无需重新配对。使用**新的**简单提示与新会话测试：先出现“正在思考/工具”卡片，完成后相同卡片更新“本轮已完成”；然后测试搜索、需手动授权的工具、生图、并发。**旧的结果不明消息绝不能重发。**

此轮没有对生产 `~/.cos-in-paseo` 状态或 Chrome 账号进行清理、重放、重启或提权；只修改源码、文档、隔离测试。
