# Chatmode in Paseo 架构与边界（CIP v8）

适用：Paseo 插件 `alpha.4.44`、Chrome 扩展 `0.2.48`。端点与安全校验见 [PROTOCOL.md](PROTOCOL.md)，真实验收入口见 [TESTING.md](TESTING.md)。

## 1. 一套 Provider、一套 Runtime、一个 Chrome 扩展

```text
Paseo Agent ↔ Provider（server/provider.mjs）
                    ↓               ↑
            Broker / Store（state.json）
              ├─ 单次 Send 命令、租约、停止、权限动作
              ├─ 已绑定对话的观察身份及网页控件状态
              └─ 公开来源账本、投影、交付游标
                    ↕  CIP v8 · 127.0.0.1:17843
             Chrome MV3 background
                    ↕ 隔离脚本 / 公开 MAIN 阅读器
                ChatGPT 网页 / 已授权 @ 应用
```

- 不启动 CoS 桌面主程序，不代理 Paseo 内置 MCP 凭据。ChatGPT 工具执行走网页已授权的 `@` 应用。
- Chrome 与本机 Paseo 后台在同一主机；远程 Paseo 客户端只与宿主通信，不直连本机桥接端口。
- 浏览器 worker 保存扩展配对凭据；网页脚本只观察公开来源、按钮和授权卡。通过 tab、document、Conversation 与 lease 限制归属。

## 2. 发送、持久状态与恢复

- `session.open` 先保存独立配置，首条真正的 prompt 才打开新对话页；后续使用已绑定 Conversation URL。
- Send 经 `queued → claimed → authorized → result`，授权点击是一次性的；同 ID 和未知回执不自动重发。页面控件是否运行、已完成正文是否可读，都不能单独证明送达。
- 已知未发送：Runtime 在事务中记下未认领事实并销毁未发送命令正文；Chrome 在服务端确认 `notSent` 后清除自己的副本、保留最小 ID/状态防重放。应答丢失只重试未认领确认，不执行网页 Send。
- 在保留对话绑定的情况下，观察通过新的 observationLease 与 generation 重建。旧标签 ID 或相似文本不能认领其他对话。
- Stop 只点击当前可见且可用的网页 Stop；是否完成由后续可见按钮状态判断，无法证明外部已启动的 MCP 进程被停止。归档仅在安全边界内尝试关闭闲置标签，历史移入 archive 文件。

## 3. 持续公开内容采集

- `extension/page-content.js`、`public-message-main.js` 等模块收集公开文本、工作过程、工具卡、图片和授权卡。隐藏/private/analysis 来源不应作为公开回答回传。
- 正文、网页状态与权限各走独立入口，读不到一项不能伪造另一项的完成/失败。来源使用精确身份、版本与排序信息持久保存。
- `server/source-ledger.mjs` 和 `source-prose.mjs` 保持来源内容与展示投影分离，拒绝把已发布的非前缀修改强行拼接为新正文。
- Provider 根据宿主接口交付公开来源。**本机持久化与 Provider 已发送，不等于 Paseo 已保存或自动化能读取原生最终回答。**原版宿主在 pending 新轮次期间仍有归轮与事件缓存的限制，详见 [宿主并发交付边界](HOST_CONCURRENT_DELIVERY_GATE.md) 和 [实施记录](FAITHFUL_SYNC_IMPLEMENTATION.md)。

## 4. 权限与数据保护

- 手动授权需要来自 Paseo 的明确允许/拒绝选择，同一授权卡及当前页面重新验证后才点击。
- 设置页另有可选的自动允许开关，**默认关闭**。开启时，当前实现可能选择网页的持久授权；这项策略尚未在本轮审查中收紧，切勿把它解释为「仅允许一次」。
- 本机 Runtime 仅绑定 `127.0.0.1`，验证 Host、Origin、extensionId、token、消息大小与次数；不对网页提供通用 Shell、文件系统或开放代理权限。
- `~/.chatmode-in-paseo/` 的本地状态和配对凭据受文件权限保护，但未加密。不要同步到公开仓库或测试日志。

## 5. 已知限制与验收层级

Node 测试、SDK schema、离线 Chromium 与 MV3 夹具，只能证明相应模拟场景。真实 ChatGPT 网页、多并发、登录账号切换、后台页面休眠、外部 MCP 实际结果、Paseo 宿主冷启动等仍须分别实机验收。**不要把流水线通过写成正式生产放行。**

旧版 CIP v5 的 `/event`、`/active`、`/bindings`、`/external-turn` 等入口已经移除；不要再据旧架构图实现新适配层。CoS 移植函数及版权来源见 [vendor/cos/README.md](../vendor/cos/README.md)。
