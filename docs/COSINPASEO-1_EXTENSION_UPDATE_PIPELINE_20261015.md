# COSINPASEO-1｜Chrome 扩展更新后的标签刷新与 Agent 激活流水线

日期：2026-10-15 · 状态：**源码候选已实现；未进行真实账号的“扩展更新→运行中轮次恢复”验收**。

## 产品决策

用户提出并确认：**扩展一更新，自动刷新已打开且属于该插件绑定的 ChatGPT 对话标签，之后自动唤醒/激活对应 Paseo Agent 的原有观察流水线**。不需要用户打开 Agent 再点一次，也不重发已发送或结果不明的消息。

仅刷新由 Runtime 的持久 Session→Conversation→tabId 与扩展自己的 tab 归属**共同确认**的标签；不动用户另外打开、未被此插件管理的 ChatGPT 标签。若标签已经关闭，不为更新而新建标签（下次新消息仍走原有 Conversation 恢复）。

## 本轮实现

- **Chrome MV3**：`extension/background.js` 检查 `chrome.runtime.onInstalled` 的 `reason==='update'`，登记持久 `upgradeRecovery` 任务；普通 install/startup 不擅自全量刷新。MV3 worker 暂停后继续读取保存的任务。
- **检查绑定**：新 `GET /recovery-targets` 由 `Broker.recoveryTargets()` 按持久绑定返回最少必要字段，不传聊天正文/凭据；Chrome 同时核对自己记录的 tab 归属与真实 ChatGPT Conversation URL。
- **先刷新，后激活**：通过 `chrome.tabs.reload` 重载确证的现存标签；待 `content.js` 报告当前引擎和文档身份，再调用新 `POST /resume-agent`。它只复用项目已有 `createWakeCoordinator().wake(sessionId)` 机制，不会创建 ChatGPT Send 或 Paseo 新轮次。正常 `/active`、`/bindings` 观察随后重绑页面并继续读取可见进度、答复与可信终态。
- **顺序更新兼容**：如果 Chrome 先升级而 Paseo Runtime 还未升级，暂用旧版已有 `/active`、`/bindings` 清单刷新；激活请求保留为待办，等 Runtime 新版加载后继续，不需要重复刷新。
- **并发与失败**：每个标签独立记录待刷/刷新请求/待激活/完成；有限重试，避免刷新风暴；其中一个标签失联不会阻断其他 Agent 的原有命令。所有步骤只涉及页面刷新与观察唤醒，绝不重发已进入网页的旧消息。

### 版本

候选 Paseo `0.1.0-alpha.4.3`、Chrome `0.2.3`、网页引擎 `cos-native-alpha4.3`，CIP 桥协议 `v5` 不变（仅增加认证后的可选恢复接口）。旧版本生产脚本不会自行变成新版。

## 实测证据（隔离环境）

- Node **278/278 PASS**，含升级恢复专项 10 项：仅刷归属正确标签、普通安装不刷新、错页不接管、worker 重启不重复刷新、缺新版脚本有限重试、重复绑定防重复、其他 Agent 不受故障标签影响、Chrome 先升级时待新版 Runtime 再激活、连续版本更新重建计划，以及 Runtime 认证与绑定验证。
- **真实解压 MV3 Chrome + 临时 Runtime/Provider + 离线模拟 ChatGPT 页面**：`tests/binding-mv3-flow.py` 11/11 PASS，已加载 Paseo SDK 校验；证明原有发送/重载观察通路没有回归。**不是实际登录 ChatGPT 的更新演练**。
- `scripts/check.mjs`（465 JS 文件和 JSON）、`verify-upstream.mjs`（12 个 CoS 移植模块）、TypeScript（22 文件、0 错误）全部通过。

## 尚未证明的范围与风险

1. **刷新是页面级中断。** 浏览器重新载入活跃 ChatGPT 对话，可能使当时网页正在进行的生成、授权等待或工具交互中止；新的观察脚本只能恢复网页重载后确实还存在的可见状态，不能保证每个外部 MCP 任务会继续执行。原轮次结果未知时保持不确定、不得猜测已成功。
2. 本轮没有在**真实安装的扩展“update”事件**下验收 Chrome→新版脚本→Paseo UI 一整条流水线；单元测试确实模拟 `onInstalled(update)`，MV3 实机夹具测试的是普通安装和刷新恢复。
3. 如果 Paseo host API 尚未给 `createWakeCoordinator` 提供上下文，服务会保留唤醒待办，等有宿主生命周期事件后继续；HTTP `queued:true` 不是“Agent 已激活成功”的回执。若需要完全无用户触发的冷启动验收，应对这一路径进一步实测并补接口。
4. 当前电脑仍有其他正在执行的 Agent，因此**没有安装新版本、没有主动刷新其真实标签页、没有强制重启共享 Daemon/Runtime**；这次不会拿生产会话冒险验收首次接入更新功能。

## 下一步真实验收

1. 在一次安全的初始部署窗口成套更新到候选版本，确认实际 Chrome 扩展已装载和 Runtime 的新路由可用。
2. 启动专用 Chatmode Agent 的长轮次，保持它的绑定 ChatGPT 标签打开；触发 Chrome 扩展版本更新，观察页面是否只刷新一次、新 content script 是否生效、原 Agent 是否被自动唤醒、时间线是否继续或诚实标不确定。
3. 同时保留第二个已绑定 Agent 和一个**与插件无关的** ChatGPT 标签，确认不串 Agent、不刷新无关标签、不重复发送；再测 Chrome/Paseo 先后升级及 worker 暂停恢复。
4. 检查发信次数、旧轮次新旧文档 ID、最终状态、实际外部工具回执。合格后才能把 COSINPASEO-1 更新恢复标记 Done。

**结论：** 本次已实现用户要求的自动刷新/唤醒源码链路，仍属于待真实更新验收的候选版本。
