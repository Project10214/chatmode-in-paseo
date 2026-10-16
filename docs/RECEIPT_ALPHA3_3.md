# alpha.3.3：网页已发送但 Paseo 未确认回执

## 结论与范围

已修复并离线验证一个与本次故障相符的代码缺口：新式 ChatGPT 网页使用 `entry.turn.items` / `turn.items` 表示公开消息；旧实现只读 `turn.messages` / `allMessages` 及有限 DOM 属性，可能读不到原生用户消息编号，返回 `RECEIPT_UNCONFIRMED`，从而无法绑定对话和开始回传回答。

这是代码与离线回归结论，不是已完成登录账号上的验收。本次没有重发原消息、清理生产历史、重置配对凭据、解除旧会话阻断或自动启用 Chrome AppleScript JavaScript 权限。

## 实际证据

- 用户截图：ChatGPT 已收到含项目上下文的 `hi` 并给出回答；Paseo 显示 `RECEIPT_UNCONFIRMED`。
- 本机 `~/.cos-in-paseo/state.json`：两个 send 命令为 failed，原生用户消息 ID 与 conversationId 尚未绑定；对应 open 命令已完成。模型/应用目录已有成功记录。
- 修复前复现：`tests/receipt-shell-browser.py` 使用 CoS 源码描述的原生 typed shell 结构，公开消息读取为 `[]`。失败原样记录在 `docs/evidence-alpha3-3/receipt-before.log`。
- 修复后：同一测试通过，新增覆盖首条消息、第二轮、多应用标记、旧消息编号、正文不匹配、刷新后的身份读取、隐藏页面、冲突和超大内容。所有测试只操作离线夹具，不发送真实账号消息。

## 源码比对与改动

参考 CoS 提交 `e40562640361ca8f74158b2262ca8c555b00abed` 的 `extension/fiber.js`，原版已实现 `shellTurnSource`、`messagesFromTurnView` 和精确 local/server 会话关系。原版函数明确要求公开用户消息编号；`final_answer`、item completed 与 turn complete 同时成立才能确认最终回答。

本版新增 `extension/upstream/cos-shell-public.js`，直接移植必要函数并裁掉工具/媒体内容；保留原 MIT 版权和来源清单。`cos-picker-main.js` 现在优先读取对应 typed source，再使用原有 legacy 分支。不能从另一条缓存会话、同名内容或单独 URL 推断身份。

`dom-adapter.js` 和 `content.js` 修复冷启动/页面刷新后还没有配置模型时的原生消息读取。身份询问先刷新公开消息，再验证文档和导航代次，防止使用旧消息编号。

增加受限 `receipt` 诊断：是否实际点击、是否取得原生消息、数量和固定拒绝原因。`server/runtime.mjs` 输出 `[CIP send]` 结果；不记录正文、URL、工具输出或凭据。发送结果不明依然阻断，不自动重发。

## 验证结果

| 检查 | 结果 | 证据 |
|---|---|---|
| 全部 Node 测试 | 110/110，通过 | `evidence-alpha3-3/node-tests.log` |
| 原生 CoS 函数浏览器检查 | 16/16 | `native-transplant.log` |
| 普通浏览器夹具 | 7/7 | `browser-fixture.log` |
| 目录发现 | 8/8 | `discovery-browser.log` |
| 应用列表观察 | 9/9 | `apps-headless.log` |
| DOM 对抗检查 | 9/9 | `dom-audit.log` |
| Provider + Runtime + 页面联动 | 9/9 | `browser-provider-flow.log` |
| 新式消息回执回归 | 14/14 | `receipt-shell-browser.log` |
| CoS 来源与清单校验 | 7 个活跃模块通过 | `upstream.log` |
| JavaScript/JSON 检查 | 通过；扫描也包含测试工具与备份 | `check.log` |

以上浏览器检查合计 72 项，使用 Chrome 的离线页面；Chrome tab API 部分由夹具模拟。不是登录 ChatGPT 的完整 MV3 / Paseo 安装验收。完整 SDK 类型检查本轮未执行。

可在项目目录重跑：

```sh
export PATH=/opt/homebrew/bin:$PATH
node --test tests/*.test.mjs
node scripts/verify-upstream.mjs
CIP_CHROMIUM='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
  .test-tools/bin/python tests/receipt-shell-browser.py
```

## 生效与实机验收

磁盘版本：Paseo 插件 `0.1.0-alpha.3.3`；Chrome 清单 `0.1.5`，显示名 `0.1.0-alpha.3.3`；网页 engine `cos-native-alpha3.3`；CIP 仍为 v3。需要一起重载两个插件，并刷新旧 ChatGPT 页面。无需重新配对，不要删除 `~/.cos-in-paseo/`。

旧会话的错误记录保留，不自动恢复成成功。原 `hi` 已在网页出现，不应重新发送。重载确认版本后，用一个新的测试会话发送唯一标记，例如 `只回复 RECEIPT_V3_3_OK，不调用工具。`，验证回传；再在同一个会话发送第二条，验证沿用同一网页对话。发生失败时读取新的 `[CIP send]` 和 receipt 诊断，而非继续重复点击。

本次只修订指定开发机上的本项目，未提交 GitHub，也未修改其他项目代码。
