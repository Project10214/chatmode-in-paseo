# Chatmode in Paseo

> 原名 **CoS in Paseo**，2026-10-16 更名为 Chatmode in Paseo。Formerly named *CoS in Paseo*.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE) [![CI](https://github.com/Project10214/chatmode-in-paseo/actions/workflows/ci.yml/badge.svg)](https://github.com/Project10214/chatmode-in-paseo/actions/workflows/ci.yml)

**中文** · [English](#english-summary) — 在 Paseo 中创建 Chatmode Agent，由本项目的 Chrome 扩展驱动 ChatGPT 网页收发消息，无需 CoS 桌面应用。当前为 **alpha**。欢迎通过 [Issue](https://github.com/Project10214/chatmode-in-paseo/issues) 反馈问题、通过 Pull Request 贡献代码（中英文均可），见[贡献指南](CONTRIBUTING.md) · [安全策略](SECURITY.md) · [许可证：MIT](LICENSE)。含源自 [Chat On Steroids](https://github.com/totec448-spec/chat-on-steroids)（MIT）的移植代码，见[第三方声明](THIRD_PARTY_NOTICES.md)。

<a id="english-summary"></a>
**English summary** — Chatmode in Paseo is a [Paseo](https://paseo.sh) plugin plus a Chrome extension that lets a Paseo "Chatmode" agent talk to the ChatGPT web UI directly, without the CoS desktop app. It is **alpha** software. Issues and pull requests in English or Chinese are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md) and [LICENSE](LICENSE) (MIT). Portions adapted from [Chat On Steroids](https://github.com/totec448-spec/chat-on-steroids) (MIT) are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Requirements: Node.js ≥ 22.6, Chrome and the Paseo daemon on the same machine, Paseo SDK 0.12.0-beta.1 (unreleased candidate). The rest of this README is in Chinese; see [docs/PRODUCT_MANUAL.md](docs/PRODUCT_MANUAL.md) for the product manual and [docs/TESTING.md](docs/TESTING.md) for testing.

在 Paseo 创建 Chatmode Agent，按网页实际观察选择模型、思考强度和 `@` 应用；本项目的 Chrome 扩展发送消息并回传可见回答。开发机文件和终端操作继续使用 ChatGPT 中已经接入并授权的 MCP。

**状态：alpha。** 版本以 `package.json`（Paseo 插件）和 `extension/manifest.json`（Chrome 扩展）为准，协议为 CIP v5。Node 单元/集成测试与 CI 已通过；浏览器（MV3）回归测试需要本地 Chrome 环境，见[测试与验收指南](docs/TESTING.md)。真实已登录 ChatGPT 账号上的端到端验收尚未全部完成，现状与已知限制见[产品说明书](docs/PRODUCT_MANUAL.md)。

**主要能力：**

- 在 Paseo 的 Chatmode Agent 中收发消息，回传 ChatGPT 对用户公开的回答、思考摘要与工具调用过程。
- 设置页选择模型、思考强度与已授权 `@` 应用；Agent 输入区保留 Paseo 原生「工具」单选下拉（无工具 / 单个应用 / 全部应用 / 常用组合）。
- 1–8 路并发（默认 2），超额请求按顺序排队；同一会话串行。
- 图片与文档附件（最多 4 个）**先于正文**粘贴进 ChatGPT 的输入框，与用户粘贴文件走同一条原生路径，不使用任何文件控件；确认每个文件的移除按钮、精确文件名且上传完成后，才写正文并点 Send。未发送的失败只移除插件本次加入的附件与正文（真实账号端到端发送仍待专项验收）。
- 关闭标签页后，凭已绑定的 Conversation 重开原对话继续；Chrome 扩展更新后自动刷新本插件管理的已绑定标签并唤醒原 Agent（刷新可能打断网页正在执行的步骤）。
- **明确未发送即作废**：清除插件本次写入且未被用户修改的正文和 `@` 标记，释放临时附件，丢弃本地待发送副本；保留最小消息 ID/指纹防止重放。不删除其他历史、用户修改的草稿或发送结果不明的证据。
- **绝不自动重发**送达结果不明的消息，也不自动批准工具授权。

## 1. 判断：包含哪些东西

```text
Paseo 界面 / Agent
     ⇅ 原生 Provider 协议 v1（不是 ACP）
Paseo 插件 + 一个共享 Runtime
     ⇅ CIP v5 · http://127.0.0.1:17843
本仓库 Chrome 扩展
     ⇅ 网页操作与观察
ChatGPT 网页 / 模型 ──已授权 @ 应用──→ 开发主机 MCP
```

两个插件都在本仓库：**项目根目录是 Paseo 插件；`extension/` 是 Chrome 插件；`server/` 是共享运行代码。**并发默认 2，可在设置页调整为 1–8；超额按顺序等待，同一会话串行，不会把设置套到其他会话。

本版是**函数级复制、裁剪和适配**，不是整个 CoS runtime 搬迁。12 个模块保留 CoS 的原生编辑、发送、正文回执比较、模型、应用列表、公开消息和图片读取核心；Provider、共享服务、标签页归属和多应用选择仍有本项目适配。应用列表通过原生 `system_hints` 观察流程获取，失去确证时拒绝发送，不猜测工具身份。来源、原函数名和改动见 [移植清单](vendor/cos/README.md)。

创建 Paseo 会话时只保存配置；**首次发送时**才创建独立 ChatGPT 标签页。后续只凭已绑定 Conversation 自动打开原对话，旧消息 ID 仅用于独立去重/追踪而不阻止开页；目录刷新使用单独临时页。

原版 CoS bridge 14、CIP v1/v2/v3/v4 与本版不兼容。**协议与引擎：CIP v5、Provider v1、浏览器/Runtime 引擎 `cos-native-alpha4.3`；插件与扩展的版本以 `package.json`、`extension/manifest.json` 为准。** 已有生产插件不会随源码更新：首次加载新版本应选择安全窗口。**此后 Chrome 扩展的版本更新**将自动刷新本插件管理的已打开对话页面、重建采集脚本并请求激活原 Paseo Agent；升级过程中结果不明的旧消息绝不自动重发。

| 位置 | 内容 |
| --- | --- |
| `index.server.ts`、`index.client.tsx`、`paseo-plugin.json` | Paseo 插件入口 |
| `client/`、`shared/` | 设置页面和类型化调用 |
| `server/` | 会话、持久队列、回执、停止和身份管理 |
| `extension/` | Chrome 后台、网页适配和配对弹窗 |
| `tests/` | 原有测试、对抗回归、双会话浏览器夹具、真实 SDK 契约测试入口 |
| `docs/` | [产品说明书](docs/PRODUCT_MANUAL.md)、[架构](docs/ARCHITECTURE.md)、[协议](docs/PROTOCOL.md)、[测试与验收指南](docs/TESTING.md)、[上游依据](docs/UPSTREAM.md)、[CoS 复用比对](docs/UPSTREAM_REUSE_AUDIT_20261016.md) |
| `vendor/cos/` | CoS 移植来源清单、哈希记录与许可证 |

## 2. 执行：安装或替换

### 环境与检查

Chrome 与 **Paseo 后台必须在同一台开发主机**；Paseo 手机端可以远程连接该后台。本机服务不应公开到局域网或公网。使用 Node.js 22.6 以上。SDK目标是 `0.12.0-beta.2`；宿主范围为 `>=0.11.4`（2026-10-18 起放行之后所有版本，含 beta；Paseo 重启会自动升级）。协议版本协商与已安装 SDK 的事件格式校验会把接口变化变成明确报错；每次 Paseo 更新后再按 [新版兼容核查](docs/PASEO_012_COMPATIBILITY.md) 补做审计。已对照0.11.4与0.12.0-beta.1的加载/重载时序；[新版兼容核查](docs/PASEO_012_COMPATIBILITY.md)不等于整个版本范围或真实账号工作流已通过。当前候选仍未通过旧连接恢复门禁（OBS-P1）；[并发交付](docs/HOST_CONCURRENT_DELIVERY_GATE.md)已按“到达顺序显示、不丢不重”的契约在插件侧修复，迟到旧正文归轮为已知限制，不可按“统一修复完成”发布；最新实现/验收状态见[实施进展](docs/FAITHFUL_SYNC_IMPLEMENTATION.md)。

```sh
cd /absolute/path/chatmode-in-paseo
npm run check
npm run verify:upstream
npm test
npm install --ignore-scripts --no-audit --no-fund
npm run typecheck
npm run test:sdk
```

前三条无需下载依赖；后三条需要先安装上述固定版本的开发依赖，它们只用于类型检查和测试，不参与生产插件加载。各类改动该跑哪些测试，见[测试与验收指南](docs/TESTING.md)。

### 首次安装

```sh
paseo plugin install /absolute/path/chatmode-in-paseo
```

在 Paseo 的 **Settings → Plugins → Chatmode in Paseo → Chatmode 配置** 打开设置贡献，生成一次性配对码。在 Chrome 的 `chrome://extensions` 开启开发者模式，选择“加载已解压的扩展程序”，指定本项目 `extension/`。登录自己的 ChatGPT 账号后，在扩展弹窗填写设置页显示的本机地址和配对码。

配对并登录后，更新版扩展首次连上 Runtime 就自动同步目录，不需要打开设置页或点击获取。设置页会自动显示进度、成功数量或具体失败原因。选好模型、思考档位和应用后保存默认配置，再创建 `chatmode` Agent；应用使用逐项开关。已有会话不会被默认值修改。“重新同步（备用）”只用于主动重新检查。失败不会每秒重开网页，已开始的真实消息不会自动重发。

### 首次启用 macOS 自动唤醒（只需一次）

在已完成 Chrome 配对的开发机执行：

```sh
npm run install:native-wake
```

安装器将 `scripts/native-wake-host.py` **复制到本机私有目录** `~/.chatmode-in-paseo/bin/native-wake-host.py`，再把当前已配对扩展的准确 ID 和这个本地路径写入 Chrome Native Messaging 清单；这不是常驻服务。**不要让清单直接指向外接项目盘**：实机验收中 Chrome 无法执行该位置的小程序，迁至本机后验证通过。入口仅接受固定“打开 Paseo”动作，不接收任意命令或聊天正文。Chrome 扩展须已授权 `nativeMessaging`。Paseo/Chrome 任一侧退出时另一侧可以尝试拉起；OS 接受启动不代表 Daemon 或 Agent 已恢复，仍需实时状态确认。

### 升级已有安装

先人工检查旧网页会话，停止不需要的生成，关闭对应 Agent，停用旧 Paseo 插件。**在 Runtime 已退出后备份 `~/.chatmode-in-paseo/`，不要删除历史或仍被进程使用的锁。**替换整套源码，再通过 Paseo 重新加载插件；Chrome 同时重新加载新版 `extension/`。新版在真正收到 Chrome `onInstalled(update)` 后会自动刷新**本插件管理的已绑定对话标签**；如个别页面恢复失败，只针对该页面按诊断处理，不刷新其他聊天标签。

若更换目录导致 Chrome 扩展 ID 变化，重新配对。配对失败保留原配置；版本不匹配在提交配对码前拒绝。升级时发现旧未完成事务，会阻断而不是自动重发。结果不明的会话需先人工核查；设置页的“结束本地跟踪”不停止网页/MCP、不删除历史，且要求先关闭该 Agent。

**不要同时运行 `npm run dev` 和 Paseo 插件指向同一个状态目录。**正常使用由 Paseo 自动启动 Runtime，不需要 CoS 或第二个运行程序。

## 3. 检查：验收和边界

离线浏览器检查需要 Python、Playwright 和 Chromium。它们加载内存页面，不登录账号、不发真实消息：

```sh
python3 -m pip install playwright==1.57.0
python3 -m playwright install chromium
# Linux 已有 /usr/bin/chromium 时无需设置；其他系统使用 Playwright 安装的浏览器：
export CIP_CHROMIUM="$(python3 -c 'from playwright.sync_api import sync_playwright; p=sync_playwright().start(); print(p.chromium.executable_path); p.stop()')"
npm run test:dom
npm run test:attachment-order
npm run test:failed-send-disposal
npm run test:browser
npm run test:flow
npm run test:native
```

真实联调按[测试与验收指南](docs/TESTING.md)进行：先短消息与第二轮，再做开发机 MCP 只读调用，最后测试两个会话、停止、断线和重启。**排队不是已发送；回答结束不是工程验收；停止网页不等于停止已启动的外部命令。**

模型目录使用移植的 CoS Fiber picker 读取。本版增加 `shellTurnSource` / `entry.turn.items` 及 `turn.items` 的公开文字分支，不搬工具参数、隐藏分析或图片载荷。不可读的菜单/应用 ID 不会被假造；菜单改版、本地化、分页或账号切换可能需要实机适配。多会话不增加账号额度；不自动批准、不轮换账号或重发来规避限制。

仅允许排除带明确警告的、宿主形状的本机 `paseo` MCP 项，避免它阻塞所有新聊；**这不表示该 MCP 已被导入网页**。其他 Paseo MCP 配置及预先批准规则不支持并报错。开发工具须在 ChatGPT 接入授权；网页模型不会因此自动获得 Paseo 子 Agent 工具。

运行数据保存在 `~/.chatmode-in-paseo/`（或 `CIP_STATE_DIR`），权限限制为当前用户，但不加密。历史接近容量上限会拒绝新消息，输出超限会记录失败，不静默丢失或无限卡住；Paseo 归档 Chatmode Agent 时，会话记录移到 `archive/` 下按日期的文件，取消归档时移回；不提供删除历史的界面。

### GitHub / 参与贡献

源码托管在 <https://github.com/Project10214/chatmode-in-paseo>，以 [MIT 许可证](LICENSE)公开，CI 见 `.github/workflows/ci.yml`。欢迎提交 Issue 与 Pull Request，中英文均可，流程见 [CONTRIBUTING.md](CONTRIBUTING.md)；安全问题请按 [SECURITY.md](SECURITY.md) 私下报告。

The source is hosted at <https://github.com/Project10214/chatmode-in-paseo> under the [MIT License](LICENSE). Issues and pull requests in English or Chinese are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md). Please report security problems privately as described in [SECURITY.md](SECURITY.md).

更多信息：[产品说明书](docs/PRODUCT_MANUAL.md) · [架构](docs/ARCHITECTURE.md) · [协议](docs/PROTOCOL.md) · [测试与验收指南](docs/TESTING.md) · [第三方声明](THIRD_PARTY_NOTICES.md) · [CoS 复用比对](docs/UPSTREAM_REUSE_AUDIT_20261016.md)
