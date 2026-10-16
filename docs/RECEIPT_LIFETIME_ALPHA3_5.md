# alpha.3.5 — 发送已发生，但回执等待被提前中止

项目：`/Volumes/penndisk/HarnessSpace/Project10214/cos-in-paseo`
版本：Paseo 源码 `0.1.0-alpha.3.5`；Chrome 清单 `0.1.7`、显示版本 `0.1.0-alpha.3.5`；页面 engine `cos-native-alpha3.5`，CIP 仍为 v3。

## 结论与不确定性

已修订一个可复现的会话地址生命周期缺陷。不是已宣称用户账号上的完整收发恢复正常。

最新生产记录明确表明：native Send 已被点击，而且读取到一条与发送正文匹配的用户消息；等待却由 `chat-changed` 分支提前结束，随后 Paseo 没有绑定原生消息/会话，也没有启动回答观察。

原诊断没有保留究竟是文档失效、导航变化还是其他 guard 条件，因此不能仅凭旧日志断言具体现场页面使用了哪一种临时地址。新增浏览器场景复现了相同错误字段，是已证实的代码缺口，不是现场抓取证明。新版增加固定 guard 原因码，避免再次只能猜测。

## 本次现场证据

通过 mymac 读取 Penn’s Mac 的项目和运行日志。最新两次失败（本机时间）为：

| 时间 | 发送命令历时 | 结果 |
| --- | --- | --- |
| 2026-10-14 00:23:39.513 | 918 ms | RECEIPT_UNCONFIRMED |
| 2026-10-14 00:26:30.918 | 1437 ms | RECEIPT_UNCONFIRMED |

两次诊断均为 `nativeClicked=true`、`rowCount=1`、`matchingUserCount=1`、`transcriptAvailable=false`、`refusal=chat-changed`。此前目录已返回 4 个模型、8 个应用。本轮不是应用目录超时，也不是等待 25 秒后自然超时。

此次没有重发这些消息，没有修改 `~/.cos-in-paseo/state.json`、配对令牌或原失败记录。没有重启用户浏览器、修改 Chrome 自动化权限或声称已重载新版插件。

## 与 CoS 的对照

对照 `totec448-spec/chat-on-steroids` 固定提交 `e40562640361ca8f74158b2262ca8c555b00abed` 的 `extension/content.js`，Git blob `f5bfa3927b0d63cf6f287a79da43bb79b1ce8c0c`，函数 `submittedSendLifetime`（917–934 行）。

原版区分首次取得正式会话地址与随后离开该会话。我们的旧 `content.js` 在首次发送后仍要求“当前地址是根目录，或者已经有正式会话 ID”；同一文档中的临时地址不满足这个条件，于是把真实发送过早判为会话切换。

另外，旧代码只检查初始 `payload.conversationId`。首次发送该值为 null，因此在两个检查之间发生 A→B→A 或第一次正式地址后再跳到 B，没有完整的永久失效记录。

本版把 CoS 的“首次绑定、之后离开即失效”规则适配到 CIP：在实际点击之前激活发送生命周期；按真实 `currententrychange`、popstate、hashchange 记录正式地址变化；首次取得正式地址前继续观察，后续离开会话则永久拒绝该回执。此处属于适配，不是整个 CoS 文件原封不动移植。

地址变化本身不是送达证据。接受回执仍必须满足新原生用户消息编号、正文匹配、目标文档和会话约束。没有放宽为“清空输入框/出现回答/URL 变化就算成功”。没有自动补发。

## 修改范围

- `extension/content.js`：发送生命周期与导航监听，命令完成后解除监听。
- `extension/dom-adapter.js`：点击前通知生命周期进入发送阶段；保留具体 guard 原因和两个布尔状态，不记录实际 URL、正文或秘密。
- `server/diagnostics.mjs`：只接受固定原因码及布尔字段。
- `server/provider.mjs`：回执未确认时把“仍在排队”提示更新为“已尝试发送，回执未确认”；明确不会自动重发，终态仍是 failed 而不是伪造成功。
- 两端引擎标记、包版本、Chrome 清单与相应版本测试同步更新。
- 新增 `tests/receipt-navigation-browser.py`、`tests/receipt-lifetime.test.mjs`。

七个已有 CoS 源码模块未在本轮改写。相关来源和 MIT 声明继续保留。

## 验证结果

新导航测试实际使用 Chrome 的 URL、history 和 Navigation API，加载完整生产 `content.js`；不是给 `location` 换一个内存对象。网络全部由本地夹具响应，不使用真实账号。

修复前，首个场景失败，字段与现场记录一致，见 `docs/evidence-alpha3-5/navigation-before.log`。修订后，首次发送、公开回答回传、后续对话、二次跳转拒绝均通过。

| 检查 | 结果 |
| --- | --- |
| Node 全量 | 116/116 |
| 真实 URL 导航/回执/观察 | 5/5 |
| 可信用户点击与草稿保护 | 3/3 |
| 新式原生消息回执 | 14/14 |
| Provider + Runtime + content 联动 | 9/9 |
| 目录按需读取 | 11/11 |
| CoS 原生函数 | 16/16 |
| 普通页面夹具 | 7/7 |
| 目录发现 | 8/8 |
| 应用响应观察 | 9/9 |
| DOM 对抗检查 | 9/9 |
| 已安装 Paseo 0.11.2 SDK 契约 | 1/1 |
| 来源/加载清单校验 | 7 个既有模块通过 |
| JavaScript/JSON 语法 | 通过（扫描也包含测试工具） |

浏览器检查合计 91 项。全部本轮日志保存在 `docs/evidence-alpha3-5/`。完整 TypeScript 类型检查未在本轮执行；SDK 的单项运行契约检查不等于完整类型检查。以上也不等于登录账号后的完整 MV3/Paseo 实机验收。

## 生效与验收

修改已经写入原项目，但尚未自动重载运行中的两个插件。一起重载 Paseo 插件与 Chrome 扩展，Chrome 显示版本应为 alpha.3.5（内部版本 0.1.7），再刷新旧 ChatGPT 页面；配对不用重建。

保留旧失败会话，不重发已经到达网页的消息。只用一个新的、无外部操作的测试消息，例如 `只回复 RECEIPT_LIFETIME_OK，不调用工具。`。成功标准是回答回到 Paseo，并且同会话第二轮仍使用原 ChatGPT 对话。

若仍失败，读取最新 `[CIP send]` 的 `guardCode`、`pathChanged`、`routeKnown` 和消息计数，区分未解除的文档/导航问题；不要靠延长超时或重复发送掩盖它。

## 来源

- https://github.com/totec448-spec/chat-on-steroids/blob/e40562640361ca8f74158b2262ca8c555b00abed/extension/content.js#L917-L934
- https://paseo.sh/docs/plugins/providers （send 接收工作、事件返回结果；每轮必须有一个终态）
- https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts

本轮未提交 GitHub。工作区没有 Git worktree，依据实际修改回执、当前文件与本轮测试核对；没有声称产生远端提交。
