# 正文只增同步：接手复核（2026-10-17）

**当前状态：后续真实工作会话发现阻断，尚未修复，不可入库收尾。新增回归后默认测试为 411 项、408 通过、3 失败、0 skip。见 [现场异常调查](APPEND_ONLY_INCIDENT_REVIEW.md)。下文四轮无工具验收是部署当时的历史通过记录，不代表该实际工作流通过。**

基线：最新 `origin/main` = `3e0810a3d8350ee408e3051f0f57abe658406282`。
分支：`fix/chatmode-timeline-duplicates`。
版本候选：插件 `0.1.0-alpha.4.16`，扩展 `0.2.23`。

## 实现范围

延续用户批准的“原文只增加”方案，仅修公开 DIL `fallbackMarkdown` 的流式转换，不修改 Paseo，也不添加替代正文卡片或重构 turn ID。普通文本立即发布，尚有语法歧义的部分等待明确；已发布文本不重新改写。消息确认完成后，用原 CoS 转换器核对最终全文。Provider 仍发送同 ID 的累计全文快照，宿主计算增量。

接手前把 CIP 的 19 个变更文件做了校验快照，在远端全新克隆中重建候选。离线阶段未改 CIP 原工作区、原 main 开发目录、线上插件或已安装 Paseo；后续获批部署见文末。依赖在新克隆独立安装（不是借用另一工作区的 node_modules）：

```sh
npm install --ignore-scripts --no-audit --no-fund --package-lock=false
```

## 接手新增的修复

`tests/public-prose-regressions.test.mjs` 先验证了七个 CIP 原候选失败；针对第八个终态边界也先验证失败后再修正。

1. **行首上下文：** 不能把一句话中尚未发布的后缀独立当作新行解码，否则句中的三个反引号会被误认为代码围栏。每个完成行仅解码一次，保留完整行上下文，再发布尚未发送的后缀。
2. **完整空白语义：** 公式缩进与原转换器的 `trim()` 一致，支持 NBSP、全角空格、BOM 等，不仅限空格/Tab。
3. **中间发言收尾：** 已完成的 commentary 释放其语法缓冲，但不触发用户轮次完成。
4. **缓存生命周期：** 已完成 commentary 可被回收，避免正常长会话耗尽 32 条活跃消息缓存。
5. **媒体引用：** 没有正文的图片/媒体引用不被误判为“最终正文丢失”。已有文字流仍需要可验证的最终正文。
6. **失败保持：** 确认的原始源分歧保持失败，不能在后续读取中假装恢复成成功。
7. **处理量：** 解析游标向前推进，长行不再每个字从行首反复扫描。测试使用语法扫描量而非易抖动的时间阈值；原候选处理一个 20,000 单元普通文本块就触发该失败。
8. **最终答案收尾：** 保留原有 `item.completed + turn.complete` 的最终回答确认要求，不能因单独的 item 标志提前冻结仍在生成的正文。

另扩充了实际浏览器回归，覆盖句中反引号与 Unicode 公式缩进。CoS 版权及来源保留，修改后的适配文件哈希已更新。

## 亲自执行的离线验证

运行环境：隔离 Node **22.23.3**，独立安装的 SDK **0.11.2**，原版 Paseo **0.11.4** 函数 SHA 校验，临时无登录 Chromium profile。以下为部署前离线检查，当时没有真实 ChatGPT 消息发送，没有修改安装中的插件或浏览器配置。

| 命令/检查 | 结果 |
| --- | --- |
| `npm run check` | PASS |
| `npm run verify:upstream` | PASS |
| `npm run typecheck` | PASS |
| `npm run test:sdk` | PASS，2/2 |
| `npm test` | PASS，407/407，0 skip（提供固定 CoS 源文件启用可选 TEXT12） |
| 生产入口回归 + 接手回归，原版 Paseo mapper/renderer 对照 | PASS，21/21 |
| 相同 Node 环境的干净 main：`npm test` | PASS，369/369，0 skip |
| 生产转换器随机组合审计 | PASS，固定种子 `0x51a7`，1500 个合成只增序列；不是数学完备证明 |
| 新正文合成浏览器测试 | PASS，8 个场景 |

17 个离线浏览器脚本通过：`append-only-public-browser`、`dom-audit`、`native-transplant`、`browser-fixture`、`attachment-order-browser`、`failed-send-disposal-browser`、`failed-send-persistence-browser`、`composer-diagnostics-browser`、`binding-identity-browser`、`receipt-shell-browser`、`receipt-interaction-browser`、`catalog-browser-regression`、`apps-headless`、`discovery-browser`、`browser-provider-flow`、`images-public-browser`、`binding-mv3-flow`。最后一项加载真正的 unpacked MV3 扩展、worker、MAIN/ISOLATED 脚本和 Runtime，但网页和网络仍为隔离夹具。

### 三项原有浏览器失败：本轮独立 main 对照

候选与 main 使用同一个 Node22、SDK、Python/Playwright 和 Chromium，均运行在各自临时 profile/TLS 夹具上：

| 脚本 | 候选 | main | 相同失败位置 |
| --- | --- | --- | --- |
| images-mv3-flow | exit 1 | exit 1 | 第 12/18 行旧 fixture 字符串替换断言 |
| native-activity-mv3 | exit 1 | exit 1 | binding-mv3-flow[native-activity]:213，工具 call ID 集合断言 |
| concurrency-reopen-mv3 | exit 1 | exit 1 | binding-mv3-flow[concurrency-reopen]:285 |

这些仍是 FAIL，不算通过，也没有在本补丁中顺手修改旧断言。只证明在同环境未修改 main 上也失败。

## 研究实验与默认回归的区分

CIP 曾把研究用的“预期红例”直接放进默认 `npm test`，导致默认测试恒失败。接手后完整保留在：

- `tests/provider-timeline-host-regression.diagnostic.mjs`
- `tests/provider-upsert-interface-gate.diagnostic.mjs`

明确运行方式：

```sh
npm run test:host-limitations
```

原版宿主对照结果：**23 项，14 通过、9 失败、0 skip，退出码 1**。这些失败没有被声明修复，也不是 main 自带的九项失败。它们检查直接向下游注入任意非前缀正文、plugin-only 正文、双轨正文和机器侧结果取尾段等本次源头补丁未提供的能力。

另外修正了其中一个源头夹具遗漏 `public-prose-main.js` 的加载问题：原先失败原因已变成缺脚本而非正文重复。现在加载实际生产依赖、等待最终正文，并保留“全文不得重复”的断言，该源头回归真正转绿。其余九项限制断言没有削弱或设为 skip。

默认 `npm test` 的绿色，只代表本次只增源头契约及项目回归通过；不表示独立限制实验已通过。参见 [测试指南](TESTING.md)。

## 尚未解决 / 禁止越界

- 线上历史事故的具体读取分支仍未逐帧证实。已修的是有明确源码和可执行反例的 DIL 转换路径；不能把离线通过说成所有线上重复已经消失。
- 真正修改已经发布的原始文字，仍不能通过当前原生追加接口无损回写；明确诊断而不假报完成。
- 工具插在同一答案的增量中间时，Paseo 完成回报可能只取最后连续片段。本补丁没有通过复制第二份正文、隐藏卡片或修改宿主掩盖它；仍需单独决定处理范围。
- 用户已批准部署及真实账号验收。没有提交、推送、开 PR 或合并。

## 已批准的可回滚部署与真实验收

2026-10-17 用户明确要求直接部署，并允许影响仍在运行的 Chatmode 会话。只停用/启用该插件，没有重启 Paseo daemon。先备份旧代码、状态和配置，再以完整导出产物交换交付目录；未在交付目录开发源码。扩展通过 Chrome 的公开脚本接口触发已有 Reload 按钮，加载路径、扩展 ID 和配对保持不变。

插件实际 running：`0.1.0-alpha.4.16`；Chrome 扩展管理页实际版本：`0.2.23`。179 个交付源码文件的哈希与候选一致，部署期间没有产生新的 send 命令、没有重发旧用户消息。部署补丁 SHA-256：`37214000d3f2a151107797367f80ab974bf245732aa4a9d9f2a416bc8063b441`。本节验收记录在部署后追加，不改变该历史发布物的源码哈希。

使用专用 Agent、真实登录账号、新生成的无副作用输入，关闭应用工具选择。没有重放旧任务或批准 MCP 授权：

| 实际输入 | 结果与证据 |
| --- | --- |
| 单行纯文字回显 | PASS；一条用户消息、一条正确回答，原生接收回执和完成状态确认 |
| 表格、行内/块公式、代码围栏的 Markdown | PASS；359 字符，正文与 Paseo 最终回报相同，首尾标记各一次 |
| 仅发送生成的 64×64 双色 PNG，无文字 | PASS；原生接收回执确认，模型正确识别两种颜色；20 字符回答与持久化正文、SDK 和后续宿主读取一致 |
| 14 段长 Markdown 连续回显 | PASS；2034 字符，真实收到 11 次正文增量，首段先于完成通知；增量拼接、持久化正文、宿主最终回报完全相同，首尾标记各一次 |

图片发送最初被 Paseo CLI 的 `MISSING_PROMPT` 参数校验拒绝，核实没有产生新消息后，改用公开 SDK `agent.run('', { images: [...] })` 一次发送；没有添加占位文字或自动重试不明结果。两次 SDK 发送均有一次性尝试保护。

**边界：**这些验证覆盖真实发送、接收、增量及完成回报，不等于所有 UI 布局、归档/取消归档、工具穿插或全部历史事故都通过。未把宿主九项诊断失败和三项 main 可复现浏览器失败改写为通过。专用验收 Agent 保持 idle，便于人工查看。

完整离线日志仍在接手目录的 `logs/`；部署、回滚说明和真实验收指标保存在本机私有备份目录。未复制账号凭据或其他真实用户对话正文到仓库。
