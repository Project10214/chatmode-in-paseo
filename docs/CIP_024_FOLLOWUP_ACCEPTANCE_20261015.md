# CIP 0.2.4 / Paseo alpha.4.4：继续验收、修复与发布门槛

**日期：2026-10-15** · **结论：新候选已完成代码修复与隔离回归；真实账号全量验收仍未通过，未升级生产中 Chrome/Paseo。**

## 1. 证据区分

- 上一轮真实登录账号验收：Paseo alpha.4.3 / Chrome 0.2.3 的独立 Agent A/B 真实发送、同对话连续两轮、并发隔离、Stop 真取消与续聊、Agent reload 与续聊、Native Messaging 本机通信通过。详见 [CIP_023_REAL_ACCEPTANCE_20261015.md](CIP_023_REAL_ACCEPTANCE_20261015.md)。
- 上一轮真实工具测试：选择了 mymac 的 Agent A 两次均返回 `NO_TOOL_RESULT`；有公开思考摘要，**没有可信成功工具调用的源记录**。所以仍无法区分「网页没有调用应用」与「调用已经发生，但独立工具事件没被采集」。本轮还对当前共享 Runtime 持久状态作只读统计：91 个会话、96 条 reasoning、0 条独立 `tool_call`，未找到可供反向验证的成功真实工具调用样本。**不允许把这误判为工具卡解析器已确认出错或已修复。**
- 本次生成源码候选：Paseo `0.1.0-alpha.4.4`、Chrome `0.2.4`、原引擎 `cos-native-alpha4.3`、CIP v5。**本次修复没有重新加载到真实登录 Chrome/Paseo。**

## 2. 代码修复一：验证已选应用确实进入当轮发送请求

先前的 `cos-send-evidence.js` 只用正文 SHA256、ChatGPT 原生用户 UUID、单次点击及 SSE 响应建立发送网络证据，**没有独立核实 @ 应用引用确实序列化进该条请求**。如果用户在 Paseo 选择了 mymac，而网页只提交了普通文本，则 UI 已选工具不等于模型获得工具调用能力。

本次补丁：
1. 在仅针对本轮已授权 Send 的 `/backend-api/(f/)conversation` POST 正文内，收集已支持的两种公开引用：`app://asdk_app_...` Markdown、显式 `app_mention` 结构。严格比较这些引用与本轮 `appIds` 的集合。普通无工具消息按原规则处理。
2. **先验证本轮正文 Hash 和原生消息身份，再检测应用引用**。若找不到预期引用，网络通道返回有限枚举 `apps`，不暴露用户正文、应用 ID、凭据或隐私工具参数。
3. 在与网络回执独立的真实 DOM 消息确认后，`dom-adapter` 附加 `appNetworkEvidence: none | included | omitted | unverified`。仅当支持格式中找到所有引用才确认 `included`，未知网页格式只能 `unverified`。
4. Runtime 持久保存此枚举并在 Paseo 返回对应提醒。如果消息正文已送达但预期应用引用没有经过支持的格式核实，会提示「所选 @ 应用缺少网络提交证据」；**不会重发消息、不会替用户批准权限，更不会把工具成功凭空补出来**。

注意：`omitted` 是**当前支持的请求解析格式内缺少引用**，不能声称真实页面所有可能的其他元数据通道都不存在工具信息；工具是否执行仍以真实 ChatGPT 产生的调用与独立原生 `tool_call` 为准。

代码范围：`extension/upstream/cos-send-evidence.js`、`extension/upstream/cos-request-receipt.js`、`extension/dom-adapter.js`、`server/broker.mjs`、`server/provider.mjs`、`tests/app-receipt-browser.py`、`tests/broker.test.mjs`、`tests/provider.test.mjs`；上游归因哈希随修订记录在 `vendor/cos/provenance.json`。

## 3. 代码修复二：连续 Chrome 扩展更新恢复漏刷新

原 `extension/background.js` 在 `onInstalled({reason:'update'})` 后仅当浏览器内部 engine 名改变时重建 `upgradeRecovery`。如果先后两个扩展补丁仍用同一 `cos-native-alpha4.3`，第二次更新可能沿用第一次尚未完成的刷新计划。

修复为：**每个真实 update 事件都重新发现已绑定受管标签；单纯 MV3 worker 重启而没有 update 事件则沿用原持久计划**。仍检查唯一 `sessionId + tabId + Conversation ID`；不会按 URL 刷新其他同 Conversation 标签，不关闭重复标签、不重发旧消息。

新增 `UPDATE10` 回归，和此前 9 条一起 **10/10 PASS**。

### 独立 Chrome 升级事件探测

在临时扩展副本 + 临时 Chrome Profile 中做了两组实际实验：首次加载 0.2.4，然后把临时 Manifest 改为 0.2.5，通过 `Extensions.loadUnpacked` 再加载；另一组先退出隔离 Chrome 后重新启动并加载同一 Profile。两次均能读到 0.2.5，但扩展的 `onInstalled` 监听仍保留之前的 `install` 结果，**没有得到 `reason:'update'` 的真实回执**。因此不能把「开发者模式重新加载」冒充成正式浏览器更新过程；此部分仅有代码级回归，没有通过真实更新事件验收。无操作涉及生产 Chrome Profile。诊断脚本保留于 `.test-tools/mv3-update-event-probe.py`、`.test-tools/mv3-update-restart-probe.py`。

## 4. 复核结果（仅本候选 alpha.4.4 / 0.2.4）

| 项目 | 实际结果 | 证据限制 |
| --- | --- | --- |
| Node 全量回归 | **283/283 PASS** | 本地单元／集成，不等于正式网页 |
| 源码／Manifest 静态校验 | **474 JS + JSON PASS** | 不检查真实账号连接 |
| 上游裁剪来源／哈希校验 | **12/12 PASS** | 已记录这次的裁剪适配 |
| TypeScript / SDK 检查 | **22 文件、0 diagnostics PASS** | 本地接口兼容 |
| Chrome 真浏览器中的 @ 应用请求回执 | **12/12 PASS** | ChatGPT 网页和网络为夹具 |
| Chrome MV3 + 临时 Runtime / Provider | **11/11 PASS** | Chrome/扩展/Provider 真实，ChatGPT 页面离线夹具 |
| Chrome Native Messaging 本机通信 | **PASS** | 向原生程序发送无效操作并被拒绝；不代表冷启动已成功 |
| 正式账号工具调用 | **仍 FAIL / 未验证新候选** | 两次旧版真实测试为 `NO_TOOL_RESULT`，新代码尚未部署 |
| 正式账号网页直发／关页恢复 | **本轮 NOT RUN** | 不操作其他 Agent 绑定的浏览器页面 |
| 正式 Chrome 更新自动刷新／唤醒 | **本轮 NOT RUN** | 临时 Chrome 的重新加载没有 `onInstalled(update)` |
| Paseo App/Daemon 完全退出后的原生唤醒 | **本轮 BLOCKED** | 多个其他 Agent 仍运行，不能强行退出全局 Paseo |

本次修复源码备份：`.local-backups/app-mention-attestation-20261015/`、`.local-backups/update-second-event-20261015/`、`.local-backups/version-024-20261015/`。

## 5. 尚需执行的真实验收顺序

1. 在所有其他 Agent 已停稳的维护窗口加载 alpha.4.4 + 0.2.4。选择专用 Agent，**先用无需工具的唯一文字标记检查一次性发送**；再选择 mymac，发送唯一的只读文件测试，读取 Runtime 持久命令中的 `appNetworkEvidence`（`none/included/omitted/unverified`）。如果是 `omitted`，定位新页面 `@` 引用序列化格式；若是 `included` 但仍 `NO_TOOL_RESULT`，检查网页应用实际是否允许调用，再测试工具卡采集，不能跳过这一层。
2. 让真实 ChatGPT **成功执行两次不同的只读工具调用**，收集对应真实原生 callId、开始／结果状态；Paseo 应有两个独立且不重复的 `tool_call`，不泄漏隐藏思考与敏感参数。否则 COSINPASEO-2 保持 In Progress。
3. 专用受管标签执行实际「关闭→原 Conversation 自动重开→发送一条新消息」，对照浏览器用户手动发送的一条消息是否在原 Paseo Agent 生成独立轮次且不代发。额外模拟同 Conversation 的未受管重复标签。
4. 在可控专用浏览器环境真正执行 Chrome 扩展版本更新事件 `onInstalled(update)`，确认仅刷新属于 CIP 的绑定页及唤醒 Agent；**不可用开发者模式普通 reload 代替**。
5. 所有活动 Agent 都已完成后，退出 Paseo App/Daemon，测试 Chrome Native Messaging 的有效 `wake` 能否启动 Paseo 并恢复原 Agent，再测试多标签／长轮／弱网／界面视觉。

**发布闸门：** 本次状态为「新候选待加载、部分真实测试未完成」。不允许写 Done，不允许仅因 283/283 单元测试或已看到 public reasoning 就宣称全量实机通过。源代码不会自动升级生产插件，生产系统保持原运行状态。
