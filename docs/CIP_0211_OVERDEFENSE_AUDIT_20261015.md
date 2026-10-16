# CIP 0.2.11 · 过度防御专项审计和修复（2026-10-15）

## 结论

对 Chatmode → Paseo Provider/Runtime → Chrome service worker → content → CoS 原生网页编辑、工具发现和状态回传全链路做误拦截审查。本次只处理能够证明不改变会话/用户正文/工具授权/原生发送事实，却被当成异常的情形。保留所有涉及会话身份、并发授权、用户实际修改、真实错误与不可重复发送的门禁。

**候选版本：Chrome 扩展 0.2.11；Paseo 0.1.0-alpha.4.6 不变；CIP v5、cos-native-alpha4.3 不变。未部署到用户生产 Chrome/Paseo。**

## 复现并修复的误拦截

1. **同页导航事件误伤回执与身份读取**：`extension/content.js` 的 `identity`、`external-candidate` 和 `pending-receipt` 原先依赖每次导航事件递增的 `navigationEpoch`；完全相同的 pathname 也会终止读取。改成 `pathEpoch`，只记录真实 pathname 离开；A → B → A 的离开仍拒绝。新增 LATE6–10，修改前 LATE6–9 确实失败。
2. **网页其他位置的点击/按键误认作用户改稿**：`extension/dom-adapter.js` 把所有可信 `pointerdown` / `keydown` 视为草稿更改，误伤模型菜单、外部点击、光标移动。现在只在编辑框内部可改变文本的动作或删除 app 标记的动作标记用户改动；人工输入/粘贴、模型实际变化仍拒绝发送。Headless Chrome 原生编辑测试复现并证明修复。
3. **React 装饰性重排误判正文变化**：`dom-adapter` 原先要求 `box.innerHTML` 字节相同，编辑器重新渲染等价内容也使发送失败。改为比较真实正文、编辑框归属、选中模型/思考/工具和附件；实际草稿变更或跨聊天仍失败。
4. **原生 Send 按钮换节点就误报失败**：`extension/upstream/cos-native.js` 原先在异步授权前缓存按钮对象，React 重新渲染同一表单按钮会使 `sendButton() !== control`，无法投递。点击前重新取唯一的、当前原生表单 Send 按钮，仍运行单次点击和最终正文/配置检查。外部伪按钮不会被点击。CoS 本地适配哈希及来源说明已更新（不是声称与上游逐字相同）。
5. **目录探测误认任意全页操作为用户输入**：`extension/app-discovery.js` 中输入临时 `@` 期间，页面外部点击或光标移动可能导致 `APP_PROBE_INTERRUPTED`。现在只关注实际编辑框的文本动作/删除标记动作；真实输入/粘贴仍中止。新增 `tests/app-discovery-ownership.test.mjs`，修复前 2 项失败，修后 5/5 PASS。
6. **未送出的插件自有草稿被 React 重排锁死**：`dom-adapter` 在明确未点击且授权失败时，原先因为 `innerHTML` 改变而不清理自己的草稿，导致下一轮 `DRAFT_CONFLICT`。现在仅在正文/配置完全匹配、无人修改、无工具标记、无附件和无新的原生用户消息时允许清理；任何用户改稿或已有 app 标记均保留，不替用户删除。
7. **同一 app 的嵌套原生标记被当成多个工具**：`dom-adapter.chips()` 只计外层逻辑标记，内层同 ID 的 React 标签不再重复计数；若内层应用 ID 不同则仍以 `APP_ID_UNPROVEN` 拒绝。
8. **Chrome 页面重载误把不明发送判成绑定丢失**：`extension/background.js::watchPendingReceipt()` 收到文档替换导致的 `PAGE_IDENTITY_CHANGED` 时，原先立即回报 `binding_lost`，现改为保留未知结果、持续观察和告警。仍不把文档恢复当作送达证明，**永不自动重发**。新增 BIND22–23；BIND22 修复前失败。

## 边界：不能删的保护

- Session / Conversation / documentKey / tab 所有权、原生消息 ID 与真实一次性租约：不能跨会话拿回执。
- 用户真实输入或编辑过的草稿、实际工具/app ID/模型/思考变化、附件选择：不擅自覆盖或改发。
- 真实路径离开、A→B→A、不同用户消息及已送出但未确认：不能冒认成功或自动补发。
- 目录必须由 ChatGPT 原生证据确认；同名 app 或不同 ID 不能代替。
- 正在生成、权限等待、控制操作可能已修改网页、隐私/凭据/速率/媒体大小边界：保留审慎处理。网页真实忙碌不能强行投递。
- **未解决的固有限制**：Chrome 页面完全替换后若原生送达证据消失，可能仍需人工核对原 ChatGPT 对话；不以宽松猜测消灭不确定性。禁用双发是设计边界而非过度防御。

## 测试和发布状态

- 本次全量 Node 回归：**327/327 PASS**。
- 原生离线 Chrome 编辑器：**27/27 PASS**，包括发送、失败后的安全清理、保护用户改稿、app ID 串用、React 按钮重建以及每条消息只发一次。
- JavaScript/Manifest 语法校验：**488 个文件 PASS**；CoS 来源模块哈希：**12/12 PASS**。
- 关联测试：`tests/late-browser-receipt.test.mjs`、`tests/binding-observation.test.mjs`、`tests/app-discovery-ownership.test.mjs`、`tests/apps-headless.py`、既有 `tests/navigation-ensure.test.mjs` 等。
- 本机未有可用 Python Playwright、项目本地 TypeScript `tsc`，所以并未声称其专属套件/类型检查通过。隔离 Chrome 不是已登录真实账号，**当前没有新版本正式端到端验收 PASS**。

## 下一步（只在安全窗口）

1. 先确认所有正在调用工具/生成回答的 ChatGPT 会话空闲，不使用「Stop」伪装升级成功。
2. 更新 Chrome 已解压扩展到 **0.2.11**；Paseo 仍为 **0.1.0-alpha.4.6**，不强制重启共享 Daemon。
3. 仅使用独立测试 Agent，以新唯一正文验证「首次发送→原生回执→最终完成」「工具切换→准确 App ID」「关页/Chrome 退出→原 Conversation 续聊」；核对原网页后才能判定真实通过。旧结果不明的消息不重发。

此前 0.2.10 新会话 NAVIGATION_CHANGED 的原始复现及修复见 `CIP_0210_NAVIGATION_FALSE_POSITIVE_20261015.md`；Chrome 冷启动恢复见 `CIP_CHROME_COLD_START_RECOVERY_20261015.md`。
