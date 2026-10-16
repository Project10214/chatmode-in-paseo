# alpha.3 最终检查证据

本目录为 2026-10-13 alpha.3 最终日志。`../evidence/` 和 `../REPAIR_NOTES.md` 是 alpha.2 历史，不合并计数。

Node 86 + Chromium 41 = 127 功能检查；JS/TS 语法及来源完整性另外列出。SDK、类型和依赖安装的失败日志特意保留，不能当作通过。所有浏览器页面、React 模型状态、Chrome tabs API 和测试消息均是夹具；没有调用用户真实账号、模型、远程 MCP 或 Paseo 安装。

浏览器禁止导航的调试观察：`Page.goto: net::ERR_BLOCKED_BY_ADMINISTRATOR at https://chatgpt.com/`。未重试实际站点；后续全部采用内存页面。native 测试在夹具内将 opaque origin 的 postMessage target 映射为 `*`，生产代码的 Origin 检查未改动。这里是环境观察摘要，不是原始导航堆栈日志。
