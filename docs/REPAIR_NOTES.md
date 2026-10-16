# CoS in Paseo · alpha.2 修订与回归记录

**结论：上轮 17 组问题均已落实代码修订；离线可复现用例通过。真实 ChatGPT、Chrome 扩展安装、Paseo 宿主与完整 SDK 类型验收仍未完成，不判定为生产可用。**

日期：2026-10-13。修订目标：`0.1.0-alpha.1 → 0.1.0-alpha.2`；Chrome 扩展清单版本 `0.1.0 → 0.1.1`；本项目浏览器协议 `CIP v1 → v2`；Paseo Provider 协议仍为 v1。

原始 alpha.1 压缩包未覆盖。修订保留“Paseo 插件 + 共享 Runtime + Chrome 扩展”的直连架构，没有引入 CoS 主程序、另一个 MCP 执行器或自动权限批准。

## 1. 修订结果

| 原问题 | 实施的修复 | 主要位置 | 检查证据 |
| --- | --- | --- | --- |
| F01 配置页没有入口 | 用 `addSettingsScreen` 注册设置贡献，使用宿主的 `PluginSurfaceProps`；移除自行猜测的主题背景和嵌套滚动容器 | `index.client.tsx`、`client/settings.tsx` | A01 静态入口检查；真实宿主点击仍待验 |
| F02 模型字段不满足 Paseo 契约 | 输出使用字段白名单；可选思考默认值为 null 时省略；实际插件入口对事件调用真实 SDK 的 `ProviderEventSchema` | `server/provider.mjs::wireModels`、`index.server.ts` | A08、R17；真实 SDK 检查入口已添加但本环境被依赖缺失阻挡 |
| F03 默认注入 MCP 导致无法开聊 | 仅排除名称为 paseo、HTTP 回环地址、路径为 `/mcp/agents` 的宿主形状配置；展示“未导入网页工具”警告；其他配置仍拒绝 | `server/provider.mjs::hostMcpNotice` | A02、R16、双会话联动第 4 项 |
| F04 菜单/禁用属性/空应用列表 | 区分选择器按钮与弹出的菜单项；只把 `aria-disabled=true` 当作禁用；已识别的空应用菜单返回空数组，不阻止模型目录 | `extension/dom-adapter.js` | D00、D02、D06、DOM 收发第 1–2 项 |
| F05 多行正文与回复被压平 | 用 DOM 结构化文本读取保留段落、BR、空行、代码换行，排除应用标签与按钮；发送比对使用同一规范 | `extension/dom-adapter.js::authored` | D01、D07；双会话联动含工作目录上下文的多行消息 |
| F06 等待发送授权时正文/模型被改仍误发 | 授权返回后同步核对文档与导航代次、正文、原始编辑器 HTML、模型、思考、应用、消息基线及 Send 按钮；最后校验与点击间没有 await | `extension/dom-adapter.js::send`、`extension/content.js::run` | D04；授权拒绝无点击检查 |
| F07 代码块 Copy 被当作回答完成 | 只采纳显式 final 标记或专用整轮复制控件，排除代码区；仍要求本轮原生消息锚点和稳定窗口 | `extension/dom-adapter.js::messages`、`extension/content.js::observe` | D03、DOM 收发第 4 项 |
| F08 完成与停止竞态卡死 | 停止判断、生成命令在同一串行事务完成；Stop 绑定 turn ID；重复 Stop 复用命令；完成事件同时结算该轮待停请求 | `server/broker.mjs::interrupt`、`observe`、`failTurn` | A03、R01、R02、双会话联动第 7 项 |
| F09 慢页面挡住其他会话 | 按 session 使用非阻塞执行通道，Stop 单独通道；回执和观察各自调度；单次页面 RPC 有上限 | `extension/background.js::pump`、`launch`、`tabRpc` | A09 实际断言 Stop B 已派发；双会话联动 |
| F10 浏览器重启失去跟踪且静默 | 在本地扩展存储保留绑定；重新观察真实 URL、原生用户消息锚点和文档；能证明时只恢复观察，不能证明则阻断该会话 | `extension/background.js::watchSession`、`server/broker.mjs::rebindObservation`、`observe` | A11、R09–R11；没有把网页重启当作重发授权 |
| F11 发送前失败留下自己草稿 | 仅清除同一页面同一编辑器中自己插入且完全未变的草稿；保留用户修改过的内容；明确上报 `notSent` | `extension/dom-adapter.js::send` | D05、R12、原有草稿保护检查 |
| F12 失败消息 ID 再试会偷偷开新轮 | Provider 在 await 前保留 ID；Broker 持久记录失败 ID 和正文摘要；同 ID 不再新建执行，显式重试必须使用新 ID | `server/provider.mjs`、`server/broker.mjs::prompt` | A05、R03、R04 |
| F13 保存的默认配置未进宿主目录 | 默认模型和思考值写入实际 catalog 输出；缓存键包含默认值及目录内容；失效选项报错而非自动替代 | `server/provider.mjs::wireModels`、`getCatalogCacheKey`、catalog 分支 | A12、R17 |
| F14 已认领的配置超时后仍可旧状态继续 | 已认领配置不明时进入 blocked，晚到回执不能发布生效配置；运行服务重启也恢复这道阻断 | `server/broker.mjs::tick`、`recover`、`result` | A04、R13、R14 |
| F15 恢复会话只改显示目录 | 持久更新 cwd 与用户级任务说明、增加上下文代次；下一条发往既有网页的消息带入新上下文；读回实际保存值 | `server/broker.mjs::updateContext`、`prompt`、`server/provider.mjs` | A06、R15 |
| F16 配对输错破坏旧连接 | 新连接作为候选，服务器确认并存储成功后才替换；配对意图与断开操作分代检查；不兼容版本在提交码之前拒绝 | `extension/background.js` | A10、A13；旧 token 仍在内存和持久存储 |
| F17 容量用尽发生在发送之后 | 入队前预留一条用户消息、最多 16 段响应和最坏 JSON 字节空间；保留 128KiB 控制区；聚合输出超限记录明确终局并阻断 | `server/store.mjs`、`server/protocol.mjs`、`server/broker.mjs` | A07、R05–R08 |

新增处理：设置页显示 blocked 会话；仅允许在对应 Provider 连接已释放后、经过两次明确点击结束本地跟踪。保留历史，不假装停止网页和外部 MCP。测试 R18。普通等待授权与“缺少 final 证据”分开提示，测试 R19。

这些条目中，静态入口和数据形状检查证明的是源码结构；真实 SDK 与真实网页仍有单独验收门槛。表格中的“修复”不等于保证覆盖所有未来网页改版。

## 2. 执行记录

| 套件 | 本次结果 | 范围 |
| --- | --- | --- |
| 原有 Node 回归 | 48/48 PASS | 原有用例保留 |
| 移入的上轮 Node 对抗 + 协议兼容新例 | 13/13 PASS | 上轮 12 项，加 A13 |
| 本轮边界回归 | 19/19 PASS | R01–R19 |
| **Node 合计** | **80/80 PASS** | `npm test` |
| Chromium DOM 对抗 | **9/9 PASS** | D00、D00b、D01–D07 |
| Chromium DOM 收发夹具 | **7/7 PASS** | 目录、双应用、多行回执、完成、授权拒绝、停止、草稿保护 |
| Provider + Runtime + DOM 双会话联动 | **8/8 PASS** | 实际 Node Provider、HTTP 与存储；真实 Chromium 的内存页面；模拟 Chrome tabs API |
| JS / JSON / 协议一致性 | PASS | 20 个 JS/MJS 文件；权限清单与 CIP 两端版本 |
| TS / TSX 语法 | PASS | 4 文件，环境 TypeScript 5.8.3 的 transpileModule，非项目类型解析 |
| 上传脚本 Bash 语法 | PASS | 没有执行上传 |
| 完整项目类型检查 | **BLOCKED** | `npm run typecheck` 退出 2：未安装 node/react 类型包 |
| 真实 SDK 契约检查 | **BLOCKED** | `npm run test:sdk` 退出 1：缺少 `@getpaseo/plugin`；未使用手写替身 |
| 真实 Paseo、Chrome MV3 加载、登录后的 ChatGPT | **未执行** | 没有连用户开发机、没有登录用户账号、没有真实 MCP 调用 |
| GitHub 提交 / CI | **未执行** | 源码压缩包交付，不声称远端完成 |

环境：Node 22.16.0、npm 10.9.2、Chromium 144.0.7559.96、Playwright 1.57.0。项目直接依赖仍以 package.json 的版本为目标。本环境无法解析 npm registry 域名，未能获取依赖；这不是依赖版本不存在的证据。

可复核的原始输出位于 `docs/evidence/`；机器可读汇总为 `docs/TEST_RESULTS.json`。

### 测试夹具调整说明

没有通过删除预期、跳过失败或接受误发来换取通过。上轮三条测试把“错误行为必须先出现”当成等待条件；返修后调整了执行条件而保留正确性断言：A03 允许已完成轮次不产生多余 Stop；A05 不再先等待非法新 Send 才判重复发送；A07 允许容量不足时在发送前拒绝。A09 额外检查 Stop B 确实被派发。

浏览器因环境禁止导航而使用 `page.set_content`。测试只在包装作用域注入夹具 URL；生产文件不包含此替代对象。夹具的文本读取独立于生产序列化函数，保留多行和空行，避免用同一个函数当自己的证明。夹具发送器、Chrome tabs API 与授权响应均是测试替身。它们证明本地收发链路的行为，不证明真实 ChatGPT 接收了消息。

## 3. 安装决策与下一步

**必须整包更新两个插件。**先检查并停止旧网页工作、关闭 Agent、停用旧插件；Runtime 退出后备份状态目录，再更换源码并重新加载 Paseo 插件和 Chrome 扩展，刷新旧网页。CIP v2 不与 alpha.1 混用。新建仓库用原附 `publish-private.sh`；已有仓库使用正常审查分支，不强推覆盖。

有网络的开发环境先运行 `npm install --ignore-scripts`、`npm run typecheck` 和 `npm run test:sdk`；任一失败都不要进入真实开发任务。然后按 `docs/ACCEPTANCE.md` 做一个短回复、两轮同会话、已授权 MCP 只读调用和双会话停止验证。

剩余主要风险是实际 SDK 编译与宿主 UI、ChatGPT 菜单/账号变化、Chrome MV3 生命周期，以及高负载存储性能。重连只恢复能被证明的观察；无法确认身份或结果时，宁可显式阻断，不会假称恢复成功或自动再点 Send。浏览器停止不等于外部进程停止，选中应用不等于授予权限，多会话不扩充额度。
