# Chrome 0.2.7：真实工具事件诊断、解析修复与更新恢复

日期：2026-10-15 · 组件：Paseo 插件 `0.1.0-alpha.4.4`、Chrome 扩展候选 `0.2.7`、CIP v5、引擎 `cos-native-alpha4.3`。

**总体判断：解析器代码缺陷已定位并修复，真实页面公开事件的离线注入读取和真实 Chrome MV3 隔离回归已通过；生产环境 Chrome 仍需在其他 Agent 空闲后升级并完成 Paseo 原生工具卡验收。不能把本轮标记为完整 Done。**

## 1. 有证据的生产问题（COSINPASEO-2）

本轮复用专用已登录 ChatGPT Agent A。先要求它调用 mymac 读取已有测试文件，返回了真实文件的正确 SHA256，但 Paseo 仍无独立 tool_call，只有 reasoning。

为了排除模型凭历史答复猜测，新增两个**生成后内容不可预测、哈希从未给到模型**的临时文件，通过同一原 Agent 要求对每个文件独立调用 mymac read。结果：ChatGPT 答复中的两条 SHA256 均与开发机重新读取文件得到的 SHA256 完全一致；同一 Session 的最终状态 `idle/completed`，但 Paseo 存储里的 `tool_call=0`。

随后通过现有浏览器连接器只读打开这一**确切专用 Conversation**，检查其公开展示数据与已提交 React turn 数据结构。证据：

- 当前该轮 `turn.status=complete`；
- `chatgpt-reasoning-group.reasoningRecap.type=collapse`，公开摘要可同步；
- 在同一个 group 里确实存在**两个不同 `callId`** 的 `mcp-tool-call`，来源 server 为 `mymac`；
- 工具名称原生格式为 `link_<opaque-hex>/read`，而此前 `cos-activity-main.js` 中 `TOKEN` 校验不允许 `/`，导致 `publicTimeline` 与 `viewCallsOf` 静默丢弃工具；
- 页面原生数据中这两个工具条目的 `completed` 仍是 `false`；虽然最终模型答复已经完成，**不得把这个布尔字段猜成成功**；
- 对应工具公开 DOM 没有可准确通过相同 `callId` 绑定的输入/输出卡片，不提取后台 `invocation.arguments` 或私有结果。

这证明至少**独立工具卡丢失的一个确切根因**在本地名称过滤链路，而不是文件读取未成功。但仍须验证安装后的 Paseo UI 实际显示效果。

## 2. 修复

`extension/upstream/cos-activity-main.js` 新增受限 `displayTool`：仅在原生工具字段严格匹配 `link_<16–64 位十六进制>/<安全 action>` 时提取最终 action 名，配合验证过的公开 server 显示为 `mymac · read`。其他任意路径、URL、非法字符、非公开/隐藏项继续拒绝。保留原生 `callId` 仅用于会话内幂等，不泄露不透明的 link 标识、调用参数、token 或私有思考。

已直接把修改后的完整 MAIN-world reader 在**刚才的真实 ChatGPT 页面**上执行，返回 `callCount=2`、`distinctCallIds=2`、两个名称均为 `mymac · read`、`reasoningCount=1`、无 link 标识泄露。两工具仍为 `running`，因为来源 `completed=false`；完成时 Runtime 必须保留“结果未确认”而非伪造成功。

新增 `COS2-REAL`、`COS2-REAL-SAFETY` 回归，并把真实 MV3 隔离联调工具名替换为 `link_<hex>/read`，覆盖完整 Chrome 扩展 → Runtime → Paseo Native tool_call 两张工具卡的传递。修改过的上游适配文件 SHA256 重新记录于 `vendor/cos/provenance.json`；原版保存在 `.local-backups/cos2-real-link-tool-20261015/`。

## 3. 另外发现：开发者模式手动重新加载不保证收到更新事件（COSINPASEO-1）

上轮独立 Chrome 实验证明：用户在 `chrome://extensions` 使用开发者模式更新后，即使 Manifest 从旧版变为新版，也不一定触发 `onInstalled(reason='update')`。原先的恢复计划只依赖该事件，因此可能漏刷新。

`extension/background.js` 增加 `loadedChromeVersion` 持久化比较：如果新 worker 启动时实际 Chrome Manifest 版本不同，且已有已配对的受管标签，**原子写入版本和恢复计划**，调用原本已实现的 `/recovery-targets`、精确 `sessionId + tabId + Conversation ID` 对照、受管标签 reload 和 `/resume-agent`。仅后台 MV3 worker 重启、版本不变时继续旧计划；新安装且未配对不触碰标签；没有权限放宽或再次发送旧消息。

新增 `UPDATE11–15` 等回归，覆盖开发者模式无 update 事件、旧版首次迁移、未配对的新安装、同版本后台重启，以及版本变更已创建恢复计划后迟到的 update 事件（不能二次刷新），全部通过。

**独立 Chrome 实验进一步确认：** 使用 Chrome for Testing 的独立 Profile、实际已加载的 MV3 插件，以及本机隔离假 Runtime／假 ChatGPT 页面。先加载旧版并保存绑定，然后从同一目录、相同 Extension ID 加载新版（开发者模式行为，不假设 `onInstalled(update)`）。观察到假页面的真实 reload 次数从 1 增到 2、访问 `/recovery-targets`、请求 `/resume-agent`，且没有 `/claim`、`/authorize`、`/result` 等发送链路副作用：**PASS**。

对应可重跑测试：`tests/manual-reload-mv3-flow.py`，全部运行于一次性 Profile，没有生产 Cookie、ChatGPT 登录、Paseo Agent 或生产 token。

**最终回归：** Node 单元/集成 **290/290 PASS**，真实 Chrome MV3+隔离 ChatGPT/Runtime **11/11 PASS**，手动扩展更新恢复 Chrome 实验 **PASS**，上游来源哈希 **12/12 PASS**，静态 JS/JSON 检查 **479 文件 PASS**，TypeScript/SDK **22 文件、0 错误**。所有这些仍不等于安装新版后的真实生产 Agent 工具卡已验收。

## 4. 仍未完成的生产实机验收

- **COSINPASEO-2：** 把 Chrome 扩展 0.2.7 安全更新到生产 Profile 后，发送两个不同的真实已授权只读工具调用，确认 Paseo Native timeline 出现**两个不同 callId 的独立卡片**。仅把新版 reader 在 ChatGPT 页面中直接执行以及隔离 MV3 联调通过，都不等于生产 Paseo 回传通过。
- **COSINPASEO-1：** 关闭确切**受管**测试标签后，由同一个 Paseo Agent 下一条消息新开同一个 Conversation；网页人工发言 → 同一个 Paseo Agent 的自动回传；真实 Chrome 更新引发的 Agent pipeline 唤醒；整个 Paseo 冷启动。
- 用户已确认 Chrome 0.2.6 的 UI 根宽度修复通过，**不要为更新 0.2.7 打断其他正在工作的 Agent**。真实 ChatGPT 测试对话在桌面浏览器工具中的关闭操作遭到“当前对话被 ChatGPT orchestration 管理”的保护拒绝；未绕过此限制，也没有把此拒绝误写为恢复失败。
- 真实工具字段 `completed=false` 在完整答复后仍成立，属于网页所提供的状态证据限制；仅能报告可信的调用 ID / 可见名称，不能把工具成功状态臆测为 `completed`。

更新后仍以用户确认和 Runtime/Paseo 双向证据为准。COSINPASEO-1/2 均保持 In Progress，直到实机完成。
