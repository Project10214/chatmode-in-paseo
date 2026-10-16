# COSINPASEO-1 / -2 第一阶段迭代记录（2026-10-15）

## 已实现的源码改动

1. `extension/upstream/cos-activity-main.js`：原先把所有公开消息都要求 `recipient=all`，但真实 MCP 工具调用是定向发给工具提供者的；调整为工具调用可使用非私有定向接收方，仍拒绝 `analysis/private`、隐藏/瞬时条目及不可信 ID。将 `collapse` 明确视为公开界面的折叠分组（非 `hide_all`），支持公开摘要和已经完成的 `presentation=thought` 说明。永远不读取 `activeReasoning`、原始工具参数/结果及未公开私有思考。
2. `extension/content.js`：现有 Chrome 内容脚本依赖 750ms 定时观察。新增受原生身份约束的 `monitor` 检查触发：只有 `D.state()` 成功读取且没有错误时才主动执行同一 `observe()`，减少后台标签定时器限速造成的轮次收尾延迟。导航 A→B→A、原生 ID 不可读时沿用原有拒绝/重试规则，不伪造完成回执或触发 Send。
3. `client/native-activity.tsx`：把总是展开的多步活动卡改成紧凑状态栏，默认折叠，点击展开完整步骤；显示明确的运行/等待回执/完成/失败状态。此组件只用于 Chatmode 插件自己的 `native-activity`，不影响其他 Provider。
4. `vendor/cos/provenance.json`：同步更新来源模块的本地 SHA256，保留 CoS MIT 来源和完整性验证。

原版备份：`.local-backups/cos12-20261015-before-first-phase/`。

## 持久回归测试

- 新增 `tests/cos2-collapse-public.test.mjs`：公开折叠分组、定向工具、callId 去重、隐藏/private 不泄漏。
- 新增 `tests/cos1-monitor-ping.test.mjs`：Chrome 定时器被限速时仍由可信监控脉冲完成回执；真正运行中的轮次不能误判完成。
- 扩展 `tests/binding-mv3-flow.py`：`CIP_FIXTURE_COLLAPSE=1` 测试折叠公开工具场景，`CIP_FIXTURE_ESCAPE_REQUESTS=1` 测试转义消息。

已执行：
- `node --test tests/*.test.mjs`：**251/251 PASS**。
- `node scripts/check.mjs`：448 个 JavaScript 文件通过语法/清单检查。
- `node scripts/verify-upstream.mjs`：12 个活跃来源模块哈希/世界声明 PASS。
- `node .test-tools/ui/typecheck.cjs`：21 文件、0 diagnostics。
- Chrome 真实解压扩展 + 临时 Worker/Runtime/Provider + **离线模拟 ChatGPT 网页**：普通 **10/10**，`collapse` **10/10**，`collapse` + 转义 **11/11**；安装的 Paseo SDK 校验为 true。

## 仍未宣称完成的内容

- **真实账号新版端到端验收**：源码已更新，但没有重启共享 Runtime 或全局重新加载 Chrome 插件；生产还有其他活跃会话。新脚本在真实页上的事件回传尚未重新验收。
- **COS1 结束延迟**：已修复一条合理且可复现的定时器限速路径；未证明覆盖所有真实终态延迟成因。需生产真实会话测量“最后回答→可信 `completed`”时间。
- **整个 Paseo Daemon 已退出时主动拉起**：此桥目前依赖 Daemon/Provider 存活。要做到系统级唤起，需要单独评估 macOS Native Messaging 或 LaunchAgent 的安装和权限，不可声称当前已支持，也不能为了测试而关闭其他 Agent。
- **完整消息富文本排版**：现有 Paseo 0.11.2 插件 `addTimelineTransformer` 按消息类型全局匹配，接口没有 Provider 过滤器；直接转换所有 `assistant_message` 会影响其他 Agent。暂不启用全局消息替换。下一阶段优先采用能够安全限定 Chatmode 身份的渲染扩展，再适配 Markdown、代码、表格、公式。当前仅完成 Chatmode 活动卡的紧凑/可展开排版。

## 下一阶段操作顺序

1. 等待共享 Runtime 不再有运行轮次；备份状态、确认扩展版本，选择专用 ChatGPT + Paseo 验收 Agent 进行定点刷新（不能刷新他人的工作标签）。
2. 测量完整工具轮次：`collapse` 下两个独立公开工具卡、状态变化、公开 `thought`/摘要、无 private 数据和重复 Send；实测 COS1 终态延迟。
3. 设计并实现**只限定 Chatmode** 的消息渲染路径；其他 Provider 不得受影响，保持 Paseo 原生消息与回放语义。
4. 覆盖断网/竞态/关闭后的恢复与打断；评估系统级唤醒方案，在无法安全验证前保留两项任务 **In Progress**。


## mymac 开发机复验（2026-10-15 11:27–11:40 CST）

本轮 **仅使用已连接的 mymac** 操作开发机，复查本项目迭代代码、临时 Chrome 运行链路与真实 CIP 持久状态。验收机 Paseo Daemon 0.11.2 正常，CIP Runtime `/hello` 返回协议 v5。

| 验收项目 | 本轮实测 | 结论 |
| --- | --- | --- |
| 全量 Node 自动化 | `node --test tests/*.test.mjs` | **251/251 PASS** |
| 源码语法与扩展清单 | `node scripts/check.mjs` | **PASS，448 JS** |
| CoS 来源完整性 | `node scripts/verify-upstream.mjs` | **PASS，12 模块** |
| Paseo UI 类型检查 | `node .test-tools/ui/typecheck.cjs` | **PASS，21 文件，0 错误** |
| 解压 MV3 + Worker + Runtime + Paseo（离线模拟网页） | 普通 10/10、公开折叠 10/10、折叠与 Markdown 转义 11/11 | **31/31 PASS，SDK 真实校验** |
| Chrome 已安装扩展定位 | 在 `chrome://extensions` 的详情页核对 `CoS in Paseo — Chatmode Bridge`、版本名 0.1.0-alpha.4.1，与配对扩展 ID 匹配 | **PASS，仅确认安装身份与版本名** |
| 真实账号工具事件同步 | 已有专用 Agent C 的 SHA256 只读测试最终 `idle/completed`，最终值与文件核对一致；Runtime 历史工具卡 `0`、reasoning `0` | **端到端未通过**。哈希一致不证明完整工具事件已经转发 |
| 更新后的脚本是否被 Chrome 装载 | 两次准备只重载 COS 扩展，均在执行前因另一个会话 `running` 触发安全门禁而自动放弃，没有实际重载 | **未验证**，不能将真实账号结果判为新代码失败或成功 |
| 真实 Paceo/Chrome 消息美观程度 | 新 `NativeActivity` 紧凑折叠组件已通过类型检查；真实桌面 UI 未重新加载完整新版 | **视觉验收未完成** |

**安全措施：** 未强制重启 Daemon/Runtime，未点击任何 MCP 授权，未刷新或 Stop 他人的标签/Agent。所有隔离 Chrome 测试均使用临时浏览器配置和离线模拟页面，不接触真实账号。对真实测试标签仅尝试只读查看公开事件结构，但 macOS AX 辅助功能读取超时，没有取得新的可信解析样本，因此没有伪造新的实机通过记录。CIP 共享 Runtime 当前仍有会话占用，不应强制全局热更。

**后续放行条件：** 共享 CIP 会话可靠空闲、扩展重载并在专用验收标签加载新版脚本、真实公开 MCP 工具出现至少两条原生 `tool_call`，公开折叠摘要按隐私规则同步，确保无重复发送，且独立测量 COS1 最终文字到可信 `completed` 的耗时。在上述条件全部满足前保留 COSINPASEO-1/2 为 **In Progress**。
