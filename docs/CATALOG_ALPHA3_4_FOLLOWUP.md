# alpha.3.4 续查：应用目录、Paseo 表单与发送回执

## 结论

本次在 Penn’s Mac 的 `/Volumes/penndisk/HarnessSpace/Project10214/cos-in-paseo` 继续检查。问题在适配层的阶段划分，不是要求重新安装 MCP，也不能用反复重载替代修复。当前源码版本为 `0.1.0-alpha.3.4`，Chrome 清单版本为 `0.1.6`。

本次读取实际状态时，存储中仍有成功确认的 4 个模型、8 个应用；后续两个 `open` 命令却因 `APP_CATALOG_UNAVAILABLE` 失败。另一个 `send` 的诊断是 `nativeClicked=true`、`rowCount=1`、`matchingUserCount=1`、`refusal=chat-changed`，日志显示约 1.3 秒就失败，并非正常等满回执期限。这是两类独立故障，不能再全部归因于 DOM 读不到。

## 源码对照

### CoS 的读取器并不保证新网页会发请求

对照固定提交 `e40562640361ca8f74158b2262ca8c555b00abed`：

- `extension/usage.js` 的 `inspectSystemHints` 读取网页自身已经收到的响应，不主动发起应用列表请求。没有请求就没有新的读取结果。
- `extension/content.js` 的 `currentCoreMention` 明确处理新标签页尚未收到自身列表的情况：它可以使用同一浏览器先前确认的 Core 身份，但本页完整列表否定该身份后不能继续使用。

此前适配移植了观察器，却把“每个新文档必须收到完整应用列表”作为所有配置的必经步骤。这不是原版 CoS 的完整流程。通用多应用目录还比原版单 Core 选择多出完整性要求，因此不能把最后确认的名称直接当成新网页授权。

本版方案：表单可以展示上次确认的选项；真实发送仍核验选中的应用。必要时只在受控空输入框触发一次原生 @ 补全，让网页自己读取数据，仍从 CoS 观察器取得完整响应；不直接请求私有接口、不读取 Cookie、不猜测同名应用、不自动批准。若网页仍不提供有效证据，明确失败而非假装成功。未选择应用时，不需要这条读取链路。

### Paseo 的目录与会话执行不是同一件事

已阅读 Paseo 官方 Provider 插件文档，并对照目标版本源码快照 `b923cde6cfda7c04ce9886b41552a4159e33ba6f` 的 `packages/server/src/server/agent/plugin-provider.ts`，包括 `fetchCatalog`、`openSession` 和 `normalizeConnection`。

创建界面先取得模型目录，实际会话随后由 `session.open` 打开；异步结果通过 Provider 事件回传。旧实现让所有目录调用共用要求新采集成功的 `ensure()`，于是一次刷新失败或目录超过五分钟，就能阻断仍然拥有有效历史选项的创建页面。

`CatalogService.forForm()` 现在把表单读取独立出来：有确认过的缓存就展示，不重新标记观察时间、不隐藏刷新失败、不额外开标签页；没有任何已确认目录的首次安装仍需真实发现。`server/provider.mjs` 使用该入口；发送前的实际配置核验没有取消。

### 另行复现了回执被点击误取消

此前 `dom-adapter.js` 在整个发送操作期间，把页面任意可信点击/输入都记作草稿被修改。即使已点击 Send，用户只是点击页面查看结果，也会让 `stillCurrent` 返回 false，产生 `chat-changed`，丢弃随后出现的准确回执。

新增 `tests/receipt-interaction-browser.py` 用 Playwright 的真实可信点击，故意延迟网页用户消息的挂载。修复前稳定得到与生产日志相同的：`RECEIPT_UNCONFIRMED`、匹配用户消息数 1、`chat-changed`。修复后，草稿编辑保护只在实际 Send 之前生效；已经发出的请求继续按精确文档、会话、用户消息 ID 和正文等待回执。发送前的人为改稿仍阻止发送；发送后输入的下一条草稿不会被删除。没有增加自动重发。

这解释了一条可复现的回执失败路径；不声称已经排除了真实站点所有回执兼容问题。

## 本次实际验证

| 项目 | 本次结果 | 证据 |
| --- | --- | --- |
| 全量 Node 测试 | 114/114 通过 | `evidence-alpha3-4/node-tests.log` |
| 应用列表按需读取回归 | 11/11 通过 | 本次工具输出；前一轮同名日志保留 |
| 新增发送前/后可信交互回归 | 3/3 通过 | `receipt-interaction-after.log` |
| 同一交互回归修复前 | 失败，复现 matchingUserCount=1、chat-changed | `receipt-interaction-before.log` |
| 实际安装的 Paseo SDK 0.11.2 契约 | 1/1 通过 | `sdk-installed.log` |
| 最后修改后的完整浏览器套件重跑 | 工具安全状态检查阻止，未完成 | 不将历史记录冒充本次全量结果 |
| 完整 TypeScript 类型检查 | 未完成；项目缺少 React/Node 等开发类型依赖 | 已安装应用中也未找到完整类型包 |
| 登录后 ChatGPT / Chrome / Paseo 完整链路 | 尚未实机验收 | 不以离线模拟替代 |

SDK 契约检查使用电脑已安装的 Paseo 应用内真实模块，版本确认是 0.11.2；不是自写 SDK 替身，也没有启动第二个生产 Runtime。该测试验证 Provider 事件/输入协议，不代表界面类型检查或登录账号的完整链路已通过。测试入口 `tests/sdk-contract.mjs` 新增了可选的本地 SDK 模块路径。

前一轮 `CATALOG_ALPHA3_4.md` 和其 83 项浏览器记录保留为历史证据。本次追加了回执交互修订；完整套件重跑被阻止后没有改换工具或命令规避，故最终只报告实际完成的本次检查。先前“SDK 因缺依赖未完成”的记录已由本次真实安装模块测试补充，不再作为当前结论。

## 生效和下一轮验收

1. 重载这一个 Paseo 插件及对应 Chrome 扩展，核对 Chrome 为 0.1.6 / alpha.3.4，再刷新原有 ChatGPT 页面。无需删除状态或重新配对。
2. 用一个新的测试会话，明确关闭全部 @ 应用后发送唯一纯文本标记，验证回答回到 Paseo；“不调用工具”的文字本身不会关闭 Agent 中预选的应用。
3. 纯聊天通过后，同一会话选择 mymac，再测只读目录调用。若失败，读取具体阶段诊断，不重复提交网页中已经出现的消息。

本次没有发送真实聊天消息、修改其他项目、删除历史、重置凭据、解除旧会话阻断或上传 GitHub；没有擅自开启 Chrome 的 AppleScript JavaScript 权限。

## 一手资料

- CoS 应用观察器：`https://github.com/totec448-spec/chat-on-steroids/blob/e40562640361ca8f74158b2262ca8c555b00abed/extension/usage.js`
- CoS 新标签页 Core 身份选择：`https://github.com/totec448-spec/chat-on-steroids/blob/e40562640361ca8f74158b2262ca8c555b00abed/extension/content.js`，`currentCoreMention`。
- Paseo Provider 适配源码：`https://github.com/getpaseo/paseo/blob/b923cde6cfda7c04ce9886b41552a4159e33ba6f/packages/server/src/server/agent/plugin-provider.ts`
- Paseo 插件文档：`https://paseo.sh/docs/plugins/providers`
