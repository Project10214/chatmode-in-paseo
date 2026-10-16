# CoS in Paseo alpha.3.13 — @ 应用发送回执修复与严格边界

日期：2026-10-14。项目目录：cos-in-paseo。只修改本仓库源码、测试和文档；不访问 ChatGPT 账号隐私请求正文，不重发或改变生产历史。

## 真实故障证据（只读）

- 17:16:55 新会话，选中一个已授权 ChatGPT @ 应用；17:17:00 进入 Send。页面触发原生发送，但用户看到 RECEIPT_UNCONFIRMED → DELIVERY_UNCONFIRMED。
- 生产状态的脱敏诊断：`nativeClicked=true`、`networkStage=request`、`networkRouteMoved=true`、`sourceSections=1`、`sourceMatches=1`、`sourceUsers=0`、`rowCount=0`。
- 解释：浏览器探测到 ChatGPT 的原生发送 POST，但未获得与准备正文一致的原生消息 UUID；网页内也没有可验证的原生用户消息标识。**无法据此断言消息没发送，不能重放。**
- 另有无 @ 应用的会话正常回执。两者构成值得核查的关联，但过去的日志没有请求结构，因此**不能断言哪一种原生请求格式就是 17:17 的真实根因**。
- 第二个 DELIVERY_UNCONFIRMED 是防止同一会话重复发送的锁定保护，不是 MCP 断开、网页接收器整体崩溃。MCP 是否执行以及执行结果需要另行核验。

## 已修复的确定性缺口

- MAIN 世界的原生网络回执解析器允许被当前会话明确选中的 @ 应用标记：包含下划线、非拉丁文字的 `[$标签](app://asdk_app_...)`；其他应用标记绝不自动剥除。
- 允许精确定义的文本型对象和 `{type:'app_mention',app_id:<本轮已选 ID>}` 型结构化标记。无法识别的富媒体、工具、附件对象继续拒绝回执。
- 完整文本 SHA-256 继续绑定原始一次性发送意图；允许单次 CoS 原生 Markdown 反转义（不做模糊匹配）与确定性的多片段合并。
- 增加不包含提示文本、应用 ID、密钥、URL、网络正文的 `networkStage`：`request` / `shape` / `parsed` / `mismatch` / `body` / `response` / `accepted`。用于区分请求体结构、文本不一致和服务器响应问题。
- **没有**绕过 nonce、唯一用户 UUID、已授权的一次点击、当前文档/会话路由、原始正文 SHA-256、HTTP 2xx 和 SSE 的联合校验。网络回执不等于最终生成结束。

## 测试证据

- 新测试 `tests/app-receipt-browser.py`：旧版本复现 5 个缺陷；修复后 10/10 通过（多语言/下划线标签、正文单次转义、结构化 app 标记、拆分文本，及错误 app、错误正文、未知对象拒绝）。
- 原有 `tests/send-evidence-browser.py` 8/8 通过；`tests/send-evidence-edge-browser.py` 新路由、Request 和跨会话防护通过。
- `tests/send-evidence-mv3.py` 增加 `CIP_FIXTURE_WITH_APP=1` 离线场景：真实解压 Chrome MV3 插件、后台、MAIN/ISOLATED、Runtime、Paseo 0.11.2 SDK 合约，带应用时完整链路 8/8 PASS。
- Node **181/181 PASS**（包含新增无私密信息的回执阶段白名单测试）；全项目语法检查 PASS；TypeScript **19 文件、0 诊断**；真实 Paseo 0.11.2 SDK 合约 PASS；CoS 来源 SHA **12/12** PASS。证据在 `docs/evidence-alpha3-13/`。
- 所有 Chrome 测试以本地隔离 TLS 网页代替 chatgpt.com，不登录、不开真实远程 MCP。**绝不把隔离测试宣称为真实账号的成功验收。**

## 版本与升级

- Paseo 插件 `0.1.0-alpha.3.13`；Chrome manifest `0.1.15`，显示版 `0.1.0-alpha.3.13`；脚本 `cos-native-alpha3.13`。
- CIP v3、Paseo Provider v1 不变，正常授权无需重新配对（扩展 ID 不变时）。
- 原本被阻断的 RECEIPT_UNCONFIRMED 会话、生产 state、浏览器 Tab 和可能已经执行的 MCP 调用都不重置；原历史消息不自动重发。
- 等所有 ChatGPT 和 Paseo 任务确实空闲后，先停止 Runtime 并备份状态，再重载 Paseo 插件与 Chrome 扩展，刷新空闲网页标签。**只用全新的 Paseo 会话、新的可识别测试文本**实机验收一个选中 @mymac 的发送、回执、回答与第二轮，随后验证远程 MCP 只读工具。实机重现时只采集上述无隐私阶段诊断来完成下一轮适配。


## 本轮实际执行状态

- 完成源码修复与版本一致性检查：alpha.3.13、Chrome 0.1.15、引擎 cos-native-alpha3.13、CIP v3。测试日志均在 `docs/evidence-alpha3-13/`。
- 10 项新增应用回执、8 项原有网络回执、6 项路由正反例、带应用/无应用/带转义各 8 项真实 MV3 隔离测试、11 项并发关页续聊、8 项工具快捷切换通过；Node 181/181、19 文件 TypeScript、Paseo SDK、12 模块来源完整性均通过。
- 检查时生产状态为 **active 0、blocked 16、pending command 0**；没有读取、重发旧提示或清除生产状态。
- **运行中的 Paseo 与 Chrome 插件未重载，因此生产仍不能声称已使用 alpha.3.13。** 检查 Chrome 定向重载入口时无法可靠辨认目标的实时 GUI，已关闭自己临时创建的管理窗口，没有碰用户其他窗口。为避免生产出现新旧引擎混用，Paseo Runtime 也没有单边重载。
- 下一步在可确认 Chrome 目标扩展的管理界面进行成套重载，刷新该扩展已绑定的空闲 ChatGPT 标签页，然后用全新的带 @ 应用会话做真实发送回执验收。旧 blocked 会话保持不变。
