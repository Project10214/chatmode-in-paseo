# 测试与验收指南

适用于 **CIP v9 / 扩展 0.2.52 / 插件 alpha.4.50** 的开发、修复和升级。产品范围与行为边界见[产品说明书](PRODUCT_MANUAL.md)，端点以 [PROTOCOL.md](PROTOCOL.md) 为准。旧版 v5 路由不再作为现役验收指令。

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
npm ci --ignore-scripts --no-audit --no-fund # 已提交 package-lock.json
npm run check             # 语法、JSON、清单与协议版本一致性
npm run verify:upstream   # CoS 来源与哈希校验
npm test                  # 现役 Node 单元与集成测试
npm run typecheck         # TypeScript / SDK
npm run test:sdk          # 真实 Paseo SDK schema
npm run sync:health       # 只读：本机 Runtime 状态里的页面→Paseo 同步健康度
node --test tests/approval.test.mjs tests/approval-gate-http.test.mjs # 自动允许/手动拒绝并发与授权前服务端门禁
# 已准备固定 beta.2 原版宿主包时额外运行：
CIP_PASEO_SERVER_PACKAGE=/path/to/server-0.12.0-beta.2/package npm run test:host-gate
```

### 同步健康度（`npm run sync:health`）

只读读取本机 Runtime 状态（`~/.chatmode-in-paseo/state.json`，可用 `CIP_STATE_DIR` 覆盖），**只输出长度和计数，不输出任何聊天正文**。它回答"页面→Paseo 这条同步链路现在是否健康"：

| 列 | 含义 |
| --- | --- |
| `frames` | 该会话收到的 page-view 帧数；远大于读数次数说明传输在分帧 |
| `lag` | 账本文本比已投递的历史更长 —— 正文被冻结或落后（修复 1 的症状） |
| `rev` | 前一条用户消息引用发生漂移的次数（修复 1 的触发条件，修复后由 `SOURCE_USER_MESSAGE_REVISED` 显式报出） |
| `cfl` | 来源身份冲突 —— 修复 1 修复前的症状，修复后应为 0 |
| `churn` | **正文一字未改却被记为 rewrite** 的次数 —— DOM 路径位移被读成内容改写的指纹（修复 2 的症状），修复后新会话应为 0 |
| `dom` | DOM 本地身份（没有稳定 native id）的来源数，位移风险高 |

```sh
npm run sync:health                    # 最近 8 个会话
node scripts/sync-health.mjs --limit 40
node scripts/sync-health.mjs --session <sessionId>
```

离线浏览器测试需要 Python、Playwright 和 Chromium（安装方法见 [README](../README.md) 第 3 节）。它们加载内存页面，不登录账号、不发真实消息：

```sh
export CIP_NODE="$(command -v node)"
python3 tests/public-message-browser.py        # 公开原文，MAIN/ISOLATED
python3 tests/page-content-browser.py          # DOM 公开来源与授权卡
python3 tests/model-picker-opening-browser.py # 菜单打开后才有模型元数据；缺失/错误模型仍拒绝
python3 tests/continuous-actions-browser.py    # Stop、持续授权按钮复核与网页授权动作
python3 tests/attachment-order-browser.py      # 先附件后正文
python3 tests/failed-send-disposal-browser.py  # 未发送清理
python3 tests/binding-mv3-current.py            # 真 MV3 worker + 本机 Runtime + 隔离页面
python3 tests/page-view-framing-browser.py      # 一次页面读数被传输分帧时，只有末帧是收尾证据
# 其它专项：tests/artifact-browser.py、tests/prose-source-flow-browser.py
```

浏览器级脚本位于 `tests/*.py`；`tests/legacy/` 收录旧架构研究夹具，不作为 v8 发布门禁。GitHub CI 的 `browser-regression` job 执行上述六类隔离浏览器检查，仍不能代替真实登录账号验收。

### 浏览器夹具的本机环境（2026-10-21 实测）

`tests/*.py` 依赖三件本机事实，缺一件就会静默少跑或直接报错：

1. **Python Playwright 版本要与已缓存的 Chromium build 对应。** `~/Library/Caches/ms-playwright` 里已有 `chromium-1200`；**Playwright 1.57.0 正是使用 build 1200 的版本**（1.58→1208、1.59→1217、1.60→1223，都会重新下载浏览器）。装在 `.test-tools/pw-venv`：
   ```sh
   python3 -m venv .test-tools/pw-venv
   .test-tools/pw-venv/bin/python -m pip install "playwright==1.57.0"
   ```
2. **`CIP_CHROMIUM` 必须指向 Chromium 可执行文件。** 多个夹具（`page-content`、`button-state`、`config-at-send` 等）不报错但直接 `KeyError: 'CIP_CHROMIUM'`：
   ```sh
   export CIP_CHROMIUM="$HOME/Library/Caches/ms-playwright/chromium-1200/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
   ```
3. **真实宿主夹具要一个解包并装好依赖的 `@getpaseo/server` 目录**，缺了就抛 `CIP_PASEO_SERVER_PACKAGE is required`，不 skip：
   ```sh
   export CIP_PASEO_SERVER_PACKAGE="$PWD/.test-tools/paseo-server-012/package"
   ```
   要跑到**已安装的 Paseo** 上，还要指明它的 daemon 源文件与 web 渲染包（哈希必须落在 `tests/fixtures/paseo-real-contract.mjs` 的 pinned 审计里）：
   ```sh
   export CIP_PASEO_PROVIDER_SOURCE="$CIP_PASEO_SERVER_PACKAGE/dist/server/server/agent/plugin-provider.js"
   export CIP_PASEO_RENDERER_BUNDLE="/Applications/Paseo.app/Contents/Resources/app-dist/_expo/static/js/web/index-<hash>.js"
   ```

`.test-tools/run-browser-tests.sh` 已把这几项固定下来（本目录被 `.gitignore` 忽略，不进版本库）：

```sh
sh .test-tools/run-browser-tests.sh                 # 全部 30 个夹具
sh .test-tools/run-browser-tests.sh page-content-browser.py
```

**2026-10-21 基线：30 个夹具全部通过**（含 `prose-source-flow-browser.py`），`npm run test:host-gate` 对着 **Paseo 0.12.0 正式版** 4/4。

**pinned 审计现覆盖 0.11.4 / 0.12.0-beta.1 / 0.12.0-beta.2 / 0.12.0 正式版。** 0.12.0 的审计依据：npm 发布的 `@getpaseo/server@0.12.0` 与已安装桌面 app **逐字节一致**（`plugin-provider.js`、`agent-manager.js` 哈希均相同），因此可复现。与 beta.2 相比，daemon mapper 差 3 行（全在 `prompt.steer` 能力协商），agent manager 差 2 行（**都在 agent 注册路径**，不在 pending/staged-events 轮次生命周期里），`mapTimelineItem` 字节一致，web reducer 仍是 Metro id `3664` + 同样的三个依赖。


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

### 宿主能力限制诊断（不是修复验收）

`tests/legacy/*.diagnostic.mjs` 是另行保留的宿主限制研究实验，不属于默认 `npm test` 或 CI 门禁。它直接向 Broker/宿主注入任意正文改写，或尝试插件卡片等本次未采用的协议；在 Paseo 0.11.4 上仍会失败，不能当作已解决，也不能称为 main 原有失败。这些实验和断言仍可运行，没有删掉或设为 skip。

默认 `npm test` 执行实际生产路径回归，包括原始消息完成、接收端一次适配、Broker/Provider、历史重开及异常处理；旧流式研究标HISTORICAL，不充当新生产覆盖。原始文本真的改写、宿主最终回报仅取工具后的尾段，仍属于明确记录的限制；默认测试通过不代表这些限制消失。部署前还需要真实账号验收。

## 2. 真实账号验收

改动涉及真实用户行为时，使用**专用的 ChatGPT 账号/会话和专用 Paseo Agent**。只抓关键场景，**按任务选择，不是每次都跑满 T1–T8**：

| 编号 | 关键场景 | 通过标准 |
| --- | --- | --- |
| **T1** | 安装、配对、配置 | 本机连接、模型/工具读回正确；不接受错 token 或错页 |
| **T2** | Paseo → ChatGPT | 首轮与第二轮成功、同一 Conversation、每条一次 Send，最终回 idle |
| **T3** | ChatGPT 网页 → Paseo | 原 Agent 收到用户消息、后续回复与终态；`origin=browser`，Paseo 不二次发送 |
| **T4** | Stop、关页、恢复 | **仅凭绑定 Conversation 重开原 URL**；消息按独立 ID 去重，结果未知不自动重发；不影响其他 Agent |
| **T5** | 公开思考与工具 | 同一真实对话中两个不同调用能保存为两个公开来源；Paseo 卡片/状态准确，无私有推理泄漏。宿主原生最终回复的字段另行核对 |
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
- [ ] 默认自动允许关闭时，授权必须人工选择；若主动开启自动允许，另做精确按钮和持久授权范围验收，不将网页卡片消失当作批准。限额/策略警告停止工作，不换账号或重发来规避。
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


## 未发布完整消息模式（2026-10-17）

正文逐字要求已由用户改为每条原生消息完结后提交。主覆盖：`complete-prose`、`completed-message-{source,observer,receiver,http}`、`message-receipt-integrity`；既有 append-only/public-prose/monitor 覆盖保留并迁移了相应交互。历史研究模型明确标为 HISTORICAL。

`completed-message-browser.py` 串起生产 MAIN/ISOLATED/content、真实 Store/Broker/Provider 和原版宿主 mapper/renderer；它是合成隔离页面，不是已安装 MV3/真实账号验收。原生工具/图片 MV3 仍单独跑。

本轮修正的夹具问题并非生产修复：native-activity 派生场景本来就新增两次工具调用，应精确核对三个原生 ID（保留隐私/详情/终态断言）；images 派生脚本更新了已失效的源码替换定位，保留源身份、可解码像素、重载不重发等断言。concurrency区分异步接受与实际preflight终态；导航走必须WRONG_CONVERSATION且不Send，不能当关闭后静默重开。生产已修，相关单测/MV3通过；确证关闭仍可正常重开。

最新候选alpha.4.20/扩展0.2.26/桥7/正文IPC v2，SDK为0.12.0-beta.1：默认504项503过1红OBS-P1、0skip；新旧原版完整宿主类各13项10过3红、0skip；新版选定21个浏览器/MV3全部通过；宿主能力诊断23项16过7红、0skip。日志为 `paseo-012-full-final.log`、`paseo-012-real-{0.11.4,0.12.0-beta.1}.log`、`paseo-012-{browser,mv3}.tsv`、`paseo-012-diagnostics-final.log`（接手工作区logs）。新版拒绝加载的manifest修复和来源核查见 `PASEO_012_COMPATIBILITY.md`；准入4/4不等于交付门禁通过。

宿主类套件不在默认通配符内，必须单独运行；支持固定0.11.4和0.12.0-beta.1，按包实际版本选择来源并使用它自己的SDK。缺包、未知版本、版本/哈希不符是失败，不skip。REAL-9覆盖Provider收到新prompt前后两个pending窗口（契约：旧/新正文各可见一次，按到达顺序，归轮为已知限制），REAL-12覆盖新prompt失败后旧正文仍可见一次（插件侧暂存后交付）。见 `HOST_CONCURRENT_DELIVERY_GATE.md`。没有部署或两个原Agent已恢复的结论。

完整来源核对需设置CIP_UPSTREAM_CONTENT_JS、CIP_PASEO_PROVIDER_SOURCE、CIP_PASEO_AGENT_MANAGER_SOURCE、CIP_PASEO_RENDERER_BUNDLE；CIP_SDK_MODULE若自定义，使用本地file:/// URL而非HTTP。不得沿用缺来源时的skip结果冒充0skip验收。

## alpha.4.21：工具授权、工具卡片、引用

- `tests/approval.test.mjs`：ChatGPT 工具授权框 → Paseo 原生授权请求（只有“允许一次 / 拒绝”，按 SDK schema 校验）；Broker 只接受本轮当前授权框的、经网页确认的点击；网页上直接处理会如实提示。
- `tests/approval-card-browser.py`：真实 Chrome 加载 2026-10-17 从已登录 ChatGPT 页面抓取的授权框 HTML（`tests/fixtures/chatgpt-approval-card.html`），验证读取应用/工具/命令、详情弹层复原、只点 Allow once 或 Deny、绝不点 Always allow。
- `tests/native-timeline.test.mjs` TIMELINE-APP：同一次应用调用（授权前 `asdk_app_… · tool` 与运行时 `codex_apps · app.tool`）合并为一张可读卡片；`approval_wait` 不单独成卡。
- `tests/citations.test.mjs`：行内引用标记按页面顺序配对来源标签（数量完全一致才配对），渲染为 Markdown 链接；未配对的标记丢弃，绝不原样显示或猜测链接。

## alpha.4.27：Paseo 展示文案

- `tests/ui-copy.test.mjs`：统一状态词；运行、送达、同步、跟踪分开表达；授权按钮保留网页原名，不将 Chrome 的 Allow 称为“允许一次”；工具结果未知不表述为成功；网页提示和公开思考摘要不改写。
- 直接执行生产 TSX（原生组件与 hooks 使用隔离桩），覆盖新旧状态卡、宽屏/紧凑设置页、保存结果不确定时的提示；Provider 事件使用原版 SDK 校验。不是实机 UI 或真实账号验收。
- 文案规范与关键示例见 [UI_COPY.md](UI_COPY.md)。仅修改插件展示，不改 Chrome 扩展、发送/授权/停止逻辑。扩展版本仍为 0.2.32。

## 持续同步（2026-10-18）测试面

**自动门禁（可重复运行）**

| 命令 | 结果 | 说明 |
|---|---|---|
| `npm test` | **745 / 745** | Store/Broker/Provider/HTTP/合成宿主投影 |
| `npm run test:sdk` | **2 / 2** | 安装的 SDK schema 校验真实 Provider 事件 |
| `npm run test:host-gate` | **4 / 4** | 固定 `@getpaseo/server@0.12.0-beta.2` 原版宿主类：屏障、替换连接、宿主 cancel 尾部、会话层 pending prompt |
| 26 个隔离 Chromium / MV3 套件 | **26 / 26** | 见下 |

当前契约 MV3 端到端（`npm run test:mv3-current`，6 项）：真实 unpacked 扩展 + service worker + MAIN/ISOLATED + Chrome tabs + 真实 Node Runtime/Provider。验证：一个 Paseo Send → 一条用户回声 + 一条助手正文、无重复用户来源；页面重载后继续观察且不重发；第二轮复用同一对话且只多一个 Send；在 ChatGPT 里手动输入的消息被当作网页来源，不产生 Paseo Send。页面与网络仍是离线夹具，不是实账号验收。

当前契约 Chromium（核心）：`page-content`（Work/正文分型/审批读取）、`continuous-actions`（观察器与 Stop/审批动作适配器）、`button-state`（只按可见按钮判状态）、`artifact`（原字节/分块/下载/拒绝源）、`public-message`（MAIN/ISOLATED 39 项）、`prose-source-flow`（真实来源→Provider→原版 reducer）、`media-source-flow`（来源→传输→存储）。

兼容保留（仍通过）：`attachment-order`、`failed-send-disposal`、`failed-send-persistence`、`composer-diagnostics`、`receipt-interaction`、`catalog-browser-regression`、`discovery-browser`、`app-receipt`、`outbound-upload`、`pending-receipt`、`popup-uiux`、`response-delay-app`、`send-evidence`、`send-evidence-edge`、`upload-paste`、`eight-tabs-mv3`、`manual-reload-mv3-flow`、`upload-isolated-world-mv3`。

**已归档**：`tests/legacy/` 保留旧 `CIP_DOM.state`/`/event`/`native-activity`/外部导入/逐消息回执套件与两份宿主诊断。逐文件退役原因与当前覆盖映射见 `tests/legacy/README.md`。这些脚本不属于验收，不再放进任何绿灯统计。

**部署前仍缺的验收**

1. **真实 MV3 端到端**：已由 `tests/binding-mv3-current.py` 覆盖到离线夹具层（真实扩展/worker/worlds/Runtime）。仍未覆盖的是**真实 ChatGPT 页面标记**与真实账号；部署前需在真实页面复跑同一断言。
2. **真实账号与 UI**：未登录真实 ChatGPT、未操作真实 Paseo 客户端/授权/Stop/附件下载。
3. **AgentManager 自身 pendingRun 暂存路径**：宿主门禁覆盖会话层 pending prompt，不是 manager 的排队暂存路径。
4. 宿主限制仍未解决也未声称解决：finalized foreground turn 原位恢复（OBS-P1）、跨运行片段工具卡合并、无原生跨平台下载 API（ART13）。见 `IN_PLACE_RECOVERY_PLAN.md`、`CONTINUOUS_SYNC_HOST_GATE.md`、`PROSE_2B_PROGRESS.md`。

离线与隔离 Chromium 绿灯不能替代以上四项。
