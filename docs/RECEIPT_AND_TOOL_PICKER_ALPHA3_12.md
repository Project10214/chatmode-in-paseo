# CoS in Paseo alpha.3.12 — 发送回执兼容修复与原生工具快捷选择

## 变更
- Paseo 插件：`0.1.0-alpha.3.12`。Chrome 解压扩展：`0.1.14`（`version_name: 0.1.0-alpha.3.12`）。通信引擎 `cos-native-alpha3.12`；CIP v3 / Provider v1 保持不变。
- 不启用 CoS 桌面主程序。历史、账号、凭据与真实 `~/.cos-in-paseo` 数据均未清理、迁移或重放。

### 修复一：新 ChatGPT 对话回执
现场：2026-10-14 15:23 与 16:04 的真实测试都出现 `RECEIPT_UNCONFIRMED`。日志共同为 `nativeClicked=true, pathChanged=true, routeKnown=true, transcriptAvailable=true, rowCount=0`。16:04 的失败在发送尝试后约 26.3 秒。网页已收到并回答用户提示，但 Runtime 没有可确认的 user-message ID。**该日志不能独自确定真实请求形式。**

隔离 Chrome 中分别实测复现了两个原实现的缺口：
1. 新建对话从 `/` 进入首个 `/c/UUID`：旧 MAIN 观察器强制 `current.path===location.pathname`，导致 POST 回执漏认。现仅允许本次新聊天原页面选出的**第一个具体对话地址**；已绑定对话跳到其他会话、来回切换仍拒绝回执。
2. `fetch(new Request(...))`：旧版只认 `init.body` 字符串。现只在本轮已获发送授权后、对 ChatGPT 同源明确 POST 进行被动读取，`Request.clone()` 后用限额 2MB 流式解析正文；完全不修改、重发或延迟实际 `fetch`。

两种情形必须经过同一条身份链：一次发送意图 + 独立 nonce + 准确提交正文 SHA-256 + 唯一原生用户 UUID + 允许的会话路由 + HTTP 2xx SSE。失败时继续 `RECEIPT_UNCONFIRMED`，**不会使用“按钮点了”“网页开始回答”“URL 变了”冒充成功**。

### 修复二：空的原生转录阻断备用身份读取
`cos-picker-main.js` 原来即使 React/Fiber 扫到挂载的 turn、却没有读出任何原生用户消息，也会返回 `available=true`；`dom-adapter.js` 因此跳过带原生 `data-message-id` 的 DOM 备用读取。现在 `available` 必须包含至少一个确切 native user ID。只允许已有的严格 DOM `data-message-id` 备用，不使用 `fallback-turn-*` 布局索引，也不放宽正文校验。

### 失败诊断升级
记录下列有界的**操作证据**，不用日志暴露用户消息或工具参数：
- `sourceSections`、`sourceMatches`、`sourceUsers`（各 0–128）：主世界看到了几个候选段落、几个符合会话、几个拥有原生用户身份。
- `networkStage`：`unavailable / armed / request / body / accepted`。分别表示回执采集不可用、已设定监听、发现指定 POST、请求正文与本次发送匹配、收到了合规服务端接受证据。
- `networkRouteMoved` 布尔值；原有 `rowCount`、`matchingUserCount` 等仍保留。

这些阶段只用于定位，不能触发主动重发或独立完成状态。

## Paseo 工具选择：输入区仅一个原生入口
截图中重复的滑块图标来自 `server/provider.mjs configState()` 为每个 `@ 应用` 暴露独立的 `ProviderSetting.toggle`；应用数多时使输入区拥挤且难分辨。对照本机已安装的 **Paseo 0.11.2 SDK**，选用：
- **`ProviderConfigState.settings` 内的单个 `ProviderSetting`（`type:'select', id:'app:quick'`）**，由 Paseo 自己渲染到对话工具配置，不新开定制页面、不引入自建弹窗。
- **`session.configure`** 接收当前对话工具切换，只更改当前 session 的 `appIds`，保留模型、思考强度和会话归属。
- 菜单含“无工具（普通对话／生图）”、每个网页已确认的 `@ 应用`、“所有已授权应用”；已保存的多工具组合可作为快捷项，已有自定义组合仍可保留。
- 原来 `app:<id>` 的布尔配置仍能由旧客户端/SDK 发送并正确解释；常用多工具组合仍可在插件设置页维护，不损坏旧数据。
- **不把本机 Paseo MCP 服务器配置直接转发到网页**，不授予网页新的工具权限。网页选中的 `@ 应用` 仍须事先在 ChatGPT 授权，首次发送依旧进行应用身份核对。

## 验证矩阵
- `tests/send-evidence-edge-browser.py`：修复前新对话路由和 `Request` 两项均返回 null；修复后两项取得预期原生 UUID；错误正文、已绑定对话跳转、A→B→A 路由欺骗均不能借回执。
- `tests/binding-identity-browser.py`：修复前“空原生转录 + 明确 DOM 原生用户 ID”输出空列表；修复后确切身份可读取。未知布局键与错误消息 ID 仍拒绝。
- `tests/send-evidence-browser.py`：源响应、HTTP、正文与请求身份 8 项正反例；`tests/send-evidence-mv3.py`：真实 MV3/Service Worker/Runtime/已安装 Paseo SDK 与离线网页 8 项链路回归。
- `tests/provider.test.mjs`、`tests/protocol.test.mjs`：只暴露一个 select，单工具、无工具、全部、常用组合的切换与无权限工具拒绝；兼容旧 app 开关，且仅当前会话变更。
- `tests/receipt-diagnostics.test.mjs`：诊断字段范围和隐私白名单。
- 并发/关页续聊/生图/原生状态、全量 Node、TS 完整类型、来源 SHA 与 manifest 一致性：实际结果以 `docs/evidence-alpha3-12/` 最新日志为准。

### 严格的验收边界
以上是**离线仿真页面 + 实际 Chrome MV3 扩展 + 真实 Paseo SDK**，不是登录账号的真网发送。ChatGPT 以后如改用 XHR、WebSocket、multipart 或其他不可证明请求格式，仍可能拒绝回执，必须根据上述 `networkStage` 精确定位。不能单凭这些测试宣布真实账号问题彻底解决。

待网页所有任务空闲后，手动重载 Paseo 插件和 Chrome 扩展、刷新空闲的 ChatGPT 标签页。确认 **alpha.3.12 / Chrome 0.1.14**。使用新 Paseo 会话发送一条**新的、无工具**提示测试发送与回复；再测试工具下拉切换。旧 `RECEIPT_UNCONFIRMED` 或 `BROWSER_BINDING_LOST` 的阻断会话不解封、不重发。

## 封版回归记录（隔离测试）

- **180/180 Node 测试通过**；完整 TypeScript 检查 **19 个源码文件 / 0 诊断**；`verify-upstream` 核验 **12 个 CoS 来源适配模块**；全量扩展 JavaScript/JSON 语法检查通过。
- **20/20 UI 测试**（桌面亮色、手机暗色、图片预览、原生状态卡和配置保存）。工具下拉本身由 Paseo 原生 ProviderSettings 提供，接口契约与数据切换由本地已安装 SDK 测试确认，**尚不是用户真正运行界面的 UI 验收**。
- 实际 Chrome MV3 + Runtime + 已安装 Paseo SDK（**网页和网络均是隔离模拟**）：发送回执链路 **8/8**；并发排队与关页续聊 **11/11**；原生工具状态 **8/8**；图片 blob、URL、读取失败分别 **6/6**。
- 15 支其他浏览器脚本全部退出 0。测试 `browser-provider-flow.py` 首次因终端默认 PATH 找不到 Node 而无法启动，用 `PATH=/opt/homebrew/bin:$PATH` 重新执行后 **9/9** 通过；该环境缺口不是产品代码回归。
- `send-evidence-edge-browser.py` 最终含 **6 条证据**：新地址在 POST 前/后切换均保留同一次原生回执，Request 对象可解析，错误正文/已有会话切换/往返路由均被拒绝。初版两项正例在 alpha.3.11 下确实为 null，修订后通过。
- 当前本机生产存储在检查时共有 28 个 idle、14 个 blocked，会话无 sending/running/stopping；**未因此推断网页中其他手工任务一定空闲，更未自动重载或投递**。

证据目录：`docs/evidence-alpha3-12/`。用户后续若真实账号仍报回执不确认，按最新日志中的 `networkStage`、`networkRouteMoved`、`sourceSections`、`sourceMatches`、`sourceUsers` 定位具体剩余格式，不对结果不明的旧消息做任何重发。

## 封版核验（2026-10-14，隔离环境）
- Node 全量回归 **180/180 PASS**：`docs/evidence-alpha3-12/node-tests.log`。
- 完整类型检查 **19 个 TypeScript 文件、0 diagnostics**：`types.log`；12 个 CoS 来源改编模块 checksum 验证通过；JS 清单/语法检查通过。
- 本机已安装 **Paseo 0.11.2 SDK** 的真实 `ProviderEventSchema` /`ProviderInputSchema` 验证通过，包含单项 `ProviderSetting.select` 和 `session.configure`：`installed-sdk.log`。
- 真实 Chrome 解压 MV3 扩展 + Service Worker + Runtime + 已安装 SDK + 隔离 ChatGPT 测试页：`send-evidence-mv3.log` 8 项、`quick-tools-mv3.log` 8 项、`concurrency-reopen-mv3.log` 11 项、`native-activity-mv3.log` 8 项均通过。
- 图片三形态：`images-blob.log`、`images-url.log`、`images-missing.log` 各 6 项通过。
- 手机/桌面设置与扩展弹窗 **20/20 PASS**：`ui-browser.log`。15 个旧浏览器脚本复核通过（`browser-provider-flow.py` 使用 Homebrew Node PATH，避免测试脚本找不到 Node 的环境故障）。
- 定向新边界：`send-evidence-edge-browser.py` 验证首个新对话地址与 `Request` 正确回执，错误正文、跨会话、A→B→A 跳转都拒绝；`binding-identity-browser.py` 空原生转录情况下可按确切 DOM ID 读取，不接受伪布局 ID。
- 以上都是**隔离 / 离线**测试，不声明真实 ChatGPT 账户已验收。原有受阻会话的投递未知，保持阻断且不得重发。本轮未重载用户生产插件。
