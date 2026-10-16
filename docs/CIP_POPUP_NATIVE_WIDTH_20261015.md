# Chrome 0.2.6 原生弹窗宽度修复与实际验收

日期：2026-10-15。目标：修复扩展工具栏点击后弹窗被挤成「竖长条」。本次只修改 Chrome 扩展展示和版本名/检查规则，**未刷新正在运行的生产扩展、未停止 Agent**。Paseo 插件仍为 `0.1.0-alpha.4.4`，Chrome 扩展候选 `0.2.6`，CIP v5 不变。

## 真实根因

此前 Chrome 0.2.5 的普通网页截图约 400 × 335，看似正常，但用户实际在浏览器工具栏点击 CoS in Paseo 图标时仍然是细长弹窗。本轮使用开发机真实 Chrome 的无障碍接口按下 **CoS in Paseo** 原生工具栏按钮，直接确认窗口仅 **189 × 500** 像素。以前只测 `popup.html` 在普通标签页的渲染，没有测到 Chrome action popup 的原生尺寸。

CSS 仅给 `body` 写了 `width:400px;max-width:100vw`，而 `html` 未设固有宽度；Chrome 创建弹窗时按初始窄 viewport 回推 `100vw`，弹窗在宽度上被困住，形成自我反馈。新实现让 **`html` 和 `body` 均有 400px 固定/最小宽度**，移除 `body` 的 `max-width:100vw`，避免根容器在原生弹窗中缩水。

## Chrome 原生窗口对照（不是普通标签页）

使用独立 Google Chrome for Testing Profile，`Extensions.loadUnpacked` 加载项目扩展后，由 MV3 `chrome.action.openPopup()` 实际弹出工具栏 action popup；macOS 系统无障碍读取弹窗窗口宽高：

| 版本/环境 | 原生窗口宽 × 高 | 判定 |
| --- | --- | --- |
| 用户正在使用的 Chrome 0.2.5，直接点击工具栏图标 | **189 × 500** | 实际问题复现 |
| 独立 Chrome，使用旧 CSS 的真实工具栏弹窗 | **145 × 614** | 旧样式复现 |
| 独立 Chrome，使用修订 CSS 的真实工具栏弹窗 | **414 × 348** | **PASS** |

浏览器原生窗口的尺寸包含少量 Chrome 边界，因此 400px 内容对应约 414px 的原生窗口。对照命令：`CIP_NATIVE_POPUP_BASELINE=1 .test-tools/bin/python .test-tools/popup-actual-action.py`（需设置 `CIP_CHROMIUM` 指向 Chrome for Testing），不使用生产账号或配置。该测试独立实际打开 action popup，并非仅检查 DOM body 宽度。

## 交互与版本

- 保留 Chrome 0.2.5 已做的紧凑连接首页、单独配对/断开确认页、明暗样式及敏感配对码清理。
- 新增「初始浏览器 viewport 仅 150px 时 `html/body` 仍保持 400px」防回归测试，浅色、深色均覆盖。
- Chrome 插件版本改为 **0.2.6**，`version_name` 也显示 **0.2.6**，不再用 Paseo 插件的 `alpha.4.4` 代替 Chrome 自己的版本。静态脚本保持 CIP v5 协议一致性校验，并单独检查 Chrome 显示版本与其自身 Manifest 是否一致，允许 Chrome 和 Paseo 独立升级。
- 不改浏览器后台的身份、消息收发、Native Messaging、工具权限或 Paseo Runtime；没有增加新权限。

**用户更新路径：** 待在用 Agent 安全空闲后，在 `chrome://extensions` 对 CoS in Paseo 点击「重新加载」，再次点击浏览器工具栏图标确认卡片展示版本 **0.2.6** 且弹窗不再收窄。生产中的最终实际外观仍以用户完成更新后的实机反馈为准。
