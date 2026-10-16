# Chrome 0.2.7 更新后真实账号验收（2026-10-15）

## 结论

**核心缺陷「真实工具已经执行但 Paseo 没有独立工具卡」已经通过真实账号验收并修复。完整 COSINPASEO-1/2 仍不能统一标 Done。**

本轮使用正式 macOS Chrome 中用户自行更新的扩展，实际点击 Chrome 工具栏 CoS in Paseo 后，直接观察到版本 **v0.2.7**、连接正常、弹窗宽高约 **414 × 358**。Paseo `0.11.2`、CoS-in-Paseo 插件候选源码 `0.1.0-alpha.4.4`、Runtime CIP v5 均在线。用户未要求本轮重启共享 Paseo；未执行生产扩展重载或影响其他工作 Agent。生产 Paseo 已加载插件版本不能仅凭源码 `package.json` 证明，但真实工具卡已经实际进入其日志与持久会话。

## 真实验收记录

| 验收项 | 证据 | 判定 |
|---|---|---|
| Chrome 实际版本和 UI | 真实 Chrome 工具栏弹窗显示 `v0.2.7`，宽 414，状态「已连接 Paseo」 | **PASS** |
| 工具执行真实性 | 专用 Agent A `7faef68a-…-4b10e65e`，已登录 ChatGPT Conversation，要求用户已授权的 @mymac **分别执行两次独立 read**；两个新生成的随机文件 `cip027-live-A/B.txt` 的 SHA256 答复与本机独立计算 **逐项完全一致**，哈希未提前提供给模型 | **PASS** |
| Paseo 原生独立工具卡 | Runtime 持久历史出现 **2 条独立 `tool_call`**；名称均为 `mymac · read`，`callId` 不同；`paseo logs` 也分别显示两项工具条目 | **PASS：工具同步核心故障已修** |
| 公共思考和最终回答 | 同一 Agent 回传公开 `reasoning` 及终态 `idle/completed`，两份 SHA 回答均正确 | **PASS** |
| 最终工具状态准确性 | 实际 ChatGPT 页这类工具 `completed=false`、没有可信最终状态。Runtime 在回答终止时将未确认工具从 `running` 收口为 `canceled`，详细说明「轮次已结束，但网页没有提供该工具调用的可信最终结果」 | **有限制：不伪造成功，但显示 canceled 可能引起误解** |
| 隐私与事件身份 | 两条工具卡不同 `callId`，名称只有 `mymac · read`；持久内容不包含 `link_<hex>`、本机路径或内部私有参数 | **PASS** |
| 原 Agent 重载后工具记录持久性 | 只对空闲 Agent A 执行 `paseo agent reload`，返回 reloaded；2 张工具卡与 Conversation 仍在。随后发送唯一标记 `CIP027_AFTER_RELOAD_TOOL_20261015`，收到 `CIP027_RELOAD_OK`、消息与回答各 1 条、最终 idle | **PASS** |
| 同 Conversation 续聊 | 独立 Agent B `89258009-…-da3017693907` 发送唯一标记 `CIP027_REOPEN_B_20261015`，收到 `CIP027_REOPEN_B_OK`；消息/回答各 1 条、原 Conversation 未变、原 tabId 未变 | **PASS：正常续聊；非关闭后重开** |
| 已安装扩展自动刷新恢复 | 从旧候选到新版的生产事件链未进行旁路拦截；独立 Chrome MV3 + 隔离 Runtime/假 ChatGPT 的手动更新测试已证实相同 Extension ID、真实页面 reload 1→2、调用 `/recovery-targets`、`/resume-agent`，0 次新 Send | **隔离 PASS，生产场景仍待专项** |
| ChatGPT 网页直接发言→Paseo | 用户已在真实 Chrome 的专用 `CIP023_A_OK` 对话手动发送 `CIP027_WEB_DIRECT_20261015`；Runtime 的原 Agent A（Session 尾号 `1007bf0e`）收到**恰好一条** `user_message`，且有真正的原生 `messageId`，`turn.origin=browser`，同一 Conversation；对应 `CIP027_WEB_DIRECT_OK` 恰好一条，最终 `idle/completed`。该标记在 Agent A 的 Send 命令数为 **0**，其他 Session 的 user_message 中无重复导入。`paseo logs` 也显示这一轮及正确回答。 | **PASS（真实登录网页直发）** |
| **受管标签真正关闭→原对话重开** | 用户已亲自关闭 Chrome 中专用验收对话 `CIP023_A_OK` 的受管标签。此时原 Agent A 为 `idle/completed`，Runtime 保留原 tabId **`2029412163`** 和 Conversation。随后只从原 Paseo Agent A 发送唯一标记 `CIP027_CLOSED_TAB_REOPEN_A_20261015`：CIP `ensure` 在新的 tabId **`2029412185`** 成功，`send` 也在同一新 tabId 完成；原 Conversation ID `6ad0845a-3440-83e8-8145-f7feb384e144` 不变，原 Session 尾号 `1007bf0e` 不变。消息恰好一条、正确回复 `CIP027_CLOSED_TAB_REOPEN_OK` 恰好一条、最终 `idle/completed`。原有两张工具卡保留，Send 恰好按本轮增加一次，旧用户消息未重发，其他 Session 没有同一验收标记。 | **PASS（真实已关闭标签→新建受管标签→原 Conversation）** |
| Chrome→Paseo 完全退出冷启动 | 检查时存在 **2 个其他工作的 Agent**；不退出全局 Daemon，不中断其他任务 | **BLOCKED** |

## 重要边界

- **不得将工具回显中正确 SHA256 本身当作完整事件同步的证据**；此次另有两个已持久化的真正 Native `tool_call` 和 `paseo logs` 回执，因此核心故障判 PASS。
- 当前工具 `canceled` 表示「网页没有可信的完成回执」，并不证明 MCP 实际被取消；随机文件确实读取成功。这是状态表达限制，应另行改进 UI/Provider 对「未知最终状态」的呈现，不得擅自改成 completed。
- **网页直接发言已通过真实登录账号实测**：用户主动从 ChatGPT 网页发送的标记只作为原 Agent 的独立浏览器轮次导入，且未排入新的 Send。
- **关页重开也已完成真实验证**：用户关闭确切专用受管标签之后，Paseo 新一轮发送导致 Chrome 新建另一 tabId，仍使用原 Conversation，原历史保留、无额外旧消息重发。这不是普通续聊；旧新 tabId、Ensure/Send 回执均已独立比对。
- 此次未刷新任何其他 Agent 的受管标签、没有重新配对、没有重启 Paseo 或修改 Chrome 安全权限。原始随机文件只作为一次性读回证据。

## 代码与版本

- Chrome 扩展：`0.2.7`（实际已安装确认）。
- Paseo 插件源码：`0.1.0-alpha.4.4`，Runtime CIP v5。
- 核心修复：`extension/upstream/cos-activity-main.js` 安全提取 `link_<hex>/read` 的显示名称，准确保留工具 callId，不泄露 link 或隐藏参数。
- 开发模式更新恢复：`extension/background.js` 记录 loadedChromeVersion、精确受管标签恢复并防止重复 Send。
- 更新前的全量回归：290/290 Node，11/11 Chrome MV3 隔离联调，12/12 上游来源哈希，22 个 TypeScript 文件 0 诊断。**本报告本身记录的是更新后的真实账号验收，不以隔离结果代替。**

## 下一步

**网页直接发言与真实关页新建均已 PASS**，是 COSINPASEO-1 的关键验收闭环。仍待验收：在有安全维护窗口的情况下完全退出 Paseo App/Daemon，由 Chrome Native Messaging 有效 `wake` 自动启动并恢复原 Agent；生产版扩展更新后的主动唤醒流水线还需单独细节确认。当前其他 Agent 仍运行，不进行全局冷启动故障注入。COSINPASEO-1 暂保持 In Progress；COSINPASEO-2 核心缺卡故障已实机修复，但工具状态与原生图形 UI 细节仍有限制。
