# alpha.3.7：09:30 发送后的正文回执未确认

## 结论与边界

已定位到回执的正文比对层，并修复可完整复现的 CoS 转义比较移植遗漏。代码已写入原项目；没有重载用户插件、发送账号消息、修改生产状态、解除旧会话阻断或上传 GitHub。

磁盘版本：Paseo 0.1.0-alpha.3.7；Chrome 清单 0.1.9，显示版本 0.1.0-alpha.3.7。CIP 仍为 v3。

## 1. 现场证据

只连接 mymac（Penn’s Mac，/Users/penn）。读取 ~/.cos-in-paseo/state.json 和 ~/.paseo/daemon.log 时，仅输出时间、状态、错误、数量及身份信息，不输出正文或凭据。

09:30:34.807 的 send 在 09:31:02.019 记录失败，用时 27210ms：

```json
{"error":"RECEIPT_UNCONFIRMED","diagnostic":{"stage":"receipt","rowCount":1,"matchingUserCount":0,"nativeClicked":true,"transcriptAvailable":true,"pathChanged":true,"routeKnown":true,"refusal":"not-accepted"}}
```

这证明已有可读用户消息和正式路由，但正文不匹配；不同于先前的 chat-changed 提前中断或临时布局 ID 失效。目录采集另有 NAVIGATION_CHANGED，而该次 open 已完成，不能将目录错误当作这次 send 的直接原因。

本轮尝试检查已打开浏览器的只读请求被平台阻止，没有执行该请求或更改权限。因此未直接取得现场消息原文，不能仅凭相同错误字段断言所有现场因素均已排除。

## 2. CoS 比对与修订

固定来源：CoS e40562640361ca8f74158b2262ca8c555b00abed，extension/content.js；Git blob f5bfa3927b0d63cf6f287a79da43bb79b1ce8c0c。

原版第 827–828 行 unescapeMarkdown、第 878–887 行 matchesSubmittedBootstrap，明确处理应用插入文字被原生网页存成 Markdown 转义的情况：先比较原文，失败后只还原一次。旧 dom-adapter.js 只比较 row.text 与 norm(command.payload.text)，漏掉了这条分支。Paseo 即便只输入 hi，也会加上多行项目上下文，方括号和换行都可能进入此分支。

新增 extension/upstream/cos-receipt-text.js，保留原版两行解码表达式和版权。比较器按本项目边界裁剪；没有照搬原版删除全部空白的 sendText，也没有引入 Goal／续聊标记规则。

仅当前页面、同一原生 ID、同一原生正文的用户消息允许转义比较。DOM 标签文本不能借此通过。要求完整正文相同，不做模糊、子串、大小写宽松匹配，不重复解码；发送前的草稿、模型、应用、导航检查以及旧 ID 拒绝均保留。成功回执同时要求最新用户消息 ID 匹配。

没有改写发送内容或网页记录。后台新增只含固定枚举与数量的 bodyMatch、exactUserCount、escapedUserCount 诊断；不记录正文。来源校验支持原版 const 箭头函数的明确声明形式，仍保留文件哈希、名称、许可与加载位置检查。

## 3. 验证

先修改测试夹具，让原生用户消息采用独立的标点／硬换行转义序列化，再运行未修订的 alpha.3.6：真实独立 MV3 扩展、HTTP Runtime、已安装 Paseo SDK 链路失败，产生与现场一致的 rowCount=1 / matchingUserCount=0 / transcriptAvailable=true / not-accepted，等待约25秒。证据：evidence-alpha3-7/escaped-before.log。

修订后实际通过：

- Node：141/141，含12项新增正文比较测试；原文优先、单层转义、多行／代码缩进、字面反斜杠、双层转义拒绝、无原生证据拒绝及诊断过滤。
- 其余11套离线浏览器回归全部通过，覆盖身份、导航、草稿、应用、两轮对话等。
- 完整真实扩展＋实际 Paseo SDK：原文模式7项、转义模式8项均通过，覆盖回传、刷新续收、双会话；并断言 Runtime 持久回执 bodyMatch 确为 raw 或 markdown。
- 实际 Paseo SDK 独立契约测试1项通过；8个来源模块与 JavaScript/JSON 检查通过。

日志位于 docs/evidence-alpha3-7/。浏览器使用一次性测试配置和本地模拟网页／回复；没有对用户账号发送测试消息。完整 TypeScript 类型检查未执行，登录账号验收未完成。

## 生效与下一步

重载两个插件，确认 Chrome 显示 alpha.3.7（内部0.1.9）；只刷新不再执行任务的旧页面。无需重新配对或删除状态。保留旧报错会话，不重发原消息；新建一次测试会话发送新的标记，验收回答是否回到 Paseo。若仍失败，读取本版 bodyMatch／exactUserCount／escapedUserCount 诊断继续区分，不将失败改写成成功。
