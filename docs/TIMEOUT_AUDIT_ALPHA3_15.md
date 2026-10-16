# CoS in Paseo alpha.3.15：全项目超时与活动状态审计

日期：2026-10-14。范围：生产代码 `server/`、`extension/`（含所有实际加载的 `upstream/`）、`client/`、`shared/`、`scripts/`、两个插件入口。逐项搜索定时器、Deadline、到期计算、网络 Abort、恢复/关闭逻辑，并核对调用关系；排除隔离测试、历史工作副本及文档自身。**未登录用户 ChatGPT，不读取生产会话正文或自动重发。**

## 结论与状态规则

- **发送前**（目录、打开页面、模型/工具设置、浏览器 RPC、网络请求）：保留适度截止时间；确认没发送时可返回错误。不能由“点了 Send”伪称已送达。
- **发送后，已有可信的一次性授权及匹配的对话绑定**：70 秒回执和 90 秒命令期限不再构成整轮终止。进入 `receiptPending`，继续观察同一标签页/文档/对话和原始轮次；不释放成可重新发送的 `idle`，不调用第二次 Send。
- **迟到的原生用户消息**：用当前 document/turn、发送前 user-ID 集合和严格原文比较核验；必须有唯一原生用户 ID。确认后恢复 `running` 和原生消息/工具/回答流。只有 URL、点按按钮或“生成中”绝不是成功回执。
- **活动保持**：已确认的同一会话网页状态可用绑定心跳（至多每 60 秒一次）续期。等待授权、搜索、调用 MCP、推理和生成均不会因为固定总时长而停止。
- **临时状态不可读**：15 秒只发降级提示，继续重试，不刷新存活时间。3 小时**没有任何可验证的活动**才认定监控长期异常、结束本地这一轮；这不声称 ChatGPT 网页或外部工具已停止。
- **确定性错误**：会话地址切换、明确的原生 user-ID 冲突、伪造身份、页面删除/错误宿主、用户显式 Stop/Close 等不延迟处理。不可证明的外来消息绝不并入当前会话。
- **连接/Runtime 重启**：不再对已有可信 URL、tab/document、lease 及原生 ID/待确认回执的活动轮次一概判失败；恢复观察而不是重播 Send。恢复连接后保留原轮次。Provider 连接关闭不再隐式发 Stop；显式 `session.interrupt` / `session.close` 仍执行中断。

## 全部生产计时点与判断

| 所属/触发条件 | 旧时限或节奏 | 判断及 alpha.3.15 处置 |
|---|---:|---|
| `server/broker.mjs` Send、控制命令从创建起的 deadline | 90 秒 | 保留**命令安全边界**。获授权且已有确切会话链接的 Send 过期→软交接/继续监控；未领用、配置失败或缺可信链接→失败，绝不猜测送达 |
| `extension/background.js` 已领取网页命令 RPC | 最多 90 秒（通常 deadline 减 1 秒） | 只是 RPC 截止；后续仍可观测已绑定的活动轮次，未确认不得重发 |
| `extension/dom-adapter.js` 原生回执 | 最多 70 秒（无 deadline 回退 25 秒） | 时间到不再必然结束会话：可信已绑定、已点按且未身份撤销→`receiptPending`；后续严格恢复回执 |
| `extension/upstream/cos-native.js` 发送按钮就绪 | 调用 25 秒，上游默认上限 30 秒 | **发送前**失败，保留；点击后回执计时仍有界，但只是移交观察 |
| `extension/upstream/cos-send-evidence.js` 匹配 POST 发起 | 授权后 12 秒 | 保留严格证据窗口，超过只丧失该证明来源，不等于 ChatGPT 失败 |
| 同上，等待已匹配 POST 的 SSE 头 | 70 秒 | 保留证据完整性期限；失效后还可通过严格原生用户消息恢复，不截断生成 |
| `extension/upstream/cos-request-receipt.js` 侦测器握手 | 1.3 秒 | 仅降级证据来源，不结束会话 |
| `server/broker.mjs` 活动轮次 watchdog | 无可验证进展 3 小时 | 保留为**失去监控的异常兜底**；同一会话确证心跳/等待事件可重置，不按总运行时长终止 |
| `extension/background.js` 观察绑定不可读 | 15 秒 | **改变**：宽限后只发布 `observation_gap` 提示，继续观察；明确身份冲突才立即判错 |
| 同上，已验证会话心跳 | 60 秒 | 保留，要求 tab/doc/route/turn 正确；没有仅凭页面存在就伪造活跃 |
| `server/slots.mjs` 排队等待名额 | 原 3 小时 | **删除排队超时**，未发送的队列仅由取消、容量释放、Runtime 关闭、队列容量限制退出 |
| `server/provider.mjs` Provider 连接关闭后等待 Stop | 原 5 秒 | **删除隐式 Stop 和伪失败**；连接关闭仅解绑订阅，显式用户 Stop 仍有效 |
| `extension/content.js` 原生监控采样 | 每 750 毫秒 | 保留；明确终局需正确 native final 及相同轮次 |
| 同上，稳定终局确认 | native terminal 1 秒／普通 4 秒 | 保留终局去抖，不得把短暂空闲/工具等待当完成 |
| 同上，暂时未渲染生图预览 | 最多 15 秒 | 仅图片预览降级，不推断生成停止；图片身份/容量/格式错误仍拒绝 |
| `extension/media-adapter.js` 生图像素请求 | 6.5 秒 | 预览返回 unavailable，不停止原生生成 |
| `extension/upstream/cos-images-main.js` 转为 WebP blob | 5 秒 | 像素获取局部失败，图片卡降级；不驱动整轮超时 |
| `extension/background.js` 读取网页身份 | 最多 25 秒，250 毫秒复核 | 发送前/重开时必要身份探测；内容不可用不假定已发送 |
| 同上，普通 `tabRpc` | 默认 2.5 秒 | 单次 IPC 局部失败，观察器可重试；明确冲突仍立即失败 |
| 同上，本机 HTTP `fetch` | 15 秒 | 单请求退避/重试，不能当整个 ChatGPT 任务截止 |
| `server/runtime.mjs` HTTP headers/request | 10 秒／15 秒 | 保留本机接口资源保护；不会在等回答时持续占用 HTTP 请求 |
| 同上，本机检测/调度 tick | 每 1 秒 | 保留轮询，tick 本身不构成失败 |
| 同上，扩展在线状态判断 | 最近通讯 45 秒 | 仅健康状态展示，不因离线标志直接结束 ChatGPT 会话 |
| `extension/background.js` 心跳/pump 调度、MV3 alarms | 1 秒；alarms 0.5 分钟 | 保留重试与恢复入口，不自动重投任务 |
| 同上，Popup 在线状态 | 最近通讯 15 秒 | 仅 UI 显示 |
| 同上，已确认指令账本清理 | 24 小时 | 只清理 acked 记录；不自动丢弃未决 Send |
| `server/broker.mjs` 已结算指令裁剪 | 1 小时 | 只裁剪非 pending 命令；已存会话状态与绑定独立持久 |
| `server/runtime.mjs` 配对码 | 15 分钟 | 安全 TTL，必须保留 |
| 同上，请求限流窗口 | 60 秒 | 安全控制，必须保留 |
| `server/catalog.mjs` 目录失败降频/成功缓存 | 60 秒／5 分钟 | 仅目录读取，不触碰正在生成的轮次 |
| `extension/app-catalog.js` 应用枚举窗口 | 默认 18 秒，100 毫秒轮询 | 发送前目录发现失败，不作为活动轮次超时 |
| `extension/dom-adapter.js` 网页 DOM 等待/编辑器就绪 | 默认 15 秒／20 秒，100 毫秒轮询 | 发送/配置前检查；无法找到控件应失败，不猜测成功 |
| `extension/upstream/cos-models.js` 模型投影和选择器 | 1.5 秒／默认 3 秒 | 只限配置，失败不得偷偷换模型 |
| `extension/upstream/cos-controls.js` 原生聊天面板准备 | 5 秒 | 只限打开模型界面 |
| `extension/upstream/cos-apps-observer.js` 插件列表读流 | 10 秒 | 被动发现超时，不杀对话 |
| `extension/upstream/cos-native.js` @ 标记编辑器确认 | 1.5 秒 | 点击前校验，不能用延长时间逃过配置错误 |
| `extension/dom-adapter.js` 观察阶段 DOM 刷新 | 单次 1.5 秒；发送期间 300 毫秒取证 | 单次失败可重试；未知不能冒充有 native ID |
| `extension/popup.js` / `client/settings.tsx` | 每 2 秒 | 状态 UI 刷新，非执行超时 |

## 不能放松的条件

1. 必须绑定**一次性授权、精确会话地址、tabId、documentKey、turnId、lease**。从别的 ChatGPT 会话、另一个 Tab、别的 User ID 或本地布局索引得到的信息不接受。
2. Pending 状态仅代表“原发送结果不明、但可以安全继续观察”；**绝不**表述为已送达、已执行 MCP 或已完成。不能在当前 Pending 轮次再发新消息。
3. 不依赖页面空白、停止按钮瞬态、旧完成消息或泛化 DOM 观察判断生成结束。只接纳真实 native final 或有条件的稳定最终证据。
4. 既不自动重发、不自动批准 ChatGPT 工具调用，也不调用 Paseo 内部工具替代 ChatGPT 已授权 @ 应用。
5. 未来 ChatGPT 若切换成不支持的发送通道、React 转录一直无法读到原生 ID，仍可能**无法证明回执**。此时只能提示观察缺口或最终本地失联，不能假装回传正确。

## 测试与上线

- 定向 Node 用例：`tests/lifecycle-timeouts.test.mjs`（发送软交接、迟到回执、续期、恶意身份、重启、队列、连接恢复）；`tests/binding-observation.test.mjs`（Chrome worker 断线/身份冲突/回执恢复）。
- 全量测试、浏览器模拟、真实 Paseo SDK 类型/协议校验，**以本轮运行结果为准**；测试通过不代表登录 ChatGPT 账号已验收。
- 修改的是仓库文件，**不会自动让已加载的 Paseo Provider 或 Chrome 扩展热更新**。确保所有实际任务结束后再成套重载两边，刷新空闲网页，确认 `alpha.3.15 / Chrome 0.1.17`；**禁止重发旧的不明消息**。

## 2026-10-14 补充审核：真正活动 vs 只存在网页

对上一版审核再收紧：浏览器标签页可读、`monitor` IPC 返回成功、网页路由未变化，并不能单独证明 ChatGPT 正在执行。普通轮次只有从对应原生 User ID 读到 `busy` 或 `approval waiting` 才可周期性发送续期心跳；待回执轮次需要同一浏览器文档的原生生成/授权证据。新增的原生活动变化、正文快照、图片快照本身也会更新最近有效观察时间。页面无可信活动时，不会凭循环心跳无限延长 watchdog。15 秒身份临时不可读仍仅报警，明确身份冲突即时失败，连续 3 小时完全无有效活动才触发本地失联终止。

**最终已验证（本机隔离环境）**：`npm test` **222/222 PASS**，含新增 `BIND21`、`NATIVE-GAP3`：空闲标签页不续期，原生活动状态才续期。`npm run check` 405 个 JavaScript 语法检查通过；`npm run verify:upstream` 12 个 CoS 函数移植哈希全部通过；完整 TypeScript 类型检查 19 个文件、0 诊断；Paseo 0.11.2 SDK 契约单项测试 **1/1 通过**。最终离线 Chrome 真实 MV3 扩展/后台/Runtime/Provider 联调分别 **7/7** 与 **8/8** 通过；真实 Chromium 页面回执恢复 **4/4** 通过。**测试未触碰生产账号/浏览器个人资料或原始会话，不是实际登录网页验收。**

**保留的可证实限制**：新建/已有页面如果在原生发送后始终无法暴露用户消息 ID（例如 ChatGPT 更改网页实现），即使页面确实显示活动，也只能保留待确认状态而无法安全伪造该轮的最终回答回执。若在收到可信发送回执之前整个网页文档被刷新，原文档中缓存的发送前原生 ID 集合会消失，新文档必须重新建立足够强的身份绑定；不会仅凭同网址、匹配文字就跨文档认领未确认发送，也不自动补发。需要后续真实账号测试确认这一残余风险。会话存在不等于远端操作完成，也不等于本机 MCP 命令已经停止。


## 2026-10-14 最后一轮补漏：浏览器 RPC 本身超时

全量执行路径复核还发现：浏览器 `tabRpc` 自身的截止时间可能在网页回执获得之前到期，产生 `CONTENT_TIMEOUT` / `COMMAND_UNCONFIRMED` / `CONTENT_UNAVAILABLE`，此前即使原生会话已独立绑定，也仍会被服务器判为已失败。本轮补齐：

- `server/broker.mjs`：仅在**确切的同一次授权 Send 已绑定 ChatGPT 对话、没有明确未发送证明及身份撤销信号**时，上述浏览器 RPC 错误转为 `receiptPending`；未建立可信绑定或明确 `notSent:true` 仍终止，不提供自动重试。对已保存原生消息 ID 的停止中轮次，允许在严格身份检查后重新绑定文档，避免重载后无法继续观察。
- `extension/background.js`：原来所有命令 RPC 超时都会发送 `cancel-command`，可能在消息**已经点击发送后**破坏迟到的回执采集。如今超时只取消页面准备命令；`send` 超时不会向网页发送取消指令，不会二次点击 Send。
- `extension/content.js`：保存仅限当前文档/原会话/原轮次的迟到原生接收证明。若后台已经不再等待该 RPC，但网页之后确认收到原生 user ID，仍可通过只读 `pending-receipt` 恢复；路由 A→B→A 导致导航代次变化时拒绝该证明。未确认消息继续严格比对原发送正文和发送前 native ID 集合。
- 新增 `tests/late-browser-receipt.test.mjs` 5 例；扩展 `tests/lifecycle-timeouts.test.mjs` 至 15 例（增加 RPC 截止、缺少可信链接、停止中重绑定）。**新的结果为 222/222 Node 测试通过**，独立 SDK 0.11.2 合约 1/1、TypeScript 19 文件无诊断、CoS 来源核验 12/12、语法检查 405 文件通过；重新执行真实 Chrome MV3（离线夹具）7/7、8/8，以及页面回执恢复 4/4，通过。

**本轮未修改、清空或重放生产会话；未对登录账号实际发消息。** 仅源码与测试已完成，原来在使用的 Paseo / Chrome 插件不会自动变更为新版本。正式使用必须在确认现有任务已经完成后成套重载、刷新空闲网页，再用**全新**测试消息做一次登录账号实际回执与长任务验收。旧 `RECEIPT_UNCONFIRMED` 记录不能被自动改判为已送达。

### 最终变体验证与环境说明

再次针对原故障形态跑完整离线 Chrome MV3：**选择已授权 @ 应用的发送** 8/8 通过；**SSE 响应延迟、先绑定网址后确认回执** 9/9 通过。两者均用隔离 ChatGPT 页面与本地网络替身，不登录账号。项目根目录未安装 npm SDK 依赖，直接 `npm run test:sdk` 会出现 `ERR_MODULE_NOT_FOUND`；本轮使用项目已有 `.test-tools/ui/node_modules/@getpaseo/plugin/dist/server/provider.js`（官方 0.11.2）作为 `CIP_SDK_MODULE` 成功执行 1/1 契约测试，未下载或安装新的依赖。`npm test` 为 222/222，类型检查 19 文件、0 错误，来源校验 12/12。未做真实账号会话投递，也未重载生产插件。
