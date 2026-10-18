# Paseo 0.11.4 Chatmode duplicate investigation — 2026-10-16

> Historical investigation, not the current patch acceptance report. The executable host-boundary experiments now use `*.diagnostic.mjs`; current results and production-path coverage are recorded in [takeover review](../../docs/APPEND_ONLY_TAKEOVER_REVIEW.md).

**Scope: investigation and test fixtures only. No production changes.**
**Status (updated after reviewed metadata): five intentionally RED regressions, ten GREEN controls.**

## 1. Runtime versions and independently verified source

- Project base: `3e0810a3d8350ee408e3051f0f57abe658406282`; branch `fix/chatmode-timeline-duplicates`.
- Plugin SDK: `@getpaseo/plugin` `0.11.2` (project package.json and inspected installed SDK). SDK's `assistant_message.text` is a string schema; it does **not** imply delta semantics.
- Installed host: Paseo `0.11.4` (app Info.plist).
- Installed daemon's `plugin-provider.js` SHA-256: `dc9948ca942d2aeef10a48c4ef1fc625819005ef28296bb386cfb9737502d475`.
  - Archive entry: `node_modules/@getpaseo/server/dist/server/server/agent/plugin-provider.js`.
  - `mapTimelineItem` lines 1338–1380; `translateTimeline` lines 1126–1139; `PluginAgentSession` constructor lines 856–879, `accept` lines 1060–1065.
- Installed web renderer: `app-dist/_expo/static/js/web/index-72553504501f81e1c6b8473200a1c78b.js`; SHA-256 `f420d2f7bf85d22207ea62dc54b5593e9dee8b4261874a83fa8e37f938872486`.
  - Metro module 3661, `applyStreamEvent`, `A` (append assistant chunk), `V` (plugin upsert), `G` (tool update), `Ie` (head flush), `fe` (merge head to tail).
- Plugin path: `server/broker.mjs:777–789` persists one latest full snapshot by stable ID.
- Provider: `server/provider.mjs:236–259` emits each changed snapshot as a `timeline.item`.
- Browser observer: `extension/content.js:183–188` sends the **full visible text** whenever the ID or text changes (no prefix/monotonicity check).
- Native public reader: `extension/upstream/cos-transcript-core.js:20–31` reads current `content.parts`; `extension/dom-adapter.js:503–527` takes the latest assistant after its exact user anchor.

The previous assertion **"Provider must emit only deltas" was wrong**: the daemon `mapTimelineItem` stores `snapshots.get(item.id)` and sends only `text.slice(previousText.length)` for a prefix extension. Activity/tool items have different IDs and do not clear this Map.

A new `PluginAgentSession` constructs a fresh Map, but processes the `bridge.history` before accepting live events; resume passes `history: "replay"` (daemon lines 739–748; plugin `server/provider.mjs:339`). Tested active restore is GREEN; a reset *without* reconciliation of already-displayed UI data is still only an architectural question, not a confirmed bug.

## 2. Synthetic event evidence through the full chain

`tests/provider-timeline-host-regression.diagnostic.mjs` uses the real project Broker/Provider. Every case runs through the independently written `tests/fixtures/paseo-0.11.4-contract.mjs` (daemon full-snapshot→delta model + head/tail rendering model).

With two optional environment paths, the **same** events are also run through the *original, read-only installed daemon function* and *original, read-only Metro reducer*, and their mapped events and rendered assistant segments are asserted equal. Source hashes must match. The tests never access ChatGPT or any real browser account; no real credentials or user text are embedded.

GREEN examples:

- Full text `收到两张图片` → `收到两张图片，一张是电影画面，另一张是文字截图。` maps to deltas `收到两张图片` and `，一张是电影画面，另一张是文字截图。` → exactly one full visible answer (no repeated prefix).
- Same progression with an activity card in between is also exact. Multiple visual assistant segments are allowed: **segmentation is not duplication**.
- Same progression with a real project native tool-call timeline is exact.
- Completed history replay, active turn restoration and source/version contract all GREEN.

RED controls (order deliberately injected, **NOT extracted from the user's historical session**):

1. **Same-ID shrink and regain**: original text `收到两张图片，一张` → truncated `收到两张图片` → complete `收到两张图片，一张是电影画面，另一张是文字截图。`. The daemon emits `["收到两张图片，一张", "收到两张图片", "，一张是电影画面，另一张是文字截图。"]`; visibly concatenated: `收到两张图片，一张收到两张图片，一张是电影画面，另一张是文字截图。`. Actual ≠ expected, real duplication.
2. **Same-ID revision**: `收到两张图片，一张是游戏截图` → `收到两张图片，一张是电影画面`. The daemon emits BOTH full texts, visibly repeating `收到两张图片，一张是`. Actual ≠ final text.
3. **Real extension observer → project Broker/Provider → daemon/renderer** using synthetic native message parts in the **real** `CIP_COS_PUBLIC_CORE.authoredText`. The observer sends the same three snapshots from (1) without filtering; the final visible duplicate is exactly the result of (1). This proves the extension/broker permits this controlled input, **not** that production ChatGPT emitted it.

The earlier screenshot remains independent proof that duplicate display occurred. The earlier completed-turn `state.json` preserved only one final answer. **Newer, independently approved metadata now proves same-ID non-prefix tail changes occurred in a separate live turn's persisted history** (details below). It does **not** disclose what the changed characters were, record every Provider-wire event, prove which native reader branch was active, or establish that the earlier screenshot used precisely this cause.

## 2.1 Approved live metadata — what is newly established

This section reports ONLY lengths, longest common prefixes, times and lifecycle counters from the owner-approved read-only persisted-state sampler. No private log, message ID, user text, URL or token is copied into the repository.

| UTC time / sequence | Same assistant item (UTF-16 units) | Longest common prefix | Relation |
| --- | --- | ---: | --- |
| 14:33:52.493, seq 8 | new → 7 | 0 | new |
| 14:33:53.586, seq 9 | 7 → 177 | 6 | rewrites |
| 14:33:54.704, seq 10 | 177 → 250 | 175 | rewrites |
| 14:33:55.831, seq 11 | 250 → 393 | 249 | rewrites |
| later samples | 393 → 451 → 499 → 580 → 598 | full prior length | extends |

2026-10-16 14:34:04.435Z: completed; 14:34:09.436Z: completed_quiet, sampler exited. 19 successful reads and zero parse errors. The corresponding Paseo view visibly repeated some openings and incomplete table fragments; the persisted final answer still occupied one canonical assistant row.

**Proof boundary:** For the same assistant item, persisted history really changed trailing text while increasing overall length: the old final 1, 2, and 1 UTF-16 units respectively were not preserved. The actual changed characters, native-reader branch, and every intermediate Provider-wire event are unknown. A disk sampler does not record every state transition. Neither this later turn nor the older two-image incident proves an identical origin for both accidents.

FIELD-GREEN and FIELD-RED tests use entirely fabricated parentheses, punctuation and Markdown tables but reproduce the exact lengths and longest-prefix lengths above. They assert final displayed text, **not** a required count of assistant rows. DESIGN-LIMIT proves a naive startsWith-only filter can permanently keep the incorrect 7-unit prefix; DESIGN-GREEN proves an invented plugin-item identity can replace its complete data snapshot within both installed host processing and the narrow portable model. The latter confirms host item semantics **only**, not a finished text renderer, Markdown quality, or production compatibility.

## 2.2 Source-to-host path and proven synthetic source-side mechanism

1. **Main-world native sources**: extension/upstream/cos-shell-public.js:99–119 maps turn.items with messagesFromTurnView; lines 127–164 map entry.turn.items with shellTurnSource. sourceFor at lines 166–199 chooses view or shell by DOM anchor. The branches can use different cached text. An actual source switch in the sampled turn has **not** been proved.
2. **Context-sensitive formatting**: cos-shell-public.js:18–53 unescapeFallbackMarkdown decodes escaped punctuation, using later closing syntax to decide how to treat an earlier opening parenthesis. Lines 55–64 select it for a reference-only DIL item with one matching fallbackMarkdown. Executing the unmodified source in READER-RED proves that raw synthetic fallbackMarkdown grows monotonically from an unclosed backslash-parenthesis to a complete inline formula, yet the projected old trailing character changes (the later projection retains a backslash). Broker/Provider, the real host mapper and renderer then visibly duplicate. This **proves one source-layer mechanism is possible**, not that the live incident used fallbackMarkdown or those characters.
3. **Projection**: extension/upstream/cos-picker-main.js:217–278 forms publicTranscript. Lines 235–240 choose typed vs generic source; 256–262 call authoredText and reject conflicting same-ID messages within one scan. extension/upstream/cos-transcript-core.js:20–33 joins assistant content.parts with newline, without trimming the assistant result.
4. **Isolated-world cache and DOM alternative**: extension/dom-adapter.js:24–123 requests the transcript using nonce/path, coalesces outstanding reads and caches the response. Lines 464–482 can use cached native rows or legacy DOM. Its authored(node) at 163–182 serializes block boundaries, and norm at 136 standardizes line breaks/spaces and **trims**. A switch between these representations may change the suffix. No live evidence of such a switch was captured.
5. **Polling and state**: extension/dom-adapter.js:503–529 chooses the last assistant after the exact user anchor. extension/content.js:134–145 and 183–188 forward every changed full snapshot without a prefix check. The m.busy guard at 134–135 serializes same-monitor observations. An executable OBSERVER-GREEN test delays one snapshot RPC: overlapping monitor polls do not send a second snapshot until completion. This excludes one simple same-monitor overlap in the fixture; it does not prove that no async problem can occur across monitor/document lifetimes.
6. **Transport and persistence**: extension/background.js:751–764 validates source ownership and forwards to /event; server/runtime.mjs:152–155 calls broker.observe. server/broker.mjs:777–791 accepts changed full snapshots and upserts by stable ID without requiring a prefix relationship; server/provider.mjs:238–241 forwards them as timeline.item.
7. **Actual Paseo semantics**: installed plugin-provider.js:1338–1357 computes a delta only when new full text starts with prior full text. Otherwise it forwards the entire new text as an appended chunk. The installed Metro 3661 reducer appends assistant chunks. Same-ID normal growth is correct; changing already-displayed characters is not replaceable through this event type.

**Confirmed layer:** same-ID non-prefix growth in persisted plugin history; actual installed host code deterministically duplicates for that input. **Unresolved layer:** which webpage representation, rendering state, or formatting path produced the sampled changes. Do not equate a possible formatter effect with a proven live DIL branch, and do not infer actual changed characters from the metadata.

## 3. Reproduction commands

Run from the assigned worktree root. Use **Node 22** (tested `v22.23.3`); never change the globally installed Node version.

Portable, no Paseo binary/SDK/node_modules required; **zero skips**:

```sh
node --version  # v22.23.3 during this investigation
node --test tests/provider-timeline-host-regression.diagnostic.mjs
```

Real-host parity (optional, not a substitute for portable tests; both files MUST match the pinned SHA-256):

```sh
CIP_PASEO_PROVIDER_SOURCE=/path/to/extracted/plugin-provider.js \
CIP_PASEO_RENDERER_BUNDLE=/Applications/Paseo.app/Contents/Resources/app-dist/_expo/static/js/web/index-72553504501f81e1c6b8473200a1c78b.js \
node --test tests/provider-timeline-host-regression.diagnostic.mjs
```

Results on this Mac, isolated `/Users/penn/.npm/_npx/52027bd8fc0022aa/node_modules/node/bin/node` **v22.23.3**:

| Command variant | Exit | Passed | Failed | Skipped |
| --- | --- | ---: | ---: | ---: |
| Portable contract | 1 (expected RED) | 10 | 5 | 0 |
| Original installed daemon+renderer parity | 1 (expected RED) | 10 | 5 | 0 |
| `node --test tests/monitor-ping.test.mjs tests/native-activity.test.mjs tests/native-timeline.test.mjs tests/revision.test.mjs` | 0 | 34 | 0 | 0 |

All five deliberately failing assertions are **content duplication**, not fixture setup errors or a forced single-row check. The ten green controls include monotonic growth, interleaving, resumed session, source version, same-monitor sequencing, filter limitations and plugin upsert identity. A non-matching official host file SHA/version makes the optional parity test fail immediately; there is no silent fallback.

## 4. 设计决策（仅设计，尚未授权实现）

**Correctness goal:** every completed turn must show its exact verified final assistant text, and tools/status should remain live; do not solve it by hiding duplicate strings in the UI. A 0.11.4 assistant_message is **append-only after host conversion**. Correcting a previously published character is not possible with that event alone.

| Option | Streaming text | Correct final with arbitrary non-prefix edits? | Engineering/UX cost |
| --- | --- | --- | --- |
| A. Stabilize at source | Yes when source produces a stable prefix | Only if all source/native revisions really disappear | Smallest possible code change, but live root source is unproven |
| B. Monotonic guard only (startsWith/drop non-prefix) | Yes until divergence | **No** | Leaves stale/incorrect text or permanent truncation: the first 7-unit snapshot can differ at its last character from every later snapshot, so all later updates may be silently dropped |
| C. Hold back last N UTF-16 units and publish only stable prefix | Delayed/near-real-time | **No**; edits before already-published prefix are unrecoverable | Small/medium, tune latency and memory; a finite N cannot cover unbounded Markdown/formula/rewrites |
| D. Per-answer upsertable plugin timeline item, never a simultaneous native assistant stream | Yes | **No on Paseo 0.11.4**: machine result may be null or from a previous turn | Requires host-side final-result support in addition to text renderer; see section 5 |
| E. Only publish final native assistant_message after completion | No (tools and progress remain live) | **Yes** for verified final | Lowest code/protocol risk, but text is not streamed; waiting could last hours |
| F. Negotiate native assistant replacement protocol upstream | Yes | **Yes** after a verified host upgrade | High dependency/rollout scope; no host changes authorized |

**Upstream-first opportunity:** On the current code, sourceFor may choose view/entry, and a DIL reference can pass through context-sensitive unescapeFallbackMarkdown. If that formatting branch is confirmed in a scoped diagnostic, normalize a **single canonical source** and either defer unstable construct endings or create a stream-safe projection that does not retrospectively change published text. Never equate an unmodified raw fallbackMarkdown stream with an already-stable formatted stream; the new reader test disproves that assumption. Keep source IDs and end-turn proof intact. Source repair alone does not guarantee against genuine native revisions.

**Why filtering is insufficient:** At 7 → 177 units, LCP=6. Dropping the longer non-prefix text may leave an incorrect seventh unit forever; 177 → 250 and 250 → 393 repeat the risk. Buffering 64/128 units would protect those three *sampled* trailing edits if those bytes were not emitted yet, but cannot guarantee an arbitrary later change to an earlier position, nor can it safely rewrite previously displayed text. A policy that discards non-prefix updates must never mark the visible answer exact on completion.

**Superseded design candidate (NOT approved or sufficient on current public API):** use **one Chatmode-only, versioned, upsertable text plugin item per assistant message** for both live and final states, with the same stable identity and one canonical complete-text snapshot. index.client.tsx:9–10 already registers timeline renderers for generated-image and native-activity; the installed host reducer's plugin path supports upsert by identity. DESIGN-GREEN checks this with the original host mapper and reducer using a synthetic plugin card, not a working presentation layer. Add a narrowly scoped dedicated assistant-text renderer, **not** a global Paseo message override. Never emit the same live answer through native assistant_message as well: the two lanes must be mutually exclusive **from the first observation**. This would avoid the append-only *display* corruption while retaining live text, but **does not supply the native final answer**: installed Paseo getLastAssistantMessage only reads assistant_message rows. Without a separately approved host/interface extension this candidate is BLOCKED, regardless of Markdown/table fidelity, copy/select, accessibility, mobile layout, large answer limits, scroll behavior, reopens/history and version negotiation.

**Fallback if the dedicated renderer is too risky:** keep all activity/tool cards real-time and hold only assistant prose until terminal proof, then emit one exact final native assistant_message. This is the only correctness-guaranteed design using the existing native append-only assistant API with no new renderer; the visible tradeoff is loss of word-by-word prose progress.

**Suggested authorized implementation order (not performed):**

1. Prove whether source formatting/branch switching contributes to live tail changes using narrowly scoped non-content diagnostics; retain current identity/authorization fences. Run the new native-reader counterexample after any source change.
2. **Do not prototype plugin-only prose as a complete fix yet.** First obtain a host/SDK revision capability that satisfies both exact live replacement and native final-result consumers (section 5); then prototype the minimal supported design with green stable-growth, 7→177→250→393 field-shape, deep revision, live/interleaved cards, complete/reopen, late snapshots, cancellation, feature negotiation and browser tests.
3. Require exact-final, no-duplicate checks and UX acceptance on desktop/mobile. If the custom renderer is rejected, explicitly choose terminal-only text instead of pretending startsWith or bounded buffering solves arbitrary revisions.

**No production implementation, version increment, host modification, restart, message replay, commit, PR, push, merge or deployment was performed in this phase. Boss approval is required before each subsequent stage.**
