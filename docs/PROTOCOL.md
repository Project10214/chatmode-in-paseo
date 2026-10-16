# CIP v5：扩展桥接协议

本协议为本项目专用，**不是 CoS bridge 14，不是 MCP 或 ACP**。Paseo 原生 Provider 接口仍使用其 v1。CIP v5 对应 alpha.4.1 的双向原生轮次与公开思考/工具事件扩展；worker 在接收任务与提交一次性配对码前检查版本。旧 CIP v1/v2/v3/v4 与本开发候选版不兼容，必须成套更新两个插件，并只刷新已经空闲的 ChatGPT 页面。

| 入口 | 调用方与作用 |
| --- | --- |
| GET /hello | 未配对可读，返回 product/protocol/epoch |
| POST /pair | 短期一次性 code + extensionId 换 token；失败不替换扩展当前配置 |
| GET /commands | 已配对 worker 读取 queued 命令；Stop 优先 |
| POST /claim | command id + tabId + documentKey，返回唯一 lease |
| POST /authorize | send id + lease，持久化授权后允许一次原生点击 |
| POST /result | id + lease + result；重交回执不重做网页命令 |
| GET /active | 返回已经送达、仍运行的会话及其原生用户消息锚点 |
| GET /bindings | 返回已完成轮次但仍保留绑定的会话（conversationId、tab/document、最近已确认用户消息锚点）；不返回凭据或正文 |
| POST /external-turn | 仅接受配对 worker 已验证的新原生用户 ID，检查前一用户 ID、会话/网页身份与幂等性，原子登记浏览器发起的轮次；**不入 Send 队列** |
| POST /external-gap | 出现多轮无法安全核对的网页输入时，记录警告并保持绑定；不补发或猜测丢失轮次 |
| POST /rebind-observation | 对话、turn、lease、原生消息锚点与旧文档证明一致，才允许更新观察文档/标签页；不允许 Send |
| POST /event | 精确 session/turn/lease/document/tab/native-message 的 snapshot/completed/failed/waiting/binding_lost 及 `native_timeline`；后者仅可投递公开摘要和已验证可见工具调用状态/详情，使用 Paseo 原生 reasoning/tool_call 类型 |

除 hello/pair，需 `Authorization: Bearer <token>` 与 `X-CIP-Extension: <id>`。仅监听 127.0.0.1，Host 精确匹配；带 Origin 时只允许已配对的 chrome-extension Origin。页面 content script 不持有 token；观察不是文件或权限操作授权。

catalog/open/configure/send/stop 为支持的命令。Stop 带精确 turnId 和 nativeMessageId；重复 Stop 复用同一命令，本轮完成后晚到 Stop 不得影响下一轮。

`notSent: true` 仅由扩展确认本次原生点击尚未发生时返回；不能根据网络超时猜测。`notApplied: true` 表示配置在任何网页修改前被拒绝。已经认领的配置没有这种证据时，未知结果进入 blocked。发送点击已可能发生却没有回执时不得重发。

`binding_lost` 使用后台已经持有的旧绑定报告失联，不伪造一个当前网页 URL。`rebind-observation` 要求重新观察到唯一、匹配的对话和原生消息；只能恢复跟踪，不能重建用户任务或绕过未知发送。

正文上限 64,000 字符；单轮响应聚合上限 256,000 字符，最多 16 个响应片段；历史 1,000 条/会话、总会话 100、总状态 32MiB。入队前预留回答空间，控制与终局另有 128KiB 预算。超过限制记录错误，不隐瞒截断。

`CIP_STATE_DIR`、`CIP_PORT` 是本机配置，不能由网页修改。token 不应放进 URL、日志或仓库；本机状态文件不加密。


alpha.4.1 保留既有 `session.open` 的惰性打开策略：`session.open` 只在 Paseo 层保存会话，不立即产生浏览器 `open` 命令；第一条 prompt 会先产生 `open` 并等待原生配置证明，之后才产生 `send`。准备期间 Stop 取消该控制命令；若已有不明网页副作用则阻断，不继续 Send。
