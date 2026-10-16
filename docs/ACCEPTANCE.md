# 验收记录与实机门槛

2026-10-13 · 0.1.0-alpha.3。

## 1. 本版已执行

| 命令/对象 | 状态 | 证据 |
| --- | --- | --- |
| npm test | PASS，86 项 | evidence-alpha3/node-tests.log |
| npm run check | PASS，28 JS/MJS + JSON + CIP 版本一致性 | evidence-alpha3/check.log |
| npm run verify:upstream | PASS，5 个活跃移植模块/哈希/版权/manifest | evidence-alpha3/upstream.log |
| TypeScript transpileModule | PASS，4 文件语法；编译器 5.8.3；不是类型检查 | evidence-alpha3/ts-syntax.log |
| test:dom | PASS，9 项 | evidence-alpha3/dom.log |
| test:browser | PASS，7 项 | evidence-alpha3/browser.log |
| test:flow | PASS，9 项 | evidence-alpha3/flow.log |
| test:native | PASS，16 项 | evidence-alpha3/native.log |
| 依赖安装 | BLOCKED，15 秒限时退出 124，未得到依赖 | evidence-alpha3/dependency-install.log |
| npm run typecheck | BLOCKED，缺 node/react 类型，退出 2 | evidence-alpha3/typecheck.log |
| npm run test:sdk | BLOCKED，缺 @getpaseo/plugin，退出 1 | evidence-alpha3/sdk.log |
| 真实 Paseo / MV3 / ChatGPT / MCP | 未验收 | 本版未访问用户开发机或账号 |
| GitHub 提交/CI | 未执行 | 交付源码包与脚本，不伪称上传成功 |

浏览器检查全部使用内存测试页面。双会话套件是真实 Node Provider/Runtime/HTTP + Chromium + 模拟 tabs API；native 套件运行移植的真实函数，但 React 数据来自明确标注的夹具，并通过测试专用 opaque-origin postMessage 映射连通两个脚本。这不等于真实网站、扩展两个 JS 世界隔离或已安装 Paseo。

80 项既有测试保留并通过；新加 6 项延迟开页/取消竞态检查。既有 Provider 开聊测试和浏览器夹具已按新合同调整，具体 diff 随交付提供，不能说旧测试文件全部未动。

## 2. 进入实机前必须完成

- [ ] 安装 package.json 的依赖，运行完整 typecheck 和 test:sdk，修复所有失败；审查锁文件。
- [ ] 停用旧插件，备份退出后的状态目录，同时替换 Paseo 与 Chrome 插件，刷新旧网页；不用旧 CIP v1/v2。
- [ ] Paseo 能加载两端入口并打开 Settings → Plugins 的 Chatmode 设置；生成配对码；不重复启动 Runtime。
- [ ] Chrome 与 Paseo 后台在同一主机，本机配对成功；失败重配不破坏旧连接；原版 CoS 不同时驱动测试页面。
- [ ] 真实账号模型、对应思考档位、两个授权应用与稳定应用 ID 可读；保存默认配置再创建 Agent，不偷偷降级。
- [ ] 创建 Agent 不打开会话页；首条发送才开独立标签；目录刷新产生的临时页单独计数。
- [ ] 仅要求回显测试标识：单次 Send、正确消息/对话锚点、实际回答和终局；第二条进入同一会话。
- [ ] 选择开发主机 MCP 后只读一个测试文件，在目标机确认真实结果。不得把“已调用”字样当作文件执行证据。
- [ ] A、B 不同配置同时生成；停止 A 不影响 B；B 下一轮不串到 A。
- [ ] queued/claimed/authorized/receipt 时分别断线；未知结果阻断，重连不得多次点 Send。
- [ ] 配置与授权等待时改正文、换模型、导航 A→B→A、reload、关闭标签/Provider；保留用户草稿，不串会话。
- [ ] 授权等待只提示，不自动批准；限额/策略警告停止工作，不换账号、模型或会话规避。
- [ ] 长回答、缺 final、代码 Copy、多响应片段、状态接近容量上限明确处理；每轮仅一个有效终局。

## 3. 证据记录模板

```text
案例 / 日期：
Paseo 与 SDK 版本：
Chrome / 扩展 / CIP 版本：
ChatGPT 页面语言与菜单形态：
本地测试会话标识（不记录配对码、token 或私有真实 URL）：
操作 / 预期 / 实际：
PASS / FAIL / BLOCKED：
脱敏日志位置：
```

只有真实类型、安装和关键网页收发通过，才能标记为已联调版本。本次输出不满足这一门槛。
