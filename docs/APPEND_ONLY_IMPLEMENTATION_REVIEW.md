# CIP alpha.4.16 / Chrome 0.2.23：原始候选补丁验收（历史记录）

> 以下为 CIP 接手前留下的结果，不代表最新补丁。后续独立复核、八项回归修复、测试分类和当前结果见 [接手复核](APPEND_ONLY_TAKEOVER_REVIEW.md)。

**仅在独立工作树实现，未提交、推送、安装、重载、部署、PR、合并、修改宿主或真实用户状态。** 分支 fix/chatmode-timeline-duplicates；基础版本及 origin/main 均为 3e0810a3d8350ee408e3051f0f57abe658406282。原七个调查文件全部保留，不将合成测试冒充生产验收。

## 实际改动

| 文件 | 变更 |
| --- | --- |
| extension/public-prose-main.js（新增） | CIP 自有 MAIN-world 小型规范全文状态器：以 native message ID 维持有界原文、已公布全文、代码围栏、独立公式待定片段；仅处理源文本新增的 UTF-16 单元，普通文字流式；最后 native final 时执行一次原 CoS decoder 全文核验。不发送增量到 Provider。 |
| extension/upstream/cos-shell-public.js | 保留固定来源的 CoS unescapeFallbackMarkdown 作为最终语义；只有 reference-only DIL fallback 分支连接 CIP 状态器，传入原生消息 ID、类型化 view/shell 及原生完成证明；无匹配 fallback 不再把不透明引用占位串作为回答。 |
| extension/manifest.json | MAIN-world 按依赖顺序先载入状态器，再载入 CoS shell reader。扩展候选版本 0.2.23。 |
| extension/upstream/cos-picker-main.js / extension/dom-adapter.js / extension/content.js | 有界确定性流异常错误码跨 MAIN/ISOLATED 传递；同一 native ID 暂时丢失 Fiber 时不采用异构旧 DOM 序列化覆盖；已证实异常走现有 failed 观察，阻止虚假成功或用户消息重发。 |
| package.json | 插件候选版本 0.1.0-alpha.4.16。 |
| vendor/cos/provenance.json / README.md | 保留 MIT 来源；更新两处 CoS 适配本地哈希与差异记录。 |
| tests/append-only-production.test.mjs / tests/append-only-public-browser.py | 新增**真实修改后的生产入口**+完整 Broker、Provider、Paseo 原版宿主校准/回放、合成浏览器测试；研究模型测试与历史七文件仍保留。 |

## 测试证据

先红后绿：本轮早期直接运行修改前的 CoS shell 源码入口，6 项新生产测试仅 1 项通过、5 项失败；接上状态器并修复同等 DIL 语义后 6/6 通过。之后扩展更严格的 280 组合合成逐帧数据，含 0–4 空格/Tab、LF/CRLF、中文、转义、代码/公式、表格、emoji、步长 1/2/3/7，并抽取 24 组原版 Paseo mapper+renderer 对照。另通过真实 Broker/Provider、工具插入、history:replay、相同 ID 单终态及已确认错误 -> failed。已批准现场的长度/LCP 形状也有**合成源头纯增长**证明，文字非现场原文。

隔离 Node 22 二进制：/Users/penn/.npm/_npx/52027bd8fc0022aa/node_modules/node/bin/node（v22.23.3）。
隔离克隆位置：/Users/penn/.paseo/worktrees/2s2ec1pl/cip-timeline-duplicates/.test-tools/cip-clone.T8DTlT59/repo。
该克隆由只读本地 Git 基线、新的可审计二进制补丁与逐个复制的 untracked 文件重建；工作树主要文件 cmp 一致，且使用只读的固定 SDK/TypeScript 开发依赖软链接。

| 命令与环境 | 实测退出码及结果 |
| --- | --- |
| npm run check（Node22 PATH） | 0 |
| npm run verify:upstream | 0，12 个来源模块本地哈希与 MIT/加载世界核对 |
| npm run typecheck | 0 |
| npm run test:sdk | 0，2/2 |
| npm test（同一克隆，最新生产测试已同步后完整重跑） | **1**，422 项：411 通过、10 个**保留的宿主能力边界预期红例**、1 个上游可选 fixture 缺失 skip；无新增生产路径回归失败 |
| Node22 --test tests/append-only-production.test.mjs tests/images.test.mjs tests/lifecycle-timeouts.test.mjs tests/concurrency-reopen.test.mjs（含原版 Paseo parity） | **0，50/50**，0 skip |
| Playwright: tests/dom-audit.py | 0，9 项 |
| Playwright: tests/native-transplant.py | 0，17 项 |
| Playwright: tests/browser-fixture.py | 0，7 项 |
| Playwright: tests/append-only-public-browser.py | 0，6 项 |
| Playwright: tests/binding-mv3-flow.py（实际 Chrome service worker 与已安装 SDK，离线 TLS fixture） | 0，11 项 |

浏览器使用无登录的 Playwright 临时 Profile，连接本机隔离的合成 TLS ChatGPT 路由；不碰用户原 Chrome 账户、真实 ChatGPT 网页、线上插件或宿主。现有研究红例始终保留、**未删断言或跳过使 npm test 假绿**：5 个 Broker 下游任意非前缀注入测试（源头修复之外的能力边界）、5 个公开宿主完成回报/任意修订接口测试（需独立支持）。另 1 个旧测试因上游源码 fixture 不在克隆而 skip。

### 三项历史 MV3 失败同环境 main 对照

只读原 main 基线克隆：/Users/penn/.paseo/worktrees/2s2ec1pl/cip-timeline-duplicates/.test-tools/main-control.Xo824uou/repo，HEAD=3e0810a3，扩展版本原样 0.2.22。
完全相同 Node22、SDK、Python venv、Chrome 可执行文件、TLS 合成环境。
| 脚本 | 修复分支 | 未修改 main | 相同失败位置 |
| --- | --- | --- | --- |
| images-mv3-flow.py | exit 1 | exit 1 | images-mv3-flow.py:12/18，旧 fixture 文本替换断言 assert source.count(old)==1 |
| native-activity-mv3.py | exit 1 | exit 1 | binding-mv3-flow.py[native-activity]:213，多个工具 call IDs 与旧断言不符 |
| concurrency-reopen-mv3.py | exit 1 | exit 1 | binding-mv3-flow.py[concurrency-reopen]:285，既有断言失败 |

三项没有通过，只能说在相同环境中 main 也如此；日志保存在对应克隆目录 .test-tools-ci-images-url.log、.test-tools-ci-native-activity.log、.test-tools-ci-concurrency.log。

## 不可掩盖的残余边界

1. 仅修复同原生 ID 的**公开 DIL fallbackMarkdown 转换改旧尾**路径；当时线上事故究竟走 typed view/shell、generic Fiber 还是 DOM 仍未捕获逐帧证据，**不能声称全面治愈**。
2. 暂时缩短的已知旧帧不会覆盖已送出的规范正文；真实非前缀或 final 字节无法衔接时报错终止，不自动重发用户消息。append-only 不能通用地改写已经展示的字。
3. 工具插在本轮原生 assistant 增量中间时，Paseo 0.11.4 getLastAssistantMessage 可能只取最后连续片段，boss 完成回报可能缺前段。它是保留原红测的**独立发布阻断**，不是通过宿主 patch、第二份隐藏答案或新正文 UI 偷偷解决。
4. 全套 npm test 仍由人为强注入 Broker 的历史宿主边界红例导致退出 1。需要 boss 在正式发布验收时处理这些边界的分类及先前三项 MV3 夹具失败；不得冒充绿。
5. 本候选仍未真实登录 ChatGPT 实测，没有安装扩展、部署或执行用户账号上的新发送；用户未来对推送、PR、部署和合并应分别授权。
