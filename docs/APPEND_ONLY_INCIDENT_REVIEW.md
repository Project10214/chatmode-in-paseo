# 只增同步现场异常：调查记录（2026-10-17）

**状态更新：离线修复已开始，尚未交付或部署，两个线上原会话未恢复。** 原三项事故回归已转绿；新增宿主恢复门禁仍有两项红例，当前进展见 [FAITHFUL_SYNC_IMPLEMENTATION.md](FAITHFUL_SYNC_IMPLEMENTATION.md)。以下保留首次调查时的证据与结论；当时基线为 411 项、408 通过、3 失败、0 skip。

本轮只做目标会话的只读调查及隔离复现，未修改交付目录应用源码、刷新目标页面、重发任务、取消 Agent、批准 MCP、部署或提交。先前四轮无工具真实验收仍是历史通过记录，不能代表这条实际工作流通过。

## 现场事实与证据边界

用户指定的工作会话使用已部署的插件 alpha.4.16 / 扩展 0.2.23。时间均为 +08:00：

- 09:02:03，Paseo 只同步到最终报告的标题便收到 `ANSWER_RAW_DIVERGED`。对应 ChatGPT 网页上已有完整报告。
- 09:06:05，用户的新“继续”确实送到原生网页；约 4.4 秒后 Paseo 再次收到同一错误。检查时网页随后仍有工作发言及可用的 Stop 控件，Paseo 则为 error、无活动轮次。
- 首条记录另有 `INVALID_TEXT`，本轮没有将它归因于正文转换。
- 未取得首次错误前后的两份现场 fallbackMarkdown。不能断言模型改了原文，也不能把下面的合成触发器冒充为现场已证实的第一次触发点。
- 可用的 Chrome AppleScript 接口能读可见 DOM，但该上下文不暴露页面 MAIN-world 的 CIP/React 对象。GUI 工具命令 `orca skills get computer-use --json` 返回 `/bin/bash: orca: command not found`（127）；没有绕过工具限制读取现场闭包内存。

## 一、确认存在新引入的“先转换、后排除”副作用

位置：`extension/upstream/cos-shell-public.js:172-173`。

原有 `shellTurnSource()` 会从公开 reasoning-group 中读取 assistant 子项，并跳过已经由顶层消息表示的同 ID 副本。原来 `shellItemText()` 是无状态解码，先算文本再丢弃没有跨消息副作用。

新版本的 `shellItemText()` 会更新 `CIP_PUBLIC_PROSE` 的同 ID 缓存，但调用顺序没改：

1. 先调用 `shellItemText(step, ...)`，已经读入/修改缓存，或抛错。
2. 然后才检查 `topLevel.has(id)` / `remember(id)`，决定是否忽略该子项。

因此，一个本不应参与正文流的副本，也可能触发 `ANSWER_RAW_DIVERGED`。合成复现中，**有效顶层正文只增加**；仅加入同 ID、不同表示的待排除子项就失败。

独立 main 对照（`3e0810a3d8350ee408e3051f0f57abe658406282`）：

| 相同合成输入 | main | 当前候选 |
| --- | --- | --- |
| 顶层正文只增；reasoning-group 存在应忽略的同 ID 副本 | 返回正确顶层全文，无错误 | `ANSWER_RAW_DIVERGED` |

这是确定的代码回归、可以不靠“模型改字”触发相同错误。但现场当时具体是否存在这个副本，尚未直接采到。

## 二、确认旧消息错误会使整个后续读取失败

相关位置：

- `extension/public-prose-main.js:99-119`：按页面路径和 native message ID 保存状态；单条消息错误会一直保留。
- `extension/upstream/cos-picker-main.js:230, 346`：遍历多个历史区段；任意一条解码抛错，就返回整份 `messages: []` 的错误结果。
- `extension/dom-adapter.js:525-526`：尚未定位本轮用户消息，先抛整份 transcript 的错误。

保留失败消息自身的错误是正确的；问题是把它扩大成了整个页面、下一轮乃至状态通道的失败。

生产入口复现步骤：

1. 让旧消息发生一次明确拒绝。
2. 同路径下加入全新的正常用户消息和正常 assistant 消息。
3. 旧区段仍在 DOM 时，新轮也报 `ANSWER_RAW_DIVERGED`，消息和活动均不可读。
4. **仅在隔离夹具**移除旧区段，新轮正文、thinking 状态和 busy=true 立即可读。
5. 放回旧区段，新轮再次失败。

该序列同时在 Node VM 的实际 picker 入口和真正隔离 Chromium 的 MAIN/ISOLATED 适配链中复现。没有对真实网页删除节点或刷新页面。

这给出了“为什么继续后仍失败”的明确跨轮传播机制；不能据此声称已直接读出现场缓存内容。

## 三、正文采集错误终止了全部跟踪，原生状态随后丢失

相关位置：

- `content.js:140-143` / `dom-adapter.js:526`：正文读取先失败，后续工具、活动、生成/授权状态尚未发布。
- `content.js:253`：上报 `kind: failed`，清除 monitor；没有发送网页 Stop。
- `server/broker.mjs:810`：将本地 turn 记为 failed、已绑定 session 记为 idle，并结束活动行。
- `client/native-activity.tsx:23-28`：failed 和 canceled 共用“已停止”辅助状态；标题虽写“本轮跟踪已停止”，仍没有呈现原生任务在运行或待确认。

真实 Broker 隔离测试得到：session=idle、turn=failed、activity.nativeStatus=null、原生 Stop 命令数=0。因此，Paseo 的失败仅能证明同步失败，不能证明网页任务停止。不是简单改文案就足够：状态采集也要与正文转换失败隔离。

## 为什么没有把页面可见信息全部同步

当前代码不是完整网页镜像，而是有界的、按 native ID 绑定的投影：正文、公开过程摘要、部分工具生命周期/详情和活动卡片。它有区段、条数、字符数限制，也主动排除隐藏分析、账号界面和未验证来源。

主要缺陷不在于“这些状态不能同步”，而在于**正文与活动共用一次容易整体失败的读取**。一条正文异常，把本来还能判断的网页状态也挡住了。

合理的同步边界是“当前会话里用户可见的信息”，而不是整页 `innerText`：

- 回答正文继续走原生正文通道，保留现有身份与流式协议。
- 公开过程摘要、工具名/状态及可见详情走对应 timeline 项；超限时明确提示，不冒充全量。
- 原生运行、授权等待、完成/取消状态独立更新；权限按钮只同步状态，不替人授权。
- 同步健康度单列：正常、延迟、正文异常、断连。正文异常不能覆盖原生任务状态。
- 用户应能看到类似“正文同步异常；网页仍在运行”或“网页状态待确认；最近观察时间……”，而非仅一个 failed/已停止。
- 不复制侧栏其他会话、账号菜单，不读取隐藏思维或凭据，也不把按钮文字和工具进度拼成 assistant 正文。

Paseo 现有 [timeline/plugin 行更新接口](https://paseo.sh/docs/plugins/reference.md#timeline-items) 已能承载状态，不需要改宿主、删除 turnId 或把正文替换成另一张卡片。

## 新增回归及结果

- `tests/public-prose-incident.test.mjs`：4 项，1 通过、3 失败；失败分别锁定上述三类缺口。
- `tests/public-prose-incident-browser.py`：旧消息使新轮正文及活动不可读的断言失败，exit 1；正常新轮单独读取的对照通过。
- 同 Node 22.23.3、固定 CoS 源及原版宿主映射/渲染器环境，默认 `npm test`：**411 项，408 通过、3 失败、0 skip**。全部失败就是本轮新增回归，没有将它们移出默认测试、删除或 skip。
- 原来的宿主限制诊断与三项 main 可复现浏览器失败仍独立记录，没有重新宣称通过。

日志保存在接手目录的 `logs/public-prose-incident-red.log`、`logs/public-prose-incident-browser-red.log`、`logs/incident-full-tests.log`。本报告没有复制业务对话全文或凭据。

## 后续修复顺序（本轮未实施）

1. 在任何有状态解码之前，完成 native ID、可见性、重复/被替代项和规范来源选择。
2. 错误限定在所属消息和轮次；保留旧错误，不让旧失败阻塞正常新轮。
3. 将正文同步状态与原生执行状态分离，保持可验证的状态观察，不假报成功、不自动 Stop、不自动重发。
4. 对首次 raw 不连续增加有界、无正文的来源/长度/LCP/分支与包含关系诊断，区分来源表示切换、排除项误读和真实内容变化。它们目前不能从只有一个错误码的历史记录中恢复。
5. 先把新增红例修绿，再做有工具、多轮和错误恢复验收。任何新的发布/回滚另行确认；不直接编辑线上源码。
