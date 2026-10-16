# CoS in Paseo alpha.3：直接移植迭代报告

**日期：2026-10-13。版本：0.1.0-alpha.3；Chrome 清单：0.1.2；CIP：v3；Paseo Provider：v1。**

## 1. 结论与移植范围

已在 alpha.2 源码上完成本轮迭代，并交付两个插件和共享服务。此次不是再次独立重写网页发送：五个 `extension/upstream/` 模块实际装载到扩展，并由正常代码路径调用 CoS 的核心函数。原 CoS 桌面程序不参与运行。

| 能力 | 本版来源与实现 |
| --- | --- |
| 输入正文、添加原生 mention、点击 Send、等待确切回执 | 从 `chatgpt-dom.js` 直接移植 `insertPrompt` / `addAppMention` / `send` 等函数；适配层增加最终防误发检查及多应用处理 |
| 读取真实模型与思考档位 | 从 `fiber.js` 移植当前 committed React 路径、两类 picker 数据读取；只投影必要选项 |
| 选择模型与档位 | 从 `chatgpt-dom.js` 移植原生键盘/菜单选择和读回；删除原版“找最近思考档位”的降级行为 |
| 编辑器、忙碌、授权等待、停止 | 从原版移植控件识别与停止函数，包括隐藏旧编辑器排除、非英文 Stop 图标识别 |
| 正文和最终回答证明 | 从 `fiber.js` 移植公开 text、conversation 身份与原生 `end_turn/status` 判断子集；排除 analysis/隐藏消息；有界 IPC 是本项目适配 |
| 开 Chrome 标签、会话绑定、配对、服务端队列与存储 | 保留并调整 Paseo 适配实现，不把它称为 CoS 原版 runtime |
| Paseo 插件界面、Provider、通用 @ 多选、事件转换 | 保留本项目代码，结合移植模块工作 |

上游固定提交 `ccd23b66cecf2f684fa3e12ca190297be02842cf`，参考版本 2.1.35；不是追随变化的 main。源码 blob SHA、原函数名、本地 SHA-256 与改动说明见 `vendor/cos/provenance.json` 和 `vendor/cos/README.md`。MIT 版权/许可保留。`verify:upstream` 检查哈希、来源标记及实际装载，不声称完整文件逐字一致或语义等价。

**不移植也不运行**：Goal/Loop、压缩换聊、CoS 自带多 Agent 调度、CoS 桌面界面、它的本机文件/终端工具、插件安装器、附件及图片处理。普通断线恢复只恢复观察；不自动补发不确定的消息。

## 2. 已落地的实际流程

1. Paseo 创建 Chatmode 会话，只保存该会话的模型、思考档位和应用组合，发出“待网页应用”的 notice，尚不开会话标签页。目录刷新可以独立使用临时空白页。
2. 第一次发送由 Provider 先发 `open`，Chrome worker 创建对应的 ChatGPT 标签页，确认页面身份；原版选择核心切到 Chat、配置模型/思考，再选择并核对通用 @ 应用。获得配置回执后才进入 `send`。
3. 消息通过原版输入和 Send 状态机提交。异步授权返回后，额外同步复核正文、编辑器、HTML、配置、会话、消息基线与按钮。网页确切用户消息出现才算送达；没有回执不盲目重发。
4. 公开回答和终局经过扩展回传至 Runtime，再转换为 Paseo 事件。第二条进入相同 ChatGPT conversation；A/B 的设置、标签和停止命令各自隔离。
5. 首次开页等待期间停止，会取消尚未执行的控制命令；若控制已经认领而结果不明则阻断。最终 Send 入队事务也检查取消信号，避免取消后仍悄悄入队。

开发机 MCP 仍由 ChatGPT 中已经授权的应用调用，本项目不转发 Paseo MCP 凭据、不自行运行这些命令、不自动批准工具权限。停止网页也不代表已经停止外部 MCP 启动的程序。

### 本轮防错补充

- CIP 升至 v3；旧扩展不兼容。网页身份另携带 `cos-native-alpha3`，防止误用旧页面脚本；更换后必须刷新旧标签页。
- 模型目录不再按 UI 名字拼一个 `ui:` 假 ID；没有可证明的 ID 就拒绝。
- 原版读回仍要经过本项目上限和类型检查；不把页面对象整体传回，不读取账号凭据。
- 用原版终局规则处理“旧回答已结束，新一轮还没出字”，不复用旧 final；`finished_successfully` 本身不是最终完成。
- 超长公开正文在调用原版截断函数前拒绝，避免静默把截断回答标为成功。
- 非当前模型的首个已观察档位可作为 Provider 的初始建议，不宣称那是账户原生默认；用户配置与发送时必须选择实际可用值并读回。

## 3. 验证、边界和替换步骤

**通过：86 项 Node 测试 + 41 项离线 Chromium 检查（9 DOM 对抗、7 收发、9 完整双会话链路、16 原版核心移植检查），合计 127 项。**另通过 28 个 JS/MJS 语法检查、4 个 TS/TSX 语法转换、5 个来源模块完整性检查、Bash 上传脚本语法检查。

这些是不同层级的测试案例数，不是 127 个互相独立的生产场景。证据位于 `docs/evidence-alpha3/`。80 个既有案例保留，但 Provider fixture 的开页时点、manifest 加载方式、真实 hex conversation 形态和原生编辑器模拟已按本版更新；新增 6 个 Node 案例。提供变更 patch 供核对，未用“旧文件完全没动”夸大回归结论。

**BLOCKED：**当前环境依赖安装在 15 秒边界被终止（退出 124），未装入 SDK；真实 `tsc --noEmit` 因缺 node/react 类型退出 2，真实 SDK 契约测试因缺 `@getpaseo/plugin` 退出 1。没有用假 SDK 或自造类型替身冒充通过。

**未实测：**真实 Paseo 安装/配置页面、完整 Chrome MV3 安装及世界隔离、登录后的 ChatGPT、开发机 MCP、生产并发与账号限制。尝试导航到拦截测试 URL 时，当前浏览器环境返回 `ERR_BLOCKED_BY_ADMINISTRATOR`；最终浏览器测试均运行内存夹具，没有访问真实账号。MAIN/isolated 通信检查使用测试专用 opaque-origin 映射，不等于网站 CSP/扩展安装兼容性证明。

**仍有明确兼容边界：**未移植整个 CoS `shellTurnSource` / `entry.turn.items` / 全量 transcript 重建。公开消息原生读取目前覆盖确切 conversation 下的 `turn.messages` / `allMessages`，并保留已有明确 message-ID 的 DOM 降级路径；若实际 ChatGPT 只暴露其他结构，可能显示未确认或需要补适配。通用 @ 列表仍依赖可证明的应用 ID；分页、目录形态或账号切换须实测，不能称为所有账户通用已验收版本。

### 升级

先检查并停止旧会话，退出旧 Provider，备份退出后的 `~/.cos-in-paseo/`。整包替换两个插件：Paseo 重新加载根目录插件，Chrome 重新加载 `extension/`，刷新已有 ChatGPT 页面；扩展 ID 变化时重新配对。不要同时运行 standalone 和 Paseo Runtime，也不要混用原版 CoS、alpha.1/alpha.2 与本版脚本。

安装依赖后必须先跑 `npm run typecheck`、`npm run test:sdk`，再按 `docs/ACCEPTANCE.md` 验收短消息、第二轮、开发机只读调用及双会话/停止。没有通过真实类型和端到端前，不应作为重要项目的无人值守执行工具。

本次只改沙盒中的源码副本并交付压缩包，未连接其他开发机/MCP，未上传 GitHub、未创建远端提交、未运行远端 CI。输入 alpha.2 压缩包保持原样。
