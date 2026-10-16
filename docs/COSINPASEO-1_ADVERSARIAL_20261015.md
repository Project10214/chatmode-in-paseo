# COSINPASEO-1 对抗式审核与返修（2026-10-15）

## 结论

**四个独立安全/一致性攻击用例均先复现失败，再修改源码使其通过。** 本轮是 alpha.4.0 候选的对抗审核，交付整合为 **alpha.4.1 / CIP v5 / Chrome 0.2.1**（包含随后 COSINPASEO-2 的公开原生事件扩展）。保留同一 Runtime、Provider v1、单选工具设置与原有严格回执机制。不涉及 JEV。

## 复现和修复

| 编号 | 攻击与旧结果 | 修复位置与行为 | 验证 |
| --- | --- | --- | --- |
| ADV1-01 | 用已登记的 native user ID 重提交更改过的文本/文档，旧实现直接返回 duplicate、不验证身份 | `server/broker.mjs::importExternalTurn` 对同原生 ID 的重复请求再次核对原正文、tabId/documentKey 与 previousNativeMessageId，正文变动 `EXTERNAL_MESSAGE_CONFLICT`，文档变化 `PAGE_IDENTITY_MISMATCH`；真正重交幂等 | PASS |
| ADV1-02 | 第二标签页凭相同 Conversation ID 和全新 documentKey 可接管现有会话 | Broker 要求原 tabId，只有显式 `reopened` 才可换标签页；`extension/background.js::watchIdle` 先确认原标签页已经不存在、且恰有一个同会话候选才允许 `reopened`，其他情况拒绝 | PASS |
| ADV1-03 | 已配对扩展上报 `/external-gap` 时未校验 tab/native 锚点，可为错误会话制造虚假警告 | `broker.noteExternalGap` 校验 tabId、上轮真实 native user ID、精确会话路由；worker/content 附带证据 | PASS |
| ADV1-04 | 缓存的 Agent 映射变成归档态后，唤醒器仍调用其命令接口 | `server/wake.mjs` 每次检索目标 Agent 时重新确认 provider/persistence ID 和归档状态；过期缓存清退，不唤醒归档或歧义 Agent | PASS |

复现文件：`tests/cosin-paseo-1-adversarial.test.mjs`。最初 **0/4 PASS**，上述修复后 **4/4 PASS**；相关 COS1/binding 组合 **37/37 PASS**。

## 完整测试与数据来源

- `/opt/homebrew/bin/node --test tests/*.test.mjs`：**246/246 PASS**（含 COS1 对抗用例、COS2 单测和 SDK 测试）。
- `/opt/homebrew/bin/node scripts/verify-upstream.mjs`：**12/12 活跃来源模块与记录哈希、MIT 来源校验 PASS**。
- `/opt/homebrew/bin/node scripts/check.mjs`：**413 JavaScript 文件语法、JSON/Chrome 清单权限检查 PASS**。
- `/opt/homebrew/bin/node .test-tools/ui/typecheck.cjs`：**21 文件 / 0 diagnostics**。
- 真实 Chrome 解压 MV3 扩展、Service Worker、临时 Runtime 和 Paseo Provider SDK 0.11.2，在**离线模拟 ChatGPT 页面及隔离 profile**下：普通请求 **10/10 PASS**，Markdown 转义请求 **11/11 PASS**，`installedSdkValidated:true`。
- 所有测试为本机临时/内存状态。没有修改生产 `~/.cos-in-paseo`、未启动正式插件重载、未发送真实 ChatGPT 账号消息。

## 残留风险（不可宣称已解决）

1. **网页实机差异**：离线夹具无法替代当前已登录 ChatGPT DOM/Fiber 的真实事件结构。发生不可读/多轮遗漏时继续拒绝猜测，网页适配仍需真实版本验证。
2. **旧 Agent / SESSION_BUSY 状态倒挂**：历史生产代理仍可能有正在运行但未可靠终结的原生操作。不能为释放锁伪造终态或重复发送；需要实际 Runtime/网页观测的专项验收。
3. **Paseo 进程退出**：当前唤醒器依赖 Paseo Daemon 与插件宿主存活。整个 Daemon 退出后的外部系统级启动需额外 native messaging / 系统服务设计，尚未实现。
4. **多标签页、断线与工具副作用**：即便模拟用例通过，真实账号与真实 MCP 长运行任务的竞态仍需端到端手动验收。
5. **预留空间和事务边界**：该实现保持既有状态 32 MiB 总量与单轮条目配额。数据上限命中时拒绝新事件，不允许悄悄丢失已确认数据。

因此 **COSINPASEO-1 保持 In Progress**，并已允许 COSINPASEO-2 在同一稳定通信主干上独立开发。正式升级前需待运行任务结束，备份并成套替换 Paseo/Chrome，刷新空闲网页；旧 CIP v3/v4 与新 v5 不可混用。
