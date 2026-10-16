# BROWSER_BINDING_LOST — 前轮未完成状态（历史记录）

**已由 alpha.3.6 接续完成代码修订、来源校验和受控完整扩展测试；当前说明见 `docs/BINDING_ALPHA3_6.md`。用户登录账号收发仍待验收。以下保留前一轮过程，不代表当前版本状态。**

状态：未发布新版本。package.json / Chrome manifest 仍为 alpha.3.5。不要将本次工作当作已修复或要求用户继续重复发送。

## 实际日志与原因

本次只连接 mymac（Penn’s Mac，/Users/penn），项目 /Volumes/penndisk/HarnessSpace/Project10214/cos-in-paseo。

最新现场发送命令已为 done；00:49:41 的 [CIP send] 记录 phase=done。Runtime 收到并保存了发送回执。后续会话为 blocked / BROWSER_BINDING_LOST，保存的 nativeMessageId 实际是 `fallback-turn-0:0:user`。

这不是原生消息 ID，而是网页搜索/布局位置。`extension/dom-adapter.js` 的 DOM 分支使用 `data-message-id || data-chatgpt-search-unit-key`，错误地把布局键当作消息身份。`extension/upstream/cos-picker-main.js` 的 publicTranscript 只扫描 legacy section 与 data-turn-key，漏了原版 CoS 的 SEARCH_TURN_ANCHOR，导致只有搜索锚点的新式页面无法进入原生 turn.items 读取分支。

原版 CoS 对照：`.work/receipt-20261013/upstream/fiber.js` 第 79–85 行 TURN_SECTION 明确包含 `[data-chatgpt-search-unit-key$=":user"]`；应从该锚点已提交的 Fiber 读取真正 messageId，不直接用锚点值作为 ID。

回传通道确实存在：content.js 观察回答 → Chrome background.js → HTTP POST /event → server/runtime.mjs → Broker.observe 存历史/发事件 → Provider 的 timeline.item / session.turn → Paseo。官方契约见 https://paseo.sh/docs/plugins/providers，send 的结果通过 onEvent 发布，而非 send 返回值。

## 本轮复现与代码状态

新增 tests/binding-identity-browser.py。修订前第一条断言实际读到 fallback-turn-0:0:user，记录 docs/evidence-alpha3-6/identity-before.log。

已成功对 cos-picker-main.js 作两处草稿修改：补搜索锚点、拒绝布局形状的原生 ID。部分检查因此能读取真正 native ID，并在布局键变化后保持一致，但整体仍失败：尚未删除 dom-adapter.js 的错误 DOM ID 回退（identity-partial.log）。

该关键编辑调用被平台安全状态检查阻止，原样重试仍被阻止。额外 Broker ID 校验也被阻止。没有换工具绕过。

清理尝试：dom-adapter.js 中本轮成功加入的 transcript.error 短路已撤回，因此该文件恢复本轮开始内容。cos-picker-main.js 的精确撤回调用也被平台阻止，故这一个文件还保留上述两处未完成草稿改动，旧 provenance 哈希可能不匹配；不是可交付版本。

本轮没有修改生产 state.json、配对凭据、用户历史；没有重发用户消息，没有解除旧 blocked 状态。

## 还需执行

1. 完成 DOM 回退删除：只允许明确 data-message-id 或 CoS 已提交原生消息模型的 ID，绝不能用搜索布局键。补服务端拒绝布局键的纵深校验。
2. 检查 watchSession：目前一次拿不到匹配消息即 binding_lost。区分有确证的消息/会话冲突与短暂重绘/读取不可用；仅后者允许有时限的重新观察，不发送、不自动换身份。
3. 全链路验证：tests/binding-mv3-flow.py 已新增，使用真实独立 MV3 扩展、service worker、Chrome tabs、两种脚本世界、HTTP Runtime 与 Provider；网页与网络使用离线夹具，不能宣称真实账号验收。本机常规 Chrome 未加载命令行扩展，service worker 等待超时；项目内 Playwright 测试浏览器下载 job-6b636dc7b0be64b3c2fcdbccc82e50d8 在 300 秒超时，进程组清理为 clean。没有启动用户账号浏览器的调试权限。
4. 完整测试通过并完成登录网页收发验证后，再更新来源哈希/版本及让用户重载。当前不得宣传全量测试通过。
