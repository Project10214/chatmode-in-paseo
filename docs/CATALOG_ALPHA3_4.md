# APP_CATALOG_UNAVAILABLE：源码比对与修订

> 以下为本版首次修订记录。后续已取得只读生产日志摘要、补修发送后可信点击误取消回执，并通过安装在本机的真实 Paseo SDK 契约测试。当前结论与验证范围以 [续查报告](CATALOG_ALPHA3_4_FOLLOWUP.md) 为准；不要将本页的历史全量浏览器结果当作最后修改后的重新验收。

版本：0.1.0-alpha.3.4；Chrome 清单版本 0.1.6；网页引擎 cos-native-alpha3.4；CIP 仍为 v3。
目标目录：`/Volumes/penndisk/HarnessSpace/Project10214/cos-in-paseo`。

## 1. 原因：适配代码把三个不同阶段绑在了一起

已复现本项目的三处逻辑缺口。截图中的错误不是“找不到本地 MCP”，也不是上轮的发送回执错误。该错误码来自本项目的应用列表等待；它也可能由目录服务重放先前的失败，不能仅凭错误页面断言本次已发送了消息。

**A. 被动观察不等于主动获取。** CoS `extension/usage.js` 的 `inspectSystemHints` 只观察网页本身收到的 `/backend-api/system_hints` 响应；插件不因此自动产生网络请求。原版主要提取 Core 的身份，读取不到时保留不可用状态，并非完整通用应用目录服务。本项目 alpha.3.2/3.3 将它改成“必须在当前文档读到完整 plugins 列表”，却没有在网页未主动加载该列表时触发原生读取。`extension/app-catalog.js` 的 18 秒等待到期后便产生 `APP_CATALOG_UNAVAILABLE`。实际现场究竟是网页没有请求、观察器未捕获还是数据延迟，仍需要新版诊断区分。

**B. 一次刷新失败阻断已有选项。** Paseo 文档明确：创建会话前先请求模型目录。其 `plugin-provider.ts` 的 `catalog()` 通过 Provider 消息获取目录，而非直接操作 Chrome。本项目却让 `server/provider.mjs` 的所有 catalog 请求调用 `CatalogService.ensure()`：旧实现先检查最近失败，再检查成功缓存；缓存还受五分钟时限影响。因此先前已成功读取的模型/应用虽然仍在存储中，新的创建页面仍可能收到 APP_CATALOG_UNAVAILABLE，或者被迫等待新标签页重新采集。反复重载无法修复这一语义错误。

**C. 没选任何应用也强制读应用列表。** `dom-adapter.js` 的 `setApps([])` 同样等待完整列表。纯聊天因此被不必要地卡住。注意：消息正文写“不调用工具”并不等于 Agent 配置中的应用已经全部关闭，二者不能混为一谈。

## 2. 已实施的修订

- `CatalogService.forForm()` 单独服务 Paseo 创建界面的选项读取。有上次确认的目录时直接返回；不更新旧目录的时间，不掩盖刷新失败，不启动额外网页。第一次安装没有目录时仍需真实读取，绝不编造空列表。实际网页配置与发送前的模型/应用核验没有移除。
- 新增 `extension/app-discovery.js`：优先复用 CoS 的被动响应；观察器正常但没有待返回的数据时，只在受控、可编辑、无正文草稿的输入框中触发一次原生 `@` 补全，让网页自己读取列表。仍读取 CoS 观察器提供的完整数据，不抓取菜单文字，不主动调用私有接口，不提取登录凭据，不点发送或授权。
- 探测只撤回自己插入的一个 `@`，保护已有应用标记、用户新草稿、页面切换和取消。删除旧的第二次通用清理，防止把用户后来输入的 `@` 当作探测残留删掉。读取失败不循环重试。
- 没选应用时不读取应用目录；选了应用时仍必须在当前网页确认该应用 ID。列表为空、身份消失、403/429、观察器缺失均不会被当作成功，不静默换应用。
- 设置页区分“上次确认的选项”和“本次刷新结果”，允许基于已有选项保存默认配置，但不将保存当作网页授权。增加三个纯布尔诊断：观察器是否回复、是否观察到网页请求、是否执行原生探测。日志不含正文、Cookie、应用凭据。
- 两端引擎标记一起升级到 alpha3.4，防止旧网页脚本被误当成新版。

CoS 的七个来源模块没有在本轮改写；新探测器、缓存边界和界面属于 Paseo 适配代码，不能宣称是整个 CoS 原版的直接复制。

## 3. 验证、证据与边界

修复前新增回归：创建表单的两项检查失败，分别复现“缓存仍在却返回 APP_CATALOG_UNAVAILABLE”和“表单卡在背景刷新”；无启动时应用响应的浏览器检查也复现相同错误。先前浏览器夹具会提前调用 fixture fetch 提供成功列表，遗漏了这个真实使用分支。

修复后实际结果：

| 检查 | 结果 |
|---|---|
| Node 全量测试 | 114/114 通过 |
| 新应用目录浏览器回归 | 11/11 通过 |
| 其余原生发送、回执、目录、双会话等浏览器检查 | 72/72 通过 |
| CoS 来源、哈希与加载清单 | 7 个模块通过 |
| JavaScript / JSON 语法检查 | 通过；扫描也包含测试工具和备份 |
| 完整 TypeScript 检查 | 未能完成：环境没有 tsc |
| 实际 Paseo SDK 契约测试 | 未能完成：项目未安装 @getpaseo/plugin |
| 登录账号后的 Chrome / Paseo 完整收发 | 本轮未验收 |

日志位于 `docs/evidence-alpha3-4/`。三项旧测试的准备步骤从“已有缓存过期”调整为“首次读取、尚无缓存”，保留原来的默认模型、字段格式、取消行为断言；没有删除失败断言来凑通过数。

本轮生产日志读取被工具访问范围拒绝，因此没有绕过限制读取 `~/.paseo/daemon.log`；以上现场判断依据用户截图、先前已提供的结果、当前源码以及独立复现，不声称取得了最新生产日志。未清空生产状态、改配对、重发历史消息、强制解除旧会话阻断或操作其他开发机。未上传 GitHub。

### 生效与下一次验收

源码已直接更新在原目录。重载 Paseo 插件和 Chrome 扩展，确认 Chrome 显示 0.1.6 / alpha.3.4，然后刷新旧 ChatGPT 页面；无需重新配对或删除状态。

先检查新建 Agent 页面能显示已确认的模型选项、不被一次背景刷新失败整体阻断；再用新的测试消息验证回执和回答回到 Paseo。选中 MCP 应用时仍要通过当前网页核验，失败看设置页的新诊断，而不是不断重发。此前网页已经出现的消息不要重复发送。

### 比对来源

CoS 已移植快照及本轮检索快照的 usage.js 内容 blob 一致：`f64e811f4d1261616d90140641a5a21049bfd8fb`。

- `https://github.com/totec448-spec/chat-on-steroids/blob/e40562640361ca8f74158b2262ca8c555b00abed/extension/usage.js`：inspectSystemHints、installFetchObserver、响应回放。
- `https://github.com/totec448-spec/chat-on-steroids/blob/ca66e706775587d95ca57405cec4f176a11755a2/extension/usage.js`：本轮对照检索的对应实现。
- `https://github.com/getpaseo/paseo/blob/b923cde6cfda7c04ce9886b41552a4159e33ba6f/packages/server/src/server/agent/plugin-provider.ts`：catalog、openSession 与请求/事件边界；对应项目瞄准的 0.11.2 源码快照。
- `https://paseo.sh/docs/plugins/providers`：Return models, modes, and thinking options；Open a session；Complete the first prompt。
