# 上游复用比对与许可证结论（2026-10-16）

**English summary.** Before publishing this repository we compared it line by line against the two pinned commits of Chat On Steroids (CoS, MIT) that it adapts code from. Roughly 11–13% of the ~7,700 non-blank runtime code lines are verbatim-identical to CoS lines, almost all of them inside the 12 modules under `extension/upstream/`. That is about 0.8% of CoS's own code (4.2% of its browser extension). CoS is MIT-licensed, so this repository is released under the MIT License with the CoS copyright and permission notice preserved (see `THIRD_PARTY_NOTICES.md`). Method and caveats are below; the script is `scripts/audit-upstream-reuse.py`.

## 1. 目的

决定本仓库公开时采用的许可证与署名方式：弄清楚实际用了多少 CoS（Chat On Steroids）源代码，以及 CoS 自身的许可证是否允许这样用。

## 2. 方法

- **上游**：从 GitHub 取固定提交的完整源码包（`codeload` tarball）。两个提交都登记在 `vendor/cos/provenance.json`：
  - `ccd23b66cecf2f684fa3e12ca190297be02842cf`（版本 2.1.35）
  - `e40562640361ca8f74158b2262ca8c555b00abed`
- **比较对象**：上游的 JS/TS/CSS/HTML 非空行（两个提交分别约 28.4 万和 28.9 万行），对本项目的运行时代码（`extension/`、`server/`、`client/`、`shared/`、插件入口、`scripts/`）。`tests/` 单列，不计入运行时。
- **判定**：空白规范化后，本项目的某一行与上游任意一行完全相同，且该行不少于 20 个字符（排除 `}`、`return;` 之类的巧合），记为"逐字相同"。连续 3 行及以上逐字相同记为"成块复制"。
- **脚本**：`scripts/audit-upstream-reuse.py`，只读取文本，不导入、不执行上游的任何代码。用法见脚本开头。

## 3. 结果

### 3.1 本项目一侧：多少代码与 CoS 逐字相同

| 范围 | 非空行 | 可比行（≥20 字符） | 逐字相同 | 成块复制（≥3 行连续） |
| --- | ---: | ---: | ---: | ---: |
| A. `extension/upstream/`（12 个 CoS 移植模块） | 2,046 | 1,595 | 675（42.3%） | 616（38.6%） |
| B. `extension/` 其余部分 | 2,932 | 2,159 | 72（3.3%） | 17（0.8%） |
| C. `server/` | 2,302 | 1,856 | 39（2.1%） | 9（0.5%） |
| D. `client/` + `shared/` + 插件入口 | 298 | 255 | 6（2.4%） | 0 |
| E. `scripts/` | 152 | 122 | 13（10.7%） | 13（10.7%） |
| **运行时合计（A–E）** | **7,730** | **5,987** | **805（13.4%）** | **655（10.9%）** |
| F. `tests/`（不计入运行时） | 7,436 | 6,317 | 95（1.5%） | 47（0.7%） |

B–F 中逐字相同的行，最长连续块只有 2–5 行，属于通用写法的巧合（例如常见的 `const x = await …`、CSS 声明），不是成块复制。成块复制几乎全部集中在 A。

### 3.2 12 个移植模块逐个看

| 模块 | 行数 | 逐字相同 / 可比行 | 最长连续块 | 主要上游来源 |
| --- | ---: | ---: | ---: | --- |
| `cos-native.js` | 271 | 179 / 208（86.1%） | 51 | `chatgpt-dom.js` |
| `cos-controls.js` | 160 | 98 / 116（84.5%） | 18 | `chatgpt-dom.js` |
| `cos-models.js` | 234 | 145 / 181（80.1%） | 65 | `chatgpt-dom.js` |
| `cos-picker-main.js` | 324 | 144 / 270（53.3%） | 118 | `fiber.js` |
| `cos-shell-public.js` | 202 | 74 / 152（48.7%） | 18 | `fiber.js` |
| `cos-apps-observer.js` | 124 | 22 / 102（21.6%） | 3 | `usage.js` |
| `cos-transcript-core.js` | 80 | 6 / 56（10.7%） | 1 | `fiber.js` |
| `cos-receipt-text.js` | 29 | 2 / 22（9.1%） | 2 | `content.js` |
| `cos-images-main.js` | 148 | 4 / 115（3.5%） | 1 | `fiber.js`、`content.js` |
| `cos-request-receipt.js` | 58 | 1 / 41（2.4%） | 1 | `content.js` |
| `cos-activity-main.js` | 207 | 0 / 165（0.0%） | 0 | — |
| `cos-send-evidence.js` | 209 | 0 / 167（0.0%） | 0 | — |

前五个模块是真正的"函数级直接移植"。后面几个被大幅改写，逐行比对几乎找不到相同行，但仍按项目自己的来源记录（`vendor/cos/provenance.json`）保守登记为改编。

### 3.3 上游一侧：用了 CoS 的多少

下表是"本项目运行时代码中出现的上游行 / 上游可比行"。这是上界，包含巧合匹配。

| 上游文件 | 出现的行 / 可比行 |
| --- | ---: |
| `extension/chatgpt-dom.js` | 464 / 2,414（19.2%） |
| `extension/fiber.js` | 257 / 2,151（11.9%） |
| `extension/usage.js` | 32 / 483（6.6%） |
| `extension/content.js` | 35 / 9,969（0.4%） |
| `extension/` 目录合计 | 895 / 21,096（4.2%） |
| **整个上游仓库**（含 Electron 主进程 `src/`、测试等） | **1,784 / 216,826（0.8%）** |

数字取自 `e40562640361…`；`ccd23b66…` 对应为 1,753 / 212,579。

### 3.4 与项目自己的来源记录对照

`vendor/cos/provenance.json` 登记 12 个模块、57 个来源函数，分别摘自：`extension/chatgpt-dom.js`@ccd23b66（3 个模块）、`extension/fiber.js`@ccd23b66（2 个）、`extension/fiber.js`@e4056264（2 个）、`extension/content.js`@e4056264（3 个）、`extension/usage.js`@e4056264（2 个）。逐行比对与登记一致：被大量使用的上游文件正是 `chatgpt-dom.js`、`fiber.js` 和 `usage.js`。

## 4. 结论

1. **CoS 的许可证**：两个固定提交的 `LICENSE` 都是标准 MIT 文本，与 `vendor/cos/LICENSE` 字节一致；上游 `package.json` 声明 `"license": "MIT"`；我们取用的 `chatgpt-dom.js`、`fiber.js`、`usage.js`、`content.js` 中没有内嵌其他第三方的版权或许可证声明，上游 `THIRD-PARTY-NOTICES.txt` 也没有列出 `extension/` 目录下的第三方代码。
2. **复用程度**：本项目运行时代码中约 11%–13% 的行与 CoS 逐字相同，集中在 `extension/upstream/` 的 12 个模块（其中 5 个模块约一半或以上的行相同）；这只占 CoS 全部代码的约 0.8%、其浏览器扩展的约 4%。Provider、共享 Runtime、队列与存储、Paseo 设置页等其余部分是本项目自己的代码。
3. **许可证选择**：MIT 是宽松许可证，允许修改、再许可与再分发，唯一条件是保留版权与许可声明，不存在 copyleft 传染。因此本仓库整体以 **MIT** 发布，原创部分署名 **Pennnnnnnnnn**；CoS 移植部分继续保留 "Copyright (c) 2026 Chat On Steroids contributors" 及 MIT 许可文本。

## 5. 据此所做的合规处理

- 新增根目录 `LICENSE`（MIT，Copyright (c) 2026 Pennnnnnnnnn）。
- 重写 `THIRD_PARTY_NOTICES.md` 的开头与 CoS 一节：去掉"私有原型、不采用开源许可证"的旧表述，更新为 12 个模块、两个上游提交、五处上游源文件，并写入本次实测比例。
- 新增 `extension/upstream/NOTICE.md`，让声明随目录走：即使有人只复制这些文件，也能看到来源与许可证指引。**没有改动任何 `extension/upstream/*.js`**，以免破坏 `npm run verify:upstream` 记录的哈希。
- `package.json` 增加 `license`、`author`、`repository` 等字段；README 增加许可证与第三方来源说明。

## 6. 局限

- 逐行比对只能发现"原样保留"的行：改过变量名或调整过格式的代码不会被发现，所以对"改编"程度而言这些数字是**下限**；同时通用写法的巧合匹配又会让数字略偏高。它说明的是数量级，不能证明某段代码是否独立创作。
- 数字基于 2026-10-16 的工作区快照，是近似值；工作区仍在开发，之后会有小幅变化。
- 这是技术核对，不是法律意见。
