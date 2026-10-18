# 持续同步：原版宿主验证与待确认的接入代价

2026-10-18。对应用户确认需求：`CONTINUOUS_SYNC_REQUIREMENTS.md`。

## 当前进度

- 新增 `extension/page-controls.js`，仅按当前可见 Stop / Send / Start Voice 判断运行／待命／异常，启用属性独立记录。未读取原生轮次状态、正文或授权状态，无点击、网络行为。
- 隔离真实 Chromium 的 `tests/button-state-browser.py`：18 个用例通过，包括空输入 Voice、禁用 Send、隐藏旧控件、授权存在与整页错误。这里没有运行真实账号任务。
- **这个模块尚未接入生产采集链路。旧机制还未整体替换，不宣称“无残留”已经完成。** 没有用一个开关把新旧两套正式逻辑混跑，也没有部署半成品。
- 新增原版宿主探针 `tests/continuous-host-contract.mjs`。运行实际 beta.2 AgentManager、PluginAgentClientRegistry、ProviderRuntime 及其 SDK schema，原文件摘要由既有加载器验证。事件源为合成数据；pending 故障注入在测试会话边界，不修改宿主文件，不访问运行中的 daemon/Chrome/Agent。

## 10 项探针结果

全部 10 项通过的含义是**能力和限制得到复现**，不是新 CIP 功能已完成或全部验收通过。

| 探针 | 原版宿主实际结果 |
| --- | --- |
| 1 | completed 后仍保留 pending permission，响应可以传到 Provider |
| 2 | idle 后新权限可接收；新的真实运行片段可以恢复运行和原生 Stop |
| 3（限制刻画） | 同一原生 tool call 跨宿主运行片段生成两张卡 |
| 4 | 同 plugin/id 跨运行／待命保持一条，可完整替换非前缀修订 |
| 5 | 直接 append 可以补上缺失历史、替换同 ID；**新 ID 只能追加尾部，不能插回原位置** |
| 6 | pre-provider 新提示失败会丢 Provider 状态／权限／内容事件；直接 append 保留内容；重新发送仍真实存在的状态和权限可恢复该测试场景，未重复发送网页消息 |
| 7（限制刻画） | 原生 assistant 非前缀修订被拼接为“初稿甲修订乙”，不是替换 |
| 8（限制刻画） | plugin 条目保存正文后，原生 getLastAssistantMessage 仍返回 null；原生完成通知／机器结果不自动读取插件正文 |
| 9（限制刻画） | 网页侧关闭授权、Provider 未记录 Paseo 选择时，原生 resolved 事件默认 Deny；这不代表网页真的点击了 Deny |
| 10（限制刻画） | 显式 Allow 的 resolution 在 pending 窗口被丢弃后，重发 resolution 会变成默认 Deny；没有第二次网页授权操作 |

其余默认测试仍为 532/533，原有 OBS-P1 保持失败，零跳过。没有改变旧断言使其变绿，也没有把新的运行片段契约说成旧同-ID恢复已修复。check、typecheck、diff --check 通过。

## 双人复核结论

Piltman 与 Liang 最初分歧是是否保留 native timeline 作为唯一正文出口。结合上述原版动态证据，已一致：

- 使用新的宿主运行片段并不是阻塞，符合待命即收尾的新要求。
- 为保真修订、避免工具卡跨片段重复、避免 pending 丢正文，推荐**唯一内容出口为 CIP 持久来源账本 → 公开 timeline.append → 稳定插件条目**，大内容由 RPC 获取。
- 原生 lifecycle / permission 是控制接口，不是第二份正文；不得再额外写一份 native final 来伪装兼容，否则形成双轨。
- 历史需在稳定的插件内容容器中按来源顺序呈现，不能把“尾部追加”称为“插回原生历史位置”。
- 原生权限与运行状态对账有继续实施验证的价值，但尚未证明事件 ACK 丢失、过期重放、冷加载、重启后的全部情况。特别是原生 permission resolution 的真实语义不能被快照列表正确所掩盖。

## 不能暗中改变的产品行为

1. 插件内容可显示在同一个 Agent 的时间线，但不会自动成为 Paseo 原生“最终回答”。其它 Agent、自动化以及完成通知如果只读该字段，可能拿不到正文或读到旧正文。可以另提供持续内容读取接口，但不能声称原调用方无须调整。
2. 使用插件内容出口需要迁移旧 native 展示或明确展示策略，不能同时展示两份相同来源内容，也不能偷偷隐藏真实工具结果。
3. 原生权限处理的默认 Deny 语义是宿主行为，不等于用户选择；不能通过重新执行授权来修复此记录。
4. 用户要求图片、文件可预览／下载不变。现有生成图片路径包含压缩 WebP 预览及网页原图链接，并不证明原文件下载已经实现；仍须实现和实测，不降级链接交付。

因此，在大范围替换旧链路前，需要明确接受插件自有内容呈现及其原生机器结果影响；或指定必须保持的原生契约。不能擅改 Paseo 来绕过，也不能以用户未确认的功能降级宣布完成。

## 重跑

设置已提取且通过摘要校验的官方宿主包目录：

```sh
CIP_PASEO_SERVER_PACKAGE=/path/to/@getpaseo/server/package node --test tests/continuous-host-contract.mjs
CIP_CHROMIUM=/path/to/chromium python3 tests/button-state-browser.py
```

Python 需安装 Playwright。当前开发环境可以先 source 工作区外的 `../logs/validation-env-012b2.sh`，并用 `$CIP_PYTHON` 执行浏览器测试。完整审查与运行日志保留在本次 `../logs/continuous-sync-*` 目录。
