# Paseo 0.12.0-beta.1 兼容核查（未部署）

2026-10-17。用户已自行升级本机桌面托管的Paseo；只读daemon status及app版本均为 `0.12.0-beta.1`。线上插件仍是 `0.1.0-alpha.4.16`，其 `>=0.11.2 <0.12.0` 要求导致截图中的加载拒绝。**该错误是版本准入检查，不等于已经发生运行时代码崩溃。**

## 候选修改

- 未发布插件升为 `0.1.0-alpha.4.20`。
- `@getpaseo/plugin`、`@getpaseo/client`、`@getpaseo/protocol` 的开发依赖和实际安装依赖均对齐 `0.12.0-beta.1`。
- manifest改为 `>=0.11.4 <0.12.0 || =0.12.0-beta.1`。保留原0.11分支，新增明确核查的beta.1；不借此放行beta.2、0.12正式版或未来0.13。
- 扩展代码本阶段未改，候选仍0.2.26、桥协议7、MAIN正文IPC v2；没有为宿主版本修改浏览器身份或通信协议。
- 新增 `tests/paseo-compatibility.test.mjs`：先复现旧范围拒绝，再用Paseo自己的校验器验证app/daemon准入、旧版本/未来版本拒绝及实际SDK版本。四项通过。

官方要求校验会同时尝试原版本和stable core，不应只凭通用semver直觉判断beta。参考：[插件requirements](https://paseo.sh/docs/plugins/reference.md#requirements)。这里只允许新beta的准入，不宣称同步功能全部通过。

## 来源与新版行为

下载并核对官方npm server/plugin/client/protocol/relay五个包的SHA-512完整性。server包：

`sha512-BUsITOLeedMMJXkxfjp8p+b6nOt5QHGyXD+DJ9XfB9O1on5oGETCZCIoQqqS8zzz3CGNkZ+fuCQvN+GZpnZ6Jg==`

通过Electron Node模式只读已安装app.asar，核心文件哈希与官方npm包一致；没有启动/重载插件或daemon。

- 新agent-manager.js：`63c27c34cb1079880594cfc5a8b498adbd838d6411036fdd49fb79e730be442e`。
- plugin-provider、agent-run-state、agent-loading、agent-sdk-types及SDK provider协议实现与0.11.4字节相同。
- 新agent-prompt.js有消息来源/通知封装改动；最终结果仍来自同一连续assistant尾段提取路径。
- 新已安装app的Web bundle：`index-a2d4b93a04a436748e094550258f8793.js`，SHA256 `b2c903a005b0da2afde8eb7f810278d374bd7425f8098597de901dea0e5a1929`，reducer模块3664。与旧npm Web reducer相比，只新增可选tool-call agentMessage元数据转发；不新增正文替换或历史重排。

`tests/fixtures/paseo-host-sources.mjs`按包实际版本选择精确文件哈希，并校验声明/实际SDK版本，使用该宿主自己的Schema。`paseo-real-contract.mjs`同时固定旧/新renderer哈希，未知来源仍失败；没有把新文件无条件加入“跳过来源验证”。

## 实测结果

| 验证 | 0.12.0-beta.1结果 |
|---|---|
| 类型、SDK契约、版本准入 | typecheck通过，SDK2/2，准入4/4 |
| 默认回归 | 504项503过1红OBS-P1，0skip |
| 原版完整宿主类 | 13项10过3红，0skip；同0.11.4结果 |
| 原版mapper/renderer及机器结果诊断 | 23项16过7红，0skip |
| 选定隔离浏览器/MV3 | 15+6=21项全过，带新版SDK/原版renderer对照 |

日志在接手工作区 `logs/paseo-012-{full-final,diagnostics-final,real-0.12.0-beta.1,real-0.11.4,compat-parity}.log`、`paseo-012-{browser,mv3}.tsv`。首轮针对旧哈希的来源拒绝已通过新增**固定新版来源**解决，不能把它混入功能红项或删掉断言。

**升级未修复的实际问题：** REAL-9两个窗口仍把旧正文归新轮且排在新user之后；REAL-12中新prompt失败仍会丢弃旧staged正文。同一旧连接的前台已终结恢复、非前缀正文修订及完整机器回报也没有自动获得新能力。详见 [并发交付门禁](HOST_CONCURRENT_DELIVERY_GATE.md)。

## 当前边界

兼容修改只在接手repo，尚未部署。线上旧插件仍受版本范围拦截；没有直接编辑其manifest或强行启用。没有操作两条真实故障Agent、刷新ChatGPT、重发任务、Stop或重启daemon。

新版准入修复不等于统一保真同步完成。不会仅放宽旧插件范围就把既有红门禁带到现场；部署和实际原Agent恢复仍需新授权及安全条件。


## 0.12.0-beta.2（2026-10-18）

- 现象：Paseo 重启后自动升级到 0.12.0-beta.2，alpha.4.25 的范围 `>=0.11.4 <0.12.0 || =0.12.0-beta.1` 拒绝加载插件（failed）。
- 核查：官方 npm server/plugin/client/protocol/relay/highlight 六个包 SHA-512 均与 registry 一致；已安装 app.asar 中的宿主核心文件与 npm beta.2 字节一致。
- 宿主差异（相对 beta.1）：`plugin-provider.js`、`agent-run-state.js`、`agent-sdk-types.js` 不变；`agent-manager.js` 仅在跨 Agent 斜杠命令前去掉发送方信封；`agent-prompt.js` 重写调用方完成通知；`agent-loading.js` 新增 AgentNotFoundError。其余改动在内置 Claude/opencode/Copilot/omp provider、定时任务、Paseo 工具与 Web UI。插件 SDK（@getpaseo/plugin）与 protocol 的 dist 与 beta.1 字节一致；界面时间线 reducer（applyStreamEvent 模块）在 beta.1、beta.2 与已安装 app 中规范化模块编号后完全一致。
- 候选 alpha.4.26：范围改为 `>=0.11.4 <0.12.0 || =0.12.0-beta.1 || =0.12.0-beta.2`，仍不放行其他 beta 或正式版；SDK 声明与实际依赖对齐 beta.2；宿主固定指纹新增 beta.2。
- 验证：兼容测试 5/5；原版宿主类 0.11.4 / beta.1 / beta.2 各 13/13；诊断 16/23 与基线一致（修正一处依赖已删除注释的函数定位）；npm test 520 项 519 过 1 红（既有 OBS-P1）；浏览器 23/23；check/typecheck/verify/SDK 通过。

### 版本范围策略（2026-10-18 用户决定）

- 范围改为 `>=0.11.4`：之后所有 Paseo 版本（含 beta、正式版、更高主版本）都会加载插件，避免每次自动升级后插件停用。
- 仍会报错的情况：Paseo 不再支持 provider 协议 v1（连接返回 PROTOCOL_UNSUPPORTED）；插件事件不符合已安装 SDK 的格式（显示 Provider output did not match the installed Paseo SDK）。
- 不能自动发现的情况：接口不变但宿主行为变化（例如 pending 期间事件暂存/丢弃策略）。每次 Paseo 更新后按本页流程补审：官方包完整性、已安装 app 与 npm 一致、核心文件差异、原版宿主类测试、界面 reducer 对比；发现问题再调整。
