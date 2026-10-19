# CIP v9：Chrome 扩展与本机 Runtime 协议

适用源码：Paseo 插件 `0.1.0-alpha.4.45`，Chrome 扩展 `0.2.49`（2026-10-19）。
**唯一版本依据**：`server/protocol.mjs` 的 `PROTOCOL` 与 `extension/background.js` 的 `PROTOCOL`。此协议不是 MCP、ACP 或原版 CoS bridge；Paseo Provider 另采用其原生 v1 接口。旧 CIP v1–v8 不能与 v9 混用。

## 通信与身份

```text
Paseo Agent → Provider → Runtime（127.0.0.1:17843） ↔ Chrome MV3 worker
                                                   ↔ ChatGPT 标签页
                                                页面状态、公开来源与授权卡
```

- `GET /hello` 未配对可读，返回 product、protocol、epoch；`POST /pair` 使用短期一次性配对码及扩展 ID 换取 token。
- 其余 API 要求 `Authorization: Bearer <token>` 和 `X-CIP-Extension: <id>`；Host 必须是精确 `127.0.0.1:<port>`，浏览器 Origin 必须匹配已配对的扩展。页面脚本不持有 token。
- Runtime 仅监听回环地址，拒绝超大 JSON（`LIMITS.body` 为 768000 字节）和超额请求；`CIP_STATE_DIR`、`CIP_PORT` 只由本机环境设置。
- **发送/命令**要求会话、command ID、tabId、documentKey、lease、Conversation 精确匹配。**持续观察**另使用 observationLease、generation 和递增序号；重新绑定时旧 lease 失效。两条路径不可互相授权。

## v9 真实端点

| 端点 | 作用 |
| --- | --- |
| `GET /commands` | 取有序、待认领命令；Stop 等控制命令可以独立派发 |
| `POST /claim` | 按会话和页面身份认领唯一命令租约 |
| `POST /authorize` | 仅对已认领的一次性 Send 持久授予点击准入，不代表网页已收到 |
| `POST /result` | 命令回执；相同 id/lease 的重复回执不能再执行网页命令 |
| `POST /fail-unclaimed` | 拒绝未认领的命令；**只有服务端证明未认领**才可清除本地未发送正文。已失败且无租约的命令允许幂等确认 |
| `POST /input-chunk` | 已认领附件的限量分块读取，检查文件和文档身份 |
| `POST /bind-conversation` | 独立保存已授权 Send 产生的真实对话 URL；不伪造发送回执 |
| `GET /observations` | 已绑定对话的观察描述，包含页面身份和新一代观察租约 |
| `POST /rebind-observation` | 经过原对话和旧文档证明后更换观察文档与 lease；不触发 Send |
| `POST /page-view` | 原生可见按钮状态、公开来源、授权卡、来源问题的持续快照；服务端验证序号、身份、重复与修订 |
| `POST /observation-gap` | 观察暂时不可读，留下问题记录；不能推断网页停止 |
| `POST /receipt-observation` | 在原 Send 的已绑定对话中对账迟到回执；不能二次点击 Send |
| `POST /artifact/begin`、`chunk`、`commit`、`unsupported` | 与已验证来源身份绑定的附件传输与不可用回执 |
| `POST /verify-tab-close` | 归档关闭标签页前重新检查会话及页面归属 |
| `POST /verify-approval` | 扩展每次点击授权按钮前检查已认领命令的租约、页面、当前自动允许开关、人工撤销；拒绝后不能点击 |
| `GET /recovery-targets`、`POST /resume-agent` | 扩展升级时只恢复已绑定页面和原 Agent，不产生新轮次 |

**已废弃**：v5 的 `/active`、`/bindings`、`/external-turn`、`/external-gap`、`/event`。它们不属于 v9 Runtime 路由，不能作为安装或联调指令。

## 行为约束

1. **发送只尝试一次。** `queued → claimed → authorized` 并不等于网页送达；需要原生用户消息凭据。发送结果不明时不自动重发。
2. **明确未发送才能销毁正文。** 浏览器收到 `/fail-unclaimed` 的 `accepted:true, notSent:true` 后，删除 Chrome ledger 中该命令的 `text/files`，保留命令 ID 等防重放记录。回执丢失时只重试取消请求；服务端认领过的命令不能冒充未发送。
3. **网页状态由可见控件判定。** Stop、Send、Start Voice 的可见/可用状态独立于正文与来源采集；暂时读不到正文不等于轮次完成，已完成来源也不等于外部 MCP 任务结束。
4. **公开来源持久化。** 服务端保存每个来源的身份与版本，再交付 Paseo 时间线；本地保存不等于宿主已接受。已经交付的非前缀正文修订有明确限制，不能私下拼接冒充原文。
5. **授权独立于发送。** `approval` 是命令类型，不是开放的远端权限 API。用户可以在 Paseo 显式处理网页权限；设置页提供可选自动允许（包括持久许可），默认关闭。关开关和人工处理会取消尚未认领的自动命令；已认领命令在每次点击前调用 `/verify-approval` 再校验，已发生的点击不能撤销。多按钮同层自动点击必须在每次点击前重新确认当前按钮仍为允许，无法确认则终止后续点击。结果不明时不自动重试同一授权。
6. **授权内容变更和消失不等于 Deny。** 复用的网页授权卡变更内容后须发出原请求失效通知，新卡使用新 ID。Paseo 当前原生 Provider SDK 对没有用户选择的 `permission_resolved` 默认记为 Deny；桥接不得冒用该事件强行结束旧卡。旧卡会提示已失效、不能再点击网页；用户可显式选择其「拒绝」来**只清理 Paseo 待处理卡**，不再操作 ChatGPT，网页实际结果保持未知。
6. **没有通用文件、Shell 或 MCP 代理接口。** Runtime 不因读取网页内容执行本机命令；token、聊天正文与本机文件内容不得放入日志。

运行状态保存在 `~/.chatmode-in-paseo/`（可由 `CIP_STATE_DIR` 替换），权限仅限本机用户，**不加密**。存储容量与单轮限制以对应代码常量及测试为准。真正发布前需按 [测试与验收指南](TESTING.md) 做隔离 MV3 与真实账号三端验收。
