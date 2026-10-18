# Legacy browser/MV3 suites (archived)

These scripts target the **pre-continuous-sync** extension protocol: `CIP_DOM.state`,
`CIP_DOM.pageStatus`, `CIP_DOM.messages`, the `kind:'observation'` monitor IPC, the
`/event` receipt lane, the `native-activity` card, or imported external turns.
Those interfaces were removed by the continuous page-view architecture, so the
scripts fail for contract reasons, not production regressions. They are kept for
history and are **not** part of any acceptance claim. `ROOT`/relative imports were
not rewritten for the new location.

| Script | Why archived | Current coverage |
|---|---|---|
| `dom-audit.py` | `CIP_DOM.state` / adapter audit | `page-content-browser.py`, `button-state-browser.py` |
| `browser-fixture.py` | `CIP_DOM.state` | `page-content-browser.py`, `page-observation` Node tests |
| `native-transplant.py` | old private-transcript reader assertions | `public-message-browser.py`, `page-content-browser.py` |
| `binding-identity-browser.py` | old receipt/identity lane | `continuous-binding.test.mjs`, `late-browser-receipt.test.mjs` |
| `receipt-shell-browser.py` | `/event` receipts | `/page-view` HTTP tests (`completed-message-http.test.mjs`) |
| `receipt-navigation-browser.py` | `kind:'observation'` monitor | `continuous-monitor.test.mjs`, page-view HTTP |
| `apps-headless.py` | `CIP_DOM.state` | `catalog`/`session.configure` in Node + `catalog-browser-regression.py` |
| `browser-provider-flow.py` | `/event` + old lanes | `continuous-provider.test.mjs`, `/page-view` HTTP |
| `images-public-browser.py` | old image lane | `artifacts.test.mjs`, `artifact-transfer.test.mjs`, `artifact-browser.py` |
| `binding-mv3-flow.py` | `native-activity`, redacted tool detail, old `/commands` shape | current MV3 **not re-covered end-to-end**; see gap below |
| `citation-transcript-browser.py` | `CIP_DOM.pageStatus` | `citations.test.mjs` + current source projection |
| `strict-browser.py` | `CIP_DOM.state` + native-activity | `strict-regression.test.mjs`, `TIMELINE-04` |
| `concurrency-reopen-mv3.py` | old turn identity/`nativeMessageId` shape | `concurrency-reopen.test.mjs` (Node) |
| `images-mv3-flow.py` | old image completion lane | artifacts suites |
| `native-activity-mv3.py` | native-activity card removed | `native-activity.test.mjs` (current), page-state + tool sources |
| `native-terminal-mv3.py` | old terminal/no-Stop rule | `CM-R7/R8`, `CONTOBS-10` |
| `quick-tools-mv3.py` | old `nativeMessageId`/app flow | `I01–I06`, `TURN-D`, `session.configure` |
| `send-evidence-mv3.py` | old evidence/redaction lane | `send-observation-safety.test.mjs`, `send-evidence-browser.py` |

## Gap (must be closed before deployment)

There is **no current end-to-end MV3 test** that loads the real unpacked extension,
background worker, MAIN/ISOLATED scripts and Runtime with the continuous
`/observations` + `/page-view` protocol. The passing MV3 scripts
(`eight-tabs-mv3.py`, `manual-reload-mv3-flow.py`, `upload-isolated-world-mv3.py`)
cover narrower MV3 pieces. Real Chrome installation-state acceptance must be
re-established before deployment; until then, offline/Chromium-adapter results
must not be presented as MV3 acceptance.

## Archived host diagnostics

`provider-timeline-host-regression.diagnostic.mjs` and
`provider-upsert-interface-gate.diagnostic.mjs` probed the removed
`broker.observe` message lane to characterise host delta/merge behaviour. Their
GREEN cases are now covered by the real-host gate
(`tests/host-observation-current.mjs`) and by `PD-*`/`CM-*`; their RED cases
document host limitations (cross-run tool-card merge, native final-text
contract) that are still recorded in `docs/IN_PLACE_RECOVERY_PLAN.md`,
`docs/CONTINUOUS_SYNC_HOST_GATE.md` and `docs/PROSE_2B_PROGRESS.md`. They are
not runnable against the current provider without the same lane migration.

### MV3 probe result (2026-10-18)

`binding-mv3-flow.py` was run as a probe with only its first assertion relaxed. It
reaches a real Send and a completed run through the actual unpacked MV3
extension + worker + Node Runtime. The resulting session state shows why the old
assertions cannot simply be updated:

- `turn.nativeMessageId` is absent and the page-state card reports
  `DOM_LOCAL_IDENTITY` — the fixture's user/assistant rows are not being read
  under their `data-message-id` identities.
- The Paseo-context user text appears twice as page-sourced user messages
  (`fallback-turn-…:user` and `native-turn-…:user`) in addition to the Paseo
  echo.
- The fixture answer was not yet in history when the run completed, because the
  current observer timer (750ms) and the fixture's 350ms reply raced the read.

So the MV3 gap is not just stale assertions: the fixture and the observation
timing need a current end-to-end harness. Do not present the legacy probe as MV3
acceptance.

### Update: MV3 gap closed at fixture level

`tests/binding-mv3-current.py` now loads the real unpacked extension, worker,
MAIN/ISOLATED worlds and the real Runtime against the stock fixture and asserts
the current contract (one echo + one assistant body, reload without a second
Send, second turn, ChatGPT-typed message observed without a Paseo Send). The
remaining deployment requirement is to re-run the same assertions against a real
signed-in ChatGPT page and real Paseo UI.
