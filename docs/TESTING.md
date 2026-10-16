# 测试与验收指南

适用于本项目的开发、修复和升级。产品范围与必须守住的行为边界见[产品说明书](PRODUCT_MANUAL.md)，通信协议见 [PROTOCOL.md](PROTOCOL.md)。

**原则：测试强度按风险决定，但不得牺牲消息安全和真实验收。** 每一项只报告自己亲自验证到的层级：源码正确 ≠ 离线浏览器通过 ≠ 真实网页登录页成功 ≠ 外部 MCP 实际执行成功。

## 1. 按改动选择测试

| 改动类型 | 最低要求 | 是否需要真实账号 |
| --- | --- | --- |
| 只改文字/文档 | 检查内容、链接和前后描述一致 | 不需要 |
| 纯内部算法、格式、单元测试 | 相关测试 + Node 全量回归 | 通常不需要 |
| TypeScript、Provider、CoS 移植或 Chrome 扩展 | 上述测试 + 类型/SDK/来源检查（按涉及模块）+ 离线 MV3 浏览器测试 | 更改真实用户行为时需要 |
| 发送、Stop、身份绑定、唤醒、原生工具事件、部署迁移 | 自动化 + 对抗测试 + 真实三端联调 | **必须**；运行中的其他 Agent 不允许被打断 |
| 纯 UI 改动 | 组件/类型检查 + 桌面和相关移动端视觉验收 + 不影响其他 Provider | 如影响真实消息显示，则需要 |

### 常用命令

```sh
npm run check             # 语法、JSON、清单与协议版本一致性
npm test                  # Node 单元与集成测试（无需安装依赖）
npm run verify:upstream   # 改动 CoS 移植层时：来源与哈希校验
npm install --ignore-scripts --no-audit --no-fund   # 安装固定版本的开发依赖
npm run typecheck         # TypeScript、界面或 Provider 有改动时
npm run test:sdk          # Provider 事件有改动时：用真实 SDK 校验
```

离线浏览器测试需要 Python、Playwright 和 Chromium（安装方法见 [README](../README.md) 第 3 节）。它们加载内存页面，不登录账号、不发真实消息：

```sh
npm run test:dom        # DOM 适配层审计
npm run test:attachment-order # 先附件后正文；未发送失败只移除本次附件与正文
npm run test:failed-send-disposal # 未发送失败作废（含 @）、保留用户修改和未知回执
npm run test:failed-send-persistence # IndexedDB 自动保存模拟 + 新页面恢复；5 个清理/保留场景
npm run test:composer-diagnostics # 草稿错误只读诊断：节点分类/时序/脱敏，不修改草稿
npm run test:browser    # 浏览器夹具回归
npm run test:flow       # Provider 全流程（内存页面 + 模拟 tabs API）
npm run test:native     # 移植函数行为（夹具页面）
npm run test:mv3        # Chrome MV3 通信层回归（需要隔离的浏览器环境）
```

另有 `test:binding`、`test:receipt`、`test:receipt-interaction`、`test:catalog`、`test:apps`、`test:discovery`，以及 `tests/` 中未接入 npm 脚本的 `*.py` 浏览器回归脚本。它们的运行环境相同，可直接用 `python3 tests/<name>.py` 执行。

`test:failed-send-persistence` 使用临时浏览器 profile 和本地路由，模拟网站的 IndexedDB 自动保存；验证自己的未发送正文与应用清理后不会在新页恢复，用户修改、历史未知草稿和未知回执仍保留。它不是 ChatGPT 闭源保存代码的复刻；真实 B01 的来源追踪与清理验收记录只保存在本地 `docs/internal/`，不随仓库发布。

没有依赖或浏览器环境时写 **BLOCKED**，不能改称 PASS。离线 Chrome 测试必须使用独立 profile 和临时 Runtime；不要把生产 ChatGPT 账号或运行中的会话当夹具。修复问题时，同时加一条**能复现旧问题**的测试和相应的反向/异常测试。

### 可选：上游逐字比对（TEXT12）

`tests/receipt-text.test.mjs` 的 TEXT12 会把本项目的解码表达式与固定提交的上游 `extension/content.js` 逐字比对。上游文件不随仓库发布；没有它时该测试自动跳过，其余测试照常运行。要启用比对：

```sh
d=vendor/cos/reference/e40562640361ca8f74158b2262ca8c555b00abed/extension
mkdir -p "$d" && curl -L -o "$d/content.js" \
  https://raw.githubusercontent.com/totec448-spec/chat-on-steroids/e40562640361ca8f74158b2262ca8c555b00abed/extension/content.js
```

`vendor/cos/reference/` 已被 git 忽略；也可以用环境变量 `CIP_UPSTREAM_CONTENT_JS` 指向该文件。

## 2. 真实账号验收

改动涉及真实用户行为时，使用**专用的 ChatGPT 账号/会话和专用 Paseo Agent**。只抓关键场景，**按任务选择，不是每次都跑满 T1–T8**：

| 编号 | 关键场景 | 通过标准 |
| --- | --- | --- |
| **T1** | 安装、配对、配置 | 本机连接、模型/工具读回正确；不接受错 token 或错页 |
| **T2** | Paseo → ChatGPT | 首轮与第二轮成功、同一 Conversation、每条一次 Send，最终回 idle |
| **T3** | ChatGPT 网页 → Paseo | 原 Agent 收到用户消息、后续回复与终态；`origin=browser`，Paseo 不二次发送 |
| **T4** | Stop、关页、恢复 | **仅凭绑定 Conversation 重开原 URL**；消息按独立 ID 去重，结果未知不自动重发；不影响其他 Agent |
| **T5** | 公开思考与工具 | 真实网页至少 2 个不同 `callId`，Paseo 独立工具卡、名称/状态准确；有公开摘要时正确出现；无私有泄漏 |
| **T6** | 错误与并发 | 回执不明、断线、后台限速、双 Agent、换页/重复事件不会误报成功或串会话 |
| **T7** | UI/图片（改动时） | 消息排版、折叠、图片与回放正确；桌面/移动端可用，不影响其他 Provider |
| **T8** | Chrome / Paseo 自动唤醒 | Chrome 退出后 Paseo 应启动 Chrome；Paseo 退出但 Chrome 仍在线时，已配对扩展经受限本机入口唤起 Paseo；Chrome 扩展更新应刷新**原插件管理的**已打开对话并自动恢复 Agent 观察（不重发、不串页） |

- **双向同步与恢复：** 重点 T2、T3、T4、T6、T8。一次性安装/配对不作为每轮用户操作要求；T8 需真机验证 Chrome 与 Paseo 分别退出再由另一侧唤起，不能只凭 `open` 返回成功计 PASS。
- **公开思考与工具：** 重点 T5、T6。若真实页面没出现公开摘要，记“本案例没有摘要证据”，不能把空结果算作摘要通过；应另找确实显示摘要的安全场景。
- **消息 UI：** 重点 T7，连带 T2/T5 的正常显示和其他 Provider 回归。
- **一般内部改动：** 只跑受影响功能和必要回归，不因改文档或纯内部函数强制登录 ChatGPT。

**实机证据必须同时对应：** ChatGPT 中的用户/工具活动、Chrome/Runtime 的同轮身份、Paseo 的实际时间线。工具只读文件的返回值正确，并不自动证明 `tool_call` 卡片已经同步；Stop 成功也不能证明已发起的外部 MCP 进程被杀掉。

### 进入真实验收前的检查清单

- [ ] 安装 `package.json` 的依赖，运行完整 `typecheck` 和 `test:sdk`，修复所有失败。
- [ ] 停用旧插件，备份退出后的状态目录，同时替换 Paseo 与 Chrome 插件，刷新旧网页；不与旧版 CIP 混用。
- [ ] Paseo 能加载两端入口并打开 Settings → Plugins 的 Chatmode 设置，生成配对码；不重复启动 Runtime。
- [ ] Chrome 与 Paseo 后台在同一主机，本机配对成功；失败重配不破坏旧连接。
- [ ] 真实账号的模型、对应思考档位、授权应用与稳定应用 ID 可读；保存默认配置再创建 Agent，不偷偷降级。
- [ ] 创建 Agent 不打开会话页；首条发送才开独立标签；目录刷新产生的临时页单独计数。
- [ ] 仅要求回显测试标识：单次 Send、正确消息/对话锚点、实际回答和终局；第二条进入同一会话。
- [ ] 选择开发主机 MCP 后只读一个测试文件，在目标机确认真实结果；不得把“已调用”字样当作文件执行证据。
- [ ] A、B 两个不同配置的 Agent 同时生成；停止 A 不影响 B；B 的下一轮不串到 A。
- [ ] queued / claimed / authorized / receipt 时分别断线；未知结果阻断，重连不得多次点 Send。
- [ ] 配置与授权等待时改正文、换模型、导航 A→B→A、reload、关闭标签/Provider；保留用户草稿，不串会话。
- [ ] 授权等待只提示，不自动批准；限额/策略警告停止工作，不换账号、模型或会话来规避。
- [ ] 长回答、缺 final、代码 Copy、多响应片段、状态接近容量上限均有明确处理；每轮仅一个有效终局。

## 3. 结论只用四个状态

- **PASS**：本次真实执行且有证据，符合预期。
- **FAIL**：执行了，结果不符合；写清错误与复现步骤。
- **BLOCKED**：权限、登录态、工具环境或活跃生产 Agent 阻止安全验收；写清前置条件。
- **NOT RUN**：本轮未做。历史 PASS 只能引用为历史证据，不能当本轮 PASS。

实现写完但真实验收未完，写“代码完成、待验收”，**不能标为完成**。未完成范围、权限边界或验收口径如果要删改，先取得明确批准并留痕，不允许为了标完成而隐性放宽。

## 4. 记录与隐私

每次验收留一份简要记录：

```text
案例 / 日期：
Paseo 与 SDK 版本：
Chrome / 扩展 / CIP 版本：
ChatGPT 页面语言与菜单形态：
本地测试会话标识（不记录配对码、token 或私有真实 URL）：
改动（文件/关键逻辑）与测试（命令、通过数、真实或模拟）：
操作 / 预期 / 实际：
PASS / FAIL / BLOCKED / NOT RUN：
脱敏日志位置：
风险或未完成项：
```

私有 token、配对码、完整私人会话、隐藏推理或未授权工具参数不能进入记录、Issue 或 PR。日志只保留脱敏 ID/片段、状态与数量。

## 5. 升级运行中的安装：四个关口

1. **确认安全窗口：** 相关共享 Runtime 没有活跃轮次、待授权和不确定发送。若仍在运行，**只做隔离测试，不部署**；不要手动清空状态来制造空闲。
2. **保留恢复能力：** 停止共享 Runtime 后备份其状态和旧代码/扩展，核对数据兼容；不能删活锁，也不能拿不兼容的旧状态直接回滚。
3. **更新并核对真实版本：** 成套加载相关 Paseo 插件和 Chrome 扩展，刷新**明确空闲**的专用网页；核对 CIP 协议、engine、扩展实际加载的脚本、Runtime epoch 或构建哈希。**数字版本相同不等于代码已经生效**；文档修改不要求升级插件版本。
4. **小范围实机验证后放行：** 用新测试消息验证收发、恢复及受影响的工具/UI。失败即停止扩大使用，按备份和兼容方案回滚；**不重发结果不明的旧消息**。

不预设“完成状态必须在 10 秒内”一类未经基线证实的硬指标。先记录真实网页结束到 Paseo `completed` 的耗时与复现条件，确认体验目标后再决定阈值；**不能通过弱化终态验证制造更快的数字**。
