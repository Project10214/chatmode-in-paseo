# COSINPASEO-1 / COSINPASEO-2 真实账号实机验收（2026-10-15）

## 环境与范围

- 主机：Penn 的 Mac；Paseo CLI / Daemon `0.11.2`；Chatmode Provider 可用，运行中的项目插件来自本项目目录。
- 当前项目代码：Paseo 插件 `0.1.0-alpha.4.1`、Chrome 扩展源码清单 `0.2.1`；生产 Runtime `GET /hello` 返回 `protocol:5`。未独立核查 Chrome 已加载扩展的 manifest 版本。
- 专用验收 Workspace：`wks_54c13fdd13424569`；验收 Agent：`4fe685fb-e98b-4223-b6bd-861f4e229c36`；Runtime session ID 尾号 `259aa783`；ChatGPT Conversation ID 尾号 `edd7ef6b3d`。
- 原本还有其他进行中的 Agent；没有重启 Paseo / 共享 Runtime、清理锁、刷新其他 ChatGPT 标签页、审批权限或操作其他任务。验收仅对上述专用 Agent 和其专属浏览器标签页进行发送、关闭和恢复。
- 本报告是 **真实登录 ChatGPT + 正式运行中的 Paseo / Chrome** 的操作结果，区别于此前离线 MV3/Node 模拟测试。

## COSINPASEO-1：实机通过项目

| 用例 | 实际操作与证据 | 判定 |
| --- | --- | --- |
| Paseo → ChatGPT → Paseo | `paseo run --provider chatmode/gpt-6 --thinking none` 创建专用 Agent，首轮收到准确 `CIP_LIVE_A_OK`；Paseo 返回 idle、Runtime 记录可信完成回执，只有一次 Send。 | **PASS** |
| 原 Agent 原会话续发 | 同 Agent 第二轮收到 `CIP_LIVE_B_OK`，Conversation ID 不变，共 2 次 Send；完成回执到达较回复文字有可观察延迟，但最终 idle/completed。 | **PASS**（有终态延迟） |
| Chrome 直接发言 → Paseo | 在专用 ChatGPT 网页编辑器手工粘贴并按 Return 发送 `COS1_WEB_DIRECT_TEST_20261015`，收到 `CIP_WEB_REPLY_OK`；原 Paseo timeline 同步新 user_message 与 assistant_message；Runtime `turn.origin=browser`，Send 命令数仍为 2，状态恢复 idle。 | **PASS** |
| 关闭网页标签再续聊 | 专用会话 idle 后，仅关闭标题 `CIP Live Test A` 的 Chrome 标签；从原 Paseo Agent 发 `COS1_REOPEN_TEST_20261015`，收到 `CIP_REOPEN_OK`，原 Conversation ID 尾号 `edd7ef6b3d` 不变；Chrome tabId 从 `2029412094` 变为 `2029412098`；Send 数从 3 增至 4（只新增一次）。 | **PASS** |

### COSINPASEO-1 未完成的验收边界

- Paseo Daemon **整个进程已退出时**的 Chrome → 宿主系统级主动拉起，当前实现未覆盖；实机不能以“Paseo 已运行时唤醒”冒充这一条件。为避免影响其他运行中的 Agent，未关闭全局 Paseo。
- 真机长时间断网、多标签页竞态、同时 Stop、未确认工具副作用等组合尚未做实际生产端到端压力验收。
- 状态建议：**In Progress**，核心正反向通信与关页恢复已实机通过，但不宣称全范围 Done。

## COSINPASEO-2：真实场景复现未通过

1. 将**仅专用验收 Agent** 的 GPT-6 thinking 从 `none` 改为 `xhigh`；发起 `COS2_REAL_TOOL_TEST_20261015`，要求由 `mymac` MCP 只读检查 `package.json`、`extension/manifest.json`。
2. 真实 ChatGPT 页面显示思考/运行提示与 MCP 工具权限等待；没有人为批准权限。测试轮最终文字回答报告版本 `0.1.0-alpha.4.1` / `0.2.1`，并输出 `CIP_TOOL_TEST_DONE`。**该自述不等于已独立核对两次工具真实调用回执**。
3. 从生产 Runtime `~/.cos-in-paseo/state.json` 只读查询**专用 session**，直到本轮可信 `idle/completed`：Paseo history 只有 `user_message`、`plugin`、`assistant_message`，`tool_call=0`、`reasoning=0`。CLI `paseo logs` 也只有普通文本和用户消息，**没有分别呈现原生工具卡**。
4. 因此 **COS2 原生工具事件同步实机不通过**。网页上只有 `Worked for 33s` 之类公开进度标识，不能证明本轮存在公开 `reasoningRecap.summary`；思考摘要的独立实机验收为 **未证实**，不能伪造为失败或成功。未确认真实页面有公开 input/output 字段，也不能保证实现可抽取调用详情。

### 下一步定位与返修门槛

1. 在专用测试会话中只读比对真实网页**可见且允许读取**的思考 recap 与工具卡及其原生 ID/公开字段，核对 `extension/upstream/cos-activity-main.js` / `cos-shell-public.js` 的实际识别是否与当前网页一致。
2. 在严格脱敏、会话身份正确的条件下记录 `dom-adapter → content → background → Runtime /event(native_timeline) → Broker → Paseo provider` 每段是否产生事件，找出首个断点；不访问隐含推理或未公开工具参数。
3. 修复后在真实登录账号、两个独立公开工具调用和**确有公开思考摘要**的场景重验：原生 tool_call 分卡、开始/更新/成功失败、可见详情、原生 reasoning 区、终态、去重与重连。
4. 状态建议：**In Progress / 实机不通过**，不可标 Done。

## 收尾与影响

- 验收 Agent 已恢复 `thinking=none`，最后一轮 `idle/completed`；专属测试标签在关闭后因下一轮已自动重建，绑定保留。
- 未编辑源代码、未部署新版本、未修改其他 Agent/会话，也未修改 Presure 两任务完成状态。

## 补充实机验收与运行状态复核（2026-10-15 10:14 CST）

- **COS1：双 Agent 并发隔离 PASS。** 原测试 Agent A 收到 `CIP_CONCURRENT_A_OK`；新建专用 Agent B（`109428c7-0178-412f-8ca9-e5a14b2d5c05`）收到 `CIP_CONCURRENT_B_OK`；两者 ChatGPT Conversation ID、tabId、Runtime session 均不同，准确归属于各自会话并最终 idle/completed。
- **COS1：Stop/取消 PASS，取消后恢复最终 PASS（存在终态回传延迟）。** 仅对专用 Agent B 发送长思考测试并执行 Paseo Stop，记录 `outcome=canceled`、`status=idle`；随后同 Agent 发 `COS1_AFTER_STOP_TEST_20261015`，收到 `CIP_AFTER_STOP_OK`。回答文字出现后一度维持 running，即使通用状态已有 `nativeStatus=complete`；最终确认为 `idle/completed`，不是永久假死。这个延迟需独立分析，但不能记作即时完成。
- **COS2：生产事件缺口仍在。** 当前生产 Runtime 所有会话历史事件类型统计仅 `user_message`、`assistant_message`、`plugin`；`reasoning` 与 `tool_call` 均为 0。真实 mymac 工具场景中，`native-activity` 步骤数也为 0。源码中的 Runtime native timeline 处理器及 Paseo SDK 合约测试仍通过，因此优先查公开页面事件提取、筛选、匹配与发送前段；尚未证实首个丢失环节，更未证实真实可见的 recap 摘要字段存在。
- **COS1 未验边界：** 整个 Paseo 进程退出后由 Chrome 独立启动 Paseo 未实现或未证明；为保护其他 Agent，没有关闭共享 Daemon。持续断网及复杂竞态尚未全量覆盖。两任务都不应标 Done。
- **运行状态复核：** 10:14 本机 `paseo status` 表示 Daemon `0.11.2` 正在运行；Runtime `/hello` 返回 `protocol=5`；两个专用验收 Agent 均为 idle、thinking=none。另有一个非验收会话仍处于 running，未予操作。没有重启共享服务、删除状态、修改其他 Agent 或批准权限。
