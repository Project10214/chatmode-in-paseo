# COSINPASEO-1 — 双向 Runtime / 网页主动轮次：开发候选与验收边界

日期：2026-10-15。版本：Paseo 插件 `0.1.0-alpha.4.0`、Chrome 扩展 `0.2.0`、引擎 `cos-native-alpha4.0`、CIP v4、Paseo Provider v1。

> **仅源码与隔离联调；未部署到生产 Paseo/Chrome，也没有在真实已登录 ChatGPT 账号中验收。不得据此标记 COSINPASEO-1 Done。**  
> 保持 alpha.3.15 的原生**单选**「工具」下拉；本任务未恢复 COSINPASEO-3 的多选实现，未改 JEV，也未开发 COSINPASEO-2 的详细思考/工具卡。

## 1. 架构决策

- **共享 Runtime 持续运行，会话身份持久化，单轮资源按可信终态释放。** 结束一轮只释放该会话的运行状态、占用和观察，不删除 `conversationId`、Paseo/Provider 的持久会话标识、已确认的 native user ID 与历史。
- **Paseo → ChatGPT**：继续沿用原先 Broker 排队 → 权限/唯一 Send → 原生回执 → 可恢复跟踪；原会话后续发送只发送新的消息。已验证关页后的原对话续发。发生结果不明时仍拒绝重播。
- **ChatGPT → Paseo**：已绑定原生对话在 idle 时，扩展读取最新公开原生 user ID。只有上次已确认的 user ID 仍可定位且**恰有一个新用户消息**时，才通过受配对保护的 `POST /external-turn` 请求导入。Broker 在一笔持久事务中核对 session、conversation、tab/doc、原生消息身份和旧锚点；标注 `origin=browser`，向 Provider 推送 `session.turn:started` + `timeline.item:user_message`。这条路径**不调用网页 Send、不登记 clientMessageId、不再发送一遍原输入**。
- **网页回复**：已导入的 `turnId/lease/nativeMessageId` 复用现有 snapshot、activity、completed/failed 的观察链路，Paseo 按原生自主轮次显示；原生终态后恢复 idle，下一条 Paseo 发言仍能使用相同 ChatGPT 对话。
- **Paseo 闲置或关闭的 Agent**：`server/wake.mjs` 将已绑定 Runtime UUID 精确映射到原 Paseo Agent ID；通过 SDK `agents.ref(agentId).commands()` 的只读接口借用 Paseo 0.11.2 宿主的 `ensureAgentLoaded` 懒恢复机制。没有匹配 Agent、上下文尚未就绪或出现歧义时保持待恢复/记录失败，绝不新建 Agent 或发送 ChatGPT 消息。
- **工具配置**：运行中切换工具只存 `pendingConfig`；当前已发送消息依旧采用原配置。下次 Paseo 发送前，先应用并核实待生效配置。选择返回当前配置可撤销 `pendingConfig`，避免错误积累为 `CONFIGURATION_PENDING`。
- **旧轮次交接**：网页出现更新的 user ID 时，同一 document 的旧 monitor 优先核对旧轮次的真正 final，不立即报告绑定丢失；旧轮次完成后再由空闲观察器导入新消息。状态不明时不会强行宣告完成。
- **遗漏场景**：同一锚点后出现多个新用户消息，不凭网页顺序猜测或偷偷补录；仅登记 `external-gap` 警告，保留原对话链接。

## 2. 代码范围

- `server/broker.mjs`：idle bindings、网页轮次原子导入、终态更新、pendingConfig、缺口记录。
- `server/runtime.mjs`：`GET /bindings`、`POST /external-turn`、`POST /external-gap`，导入后触发唤醒回调。
- `server/provider.mjs`：原生自主轮次和 timeline 事件；Paseo 运行中修改配置延后生效。
- `server/wake.mjs`（新增）：精确映射并按需恢复原 Agent，不发送消息。
- `index.server.ts`：将唤醒协调器接入原 Paseo 插件生命周期与 Runtime。
- `extension/background.js`：MV3 轮询 idle 会话、识别归属、传输已验证候选；只读 page hint 不含正文。
- `extension/content.js`、`extension/dom-adapter.js`：读取新用户消息、优先核对上一轮 final，不将用户直接续聊误报为失联。
- `server/protocol.mjs`、`extension/manifest.json`、`package.json`、`docs/PROTOCOL.md`、`README.md`：候选版版本边界与协议文档。

## 3. 测试证据（隔离环境）

- `/opt/homebrew/bin/node --test tests/*.test.mjs`：最终完整运行 **236/236 PASS**。
- `/opt/homebrew/bin/node .test-tools/ui/typecheck.cjs`：**20 files / 0 diagnostics**。
- `/opt/homebrew/bin/node scripts/check.mjs`：**409 JS files、JSON/权限检查 PASS**。
- 已安装 Paseo 0.11.2 Provider SDK Schema：**1/1 PASS**。
- `CIP_CHROMIUM='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' .test-tools/bin/python tests/binding-mv3-flow.py`：**9/9 PASS**。使用真实 Chrome 扩展、MV3 Service Worker、原生 Provider 和临时 Runtime，ChatGPT 页面/网络为隔离夹具；新增真实网页编辑器直接发送与随后回到 Paseo 发送的双向往返、原生事件与 Send 去重。
- 新增 `tests/cosin-paseo-1.test.mjs`、`tests/cosin-paseo-1-browser.test.mjs`、`tests/cosin-paseo-1-http.test.mjs`，覆盖持久绑定、幂等、异常拒绝、工具延后生效、原生事件、唤醒与 HTTP 认证。

## 4. 已知未完成与安全边界

1. **真实已登录 ChatGPT 与真实已安装 Paseo 的双向唤醒/前台 UI 验收尚未执行。** 需要在所有已有任务完成后，才可成套重载新版 Paseo 插件/Chrome 扩展并刷新空闲网页。
2. **Paseo 整个应用/Daemon 已退出时，不保证仅凭 Chrome MV3 唤醒本机应用。** 当前唤醒依赖 Paseo 进程已经启动并提供插件宿主与共享 Runtime；系统级拉起需另行评估 native messaging / Launch Services，未经实测不声称支持。
3. **异常旧轮次的完成证据不可伪造。** 即使 Paseo UI 显示 idle，若 Runtime 仍有未确认发送/原生工具状态，当前实现保持运行锁；不会为消除 SESSION_BUSY 强行结束工具、释放不确定的原始发送。原先那个长期挂起 Agent 仍需真实网页和 Runtime 状态专项验收。
4. **插件宿主没有上下文或映射不到唯一 Agent 时，网页端新轮次会在 Runtime 持久化，但 Paseo 可能尚未实时恢复展示。** 需要通过正常宿主恢复重新连接并从持久 history 补齐，不允许对错误 Agent 发布事件。
5. 网页原生 DOM/React 公共信息在真实 ChatGPT 更新后可能不可读；遇到同一锚点后多轮消息、原生 ID 不可信、重复标签页或页面归属冲突时必须拒绝猜测并明确提示。
6. 多 Agent、掉线和真实暂停/停止的长期回归，以及插件升级/恢复后的端到端验证仍需补足。COSINPASEO-2 的原生 thinking/tool-call 详情同步不在本任务内。

## 5. 安装与验收门槛

1. 选择所有 ChatGPT 工具调用已结束的窗口；**先备份、不要直接替换在运行的插件**，不要删除 `runtime.lock` 或生产 `~/.cos-in-paseo` 状态。
2. 成套更新 Paseo 插件与 Chrome 解压扩展，确认 CIP v4、引擎 `cos-native-alpha4.0`，只刷新空闲标签页。旧 CIP v3 不与新版混用。
3. 在已绑定原 Agent 的 ChatGPT 页面手工发一条唯一的新消息：Paseo 自动启动原生自主轮次、用户消息和回答对应出现，网页只发生一次发送。
4. 完成后回到原 Paseo Agent 再发一条新消息：同一 ChatGPT Conversation 继续，工具新配置按预期生效。
5. 验证暂停/重连、插件宿主中断/恢复、旧轮次未结、多个标签页、重复送达、网页只读临时失败、模型工具长运行及配置临时变更的安全性。
6. 只有真实联调成功且没有消息丢失、重复投递或运行状态倒挂时，才能将该任务标为 Done。

## 6. 后续对抗审核和 COSINPASEO-2 联合版本（2026-10-15）

本页前述 alpha.4.0/CIP v4 是 **COSINPASEO-1 首轮历史候选版本**，不是当前最新开发源码。后续按用户要求做四项对抗复核并即时返修，然后直接施工 COSINPASEO-2；最新组合 **alpha.4.1 / Chrome 0.2.1 / `cos-native-alpha4.1` / CIP v5**，仍基于 Paseo Provider v1。

- 对抗审核：**四项原先复现失败，修复后全部通过**。涉及重复原生消息正文/文档身份、旧 tab 未消失时新 tab 不得接管、external-gap 必须核对 tab/原生锚点、归档 Paseo Agent 不得被误唤醒。详见 [COSINPASEO-1 对抗审核与返修](COSINPASEO-1_ADVERSARIAL_20261015.md)。
- 在同一 Broker 的 `native_timeline` 事件路径补充公开 reasoning/tool_call；仅限网页公开摘要和明确显示、精确 callId 归属的工具状态/详情。详见 [COSINPASEO-2 开发记录](COSINPASEO-2_DEV_20261015.md)。
- 联合回归：**246/246 Node PASS**、Chrome MV3 正常 **10/10**、转义 **11/11**、已安装 Paseo 0.11.2 SDK、21 文件 TypeScript 全检、12 份上游移植哈希均通过。
- 本机生产 Paseo/Chrome 与真实已登录 ChatGPT 完全未更新，生产连接/工具会话未触碰。**COSINPASEO-1 与 COSINPASEO-2 均应保持 In Progress**，不得因模拟测试通过而标 Done；整个 Paseo Daemon 退出后的系统唤醒和历史挂起会话还需真实验收。
