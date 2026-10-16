# COSINPASEO-1｜绑定优先恢复与双端自动唤醒（2026-10-15）

## 决策

**已绑定的 Agent 就足以决定重新打开哪个 ChatGPT Conversation。** 上一条原生用户消息 ID 不再是“开标签页”的前提；消息去重放在一次性 Send 指令、持久 clientMessageId、回执及轮次身份上。若页面仍在生成、无法验证发信回执或未授权，仍不能冒险重发或宣称成功；这些都是系统内部安全判断，不是要求用户管理的操作条件。

## 实现（未更新生产进程）

- `server/broker.mjs`：Ensure 只验证绑定 Conversation 及配置；旧 ID 保留作为历史提示，不再用于拒绝重新打开原会话，也不自动将未同步的新网页轮次认领为旧 ID。
- `extension/background.js`：原 tab 已关闭或打开了其他对话时，新建后台标签打开**原绑定 URL**，不修改或接管旧标签；内容脚本已更新后才继续。`extension/content.js` 不再因旧原生 ID 不同拒绝 Ensure。
- `server/chrome-wake.mjs` + `server/provider.mjs`：Paseo 从绑定 Agent 发送前发现 Chrome 扩展离线时，macOS 使用 `open -g -a Google Chrome` 拉起现有 Chrome 应用，等待已配对扩展实际恢复心跳，**在此之前不入 Send 队列**。一次启动共享给并发请求。
- `scripts/native-wake-host.py` + `scripts/install-native-wake.mjs`：Chrome Runtime 不可达时，由后台通过 `chrome.runtime.sendNativeMessage` 唤起本机 Paseo 应用。Native Messaging 主机仅允许当时已配对的扩展 ID，且只接受固定 `{v:1,action:'wake'}`，不接收任意 shell、URL 或消息正文。仅网络不可达触发，认证错误/协议不兼容不触发，带 60 秒冷却。
- `extension/manifest.json` 增加 `nativeMessaging` 权限；版本候选 Paseo `0.1.0-alpha.4.2` / Chrome `0.2.2` / engine `cos-native-alpha4.2`，桥协议仍为 CIP v5。新 engine 防止旧内容脚本与新后台混用。

## 当前验证

- Node 全量 **268/268 PASS**；新增关页无旧 ID、错 URL 不接管、后续新 ID 不阻塞、重复事件不重发、并发唤醒去重、Native Host 权限边界等。
- 离线真实 Chrome MV3 + Runtime + Provider：普通 **10/10 PASS**；公开 `collapse` + 消息转义 **11/11 PASS**，后者实际启用安装的 Paseo SDK 合约。
- `node scripts/check.mjs`：460 JS/JSON 检查通过；CoS 来源核验 12/12；TypeScript **22 文件、0 错误**。
- Native Messaging host 的清单安装在临时目录执行测试通过，固定指令 Python helper 测试通过；**没有将真实 Chrome 或 Paseo 全部关闭来测试启动**。

## 部署门槛（未做）

当前仍有其他 Agent 运行，**没有重启 Runtime、刷新活动标签、安装 Chrome Native Host 或将 0.2.2 装入真实 Chrome**。因此真实自动唤醒仍处于 **NOT RUN**。

在所有工作轮次结束的安全窗口：
1. 运行 `npm run install:native-wake`，注册本机已配对的 Chrome 扩展 ID（macOS 用户目录）；确认对应 Chrome 扩展已加载 `nativeMessaging` 权限。
2. 成套重载 Paseo/Chrome 新候选版，刷新**仅空闲**的绑定测试页。
3. 验证：关页→Paseo 发送→原 URL 重开→一次 Send；Chrome 完全退出→Paseo 发言自动启动；Paseo 后台退出而 Chrome 活跃→网页发言、Native Host 启动 Paseo 并同步同一 Agent。最后核对回执、终态与工具状态。

Chrome 与 Paseo 都完全退出、也没有任何正在运行的触发端时，不会凭空自行发起恢复；那需要登录启动项等独立机制。外部 MCP 的执行结果仍须在对应系统核对。

**当前 COSINPASEO-1：代码与隔离测试已通过；真实自动唤醒验收尚未完成，继续 In Progress。**
