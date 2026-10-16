# COSINPASEO-3：回滚原生单选工具入口（2026-10-15）

## 用户指令与结论

用户明确要求“回滚到上一个单选版本”。在不修改 Paseo 宿主前提下，恢复 `0.1.0-alpha.3.15` 的单个原生 `ProviderSetting.select` 工具下拉。取消“＋ 添加 / ✓ 移除”菜单和 `alpha.3.16` 自定义多选 Composer Pill，亦不再开发新建工作区工具按钮与 `@` 原生注册。**这次为旧版本的行为、协议和显示版本回退；并不声称整个目录（尤其历史文档、回滚备份和测试用例）逐字等于 alpha.3.15 的归档包。**

## 回退明细
- `server/provider.mjs`：还原唯一 `settings:[{type:'select',id:'app:quick',label:'工具',...}]`，只提供无工具、单个已授权应用、所有已授权应用、保存的常用组合和当前自定义组合保留项；旧的 `app:<id>` 布尔兼容仍保留。撤去多选增删命令、Composer RPC session 工具配置路径，以及多选引入的共享配置提交路径。
- `index.client.tsx`、`index.server.ts`、`shared/rpc.ts`：移除新 UI 注册和 `bridge.session-tools` / `bridge.save-session-tools`。
- 移除只服务于该 UI 的 `client/tools-pill.tsx`、`client/tool-identity.mjs`、`server/tool-selection.mjs` 和专属测试。`.test-tools/ui` 的测试宿主撤销相应模拟。
- `server/broker.mjs`、`server/slots.mjs`：撤回 alpha.3.17 的新预发送恢复状态分支，恢复 alpha.3.15 的阻断语义，避免改变既有未确认消息的保护。
- `extension/dom-adapter.js`、`extension/app-discovery.js`、`extension/manifest.json`：恢复旧版受控 `system_hints` 监听，不再执行原生 `@` 菜单备用发现。旧 `app-menu.js` 仅是未加载的历史参考。
- `package.json`、Chrome manifest、网页扩展与 Runtime 的引擎 ID、插件设置页文案和 README 恢复到旧版版本标识。

**重要安全边界：** 没有读取/迁移/删除生产 `~/.cos-in-paseo` 数据、Chrome 用户资料、个人会话、凭据，也没有重载用户正在运行的 Paseo/Chrome 插件或发送任何真实消息。唯一创建的备份为源码中的 `.local-backups/before-single-rollback-20261015.tgz`，包含回滚前 30 个受影响文件。历史 `alpha.3.16/3.17` 文档继续保留为已废弃实现的审计材料。

## 回滚后验证（均隔离）
- 全量 Node：**224/224 PASS**，包含单个 `select`、无工具/单工具/全部/常用组合、模型保留、不同会话隔离和多选 `add:/remove:` 指令拒绝。
- 真实 Paseo **0.11.2** SDK 协议契约：**1/1 PASS**；TypeScript **19 文件 / 0 diagnostics**。
- `scripts/check.mjs`：**405 个 JS + JSON manifest/权限检查通过**。
- `scripts/verify-upstream.mjs`：**12 个 CoS 来源移植模块及加载清单核验通过**。
- 真 Chrome MV3 扩展、Service Worker、临时 Runtime/Provider、模拟网页：**8/8 PASS**，含原生单选、首次发送、恢复、跨会话隔离。
- 浏览器应用发现正反例：**11/11 PASS**，包括无确证列表时拒绝发送、未经授权 ID 拒绝以及用户草稿不被误清理。
- UI 夹具 bundle 编译成功。
- 这些验证**不是用户真实 ChatGPT 登录账号端到端验收**。

## 用户手动生效步骤（待空闲）
1. 确认正在执行的 Paseo/ChatGPT 轮次都已经安全结束；如果某条消息结果不明，先核对网页，不要重发原消息。
2. 重新加载 **Paseo 插件 alpha.3.15** 和 **Chrome 解压扩展 0.1.17**，随后仅刷新**空闲**的 ChatGPT 标签页。两边代码引擎均须显示 `cos-native-alpha3.15`。
3. 在已有 Chatmode 会话核对只出现一个 Paseo「工具」下拉；在**新会话**选择一项已授权应用，用新消息测试发送/回传。新建工作区不再提供多选入口；若要默认多个工具可在插件配置页维护组合。

**结论：** 本地源码回退已完成并通过隔离回归；实际已安装版本和真实账号验收仍需用户在空闲时执行重载/检查。多选功能开发任务应取消而不是标记为已交付。
