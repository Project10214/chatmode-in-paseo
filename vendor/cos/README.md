# CoS 直接移植清单（alpha.3）

固定上游：`totec448-spec/chat-on-steroids`，提交 `ccd23b66cecf2f684fa3e12ca190297be02842cf`，参考版本 2.1.35。并非声称这是最新主分支。

此次是**函数级直接移植后裁剪和适配**，不是只参考设计重新写同名函数；也不是整个 CoS runtime 或两个原版文件原封不动拷贝。

| 活跃模块 | 直接源代码 | 正常执行路径 | 明确改动 |
| --- | --- | --- | --- |
| `extension/upstream/cos-native.js` | chatgpt-dom.js 的 insertPrompt / clearPromptExact / addAppMention / send | dom-adapter.send 调用原版原生编辑与发送状态机，确认真实用户消息回执 | 依赖注入；非拉丁名称使用已观察 app ID 作为 slug；加 beforeClick/onDispatch；保留精确正文、配置及身份防线（不再把无语义的 HTML 变化当正文修改）；React 在授权期间重新渲染同一表单 Send 按钮时可安全重新获取当前按钮，依然只允许一次原生点击；原版单 Core mention 由适配层扩成已选多个 app |
| `cos-controls.js` | chatgpt-dom.js 的 composer / generating / approvalWaiting / send/stop controls / stopGeneration / prepareChatModelSurface / conversationFromPath | 所有编辑器获取、忙碌/授权检测、停止、Chat/Work 切换 | 闭包拆出；只保留需要的控件函数；去掉不执行的 New Chat 复用 helper；不复制项目和展示 UI |
| `cos-models.js` | chatgpt-dom.js 的 readPickerState / modelPickerAccess / inspectModelSettings / selectModelSettings 等 | 动态目录、原生选择、读回确认 | CIP 名称空间；去掉自动选近似思考档位与按展示名称猜测；增加 family/execution pair 读回映射和受限数据校验 |
| `cos-picker-main.js` | fiber.js 的 committedPath / fiberOf / readPickerSnapshot / readShellPickerSnapshot / pickerSnapshot 等 | MAIN 读取实际已提交 React 状态；isolated 世界发起原生 UI 操作 | CIP 只读消息入口；namespace 隔离；有界公开正文投影为本项目新增，不是完整 turnsOf/shellTurnSource 移植 |
| `cos-transcript-core.js` | fiber.js 的 authoredText / turnMessagesOf / conversationEvidenceOf / turnEndMessageId / channel、隐藏消息与 app mention 文本处理 | MAIN 解析可证明归属的公开 text 与原生 end_turn/status；content 观察并回传 | 不搬私有 analysis、thoughts、工具参数、图片/附件；适配投影在截断前拒绝过大正文 |

## 明确保留的 Paseo 适配代码

Provider 注册和事件转换、首次发送延迟创建标签页、Chrome tabs API 的归属管理、CIP 配对、服务端队列/存储/停止收尾、通用 @ 菜单和应用 ID 多选、DOM 降级读取仍是本项目代码。**这些不能宣称是 CoS 原版 runtime。**

没有 CoS 主程序、Goal/Loop、压缩换聊、自己的多 agent 调度、本机文件或终端执行器、CoS 插件安装器。普通重连只恢复观察，未知发送不自动重发。

## 兼容边界

模型读取覆盖移植源码里的 September picker 和 shell powerSelections。消息 Fiber 原先只支持精确 conversation 归属下的 `turn.messages` / `allMessages`；alpha.3.3 已补齐 `entry.turn.items` / `shellTurnSource` 和 `turn.items` 的公开文字分支，仍不包含完整工具/图片扫描。另保留已有明确 message-ID 的 DOM 读取。不能识别时不能假定该页面已经支持；缺 final 证据会显示未确认状态，需要实机补充。

浏览器运行普通用户可见 public text；不对外输出隐藏思考、页面账号对象、cookie 或凭据。所有页面证据依然是网页控制的数据，不是密码学证明。

## 来源核对

`provenance.json` 记录 GitHub 返回的上游 blob SHA、固定源 URL、摘取函数以及本地文件 SHA-256；`npm run verify:upstream` 检查这些模块哈希和 manifest 实际加载位置。**它是来源与完整性检查，不冒充上游完整文件逐字相同、语义等价证明或实机测试。**注释缩短、格式调整和上述改动均已明确披露。原 MIT 版权/许可保留于本目录 LICENSE 及根 THIRD_PARTY_NOTICES.md。


## alpha.3.2：补齐原版应用发现链路

新增第 6 个活跃移植模块 `extension/upstream/cos-apps-observer.js`，来源提交 `e40562640361ca8f74158b2262ca8c555b00abed` 的 `extension/usage.js`，源 blob `f64e811f4d1261616d90140641a5a21049bfd8fb`。保留 `inspectSystemHints` 的同源响应过滤、1 MiB/10 秒有界克隆读取，以及 fetch 原始返回值、下游函数逐次捕获、DOMContentLoaded 补挂和投影回放方式。

原版只挑选 Core 名称；本项目按需求改为完整 `mode=plugins` 中的全部原生应用 ID/名称，增加顺序防护、分页/冲突拒绝与 CIP nonce 回复。不是完整复制 usage.js，也不含它的配额、发送请求体或流式内容观察逻辑。仅观察网页自己的 GET 响应，不主动请求私有接口，不读取请求头、Cookie、令牌或工具参数。

`dom-adapter.setApps` 改为调用已经移植的 `addAppMention`，不再先输入 @ 并搜索菜单；原版单 Core 标记扩展为按 ID 多选。`extension/app-catalog.js` 是两端消息适配，不是声称来自原版。

自动同步由 `server/catalog.mjs` 统一负责：配对扩展首次心跳、Paseo Provider 和设置页共用一个请求。原版 CoS 源码没有本项目的 Paseo 调度逻辑，不能将这部分说成照搬 CoS。


## alpha.3.3：补齐新网页消息回执读取

新增第 7 个活跃模块 `extension/upstream/cos-shell-public.js`。源码来自 `e40562640361ca8f74158b2262ca8c555b00abed` 的 `extension/fiber.js`，源 blob `8ebcd1ee38a596847d10f37174dfbe26f0fb2c70`。按函数复制 `shellTurnSource`、`shellItemText`、`unescapeFallbackMarkdown`、`turnViewOf`、`messagesFromTurnView`、`shellQueries`、`shellConversation` 的必要公开文字与身份路径。

裁剪工具调用、工具参数、图片及隐藏分析内容；保留精确用户消息 ID、原生 final/complete 判断、已提交 React 分支和精确 local/server 会话关系。增加超大内容及冲突拒绝，避免截断后误当完整内容。`sourceFor` 和现有 `publicTranscript` 的调用连接属于 Paseo 适配代码；不宣称整个原版文件或整个 CoS runtime 被搬迁。

同时修复刷新后的 content script 尚未切换 nativeMode 就被查询消息身份的遗漏。更换网页消息结构不再需要先进入模型配置才能启用原生正文读取。发送确认仍要求新原生用户消息编号、匹配正文和对应会话；不把 URL 变化、输入框清空或回答文字当作单独的送达证明。

离线测试不构成真实登录账号验收。


## alpha.3.6：搜索锚点与稳定消息身份

`cos-picker-main.js` 的 CIP 公开消息投影补齐 CoS `fiber.js`（e40562640361ca8f74158b2262ca8c555b00abed，第 79–85 行）的 `SEARCH_TURN_ANCHOR`；锚点只用于定位原生消息模型，消息身份取自其 messageId，不取布局键。新增布局形状拒绝和冲突保护，当前哈希已记录于 provenance.json。

DOM 回退删除、Runtime ID 校验、15 秒观察恢复、Chrome 当前标签页 URL 核验属于本项目适配，不声称是 CoS 的整套原版 runtime。

## alpha.3.8 — 生成图预览

`cos-images-main.js` 移植并适配 e4056264 的 `fiber.js:generatedImagesOf/shellTurnSource` 图片身份和完成逻辑，以及 `content.js:nativeImageNode/captureNativeImage` 的已加载像素读取。只输出公开原生消息 ID、assetId、尺寸及压缩 WebP 字节，不转发签名 URL、Cookie、私有工具数据。`cos-picker-main.js` 增加对应的受限描述投影和 nonce 图片请求。未移植 `exportNativeImage` 原图下载；Paseo 卡片明确标注压缩预览，并提供原对话网页入口。

## 2026-10-16 · 原生附件发送（Chrome 0.2.21 / Paseo alpha.4.14）

依据 GitHub 上游主分支 `totec448-spec/chat-on-steroids` 的 `extension/chatgpt-dom.js`（所读 blob SHA `f9036940bacc0c63ef4f3dcc173de5fdd0a18c2c`）中的 `uploadImages` / `composerFileName`（MIT），在 `extension/file-upload.js` 中移植附件送达证据：以新增的移除按钮和精确文件名确认每个文件，等上传进度消失、Send 可用。

**投递方式与上游不同。**上游按附件来源选原生 file input，用 DataTransfer 写入后派发 change：纯图片用唯一的 `accept="image/*"`，含普通文件时用唯一无 accept 的通用输入框。2026-10-16 在已登录的真实 ChatGPT Composer 中实测到 4 个 file input，其中两个是 `accept="image/*"`，使上游的图片选择判为歧义，这正是生产 B01 失败的原因。同一页面上，把文件放进合成的 paste 事件交给编辑器，PNG、PDF 及两者混合都能产生带精确文件名的移除按钮。经用户决定，本项目**只走粘贴**：不使用任何 file input，不点击上传菜单。页面未处理该 paste 时报 `ATTACHMENT_PASTE_UNHANDLED`，不写入任何内容。`uploadKind` 仍随描述符传递并校验。

**先附件、后正文。**上游与早期本项目都先写正文再上传；上传失败时，正文会留在 ChatGPT 持久化的首页草稿里。现在附件确认后才写正文和 `@` 应用；正文仍用 CoS `insertPrompt` 写入，不走粘贴。未发送的失败只移除插件本次新增、且文件名属于本次的附件，再清理本次正文。本项目自有的大小约束、SHA-256、浏览器 lease/文档/会话身份、失败防重发保留不变。

**只有附件的用户消息。**上游 `publicTranscript` 只收录有文字的消息，只发文件的用户消息因此被跳过；网络请求证据遇到附件也按设计放弃。真实账号实发时，只带图片的消息已送达却无法确认回执。`cos-picker-main.js` 现在保留这类用户消息：正文只取其中的字符串部分（只有文件时为空），文件指针、文件名和元数据都不带出，使其能按原生用户消息 ID 确认回执。当前网页走 `cos-shell-public.js` 的类型化投影，它在此之前已丢掉文件数据，所以对这条路径上的原生用户项，正文为空即保留（ChatGPT 不会发送既无文字也无文件的用户消息）。

本地无需安装 CoS 桌面程序，不主张两套 runtime/文件协议字节等价；**真实账号的端到端附件发送仍待专项验收**。


## 2026-10-17 · append-only fallbackMarkdown 源头修复（alpha.4.16 / Chrome 0.2.23）

保留固定 CoS 2.1.35 / e4056264 的公开源码、MIT 来源与最终 `unescapeFallbackMarkdown` 行为。未复制 CoS 的 session store，也未改 Paseo 宿主。新增 `extension/public-prose-main.js` 是 **CIP 自有代码**，MAIN world 在 `cos-shell-public.js` 前加载。仅对同原生 assistant message ID 的公开 fallbackMarkdown 增量进行按行、围栏、显示公式语法边界的安全提交；普通文字尽早显示，语法歧义暂存到明确。native final 到达时只做一次有界原 CoS decoder 全文核验并释放精确尾部。Provider 继续发送**同 ID 规范全文快照**，由 Paseo 计算增量。

**与 CoS 移植的差异**：`cos-shell-public.js` 的 `shellItemText` DIL fallback 分支现调用 CIP 自有按消息状态器并传入 view/shell 来源与原生完成证据；无匹配 fallback 时不把不透明 `::chatgpt-content-reference` 当用户正文。`cos-picker-main.js` 仅转发固定安全错误码以识别已证实源分歧。`dom-adapter.js` 对已见过的 native assistant ID 不在临时 Fiber 缺失时换成旧 DOM 文字序列化；`content.js` 收到确定的 canonicalizer 错误后走既有 failed 结束流程，不重发用户输入。

缓存按页面 Conversation 路径隔离，最多 32 条消息状态，每正文上限 256000 UTF-16 单元；优先淘汰已完成历史，路由变化或 pagehide 清除。已完成的中间发言可释放自己的待定尾部并退出活跃缓存，但不触发整轮完成；最终回答仍要求原生 turn complete。无正文的媒体引用不触发正文读取失败。语法扫描游标只向前，普通长行不再每个字从行首重扫；完整行只解码一次，保留行首上下文，避免把句中的反引号误认成代码围栏。完整正文在消息确认完成时核验，明确错误保持失败直到路由/生命周期重置。

Paseo 0.11.4 的机器侧 `getLastAssistantMessage` 在工具卡片穿插时可能只读最后一个连续 assistant segment，**本补丁未解决且没有隐瞒**。真实 ChatGPT 页面采用何种 native/view/shell/DOM 分支仍需后续验证，合成绿例不等于所有线上事故已经消失。

更新后的 CoS 派生文件 SHA-256 记录于 `vendor/cos/provenance.json`；新模块属于 CIP 自有实现，不假冒 CoS 来源。


## 2026-10-17 · 未发布整条消息候选（alpha.4.18 / Chrome 0.2.25 / 协议 7）

上述 alpha.4.16 的浏览器增量实现已经被新授权取代，不是当前候选设计。生产 `public-prose-main.js` 及 manifest 接线已删除；旧实现仅存于 HISTORICAL 测试夹具。

`cos-shell-public.js` 原样读取公开 text/DIL，保留原生消息完成、可读性和源位置；不再调用浏览器解码器。`unescapeFallbackMarkdown` 移至接收侧 `shared/public-prose.mjs`，由 `server/message-delivery.mjs` 使用。普通 text 不解码，DIL 完结后一次适配；原 MIT 来源与最终转换语义保留。

provenance 新增 SERVER 运行位置；校验器分别核查浏览器 manifest 与接收端导入/调用，不跳过迁移后的来源完整性检查。候选未部署；完整同步和旧 Agent 恢复未验收。

## 2026-10-21 · 首条消息回执的路径边界候选

`cos-send-evidence.js` 只对已识别会话路径和 group 首页的可选末尾斜线做规范化；不改会话 ID、group ID、大小写或其它路径段。因此 `/ → /c/<id>/ → /c/<id>` 可以保留同一次发送的证明，而 `/search` 等无关中间页、跨 group、会话 A → B → A 仍永久撤销本次证明。

`cos-request-receipt.js` 在 HTTP 证明到达后继续维护相同的路径归属，直到回执被读取或关闭；关闭会移除本次新增的路由监听。证明仍要求已授权发送的准确正文哈希、唯一原生用户消息 UUID、相同应用集合、成功的同源 SSE 响应以及原有 12 秒请求 / 70 秒响应时限。没有增加发送、重试或延长等待。

接收侧 `cos-native.js` 与 `dom-adapter.js` 已复核：初始首页的 Conversation 为 null，既有逻辑本来允许它取得第一个会话。既有会话 A 改成 B 的拒绝条件保留；不将它当作首页首发误判而删除。新增 `tests/first-send-receipt.test.mjs` 直接运行实际发送观察器、回执消费者及原生 Send 函数，覆盖正例、旧消息/错正文/未授权/草稿修改和路由反例；浏览器事件为合成夹具。

**边界：**上述是可复现的路径规范化缺口，不证明已有线上 35 次误报全部由末尾斜线造成。现有脱敏诊断只有路径变化布尔值，没有原始跳转顺序；真实跳转形态和用户气泡正文差异仍需主会话补证。本候选未部署，离线测试不等于真实账号验收。
