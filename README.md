# CoS in Paseo

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE) [![CI](https://github.com/Project10214/cos-in-paseo/actions/workflows/ci.yml/badge.svg)](https://github.com/Project10214/cos-in-paseo/actions/workflows/ci.yml)

**中文** · [English](#english-summary) — 在 Paseo 中创建 Chatmode Agent，由本项目的 Chrome 扩展驱动 ChatGPT 网页收发消息，无需 CoS 桌面应用。当前为 **alpha**。欢迎通过 [Issue](https://github.com/Project10214/cos-in-paseo/issues) 反馈问题、通过 Pull Request 贡献代码（中英文均可），见[贡献指南](CONTRIBUTING.md) · [安全策略](SECURITY.md) · [许可证：MIT](LICENSE)。含源自 [Chat On Steroids](https://github.com/totec448-spec/chat-on-steroids)（MIT）的移植代码，见[第三方声明](THIRD_PARTY_NOTICES.md)。

<a id="english-summary"></a>
**English summary** — CoS in Paseo is a [Paseo](https://paseo.sh) plugin plus a Chrome extension that lets a Paseo "Chatmode" agent talk to the ChatGPT web UI directly, without the CoS desktop app. It is **alpha** software. Issues and pull requests in English or Chinese are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md) and [LICENSE](LICENSE) (MIT). Portions adapted from [Chat On Steroids](https://github.com/totec448-spec/chat-on-steroids) (MIT) are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Requirements: Node.js ≥ 22.6, Chrome and the Paseo daemon on the same machine, Paseo SDK 0.11.2. The rest of this README is a detailed development log in Chinese; the product manual is [docs/PRODUCT_MANUAL.md](docs/PRODUCT_MANUAL.md).

> **2026-10-16 · Chrome 0.2.14 附件选择二次修复（本地候选，未部署）：** 用户单 PNG 再现 `ATTACHMENT_INPUT_AMBIGUOUS`。0.2.13 对同样 `accept` 的多个输入框仍直接拒绝，且没识别英文 “Upload files” 菜单。0.2.14 跟随当前 Composer 的原生添加文件操作，观察哪个 file input 被实际触发（取消系统文件对话框，改用经校验的 File 数据）；没有明确目标仍拒绝，不误发文字。新增真正 MV3 隔离世界 Chrome 实测。[修复与验证边界](docs/CIP_0214_ATTACHMENT_NATIVE_PICKER_20261016.md)。


> **2026-10-16 · Chrome 0.2.13 PNG 附件入口误判修复（本地候选，未更新生产）：** 解决 `ATTACHMENT_INPUT_AMBIGUOUS`：同页多个原生文件输入框按准确 MIME/扩展名和当前 Composer 归属选择，区分图片与文档入口；真正同分冲突仍拒绝。不改变 Paseo 主程序或 `alpha.4.7` 插件，现有其他 Agent 不重启。独立真实 Chrome 测试详见 [专项验证](docs/CIP_0213_UPLOAD_INPUT_DISAMBIGUATION_20261016.md)。

> **COSINPASEO-7 图片和文档发送候选（2026-10-16，尚未生产部署）：** Paseo `alpha.4.7` + Chrome `0.2.12` 支持原生图片/已上传文件分块传入 ChatGPT 网页文件控件，严格核对附件再发送，不让旧扩展误发纯文本。已过 SDK、Node 和独立 Chrome 文件控件验证；真实已登录 ChatGPT 上传仍须专项验收。[具体交付和验收边界](docs/COSINPASEO_7_OUTBOUND_ATTACHMENTS_20261016.md)。

> **Chrome 0.2.11 过度防御专项修复（本地候选、未部署）：** 不再因同页导航、无关点击/按键、React 编辑器/发送按钮重排、同一应用标记的嵌套显示而拒绝发送或错误终止回执；未知发送仍不重发，真实改稿/改工具/跨会话仍阻断。[复现、修复、327 项回归与真实验收边界](docs/CIP_0211_OVERDEFENSE_AUDIT_20261015.md)。

> **Chrome 0.2.10 修正新会话误报 NAVIGATION_CHANGED（候选，未部署）：** 只把真实路径/Conversation 改变当作导航离开；首次配置和点击发送前的同页事件不再被误拦截，点击后的绑定与原生回执仍严格验证。[定位与回归测试](docs/CIP_0210_NAVIGATION_FALSE_POSITIVE_20261015.md)。

> **Chrome 完全退出恢复修复（候选，未部署生产）：** Chrome 0.2.11 + Paseo 0.1.0-alpha.4.6 现在将临时丢失的浏览器监控视为可恢复状态，按原绑定链接重开且验证原生消息 ID；网页忙碌会等待，同 Agent 下一条新消息会排队，不自动重发旧消息，也不在 Chrome Quit 事件里阻止退出。[现场证据与测试范围](docs/CIP_CHROME_COLD_START_RECOVERY_20261015.md)。

**候选源码：Paseo 0.1.0-alpha.4.7 · Chrome 0.2.14 · CIP v5。** 2026-10-15 已有 CIP v5 Runtime 实机在线、部分收发通过和更新操作记录；**COSINPASEO-1 的异常恢复与 COSINPASEO-2 的公开工具/思考原生事件，仍需新版端到端验收**。新代码加入绑定对话关页重开、Chrome/Paseo 相互唤醒及**扩展升级后自动刷新绑定标签并唤醒原 Agent**。源码已通过隔离测试，生产版本仍需实际更新与验收。

> **正式文档：** [产品说明书（含模块与现状）](docs/PRODUCT_MANUAL.md) · [未来开发与验收流程规范](docs/DEVELOPMENT_ACCEPTANCE_STANDARD.md) · [Chrome 0.2.7 真实工具事件诊断与更新恢复](docs/CIP_027_TOOL_REAL_PAGE_AND_UPDATE_20261015.md) · [历史 0.2.4 继续验收](docs/CIP_024_FOLLOWUP_ACCEPTANCE_20261015.md)。新候选增加 @ 应用网络提交证据核验和连续扩展更新修复，**尚未加载到有其他 Agent 正在运行的生产环境，也未通过真实工具调用验收**。旧章节属于历史记录，须按其原始日期理解。
>
**Chrome 0.2.6 真正修复弹窗竖条：** 0.2.5 仅改善了页面内部布局，遗漏 Chrome 工具栏原生弹窗的根元素尺寸；因此用户的真实 Chrome 弹窗仍仅 **189 × 500**。已通过本机 Chrome 无障碍接口亲自打开并确认问题。原因是 `body{max-width:100vw}` 配合无固定宽度的 `html`，形成错误的窄窗口反馈。新版本固定 `html/body` 本身为 400px。另一个真实 Chrome for Testing **原生 action popup** 对照：旧 CSS **145 × 614**，新 CSS **414 × 348**（含浏览器窗口边界）；不再用普通标签页的截图代替原生弹窗验收。紧凑首页与独立配对/断开确认页、深浅模式和安全提示保持不变。浏览器交互测试：`tests/popup-uiux-browser.py`，真实 action 测试：`.test-tools/popup-actual-action.py`。**不改 Runtime、协议、凭据或正在运行的 Agent；使用者待安全时机自行重新加载 Chrome 扩展。** [原生 Chrome 工具栏弹窗实测与修复说明](docs/CIP_POPUP_NATIVE_WIDTH_20261015.md)。

> 源码已加入双向轮次、下一轮工具配置、公开思考摘要与工具调用详情，保留原生单选“工具”入口。**Chrome 扩展更新会自动刷新属于本插件的已打开 Conversation 标签并唤醒对应 Agent 的观察链路**；它不会重发旧消息，但刷新可能中断网页正在执行的步骤，外部 MCP 的副作用不能凭页面重载判断。共享 Paseo Runtime 仍不得在未保护状态时强制重启。[迭代说明](docs/COSINPASEO-1_EXTENSION_UPDATE_PIPELINE_20261015.md)。

在 Paseo 创建 Chatmode Agent，按网页实际观察选择模型、思考强度和 `@` 应用；本项目的 Chrome 扩展发送消息并回传可见回答。开发机文件和终端操作继续使用 ChatGPT 中已经接入并授权的 MCP。

**alpha.3.15 重点：** 发送后已绑定原生 ChatGPT 对话时，固定的回执/命令期限只会转入「发送回执待确认、继续观察」，不会直接切断该轮回传。找到准确原生用户消息 ID 后恢复正常状态；未确认时不能再次发送，绝不自动重发。临时读取不到网页不因 15 秒判失败，活跃任务的心跳可以持续续期；但身份冲突、明确失败、用户主动停止和长期无可信活动仍有保护。**已通过隔离测试；真实登录账号尚待验收。** 逐项判定见 [全量超时审计与实施记录](docs/TIMEOUT_AUDIT_ALPHA3_15.md)。

> 本版在设置页增加 **1–8 路并发**，默认 2，建议先设 4；超额请求按顺序等待，取得名额后才开页，可取消。保存即时生效，降低上限不会停止正在运行的任务。已完成的 ChatGPT 标签页关闭后，在同一 Paseo 会话发新消息，会重开已绑定链接并核对原生消息，再发送这一条新请求。**不自动重发结果不明的消息；重载会取消尚未发送的等待请求。** 原生工具、搜索、代码、生图、思考和授权等待按会话显示，最终状态必须通过单独回执确认；现已修复提前完成、失败状态不更新、隐藏工具名泄露和普通错误文本误报。还增加准确正文绑定的网络发送请求证据（有严格限制，不能代替最终结果）。[alpha.3.11 修复与验收说明](docs/STRICT_FIX_ALPHA3_11.md)。本次进一步修复新会话路由切换、原生 `Request` 形式发送、空转录遮蔽 DOM 身份的问题；Paseo 输入区原先多个相同工具图标合并成一个「工具」原生下拉，保留常用多工具组合与旧设置兼容。[alpha.3.12 修复与验证](docs/RECEIPT_AND_TOOL_PICKER_ALPHA3_12.md)。**alpha.3.13** 补齐已授权 @ 应用在网络请求中的多语言/下划线 Markdown 标记、严格结构化标记及单次 Markdown 转义回执；陌生应用和非文本内容仍拒绝确认，并细化不含私密正文的网络诊断。隔离测试已通过，真实账号仍需验收。[修复与安全边界](docs/APP_RECEIPT_ALPHA3_13.md)。保留图片预览与界面改进。**[新增原生状态识别、测试与边界](docs/NATIVE_LIFECYCLE_ALPHA3_10.md)**。受控完整扩展测试已覆盖关页续聊、四路并发和动态改上限，登录账号仍待验收。见 [本版修订、边界与验证](docs/CONCURRENCY_REOPEN_ALPHA3_9.md)；图片功能说明见 [alpha.3.8 记录](docs/IMAGES_UI_ALPHA3_8.md)。

**原开发阶段记录：** [COSINPASEO-1 对抗式审核及四项返修](docs/COSINPASEO-1_ADVERSARIAL_20261015.md) · [COSINPASEO-2 原生思考及工具调用开发记录与限制](docs/COSINPASEO-2_DEV_20261015.md)。上述报告记录候选代码产生时的状态；后续曾完成部分 [真实账号联调](docs/COSINPASEO-REAL_ACCEPTANCE_20261015.md)，但完整验收尚未通过，具体边界见 [产品说明书](docs/PRODUCT_MANUAL.md)。

**工具入口已回滚：** 当前只在已创建的 Chatmode Agent 输入区显示 Paseo 原生「工具」单选下拉，可切换「无工具」「单个已授权应用」「所有已授权应用」或设置页保存的常用组合。`alpha.3.16/3.17` 曾加入的自定义连续勾选面板和创建前工具入口均未保留。首次发送仍验证网页配置，不自动授予权限或重发结果不明的消息。[回滚及验证记录](docs/ROLLBACK_TO_SINGLE_20261015.md)。

## 1. 判断：包含哪些东西

```text
Paseo 界面 / Agent
     ⇅ 原生 Provider 协议 v1（不是 ACP）
Paseo 插件 + 一个共享 Runtime
     ⇅ CIP v5 · http://127.0.0.1:17843
本仓库 Chrome 扩展
     ⇅ 网页操作与观察
ChatGPT 网页 / 模型 ──已授权 @ 应用──→ 开发主机 MCP
```

两个插件都在本仓库：**项目根目录是 Paseo 插件；`extension/` 是 Chrome 插件；`server/` 是共享运行代码。**并发默认 2，可在设置页调整为 1–8；超额按顺序等待，同一会话串行，不会把设置套到其他会话。

本版是**函数级复制、裁剪和适配**，不是整个 CoS runtime 搬迁。12 个模块保留 CoS 的原生编辑、发送、正文回执比较、模型、应用列表、公开消息和图片读取核心；Provider、共享服务、标签页归属和多应用选择仍有本项目适配。旧 `app-menu.js` 不在当前 Chrome 扩展加载清单中，保留仅供历史参考；应用列表回到 `alpha.3.15` 的原生 `system_hints` 观察流程，失去确证时拒绝发送，不猜测工具身份。来源、原函数名和改动见 [移植清单](vendor/cos/README.md)。

创建 Paseo 会话时只保存配置；**首次发送时**才创建独立 ChatGPT 标签页。后续只凭已绑定 Conversation 自动打开原对话，旧消息 ID 仅用于独立去重/追踪而不阻止开页；目录刷新使用单独临时页。

原版 CoS bridge 14、CIP v1/v2/v3/v4 与本候选版不兼容。**最新候选源码：Paseo 0.1.0-alpha.4.7、Chrome 0.2.14、浏览器/Runtime 引擎 `cos-native-alpha4.3`、CIP v5、Provider v1。** 最后一次单选稳定回滚的源码基线是 alpha.3.15，历史记录见[回滚及核验](docs/ROLLBACK_TO_SINGLE_20261015.md)。已有生产插件不会随源码更新：首次加载本候选版仍应选择安全窗口。**此后 Chrome 扩展的后续版本更新**将自动刷新本插件管理的已打开对话页面、重建采集脚本并请求激活原 Paseo Agent；升级过程中结果不明的旧消息绝不自动重发。

| 位置 | 内容 |
| --- | --- |
| `index.server.ts`、`index.client.tsx`、`paseo-plugin.json` | Paseo 插件入口 |
| `client/`、`shared/` | 设置页面和类型化调用 |
| `server/` | 会话、持久队列、回执、停止和身份管理 |
| `extension/` | Chrome 后台、网页适配和配对弹窗 |
| `tests/` | 原有测试、对抗回归、双会话浏览器夹具、真实 SDK 契约测试入口 |
| `docs/ITERATION_ALPHA3.md` | 本版直接移植、链路调整及验证记录 |
| `docs/evidence-alpha3/` | 本次实际执行日志；`docs/evidence/` 为 alpha.2 历史证据 |

## 2. 执行：安装或替换

### 环境与检查

Chrome 与 **Paseo 后台必须在同一台开发主机**；Paseo 手机端可以远程连接该后台。本机服务不应公开到局域网或公网。使用 Node.js 22.6 以上。SDK 目标是 `0.11.2`；清单范围 `>=0.11.2 <0.12.0` 是待实测的兼容目标，不是已验证矩阵。

```sh
cd /absolute/path/cos-in-paseo
npm run check
npm run verify:upstream
npm test
npm install --ignore-scripts --no-audit --no-fund
npm run typecheck
npm run test:sdk
```

前三条无需下载依赖。后三条需要安装上述固定版本。本次已将真实 SDK 与开发依赖隔离安装至 `.test-tools/ui/`，使用 `node .test-tools/ui/typecheck.cjs` 完成整个项目的 TypeScript 检查；MV3 事件另外通过已安装 Paseo 0.11.2 自带的真实 SDK 校验。隔离依赖不参与生产插件加载。测试日志见 `docs/evidence-alpha3-8/`。

### 首次安装

```sh
paseo plugin install /absolute/path/cos-in-paseo
```

在 Paseo 的 **Settings → Plugins → CoS in Paseo → Chatmode 配置** 打开设置贡献，生成一次性配对码。在 Chrome 的 `chrome://extensions` 开启开发者模式，选择“加载已解压的扩展程序”，指定本项目 `extension/`。登录自己的 ChatGPT 账号后，在扩展弹窗填写设置页显示的本机地址和配对码。

配对并登录后，更新版扩展首次连上 Runtime 就自动同步目录，不需要打开设置页或点击获取。设置页会自动显示进度、成功数量或具体失败原因。选好模型、思考档位和应用后保存默认配置，再创建 `chatmode` Agent；应用使用逐项开关。已有会话不会被默认值修改。“重新同步（备用）”只用于主动重新检查。失败不会每秒重开网页，已开始的真实消息不会自动重发。

### 首次启用 macOS 自动唤醒（只需一次）

在已完成 Chrome 配对的开发机执行：

```sh
npm run install:native-wake
```

安装器将 `scripts/native-wake-host.py` **复制到本机私有目录** `~/.cos-in-paseo/bin/native-wake-host.py`，再把当前已配对扩展的准确 ID 和这个本地路径写入 Chrome Native Messaging 清单；这不是常驻服务。**不要让清单直接指向外接项目盘**：实机验收中 Chrome 无法执行该位置的小程序，迁至本机后验证通过。入口仅接受固定“打开 Paseo”动作，不接收任意命令或聊天正文。Chrome 扩展须已授权 `nativeMessaging`。Paseo/Chrome 任一侧退出时另一侧可以尝试拉起；OS 接受启动不代表 Daemon 或 Agent 已恢复，仍需实时状态确认。现有项目版本 `0.2.3` 不需要因为本机入口迁移而再次更新扩展。

### 从 alpha.1 / alpha.2 替换

先人工检查旧网页会话，停止不需要的生成，关闭对应 Agent，停用旧 Paseo 插件。**在 Runtime 已退出后备份 `~/.cos-in-paseo/`，不要删除历史或仍被进程使用的锁。**替换整套源码，再通过 Paseo 重新加载插件；Chrome 同时重新加载新版 `extension/`。新版在真正收到 Chrome `onInstalled(update)` 后会自动刷新**本插件管理的已绑定对话标签**；如个别页面恢复失败，只针对该页面按诊断处理，不刷新其他聊天标签。

若更换目录导致 Chrome 扩展 ID 变化，重新配对。配对失败保留原配置；版本不匹配在提交配对码前拒绝。升级时发现旧未完成事务，会阻断而不是自动重发。结果不明的会话需先人工核查；设置页的“结束本地跟踪”不停止网页/MCP、不删除历史，且要求先关闭该 Agent。

**不要同时运行 `npm run dev` 和 Paseo 插件指向同一个状态目录。**正常使用由 Paseo 自动启动 Runtime，不需要 CoS 或第二个运行程序。

## 3. 检查：验收和边界

离线浏览器检查需要 Python、Playwright 和 Chromium。它们加载内存页面，不登录账号、不发真实消息：

```sh
python3 -m pip install playwright==1.57.0
python3 -m playwright install chromium
# Linux 已有 /usr/bin/chromium 时无需设置；其他系统使用 Playwright 安装的浏览器：
export CIP_CHROMIUM="$(python3 -c 'from playwright.sync_api import sync_playwright; p=sync_playwright().start(); print(p.chromium.executable_path); p.stop()')"
npm run test:dom
npm run test:browser
npm run test:flow
npm run test:native
```

真实联调按 [验收记录](docs/ACCEPTANCE.md) 进行：先短消息与第二轮，再做开发机 MCP 只读调用，最后测试两个会话、停止、断线和重启。**排队不是已发送；回答结束不是工程验收；停止网页不等于停止已启动的外部命令。**

模型目录使用移植的 CoS Fiber picker 读取。本版增加 `shellTurnSource` / `entry.turn.items` 及 `turn.items` 的公开文字分支，不搬工具参数、隐藏分析或图片载荷。不可读的菜单/应用 ID 不会被假造；菜单改版、本地化、分页或账号切换可能需要实机适配。多会话不增加账号额度；不自动批准、不轮换账号或重发来规避限制。

仅允许排除带明确警告的、宿主形状的本机 `paseo` MCP 项，避免它阻塞所有新聊；**这不表示该 MCP 已被导入网页**。其他 Paseo MCP 配置及预先批准规则不支持并报错。开发工具须在 ChatGPT 接入授权；网页模型不会因此自动获得 Paseo 子 Agent 工具。

运行数据保存在 `~/.cos-in-paseo/`（或 `CIP_STATE_DIR`），权限限制为当前用户，但不加密。历史接近容量上限会拒绝新消息，输出超限会记录失败，不静默丢失或无限卡住；目前没有自动归档删除界面。

### GitHub / 参与贡献

源码托管在 <https://github.com/Project10214/cos-in-paseo>，以 [MIT 许可证](LICENSE)公开，CI 见 `.github/workflows/ci.yml`。欢迎提交 Issue 与 Pull Request，中英文均可，流程见 [CONTRIBUTING.md](CONTRIBUTING.md)；安全问题请按 [SECURITY.md](SECURITY.md) 私下报告。

The source is hosted at <https://github.com/Project10214/cos-in-paseo> under the [MIT License](LICENSE). Issues and pull requests in English or Chinese are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md). Please report security problems privately as described in [SECURITY.md](SECURITY.md).

更多信息：[本版报告](docs/ITERATION_ALPHA3.md) · [alpha.2 历史返修](docs/REPAIR_NOTES.md) · [架构](docs/ARCHITECTURE.md) · [协议](docs/PROTOCOL.md) · [第三方声明](THIRD_PARTY_NOTICES.md) · [CoS 复用比对](docs/UPSTREAM_REUSE_AUDIT_20261016.md)
