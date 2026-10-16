# alpha.3.6 — 原生消息身份与实际扩展回传链路

日期：2026-10-14。位置：`/Volumes/penndisk/HarnessSpace/Project10214/cos-in-paseo`；开发机 `mymac / Penn’s Mac / /Users/penn`。

**代码已完成修订；完整 Chrome 扩展的受控回传测试通过。尚未在用户登录的 ChatGPT 账号上验收。**

版本：Paseo 插件 `0.1.0-alpha.3.6`，Chrome 内部版本 `0.1.8`，显示版本 `0.1.0-alpha.3.6`，网页引擎 `cos-native-alpha3.6`；CIP 仍为 v3。

## 1. 原因与修订

现场 Runtime 已收到发送回执，但保存的 nativeMessageId 是 `fallback-turn-0:0:user`。这是网页的搜索/布局键，不是正式消息身份。旧 DOM 回退错误地把 data-chatgpt-search-unit-key 当作 messageId；布局改变后，background 的下一次身份比对立即报 BROWSER_BINDING_LOST。

已补齐原版 CoS 的搜索锚点入口 `[data-chatgpt-search-unit-key$=":user"]`，从已提交的原生消息模型取得 messageId。DOM 回退只认明确 data-message-id，不再把位置键升级为消息身份。Runtime 对发送回执、回答快照也拒绝位置键，避免前端失误污染持久绑定。消息模型有冲突时不会改用较弱的 DOM 证据放行。

实际装载整个 MV3 扩展后，还复现了先前模拟后台未覆盖的第二个断点：页面通过 history 更新为 `/c/<id>` 后，Chrome 消息发送者携带的旧文档地址被 background 覆盖到事件上，导致 Runtime 拒绝回复，content 记录 PAGE_IDENTITY_MISMATCH。现改为读取 Chrome 当前标签页地址，并核对事件会话、标签页、文档和本地归属；不能仅信任网页传来的 URL，也不能用旧 Sender.url 覆盖新会话地址。

短暂重绘/原生消息暂时不可读不再立即判定丢失。最多允许 15 秒重新观察，后台等待起点保存在扩展本地存储中，worker 重启不延长同一次等待。真正的会话/消息冲突、关闭页面、多个可疑替代标签页仍拒绝。不重新发送，不替换原消息 ID，不自动解除旧 blocked 状态。

增加受限绑定失败原因和 `[CIP observation]` 完成/失败日志；不记录正文、工具参数、配对凭据。设置界面仍通过现有 Provider 配置，Runtime 的 `/event` → Broker → `timeline.item` / `session.turn` 回传通道没有被另一套服务替代。

## 2. 验证证据

日志目录：`docs/evidence-alpha3-6/`。

- `node-tests.log`：129/129，通过。包含位置键拒绝、刷新恢复、15 秒限时、worker 重启保持期限、明确冲突拒绝、旧 Sender.url 与当前 tab.url 区分，以及扩展自身界面来源检查。
- `binding-identity-browser.log`：5/5，通过；修订前的错误结果保留在 `identity-before.log`。
- `mv3-installed-sdk.log`：7/7，通过，`installedSdkValidated: true`。
- 其余发送、目录、停止、双会话和导航浏览器回归通过；去重合计 103 项浏览器检查（含上述 5 项和 7 项）。
- `sdk-installed.log`：已安装 Paseo SDK 的独立契约测试 1/1，通过。
- `upstream.log`：7 个来源模块、实际哈希、许可证和加载位置核对通过。
- `check.log`：JavaScript / JSON 检查通过；扫描数还包括测试工具和备份，不能当作产品模块数量。

### 这次完整扩展测试实际覆盖了什么

`tests/binding-mv3-flow.py` 用独立临时 Chrome 配置，真正装载整个解压扩展，使用真实 service worker、chrome.tabs、MAIN/ISOLATED 两种脚本环境、Chrome 消息和 HTTP Runtime。Provider 输出由本机 Paseo 自带的 SDK schema 校验。

已验证：配对与目录读取；第一条消息只发送一次；布局键改变后仍绑定原生 messageId；回答进入 Runtime 历史并发布 Provider 事件；第二轮刷新页面后继续观察、不重发；两轮各只有一个完成事件；两个并发标签页的模型、应用、消息和回答互不串用。

网页与回答仍是离线夹具，不是用户账号。为防止扩展创建的首个标签页早于 Playwright 路由挂载，测试将 chatgpt.com 在**该临时浏览器进程**中解析到 loopback TLS 夹具。测试专用安装和证书参数只存在于该隔离进程；未开启用户浏览器的 AppleScript JavaScript、调试或证书例外。普通 Chrome 不支持旧式命令行加载扩展，因此测试采用官方 CDP Extensions.loadUnpacked；没有继续依赖失败的测试浏览器下载。

完整 TypeScript 类型检查本轮未执行。实际 Paseo 界面显示与登录 ChatGPT 的端到端收发仍待重载后的验收，不能用离线结果代替。

## 3. 生效与验收

源码已写回原目录，未修改生产 state.json、配对密钥或旧历史，没有重发旧消息，也没有上传 GitHub。上轮未完成草稿已经接续处理，来源哈希已更新。

重载 Paseo 插件和 Chrome 扩展，确认显示 `alpha.3.6`（内部 `0.1.8`），刷新旧 ChatGPT 页面；不要删除状态或重新配对。保留旧失败会话，在一个新测试会话发送：

```text
只回复 BINDING_V3_6_OK，不调用任何工具。
```

确认回复进入 Paseo，再在同一会话发送“上一条回复是什么？不要调用工具。”。成功标准是第二条沿用同一个网页会话，Paseo 收到两次回答；不是仅网页有答案。

复跑完整扩展测试（所有账号/状态均隔离）：

```sh
export CIP_CHROMIUM='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
export CIP_NODE='/Applications/Paseo.app/Contents/Frameworks/Paseo Helper.app/Contents/MacOS/Paseo Helper'
export CIP_SDK_MODULE='file:///Applications/Paseo.app/Contents/Resources/app.asar/node_modules/@getpaseo/plugin/dist/server/provider.js'
ELECTRON_RUN_AS_NODE=1 .test-tools/bin/python tests/binding-mv3-flow.py
```

## 来源与边界

CoS 固定参考 `e40562640361ca8f74158b2262ca8c555b00abed` 的 `extension/fiber.js:79–85`、`turnViewOf`、`messagesFromTurnView`；本机来源副本位于 `.work/receipt-20261013/upstream/fiber.js`，MIT 声明保留于 vendor/cos。搜索锚点用于寻找原生数据，绝不能把锚点字面值当作原生 ID。

Paseo 官方契约： https://paseo.sh/docs/plugins/providers （send 接受工作，onEvent 发布完整快照与每轮终结事件）。

Chrome 安装测试接口： https://chromedevtools.github.io/devtools-protocol/tot/Extensions/ 。
