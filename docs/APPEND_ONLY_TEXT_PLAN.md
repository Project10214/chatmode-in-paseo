# CIP 同一正文只增同步：源头修复技术方案

**历史阶段：研究与方案。后续已获准最小实现，当前进展见 [接手复核](APPEND_ONLY_TAKEOVER_REVIEW.md)。** 目标分支：`fix/chatmode-timeline-duplicates`；Node 22.23.3。本文仅引用项目源码与人工合成字符串，不包含真实对话正文、私密会话日志或凭据。原有五个调查/回归文件原样保留。

## 1. 结论与证据边界

**首选：绑定同一原生 assistant message ID 的单一正文来源；对 DIL `fallbackMarkdown` 使用语法边界驱动的逐步转换，只发布永不被后续转换修改的完整前缀。** 非 DIL 原生正文无转换时可直接逐字流式。保留现有 Broker、Provider、Paseo 的「规范全文 → 宿主取增量 → 前端追加」契约，**绝不能改成 Provider 自己发送 delta**。

- **确定的源码反例：** `extension/upstream/cos-shell-public.js:18–64` 的 `unescapeFallbackMarkdown` 对尚未闭合的 `\(`可能去掉反斜杠；同一原始 `fallbackMarkdown` 后续出现闭合 `\)` 时，会改为保留原先的 `\(`。小型合成实测：原文 `公式 \(` → `公式 \(x\)`，前者是后者的前缀；经旧转换后却是 `公式 (` → `公式 \(x\)`，不再是前缀。这个**反例位于 CIP/CoS 衍生的「文本转换」层**，并不证明 ChatGPT 原始 token 曾修改旧字。
- **现场证实层级：** 已获批的只读持久化元数据只证明 **CIP Broker 保存的转换后同 ID 文本**出现 7→177（LCP 6）、177→250（LCP 175）、250→393（LCP 249），之后 393→451→499→580→598 均纯追加。落盘采样不等于完整 wire 事件录制，无法给出被修改的具体字符，也未识别本轮页面究竟走 view/shell/DIL/DOM 哪条分支。
- **正常路径已验证：** 同 ID 规范全文纯增长，Paseo `mapTimelineItem` 只送新增后缀，renderer 追加得到正确全文；工具/状态穿插不会使宿主 Map 丢失上条规范全文。这条路径是绿例，问题不是「全文快照违反协议」。
- **独立的完成回报限制：** 已安装 Paseo `agent-manager.js:2214–2255` 只从最后一组连续 `assistant_message` 获得结果；`agent-prompt.js:285` 以此组成 boss 完成通知。工具穿插同一正文的追加片段时，机器侧可能只取尾段；仅 plugin 卡片会得到 null/上轮结果。源头只增方案**不能声称自动解决这个不同层级的问题**。

## 2. 数据链路与协议

```text
ChatGPT 模型/服务端权威生成流（本项目未直接读到原始 token）
                 │  原生消息 ID；权威是否全程只增：待独立证实
                 ▼
网页已提交的 turn.items / Fiber / 旧 DOM（可能是不同缓存/表示）
                 │  读出“整条”原生内容，不是 token 增量
                 ▼
cos-shell-public.js: sourceFor + shellItemText
                 │  非DIL原文 / DIL fallbackMarkdown + unescape 转换【已证实可改旧尾】
                 ▼
cos-picker-main.js: publicTranscript，按原生 messageId 投影全文
                 │  typed(view/shell)/generic 路由可能切换
                 ▼
dom-adapter.js: refreshTranscript/缓存；必要时旧 DOM authored()+trim
                 │  按原生消息 ID 的当前全文快照
                 ▼
content.js: observe()；同 monitor 串行；变更则发送 snapshot(全文)
                 │
                 ▼
background.js → /event → Broker：history 按复合身份原地覆盖全文
                 │  assistant:<turnId>:<nativeAssistantId>
                 ▼
provider.mjs：timeline.item(同ID的规范全文快照，不是 delta)
                 │
                 ▼
Paseo plugin-provider.js：同ID保存前次全文→计算新增后缀
                 │  已发字符如被改写，这里无法“撤销”
                 ▼
Paseo web Metro 3661：assistant 追加；plugin/tool 有独立身份
                 │
                 └→ agent-manager/getLastAssistantMessage → boss 完成通知
```

| 位置（源码行） | 身份/数据形式 | 转换或缓存风险 |
| --- | --- | --- |
| `cos-shell-public.js:99–119,127–199` | 原生 messageId；view/shell 的整条 `turn.items` | `sourceFor` 基于所在 DOM anchor 选择源；**未证实现场切换** |
| `cos-shell-public.js:18–64` | `fallbackMarkdown` 整串 → 整串 | `\(`、`\[`、反斜杠、代码围栏依赖未来语法；已证实反例 |
| `cos-transcript-core.js:20–33` | `content.parts` 整条拼接 | 保留换行，无 assistant trim；仍不等于直接读取模型 token |
| `cos-picker-main.js:217–278` | 每次完整 public transcript；原生消息 ID 去重 | typed 与通用 Fiber 路由；同次扫描冲突会拒绝，跨次变更未限制 |
| `dom-adapter.js:24–123,136,163–182,464–529` | nonce 缓存完整快照；旧 DOM 备用 | 旧 DOM 的块换行、空白规范化和 trim 与 typed 来源可能不同 |
| `content.js:134–145,183–188` | 当前 assistant 的完整 snapshot | `m.busy` 防同监视器重入；变化直接发送，不检查原生源/转换后前缀 |
| `background.js:751–764`、`runtime.mjs:152–155` | 请求身份校验；传全文 | 不做格式转换 |
| `broker.mjs:777–818` | `turnId+nativeMessageId` → 最新全文覆盖，最后才结束 | 不做正文串接；允许新全文修改旧尾 |
| `provider.mjs:238–259,339` | `timeline.item` 全文；重开 replay 全文 | 不应预先截成 delta |
| 安装版 Paseo `plugin-provider.js:1338–1357` | 同 item.id 前次全文 → 新增长度 | 非前缀则将新全文全部当作追加 chunk |
| Paseo 0.11.4 web Metro reducer 3661 | 最后追加的文本 chunk；工具/插件另有 identity | 已发的 assistant 字符无法原地修改 |

## 3. 候选与最小变更

| 候选 | 影响文件（未来获批才动） | 复杂度 | 判断 |
| --- | --- | --- | --- |
| **A 首选：来源锁定＋语法边界提交** | `extension/upstream/cos-shell-public.js`（原始字段/渐进转换）、`cos-picker-main.js`（按 ID 保留来源和转换状态）、必要时 `dom-adapter.js` 和 `content.js`（来源标记、异常门控） | **中** | 同一原生源确实纯增长时，逐次发布文本也是规范全文且严格只增；最终文本与当前转换结果字节一致。保留 native assistant 契约和实时文本 |
| B 直接转发 `fallbackMarkdown` 原文 | 主要 `cos-shell-public.js` | **低** | 原文可维持字节只增，且现有最终转换前后的字节不同；但**不能据此断言 Paseo 视觉显示错误**。尚未进行离线真实 Markdown 渲染/文本等价对照，本轮**待验证，不选也不否定其展示可行性**；若渲染等价，可比 A 更小 |
| C 固定保留尾部 N 字 / `startsWith` 过滤 | 观察侧 | 低 | 无法保证遇到早期真实改写后仍准确；可能永远停在错误前缀；**不选** |
| D Paseo 改造 / 正文插件卡片 / 最终才发文字 | 宿主/新 UI/完成回报 | 高或 UX 降级 | 本轮不授权、不是首选；不绕开 Native 最终结果接口 |

**A 的具体机制（先在单一来源上严格证明）：**

1. 每个原生 `assistantMessageId` 绑定一个来源枚举（例如 typed-view、typed-shell、generic-Fiber、legacy-DOM）以及文本种类（原文、DIL-fallback）。**不要因为同一帧的 DOM 结构变化就把另一种表示当作相同消息的新尾巴**。首选有原生 ID 佐证的 typed 结构；当首选暂时不可读，等待/提示，而不是自动接上格式不同的 legacy DOM。跨文档恢复允许**身份与规范前缀可证明一致**的显式移交；不可证明就拒绝/暂停，不静默合并。
2. 非 DIL 正文无必要转换时，读到哪个原生全文就发布同 ID 的该全文。对于 reference-only DIL，先取**同一匹配原生 ID** 的 `model_dil_v2.fallbackMarkdown`，不要把暂时不可解析的 `::chatgpt-content-reference{...}` 占位串当正文发布。
3. **保留现有 `unescapeFallbackMarkdown` 的最终结果，不要每帧立即发送它对整个未完成源串的转换结果。** 增量转换的安全提交边界由语法决定：普通字符立即放行；未完结的一行遇到反斜杠、反引号、围栏可能开头时，从歧义位置起暂存，直到语法明确（通常换行/完成）；独立一行的 `\[` 要等 `\]` 或现有转换器向后最多 400 行的判断窗口耗尽。待处理原始字保存在当前消息的临时状态里，不计为已显示文字。**未来实现不得反复重写已发前缀：** 每个原生 ID 保存已提交原文游标、未完成语法缓冲、代码围栏/公式等解析状态和已发布规范全文；只解码新变得安全的原文片段，接到旧规范正文之后，再向 Provider 发送该 ID 的**累积规范全文**（宿主负责计算 delta）。合成研究模型为校验正确性，会对“安全原文前缀”调用原版转换器作为全量 oracle；**这不代表建议生产代码每帧从头解析**。
4. 每次发布前检查 `规范全文.startsWith(此前已发布全文)`。**这里只用作不变量与报警，不用于过滤或裁剪非前缀修订。** 若原始源也非前缀、解析后的规范全文违背前缀、原生身份或来源无法证明，暂停新文本和成功终态，发最小诊断（来源类型、ID/长度/LCP/错误码，不含正文），保留已有存储状态；绝不冒充“完整成功”。若 native 本身真的改写已发表字，原生 append-only 契约不能无损修正，必须上报异常并由 boss 决定另行支持修订。
5. 当原生 final 与 receipt 同轮次被独立确认：**先释放所有待处理语法并发布完整最终规范全文，等 Broker 接受后，再发 `completed`。** 如果最终文本与已发布前缀不一致，禁止成功结束。每个状态都与 `turnId + assistantMessageId` 绑定，终态冻结，迟到的旧 streaming 读数不可倒灌。

**审查修订：安全提交边界与已提交游标。** 研究模型现在有 `committedRawEnd`（此前已经用于生成已发布规范文本的原文终点）；新安全边界 `safeEnd` **必须满足 safeEnd ≥ committedRawEnd**，相等代表暂存等待，不得退回前一个已发字符。若违反，应单独报 `BOUNDARY_CURSOR_REGRESSION`（分类器错误），不能把它误报成网页原始流变化；其后仍检查投影规范全文的前缀关系，二者用途不同。重复相同原文不增发，真正 final 才将待处理尾部完整释放。

- **缩进公式的旧错误与修正：** `cos-shell-public.js:30` 用 `line.trim() === '\\['` 判断整行公式，所以在输入还只有 0–4 个空格、Tab 或混合缩进时，下一字符仍可能让它变为公式行。研究模型在这种**尚可成为独立公式起始行**的未完行上，连同开头缩进一并暂存；确认它是普通正文后才放行。旧模型提前发表缩进、看到公式行后回撤至行首，正是本轮两个合法只增反例的根因；不修改原文，也不吞掉缩进或 CRLF。
- **围栏内不误判公式：** 完整行按原版围栏起止语法（最多三个空格加至少三个反引号或波浪线，结束行还需满足原版尾部条件）更新 `fence` 状态。**只在围栏外**将缩进后的独立 `\\[` 视为潜在公式起始行，按原版规则检索之后最多 400 行内独立 `\\]` 的闭合；在已确立的围栏内，原版函数直接保留整行字面量，代码中的 `\\[`、`\\(` 无需等待公式结束。未完结的围栏起始行可能暂时延迟到本行明确，避免凭半行错误切换状态。
- **CRLF、空白、emoji：** 原版转换器对原文 CRLF、Tab、末尾空白保留其 UTF-16 序列；发布源也保留，不做 `trim()` 或换行重写。*安装版 Paseo 的屏幕 reducer 则把 CRLF 呈现成 LF*；因此测试分别断言**发布规范全文逐字等于原转换器**，以及**宿主显示与其 LF 呈现等价**。分片恰好落在 emoji 高代理项后时，暂存该单元直到低代理项到达，不把半个 emoji 当已发表文本。

**正确性条件：** 令输入原始字串各帧为 `R₀ ⊑ R₁ ⊑ … ⊑ R_final`（`⊑` 为前缀关系），转换器 `F` 与当前已校验的最终行为相同。算法只提交不会被任何后续追加改变的 `F` 前缀；因此发布全文也单调只增，宿主能准确取后缀。native final 时若 `R_final` 和来源合法，`P_final = F(R_final)`，最终文本不因暂存漏字。**这是有条件正确性**：前提为同一权威原始来源确实只增，且安全边界推导覆盖所有现有解析分支；后者仍需更全面的性质测试/真实渲染验收。

**体验代价：** 中文等普通文字仍可快速流式；一行开头的空格/Tab 要在能排除独立 `\[` 公式行之前短暂暂存；代码围栏**内部**的 `\[`、`\(` 是字面内容，不应因公式歧义卡住（经新反例校验）；未闭合的行内反斜杠/反引号和围栏外显示公式可能暂停局部文本，工具/活动仍实时。围栏外显示公式遇到匹配关闭行、现有 400 行查找界限或原生最终确认才解除暂存。这不是任意截取最后 N 字符。纯文本模式在 emoji 的高代理项到达而低代理项未到时也暂存该单元，不影响最终字节。

**来源和许可：** 原项目保留 CoS MIT 来源。未来若修改 `extension/upstream/cos-shell-public.js`，须同步 `vendor/cos/provenance.json` 和 `vendor/cos/README.md` 的函数哈希/来源，并保留 `THIRD_PARTY_NOTICES.md`。本研究没有修改这些文件。

## 4. ID、工具、多段回复与恢复

- 保留现有 `sessionId`（会话绑定）、`turnId`（归属/发送租约/停止/重开）、native user ID（回执锚点）和 native assistant ID（**唯一正文身份**）。历史键保持 `assistant:<turnId>:<nativeAssistantId>`；禁止按文本相似度合并不同原生 ID。
- **首段正文可确认来源后：** 建立此消息的转换状态；已有安全规范字节立即以同一 ID 发布全文，后续逐次更新同一 ID。遇到不完整语法时可以先有运行状态而暂无可安全输出的字节；不制造占位回答。
- **发言 → 工具 → 最终发言：** 若两段原生 ID 不同，保留两条作者消息与中间工具，后一条绝不覆盖前一条；若是同一原生 ID 的后续内容，CIP 和 Broker 更新同一条规范历史记录，不按工具边界制造新的消息。工具卡片用独立 callId/状态，保持实时。必须区别 Paseo UI 因卡片插入而拆分*显示段落*与实际*重复文字*。
- **工具等待不是结束：** 只在原生 final/receipt 证据成立才完成；权限等待、运行中、没有文本的媒体/失败/取消走各自既有终态，绝不凭“网页暂时没字”宣布完成，更不自动重发用户输入。
- **断线/重开：** Broker 按 ID 持久化最新完整规范文本，Provider 的 `history: replay` 先发一次规范全文给**新的宿主快照 Map**，之后 live 仍送该 ID 的完整规范全文；旧快照相等则忽略，有真正新增才继续。恢复时使用上次已发布规范全文作安全基准，必须重获源身份与前缀证据，不能把整条旧答案再当新尾巴。跨文档身份无法证明时暂停。
- **final 之后：** 不接受旧 streaming 样本推翻最后版本。重复相同快照不产生额外时间线事件。Broker 一直覆盖存储的一条正文记录，不能把多帧全文相加。

**需要单独验收的完成回报缺口（当前宿主）**：`agent-manager.js:2214–2255` 对同一 native assistant 在工具卡片前后的两段增量只取最后连续部分；即使显示正文完全正确，boss 回报也可能少前半段。现有 `tests/provider-upsert-interface-gate.diagnostic.mjs` 已用原版方法确认。它**不证明本次根因是宿主**，也不能因为源头修复就划成绿项。不得暗加另一份原生完整答案或 UI 插件卡片掩盖。此条件必须在后续发布验收时单列解决/由 boss 批准额外范围；本方案暂不碰 Paseo/SDK。

## 5. 验收矩阵与研究结果

在原有五个未提交调查/测试文件之外，新增 `tests/append-only-text-plan.test.mjs`，仅模拟合成原始数据与未来的**研究模型**，执行项目现有的 CoS 读法及固定版本 Paseo 0.11.4 `mapTimelineItem + Metro 3661` 原始函数对照。不能把研究模型通过当作生产修复已完成。

| 覆盖 | 期望与判据 |
| --- | --- |
| 原始只增 → 规范只增 | 每帧 `Rᵢ⊑Rᵢ₊₁`；每个已发布 `Pᵢ⊑Pᵢ₊₁`，最终 `P=F(R_final)` |
| 已有 fallback 反例 | 原始纯增长但旧逐帧 `unescapeFallbackMarkdown` 修改旧字符；源头方案需要恢复规范前缀不变量 |
| 中文、转义标点、表格、代码围栏、行内/块公式、空行/末尾空白、emoji | 合成逐字符和不同分片发送，**规范全文逐字等于原版转换器**；不吞行首缩进、CRLF、Tab、末尾空格，且不发布半个 emoji |
| 公式的最大查找窗口 | 独立 `\[` 行在围栏外未闭合时暂存（含缩进）；关闭或超过原版 400 行查找界限后安全发表；围栏内字面量不受此限制；提交原文游标不可回退 |
| 重复观察、不同 native ID、来源切换、迟到旧流 | 相等不发新增；不同 ID 独立；原始非前缀/换源显式拒绝；最终状态不倒退 |
| 工具穿插和多段原生消息 | 精确身份顺序，不因卡片穿插重复字符，不把不同 ID 的评论/最终文字误合并；**boss 机器侧回报列单独红项** |
| 重开/恢复、取消/失败、纯图片或没有文本 | 先播已有规范完整历史，再继续该 ID 的新增；不重发用户消息；没确认文本的失败不能成功结束 |
| 人为向 Broker 注入任意非前缀 | 仍属于当前 append-only **能力边界**，不能删除旧红测或伪称全局可修改旧字 |
| 以后实现后发布验收 | Node22 fresh clone：check、verify:upstream、test、typecheck、test:sdk、Playwright 隔离浏览器；三项历史 MV3 失败与同环境 main 对照，逐项留命令/退出码/报错 |

**已执行的研究测试：**

```sh
NODE=/Users/penn/.npm/_npx/52027bd8fc0022aa/node_modules/node/bin/node
"$NODE" --test tests/append-only-text-plan.test.mjs

CIP_PASEO_PROVIDER_SOURCE=/path/to/pinned/plugin-provider.js \
CIP_PASEO_RENDERER_BUNDLE=/path/to/pinned/index-72553504501f81e1c6b8473200a1c78b.js \
"$NODE" --test tests/append-only-text-plan.test.mjs
```

**2026-10-17 本轮审查修订实测（Node 22.23.3）：** 先在旧研究模型上加入两项缩进公式和一项围栏字面量反例，针对新测试运行结果为 **0 通过／3 失败／0 跳过，退出码 1**：两项抛 `DERIVED_NON_PREFIX_MUST_NOT_PUBLISH`（模型错误地收回已提交缩进），围栏一项错误地延迟字面量。随后修订研究边界（语法状态+行首缩进暂存+原文提交游标非递减+UTF-16 emoji 半字符暂存）与 host 显示等价校验。**全部研究测试 portable 17/17、原版 Paseo mapper+renderer parity 17/17，均 0 skip、退出码 0。** 另运行有限可重复矩阵 **280 组、4104 个已发布帧、24 组实际宿主精确对照**：7 种缩进、LF/CRLF、5 种结构、分片 1/2/3/7 个 UTF-16 单元，全部源端规范正文前缀与 final 字节不变量通过；安装版宿主 UI 对 CRLF 规范化为 LF，已单独按呈现层比对，**未修改源文本**。这不是数学完备证明、不是实际网页验收，也不能把自造边界异常归咎于 ChatGPT。原有受控非前缀回归（10 通过／5 预期失败）与宿主完成结果接口门槛（3 通过／5 预期失败）仍保留，**本轮未改其断言、未以删测方式转绿**。原版宿主函数经 `tests/fixtures/paseo-real-contract.mjs` 的 SHA-256 校验，**没有补丁**；Markdown 视觉排版、复制、表格交互的真实 DOM 仍需以后单独以隔离合成渲染验收。

## 6. 待 boss 决定的三个门槛

1. **是否接受仅在不完整 Markdown/公式语法处短暂延迟正文？** 正常文字继续流式，歧义很长的单行可延迟到换行/完成；若完全不允许等待，则必须更改正文表示/展示契约，而不能承诺当前 append-only 下无损修订。
2. **原生源是否真正发生改写属于待核实的事实，不交由用户凭偏好认定。** 已批准的路线以同一原始源只增为前提；**常见合法只增的空格/Tab/CRLF/代码围栏不得误报异常**。仅当源身份和原始非前缀变化有独立证据时，才触发明确故障诊断；产品层可另行决定错误如何提示。现有宿主对已经显示的字无法无损回写，绝不可静默丢弃合法的新内容。
3. **如何安排“工具穿插时 boss 完成回报缺前半段”的独立缺口？** 源头只增不会自动修复此宿主读取问题。建议保持本次源头修复的实现边界；把机器侧回报标为正式发布前独立阻断，不得偷换成 plugin-only、terminal-only 或双轨隐藏方案。

**本轮未修改生产代码、版本、已安装 Paseo、SDK、线上插件/扩展及用户配置；没有发送真实 ChatGPT 消息，没有提交、推送、开 PR 或部署。**
