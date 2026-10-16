# Chrome 完全退出后恢复：BROWSER_BINDING_LOST / NATIVE_BUSY 修复（2026-10-15）

## 现场证据（本机只读）
用户于 22:19 左右通过 PhotoWhisper 工作区的 Chatmode Agent 进行 Chrome 退出后的继续对话验收。已通过 Paseo CLI 和 CIP Runtime 持久状态对照（不复制、输出或发布提示正文和认证信息）：
- 22:18:46：Ensure 成功。
- 22:19:02：Send 取得一次性网页原生回执，但 Chrome 退出后 Paseo 旧轮次报告 BROWSER_BINDING_LOST。
- 22:20:21：Chrome 自动恢复之后，原绑定 Conversation 的 Ensure 成功。
- 22:20:33：新 Send 因 NATIVE_BUSY 在授权与点击之前被拒；不是消息已成功送达，也不是自动拉起失败。
- 现场复核时同 Agent 已回到 idle/completed，说明这些错误不是持续的浏览器离线。

## 确认根因
1. `extension/background.js::watchSession` 在原 Chrome tabId 消失、标签导航到其他对话、候选身份变化等恢复性条件下直接发 `binding_lost`，导致 Runtime 提前给上一轮标记 failed，即使 ChatGPT 仍在生成。
2. 新一次 Paseo Send 因 Runtime 已将旧轮标为结束而进入网页。实际上 Chrome 恢复原 Conversation 时可能仍显示 Stop/正在生成；`extension/dom-adapter.js::configure` 立即抛 NATIVE_BUSY。
3. 额外对抗性核查发现：老 tabId 已导航到**另一个**对话且没有匹配替代标签时，`watchSession` 原本可能继续沿用这个外来 tab 对象进行身份检查。必须立即丢弃该对象，不允许监控或操作其他会话。
4. `chrome.tabs.onRemoved` 原本立即执行 pump，新恢复逻辑如果不处理，可能在用户主动退出 Chrome 的过程中重新创建浏览器窗口。

## 已实现
- Active turn 的已绑定 Chrome 标签丢失时，只打开**原持久 Conversation URL**（一个受管后台标签）；仅当确切网页原生 user message ID、文档与会话身份验证通过才重新绑定监控。无法验证时持续报告 observation_gap 并重试，不伪造已完成，不重发旧消息；多个候选标签或其他 Session 已拥有的标签均拒绝接管。
- 持久记录待恢复 tab，Service Worker 重启后重用而非反复开标签。旧 tab 指向其他 Conversation 时将其丢弃，不修改或劫持该页面。
- 退出 Chrome 的 onRemoved 事件只清除旧登记，不立刻重开；下一次 Chrome 启动或周期轮询恢复。
- 未确认 Send 的文档/标签消失不直接宣称 binding_lost；由于旧网页回执可能已丢，仍保持未确认，绝不自动补发。
- `configure` 对真实网页正在生成的状态最长等待 30 秒，并要求连续 500ms 原生空闲后才允许新 Send；时间预算必须保留后续一次性回执检查。
- Paseo Provider 允许在**上一轮仍运行时**接受一个新用户提示并等待旧轮结束。先唤醒 Chrome、后等原轮次；不抢占并发发送名额，不预授权，不重发旧 prompt。取消/关闭会中止等待。旧轮结束后才对新的 clientMessageId 执行下一次唯一 Send。

## 验证与边界
- 新增 COLD1–6：丢失/重启/复绑、原 ID 精确匹配、外来标签隔离、未确认回执保留、Chrome Quit 不强行重新创建窗口，全部 PASS。
- 原生离线 Chrome 实测：忙碌→空闲等待→只发送一次新消息，PASS。
- 原生 Provider 隔离测试：旧轮未终结前第二条新消息无 Send；旧轮完成后恰好一次新 Send，PASS。
- 全量 Node 回归 **306/306 PASS**，源码/清单静态检查 **487 文件 PASS**，CoS 移植来源校验 **12/12 PASS**，真实隔离 Chrome 编辑框 **13/13 PASS**；Chrome 唤醒与扩展更新专项 **25/25 PASS**。
- 生产实机 Chrome 完整退出→同一 Agent 恢复的端到端测试尚未执行；本机缺少 `tsc` 可执行文件，TypeScript 类型检查未完成（不是通过）。
- **没有退出或更新用户目前正在工作的生产 Chrome/Paseo Agent，没有在真实 ChatGPT 账号制造新对话/重复提示。Chrome 完全退出后的生产端到端验收仍待安全维护窗口完成。** 以前「单个受管标签页关页重开」的真实 PASS 不能替代本次冷启动验收。

## 版本与安全部署
- 本地候选：Paseo `0.1.0-alpha.4.6` + Chrome `0.2.9`，CIP v5 / cos-native-alpha4.3 不变。
- 两端必须配套加载；版本号/源码变化**不等于正在运行的生产插件已更新**。旧活动轮次先让网页完成并核对原生 MCP 结果，再在空闲窗口安全更新。
- 升级后，用同一个原 Agent、新的唯一消息测试：Chrome 正常→退出→Paseo 发送新消息→Chrome 自动拉起→原 Conversation 自动恢复→若先前正在生成先等待→新消息仅发送一次并拿到真实回执/最终答复。遇到前一条结果不明，只看原 ChatGPT 会话核对，不重发它。
