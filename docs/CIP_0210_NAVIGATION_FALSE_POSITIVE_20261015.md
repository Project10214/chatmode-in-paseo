# 2026-10-15 · Chrome 0.2.10 新会话 NAVIGATION_CHANGED 修复

## 实机问题

在 Chrome 0.2.9、Paseo 0.1.0-alpha.4.6 更新后，用户创建新 Chatmode Agent，首次发送“你好”时报 NAVIGATION_CHANGED。23:04:01 本机 Runtime 状态为：该会话 `open` 命令 failed/NAVIGATION_CHANGED；`tabId=null`、没有绑定 Conversation，也没有发送命令。此前同类问题至少发生两次（22:43），说明首次网页配置路径存在重复误判。

## 根因

`extension/content.js` 在 ChatGPT 网页的导航事件监听器中，每收到 `navigate` / `currententrychange` 就递增 `navigationEpoch`。即使页面实际 URL 和 Conversation 完全没有变化，`open` / `configure` 也曾将这个计数变化判断为 `NAVIGATION_CHANGED`。

前一轮已修复配置时的误判，但 `send` **在原生点击发生之前**仍严格检查 `navigationEpoch`，因此新会话可能出现“配置通过、首次 Send 又失败”的残留问题。

## 修复

- 用已经维护的 `routeEpoch`、`pathEpoch` 判断真实路径/对话离开。对于 `open` / `configure` / `catalog` / `ensure`，以及 **Send 尚未执行原生点击的阶段**，同一页面反复触发导航事件不会构成拒绝。
- 真正路径或 Conversation 离开仍拒绝，包括 `/ → /c/B → /`、`/ → /search → /`、`/c/A → /c/B → /c/A`。
- Send 原生点击仍须通过授权、一次性发送、精确正文、文档/对话所有权与回执验证。点击后由原有 `committedRoute` 锁定第一次创建的 Conversation，随后转到其他对话一律 `SEND_LIFETIME_REVOKED`。
- Stop 不变；不放开异文档、异会话、工具权限或重复发送边界。

## 验证

`tests/navigation-ensure.test.mjs` 增加 NAVOPEN1–3、NAVCONF1–2、NAVSEND1–4。修复前 NAVSEND1 和 NAVSEND3 实际失败；修复后导航、回执及重复发送相关专项 20/20 PASS。全量 Node 回归 **315/315 PASS**；静态语法/Manifest **487 项 PASS**；CoS 上游模块 **12/12 PASS**；隔离真实 Chrome 编辑框 **13/13 PASS**。测试证据不代表登录 ChatGPT 的真实对话发送成功。

新版源码候选 Chrome **0.2.10**，Paseo 仍为 **0.1.0-alpha.4.6**，CIP v5 / 原生引擎保持不变。

**部署状态：本次没有操作生产 Chrome 插件、没有重启 Paseo、没有给真实 ChatGPT 发任何消息。只有源码和离线测试通过；必须在空闲时更新 Chrome，之后再用原 Agent 的新唯一消息进行真实回执验收。**
