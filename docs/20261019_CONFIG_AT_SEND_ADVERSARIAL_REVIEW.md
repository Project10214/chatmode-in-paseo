# Chatmode · 发送时配置：对抗式审查及复核记录

- 日期：2026-10-19
- 对象：`20261019_CONFIG_AT_SEND_REVISION_PLAN.md` 的**最终用户确认版本**，而不是旧版“每条消息重新读取 ChatGPT 模型”方案。
- 状态：**离线/隔离验收通过的开发候选；真实登录账号与原生已安装 Paseo 0.12.0 的全链路验收未完成；未正式部署。**
- 目标：找出错误模型发送、旧消息被拒收、非本人标签页被接管、`@` 工具丢失、重复原生 Send 等风险。**不把用户已接受的“网页手改模型不自动检测”重新引入为需求。**

## 核心取舍（不再做过度设计）

产品契约：Paseo 改设置只存本地；首次/设置变更/网页文档重新加载才在 Send 中应用模型；后续同一网页文档、Paseo 选择不变时跳过模型选择器。每条消息仍必须携带其工具引用，并经过现有网页身份和一次性 Send 校验。

放弃持续监控/每次无菜单读取、另一个持久 `appliedConfig`、全局配置版本号、自动纠正用户直接在网页上的改模、超过必要程度的定时轮询。

## 9 个独立攻击场景

| 编号 | 优先级 | 攻击与失效 | 防护/证据 | 当前裁决 |
|---|---|---|---|---|
| R1 | P0 | 旧标签页已关闭，用户在 Paseo 改模型立刻 `TAB_NOT_OWNED` | `session.configure` 仅保存 `s.config`，不下发网页命令；首次 Send 才走 open/ensure | **离线 PASS** |
| R2 | P0 | 用户快速切 B 后发送，排队期间再次改 C，旧消息错误地按 C 发送 | 在 `session.prompt` 第一次本地准入中冻结 `clientMessageId` 配置，Store 序列化 | **离线 PASS**（CATS-02 / Provider） |
| R3 | P0 | 旧 Send 已用 A 授权，Paseo 改 B 后 A 的真实回执被拒为 `RECEIPT_UNCONFIRMED` | 正常及迟到回执均与对应 `command.payload.config` 比较，不比较最新 `s.config` | **离线 PASS**（CATS-01、CATS-05；修复前复现 FAIL） |
| R4 | P0 | 提前配置切换失败后仍按旧模型偷偷发出去 | 独立 `configure` 消失；网页模型变化只在本次 Send 的严格准备阶段执行；失败不进入原生点击 | **隔离 PASS**（模型/工具拒绝与未发送测试），真实页面待测 |
| R5 | P0 | 缓存旧模型导致后续再次重复打开选择器，或只改工具却切换模型 | 单文档 `appliedModel`；同一选择跳过模型菜单，选择改变/文档换新后原生选取 | **隔离 PASS**（`config-at-send-browser.py` 5/5），真实网页待测 |
| R6 | P0 | 上条消息携带工具 A，本条工具 mark 丢失或错误沿用 A | 工具清单可缓存，但每条 Send 的 `@` mark 必须重新检查和适配本条冻结 appIds | **隔离 PASS**（app-receipt、native mark 等） |
| R7 | P0 | 当前 tabId 指向别的会话、多个页面争用、原 Conversation 已导航 | 保留 Broker.claim 的租约、Conversation、文档身份、tab 所有权；确认旧标签页真的不存在才重开，不接管陌生页 | **隔离 PASS**（REOPEN/MV3），真实手工页待测 |
| R8 | P0 | Send 已授权/可能点出但页面回执不见，错误自动重发同一正文 | 保留 command 墓碑、唯一 ID、`notSent` 与 receiptPending 分离，结果不明不重试 | **隔离 PASS**（MV3/late receipt/failed-send），真实丢包待测 |
| R9 | P1 | 旧状态含 `pendingConfig`，升级时抹掉正在跑的旧轮次/审批与未确认回执 | `Store.open` 把 pending 作为下一轮期望，保留旧命令 payload 和 lease；协议 9 阻止旧端混用 | **离线 PASS**（CATS-04），在线升级仍受安全窗口限制 |

## 接受的风险，不另做架构

- **网页侧手工修改模型**：在同一脚本实例、路由未变且 Paseo 配置没变时不主动检测。这是用户明确接受的省去重复匹配的范围边界；不能承诺网页任何时候都与 Paseo 绝对同步。
- **页面恢复/登录策略变化**：已加载原生新页面会重新选择，但模型本身不允许切换时仍只能拒发；不降级、不绕过页面规则。
- **工具权限**：真实工具已授权与本条 `@` 标记是两件事。程序保证标记身份和可观测回执，不保证外部授权/工具服务始终可用。
- **自动更新风险**：真实登录测试不允许直接跑在生产活跃 Agent 上；成套升级 CIP 9 / Chrome 0.2.49 前先确认安全窗口。
- **真实宿主版本**：当前 `/Applications/Paseo.app` 是 0.12.0，原版 Metro bundle 哈希不同于已审计的 `0.12.0-beta.2`，原版渲染器全程类测试本次未判 PASS；正式部署前应验证宿主兼容或重新审查。

## 本轮实际证据边界

`npm test`：771 total / 770 pass / 0 fail / 1 skip（可选上游对照）。`check`、`typecheck`、`verify:upstream`、`test:sdk` PASS，固定 beta.2 Host Gate 4/4 PASS。离线真实 MV3 Worker+Runtime+Chrome 6/6 PASS。另有 Browser native picker 快路径 6/6 PASS、恢复/授权/文件/Stop/receipt 等离线回归。见 `../logs/config-at-send-v2-*.log`。

不包含真实 ChatGPT 登录账号发消息、真实账号模型 UI 变化、真实 Plane/开发工具调用或在线插件 0.12.0 宿主兼容性实测。

## 审核结论

**设计及隔离实现：通过。真实安装发布：未放行。** 不再扩展额外缓存/监控；只需在安全窗口做原生安装版本与独立真实对话的最终确认。项目现役线上部署仍为 v8 版本，新 v9 本地候选未替换它。
