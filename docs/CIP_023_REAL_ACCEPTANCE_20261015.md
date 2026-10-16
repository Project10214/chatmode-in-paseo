# CoS in Paseo 0.2.3 / alpha.4.3：真实账号验收记录

日期：2026-10-15 · 实施环境：Penn 的 Mac · **结论：部分 PASS、COSINPASEO-2 FAIL，整体未通过全量验收。**

> 本次实际调用本机 Paseo 0.11.2 + 已登录 ChatGPT 的 Chatmode Provider，另外运行真实 Chrome MV3 隔离浏览器、Node 回归与 Native Messaging 调用。不得将离线模拟网页测试等同于登录账号验收。本轮没有停止、刷新、删除或重新发送任何非验收 Agent 的消息。

## 1. 环境与固定范围

| 项目 | 实际证据 |
| --- | --- |
| 源码候选 | Paseo 插件 `0.1.0-alpha.4.3`、Chrome 扩展 `0.2.3`、网页引擎 `cos-native-alpha4.3`、CIP v5 |
| Paseo App / Daemon | `0.11.2`，Daemon 可达，`paseo plugin ls` 显示 `cos-in-paseo` 为 running |
| 共享 Runtime | `GET /hello` 返回协议 5；生产实例 epoch 与上一版本记录不同 |
| 扩展配对 | Runtime 认证通过；Chrome Native Messaging 隔离实机测试的扩展 ID 与生产已配对 ID 完全一致 |
| Chrome 生产版本 | 用户已确认更新；**因 Chrome 配置目录访问限制，未独立读到生产 Profile 实际加载的 manifest**，故不标记为“精确版本已证明” |
| 并发 | 当前 Runtime 配置上限 3；未超过上限 |
| 验收工作区 | 既有独立工作区 `wks_54c13fdd13424569` |
| 专用 Agent A | `7faef68a-de05-4f44-8950-abad4b10e65e`；Runtime session 尾号 `1007bf0e` |
| 专用 Agent B | `89258009-0460-4234-8123-da3017693907`；Runtime session 尾号 `aec621b3` |

两个 Agent 均使用单独绑定的真实 ChatGPT Conversation；报告不记录完整私人会话 URL 或凭据。

## 2. 分项真实验收

| 场景 | 证据 | 判定 |
| --- | --- | --- |
| T1 基础连接与安全 | 真实 Provider 创建 Agent 成功。未认证 `/recovery-targets` 403，错误扩展 ID 403，外来 Origin 403，正确授权 GET 200，错误 Conversation 的 `/resume-agent` 400 | **PASS（Runtime/Provider）** |
| T2 Paseo 双轮收发 | Agent A 真实发送标记 `CIP_LIVE_023_A/B_20261015`，依次收到 `CIP023_A_OK`、`CIP023_B_OK`。同一个 Conversation、2 条用户消息、2 条回答、恰好 2 次 Send、最终 `idle/completed` | **PASS** |
| T3 网页直接发言→原 Agent | 本轮没有通过 Chrome 页面亲自发起新的验收消息；新版没有额外实机证明，不能借用旧报告 | **NOT RUN** |
| T4 关页与恢复 | **已实测 Agent 进程级恢复：** Agent B `paseo agent reload` 返回 reloaded、持久 Session 和 Conversation 不变、没有新 Send；恢复后新消息获得 `CIP023_AFTER_RELOAD_OK`。**未关闭专用 Chrome 标签触发自动新开页** | **部分 PASS / 关页 NOT RUN** |
| T5 公开思考/工具 | Agent A 切为 high，分别发出 `CIP023_REAL_TOOL`、`CIP023_REAL_TOOL2`（后者显式携带 mymac 应用标识）；两轮均返回 **`NO_TOOL_RESULT`**，没有可信文件读取工具回执，Paseo history `tool_call=0`；但两条公开 `reasoning` 摘要有记录 | **FAIL（真实工具） / PASS（公开摘要出现）** |
| T6 并发隔离 | Agent B 在 Agent A 工具思考期间获得独立 Conversation，收到 `CIP023_PARALLEL_B_OK`。A/B session、tab 和回答互不串扰 | **PASS（基本并发）** |
| T6 Stop 与恢复 | 首次停止请求 `stop:done` 但原轮次恰好 completed，不当作取消成功。第二次用 `CIP023_CANCEL_REAL_20261015` 长轮次触发 Stop 后：**outcome=canceled**、活动卡 `phase=canceled`、没有额外回答；随后 `CIP023_AFTER_CANCEL_20261015` 得到 `CIP023_AFTER_CANCEL_OK`，仍在原 Conversation | **PASS** |
| T7 UI/图片 | 可从真实 Runtime/Paseo CLI 确认文本和 thought timeline，但未完成真实桌面与手机端图片、Markdown、公式、折叠视觉检查 | **NOT RUN** |
| T8 Native Messaging 注册与通信 | 安装记录存在且已验证扩展身份、允许来源和权限；Chrome 本机调用无效指令得到 `INVALID_REQUEST`，没有触发 Paseo 启动，证明进程间通信正确 | **PASS（通信）** |
| T8 Paseo 全进程退出后自动拉起 | 当前仍有 **1 个非验收 Agent 在运行**；为保护它没有退出 Paseo、没有停止 Daemon、没有实际执行有效 `wake` | **BLOCKED（冷启动）** |
| Chrome 扩展真实 update 事件 | 源码/离线测试覆盖 `onInstalled(update)`、只刷新受管标签、唤醒 Agent、乱序升级和重复恢复；没有重载生产 Chrome 扩展或刷新当前活跃其他标签 | **NOT RUN（真实更新事件）** |
| 断网/权限等待/长任务恢复 | 未对真实生产 Chrome 或网络执行故障注入；仅离线对抗夹具覆盖 | **NOT RUN（真实故障）** |

### 工具测试的重要解释

`reasoning` 摘要出现**不能**证明真正的 `mymac` 工具被调用。真实返回的两次 `NO_TOOL_RESULT` 均不能与实际工具回执对应；最终文字不应当作工具成功凭据。

已通过本轮 `mymac.read` 独立确认测试目标 `tests/monitor-gap.test.mjs` 存在且可读，并获得 SHA256 作为对照；但验收 Agent 没有提供工具证据。因此根因可能在网页实际工具选择/授权或事件采集，**目前不能断言一定是工具事件解析器本身失败**。

### 一次性发信与重载回执

- Agent A 最终：4 条测试用户消息、4 条回复、4 次 Send、2 条公开 reasoning、0 条 tool_call；`idle/completed`。
- Agent B 最终：6 条测试用户消息、5 条回复、6 次 Send、2 条已结算 Stop；其中 1 条测试轮取消，故回复数少 1 正常；`idle/completed`。
- 仅重载 **Agent B** 的 Provider 会话；没有产生旧消息重发、没有新 Conversation。
- 会话计数、命令阶段、回答内容均直接来自生产 Runtime 持久 Store，而非模型口头自述。

## 3. 本轮发现并修复：Native Messaging 外接磁盘执行问题

最初 `install-native-wake.mjs` 将 Manifest 的 `path` 指向外接项目磁盘：
`/Volumes/penndisk/.../scripts/native-wake-host.py`。这个位置**在隔离真实 Chrome 中可定位但启动失败**（`Native host has exited`）；同一份 Python 程序直接运行或复制到本机临时目录却可正常处理请求。

**本轮已经修复安装器并实机重新安装：**
- `scripts/install-native-wake.mjs` 现在将小程序原子复制到用户私有本机目录 `~/.cos-in-paseo/bin/native-wake-host.py`（模式 700），Chrome Manifest 仍在标准用户目录（模式 600），且只允许精确配对的扩展 ID。
- 允许将本项目旧版外接盘注册迁移至新路径，拒绝接管不相关 Native Messaging host；不需要常驻服务、sudo、后台监听端口或重启任何 Agent。
- 真实 Chrome 155 使用独立一次性 Profile 加载**项目原版扩展**，将相同已安装 Manifest 映射到临时 Profile；`chrome.runtime.sendNativeMessage` 发送**无效动作**，收到 `{ok:false,error:'INVALID_REQUEST'}`。因此证明通道与拒绝策略生效，同时避免真正启动 Paseo 或干扰他人。
- 可重复实测：` .test-tools/bin/python tests/native-host-chrome-test.py `；仅使用临时浏览器 Profile 且只发送无效动作。Native Messaging 真正冷启动仍未测试。

代码：`scripts/install-native-wake.mjs`、`tests/chrome-wake.test.mjs`；原文件保存在 `.local-backups/native-host-localfix-20261015/`。

## 4. 最新自动化与隔离端到端

| 验证 | 实际结果 |
| --- | --- |
| `node --test tests/*.test.mjs` | **279/279 PASS** |
| `node scripts/check.mjs` | **467 JavaScript / JSON 验证 PASS** |
| `node scripts/verify-upstream.mjs` | **12/12 PASS** |
| `node .test-tools/ui/typecheck.cjs` | **22 文件、0 diagnostics PASS** |
| 解压 Chrome MV3 + 临时 Runtime/Provider + 离线 ChatGPT `collapse`/Markdown 转义 | **11/11 PASS，真实 Paseo SDK 校验** |
| 已注册 Native Messaging Host + Chrome 155 + 一次性 Profile | **PASS（无效操作安全拒绝）** |

这里的 MV3 测试确实运行 Chrome 扩展与实际 Runtime/Provider，但 **ChatGPT 页面是离线夹具**。不能替代上表真实账号 T3/T4/T5/T8 的缺失证明。

## 5. 尚需继续的验收

1. **P0 COSINPASEO-2：** 在真实已登录 ChatGPT 测试页核查公开 `tool_call` 与授权目录，找到首次丢失环节；用两个**确实执行成功的只读工具**验证两个不同 callId 的独立卡片、结果状态和无隐私泄漏。没有真实工具执行证据，不标 Done。
2. **P0 COSINPASEO-1：** 在明确空闲的专用受管 Chrome 标签执行“关闭→Paseo 下一轮→同 Conversation 重开”；再从 ChatGPT 网页真实手动发送唯一验收消息，确认原 Paseo Agent 被唤醒、零额外 Send。
3. **P0 更新恢复：** 在独立或安全窗口实施真实 Chrome 扩展更新，确认只刷新当前仍打开且属于 CIP 的绑定标签页、不影响同 URL 的用户其他标签、原 Agent 自动激活、没有重复发送。
4. **T8 冷启动：** 等所有非验收 Agent 可靠空闲后，专门演练真正退出 Paseo App/Daemon、保持 Chrome 在线，通过本机 Native Messaging 有效 `wake` 自动启动并恢复；与本轮已经通过的“Chrome↔Host 通信”分别记录。
5. **体验与压力：** 补桌面/手机端展示、附件/图片、网络故障/权限等待、长任务的真实验收。

**本轮收尾：** 两个验收 Agent 最终均为 idle；共享 Runtime 仍存在 1 个非验收 Agent running。没有主动重启共享 Runtime、关闭用户网页、清锁或批准 ChatGPT MCP 权限。COSINPASEO-1、COSINPASEO-2 均保持 In Progress。
