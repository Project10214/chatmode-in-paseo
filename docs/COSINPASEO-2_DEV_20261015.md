# COSINPASEO-2 原生思考及工具调用详细事件：开发记录（2026-10-15）

## 本轮实现的功能

开发候选 **Paseo 插件 0.1.0-alpha.4.1、Chrome 扩展 0.2.1、CIP v5、`cos-native-alpha4.1`**；Paseo Provider 协议保持 v1。与 COSINPASEO-1 使用同一持久 Broker、同一绑定身份与 `/event`，不新建独立事件传输系统。JEV 未包含。

原来 Chrome 网页观察层通过 `native-activity` 单个状态卡回传，如「思考中」「工具调用中」。现在新增原生事件：

1. **思考过程（`ProviderTimelineItem.type='reasoning'`）：** 从 ChatGPT 原生转录的公开 `reasoningRecap` 中读取能确认公开展示的 `type:show/summary` 摘要正文，带稳定 native recap ID。同步增量内容到 Paseo 原生思考区；同 ID 只允许追加型更新，不把旧内容改写后重复显示。没有公开摘要时不编造“推理步骤”。
2. **工具调用（`ProviderTimelineItem.type='tool_call'`）：** 从已证实公开、未隐藏的 native tool entries 读取 `callId`、工具所属 `server`、`tool` 名称、运行/完成/失败状态。每个调用使用固定 Paseo timeline ID，重复上报只更新同一张卡；多个调用同时出现时各有独立 ID 和状态。
3. **工具详情：** 仅当同一轮、唯一 `data-tool-call-id` 工具卡在**可见 DOM** 中，且能找到明确 `data-testid=tool-call-input` / `tool-call-output` 字段时，才读取并过滤最长 2048 字符的输入或输出正文；传输层和 Runtime 都按白名单验证，凭证样式进行双重脱敏。没有明确可见页面证据则显示“未获得页面可见证据”，不得读取原生内部 invocation.arguments/response，也不得猜测内容。
4. **完成、失败和重连：** 通过原来带 `sessionId/turnId/lease/nativeMessageId/tabId/documentKey/route` 的 `/event` 调用，上报增量 `kind='native_timeline'`。Broker 与持久 Store 原子更新，Provider 将 `reasoning` / `tool_call` 作为 Paseo 原生 timeline.item 发出。若轮次已经终结但工具结果无可信终态，工具卡显示 canceled 和“结果未证实”，**不伪造已成功**。Paseo Provider 恢复时从同一持久历史回放，避免新建重复工具卡。
5. **保留旧通道：** 原有 assistant snapshot、native-activity 卡、图片、生图、授权等待、结束回执均继续使用原通道，并不会因为公开思考/工具状态变化而声称原轮次完成。

## 改动清单

- `extension/upstream/cos-activity-main.js`：`publicTimeline` 公开摘要和工具调用 reader，严格公开/隐藏过滤；仅有 `callId` 与同轮可见 DOM 对应时读取详细输入/输出。
- `extension/upstream/cos-shell-public.js`：从真正 owner turn 的 typed view/entry 传入可验证的可见工具卡表面，防止跨轮卡片。
- `extension/upstream/cos-picker-main.js`：公开转录回复附加 native user ID 所属的 timeline。
- `extension/dom-adapter.js`：隔离世界再校验归属、条目 ID、名称、长度、状态及可见详情。
- `extension/content.js`：增量 `native_timeline` 事件、指纹去重、同轮身份认证。
- `server/native-timeline.mjs`（新增）：原生 Paseo event schema 的白名单映射、持久去重/状态变更、隐藏信息过滤和终态收口。
- `server/broker.mjs`、`server/provider.mjs`：原有 `/event` 的分支 + 持久化 + Provider 原生事件输出。
- `vendor/cos/provenance.json`：三处函数级上游移植适配的更新 SHA-256 与关系说明。并非宣称外部上游源文件未改。
- `server/protocol.mjs`、`server/runtime.mjs`、`extension/background.js`、`package.json`、`extension/manifest.json`、`README.md`、`docs/PROTOCOL.md`：新候选版协议/引擎/版本一致升级。

## 自动化验证

| 测试 | 结果 |
| --- | --- |
| Node 全量：`/opt/homebrew/bin/node --test tests/*.test.mjs` | **246/246 PASS** |
| 新增 COS2 公开过滤、工具 Upsert、推理增量、会话归属、重连测试 | **5/5 PASS** |
| 本机 Paseo SDK 0.11.2 原生 ProviderEventSchema 合约 | **1/1 PASS** |
| 真实 Chrome MV3 + 临时 Runtime/Provider + 隔离网页（正常文本） | **10/10 PASS，SDK 验证 true** |
| 同环境模拟 Markdown 转义原生消息 | **11/11 PASS，SDK 验证 true** |
| `scripts/verify-upstream.mjs` | **12 活跃模块 + 记录 SHA、MIT 声明 PASS** |
| `scripts/check.mjs` | **413 JavaScript 及 JSON/权限 PASS** |
| `.test-tools/ui/typecheck.cjs` | **21 文件 / 0 diagnostics** |

离线 Chrome MV3 测试页面同时包含真正渲染的公开摘要、固定原生工具 callId、模拟公开输入/输出、`aria-hidden` 隐藏载荷，以及故意放进 native 私有字段的 `NEVER_EXPORT_PRIVATE_COT` / `NEVER_EXPORT_TOOL_ARGUMENTS` 字段。检查最终 Runtime history 与 Provider timeline：原生 reasoning/tool_call 显示、工具完成更新、可见输出保留；私有字段、隐藏 DOM 输出、示例凭证不进入历史。

## 与验收标准对应的限制

1. **不是模型内部推理链**：任何真实 Chain-of-Thought、analysis/private/hidden/transient group 或未显示的后台 tool payload 不允许采集，只有网页向用户公开的思考摘要可显示。ChatGPT 某些页面或模型不暴露公开 summary 时，此字段可能为空。
2. **工具参数和结果不是无条件完整可见**：只有实际网页公开展示并能通过 callId 与当前轮次精确配对、可见字段明确存在才附上 input/output；其他详情会显示不可用。实际 ChatGPT 的 DOM 结构若没有这些标识，仍需新一轮真实页面适配，不得静默改为抓取私有对象。
3. **工具结果未知不算成功**：最终回答完成与每次工具实际成功是两个不同判断，未知结果在轮次收口时标 canceled / 未证实。
4. **安全脱敏非通用 DLP**：常见 token/api_key/Bearer 等形式已过滤，但自由格式秘密仍可能出现在用户可见字段中；真实使用要遵守用户数据权限并作额外隐私审查，不能声称消除了所有泄漏风险。
5. **尚未真实账号/实际 Paseo UI 验收**：模拟测试验证原生协议和 MV3 链路，**未对正在使用的 Paseo/Chrome 插件热更或向真实 ChatGPT 发送消息**。宿主真实 UI 视觉呈现、不同公开工具卡的真实 DOM 和长任务恢复仍待验收。
6. **不含 JEV**；不改变已回滚的原生单选工具交互；COSINPASEO-1 的系统级 Daemon 退出唤起仍待专项方案。

**推荐 Presure 状态：In Progress，不能标记 Done。** 待已有任务全部结束，再备份、成套升级到 CIP v5、只刷新空闲网页、选择含 2+ 公开工具事件和公开思考摘要的真实已授权会话进行验证。必须核对思考摘要与工具原生卡、逐步状态、可见详情、重连、不跨页、不可见字段不泄露，以及原会话消息无重复 Send。
