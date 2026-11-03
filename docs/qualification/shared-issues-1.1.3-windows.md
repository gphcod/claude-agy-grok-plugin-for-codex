# Codex-hosted 1.1.3: Claude-hosted rc.9 shared-issue audit

Owner date: 2026-11-03 Pacific. [Structured evidence](../measurements/shared-issues-1.1.3-windows.json). Baseline v1.1.2 is f177f224524b05395b577fcf48edd769dc10f29f. Frozen runtime/test commit: 567e62508523b4b5103e985a15aa06dfb7e230c3. All 42 plugin files hash to 85e391f1d5427786158a14225a958b1afcc0a3e44a7f95a00dee697c5d3bf7fc; later qualification commits change no plugin bytes.

Only **Claude Opus 5.5/high** and **Grok 4.7/high** were called for review. There was no native Gemini/Argon call. The Claude-hosted rc.9 fix commit was read without modifying that checkout.

## Assessment of all eight reported issues

| Item | Codex-hosted disposition | Verification |
|---|---|---|
| 1. Wrong conversation on reply --last | Fixed: an open/lost job blocks selection of an older conversation, including during admission. | Reproduced before the patch. Real Grok 4.7/high refused in 0.207 s with exit 2; after completion, the reply followed the newest thread at round 2/9. The older thread stayed at round 1. |
| 2. Closed stderr kills the companion | Fixed: stderr has the same write-error handler as stdout. | Real entry and closed pipe: baseline exited 1; corrected entry exits 0, writes done and renders its footer. |
| 3. Locked record bypasses non-resumable refusal | Already protected by strict JSON reads and five-second lock retries; native/provider-id validation was missing and is added. | Persistent mocked EBUSY fails closed. Invalid references perform zero record reads. An actual Windows thread-record read lock was not produced. |
| 4. Git diff settings corrupt coverage | Already protected by canonical PATCH_FLAGS for every target mode. No collector change. | noprefix and mnemonicPrefix for working tree, commit and base; real submodules under log and diff. All four tests pass on the baseline and final code. |
| 5. Unstarted resume changes thread state | Fixed, including later inheritance and pruned-history cases. | Sync/async spawn errors, throwing beforeTurn and pre-spawn cancel leave metadata unchanged; started failures still count. A real companion killed before spawn and then cancelled leaves inheritance unchanged. |
| 6. Early unconfirmed Gemini 503 is retryable | Fixed in lifecycle finalization; the shared service helper remains unchanged. | Native-shaped fake agy through the real entry offers no retry; same-id replay submits nothing. |
| 7. Priority marker in a Codex finding body | Not applicable: no Codex provider or native Codex finding parser is shipped here. | Provider inventory/source inspection. |
| 8. Pruning fails a new turn | Admission already catches helper errors. The helper is additionally hardened, without claiming this host previously aborted a new turn. | Both claim checks retain unreadable jobs. A late obstruction aborts deletion before older snapshot owners of a retained dependent can be removed. |

## Additional review findings and rulings

- Claude F1 MAJOR, accepted: replying by an unstarted job id after started history was pruned still fell back to that job. The fallback is now null, so the retained thread record supplies workspace/settings/round/agent. The regression reproduces the failure and passes after the fix.
- Claude F2 MINOR, accepted: a companion killed after admission but before spawn left start evidence unknown. Admission now persists providerStarted:false; the durable spawnAttempted write clears it at the actual spawn boundary. Current proven-unstarted jobs are excluded from inheritance, while unknown legacy/spawn-window state stays conservative. Control lookup still finds active preparations.
- Claude F3 MINOR, accepted: with neither started history nor a retained record, the new null fallback could use the caller's workspace/defaults. Both job-id and native-id paths now refuse with a new-ask instruction. A late-pruning dependency case raised during closing review was also reproduced and fixed by aborting the remaining older deletion pass.

Claude's initial review statically read source but had no git/shell tool; it did not inspect git show. Its two closing rounds reviewed embedded code, confirmed F1/F2 and then closed F3 and late-pruning retention. Grok's file-based and broader embedded reviews reached their 300/240-second deadlines and are **not approvals**. Its final focused embedded review completed at Grok 4.7/high and found no actionable issue in the missing-history refusal/late-pruning fixes. Neither closing review is a blanket approval of unprovided code; the primary agent ran the tests below.

## Final verification

- npm run validate: **607 total, 571 pass, 36 platform skips, zero failures**, 305.977 s on Windows 11 / Node 22.19.0. This includes 22 new regressions. The final frozen plugin bytes remained unchanged.
- Nine local neutral-core pins pass; full cross-host core parity remains deferred. The shared service and request-publication helper hashes remain unchanged.
- Live Grok check: three successful model submissions (older ask, newer ask, newest-thread reply) and one refused pre-confirmation reply with no job/provider submission; all completed calls confirm cleanup. Both requested model/effort settings were verified in review metadata.
- Healthy fake ask framing remains Claude/Gemini/Grok **132/133/121 B**. Skill **2,987 B**, description **128 B**; defaults/contracts/permissions are unchanged. This is a byte check, not a new native-token, cost or latency benchmark.
- Runtime **5,301 lines / 31 files**, largest module 560 lines, CLI 267 lines; test source **12,155 lines / 82 files**. Compared with 1.1.2, runtime grows 20 lines and tests 277 lines. Conservative prune aborts may delay housekeeping until a later pass.

Exact-payload macOS, desktop discovery/wake and the Windows npm Grok shim remain unqualified; Linux is optional. Early Gemini 503 and thread-lock coverage is fake/mocked, as requested without a live Argon call. The earlier 1.1.0 efficiency study and 1.1.2 outage/Windows-publication qualification retain their own dates and scope.
