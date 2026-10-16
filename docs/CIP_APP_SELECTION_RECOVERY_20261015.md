# CIP：Chrome 退出重启后 APP_SELECTION_CHANGED 及首轮 Agent 锁死（2026-10-15）

## 现象
用户在关闭 Chrome、尝试通过 Paseo 再启动的验收后，CIP Agent 发送新消息时，Paseo 显示 APP_SELECTION_CHANGED，原 Agent 无法继续。

## 先前真实验收的边界
- docs/CIP_027_POST_UPDATE_REAL_ACCEPTANCE_20261015.md：关闭单个受管标签并由 Paseo 重新打开**同一 Conversation** 已真实 PASS。
- **完全退出 Chrome、再由 Paseo 自动启动**没有取得同样的真实 PASS；此前记录为待测。
- 本次没有读取私人 ChatGPT 对话正文、没有触发真实 Send、没有强制重启运行中的其他 Agent。

## 定位
1. extension/dom-adapter.js：setApps 在切到“无工具”时对现存 @ mark 要求“属于同一个 JS 文档的 ownedApps 且 innerHTML 字节完全一致”。重启/网页恢复可能留下无正文的原生 mark，但 JS 内存 owner 丢失；或者原生编辑器轻微重新渲染改变 innerHTML，即抛 APP_SELECTION_CHANGED。这条异常发生在 Send 授权之前；需要留下用户的新草稿，不应重发。
2. server/broker.mjs：首轮 open/configure 的这种失败有机会被归为 CONTROL_UNCONFIRMED，写入 blocked；session.prompt 后续要求 idle，导致首次发言失败后旧 Agent 继续发送无效。旧插件建立的 blocked 且无 Conversation、无 turn、无 Send 的持久会话，也可能无法通过 session.open 重新附着。

## 修改
- extension/dom-adapter.js：独立记录可信用户编辑动作；允许当前编辑框无正文、所有 mark ID 确定、用户未改动时移除重启残留 mark。去掉不稳定 innerHTML 的硬依赖，保留人工作文/工具选择保护和二次清理核验。
- server/broker.mjs：APP_SELECTION_CHANGED 是明确的网页配置拒绝，不应把 idle 的控制阶段直接锁死；单独提供 recoverUnboundControl，严格限于 blocked+CONTROL_UNCONFIRMED+没有 Conversation+没有 tab+没有 turn+历史从未有 Send+无未完成命令。
- server/provider.mjs：同一 Agent 下一次显式新发言、或重新加载其持久会话时，使用上述严格恢复，不自动重发此前任何消息。仍然禁止恢复已授权/结果不明的 Send。
- tests/apps-headless.py、tests/broker.test.mjs、tests/provider.test.mjs：增加真实离线 Chrome 原生编辑框复现、包含实际 Send 的单次回执、legacy blocked 恢复和不允许恢复不明 Send 的反例。

## 结果
- 未修时：新增的 Chrome 场景确切报 APP_SELECTION_CHANGED。
- 修后：隔离 Chrome 原生编辑框 12/12 PASS。
- Node 全量 298/298 PASS；静态检查 484 JS/JSON PASS；来源哈希 12/12 PASS。
- 本机无 tsc 可执行环境，typecheck 未运行；这不代表类型检查通过。
- **尚未生产更新/尚未真实登录账号执行完全关闭 Chrome 后恢复验收**；只确认修复后的源码和隔离测试，不宣称 Chrome 冷启动端到端成功。

## 安全部署/真实验收
1. 等全部工作 Agent 和 ChatGPT 网页轮次空闲，核对上次结果不明的消息，不重复发送。不要退出共享 Paseo Daemon 或更新正在进行工具调用的对话。
2. 安全重载 Paseo 插件及 Chrome 已解压扩展。当前 manifest 由其他开发过程调整为 0.2.8；同版本手动重载也应刷新**仅故障 Agent** 的受管空闲 ChatGPT 页，使 content script 生效。
3. 在**原故障 Paseo Agent** 发送新的唯一标记（不是自动重发历史 “hi”），核对新的 Send 回执与 ChatGPT 原生消息 ID、同一 Conversation、最终答复。随后单独安排完全退出 Chrome 的正式冷启动专项验收；切勿把“关一个标签”的 PASS 误作“全退出 Chrome”的 PASS。
