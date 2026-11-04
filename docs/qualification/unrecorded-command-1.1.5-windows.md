# Codex-hosted 1.1.5: a command a lost turn left running

Owner date: 2026-11-03 Pacific. [Live record](../measurements/live-unrecorded-1.1.5-windows.json), [matched benchmark](../measurements/benchmark-1.1.5-windows.json). Baseline v1.1.4 is d6c7f6a25849345e9492c9fea876f40fe5529749. Frozen runtime/test commit: d74d36653e9139b217ecdfeddd679471b20ad585. Plugin hash: 6c8fb4fae16000e21cbb05999ac74440fc8b70abf4aff810b8f7a961d887e7c6. Later documentation commits do not change the plugin bytes.

Reviews ran on **Codex 6.1 Sol/high, Grok 4.7/high and Gemini 4 Argon/low**, the owner's settings for this session. Live tests ran on the cheap models, the owner's rule being that those are for testing and not for reviewing. The design reasons are in `docs/decisions.md`.

## The fault

On Windows, Grok and its PowerShell wrapper end by themselves within about a second of losing the companion. The command the agent started keeps running with no living parent, and Windows does not reparent. `persistDescendants` returned at once on `win32`, so `job.execution` stayed empty. `cancel` found nothing linking the command to the job and reported `cancelled`, exit 0, cleanup not pending, with the command still alive.

A normal `cancel`, with the companion alive, was never affected: it snapshots the descendants first and stops the whole tree.

## The fix

| Change | Where | Check |
|---|---|---|
| Heartbeats record the turn's processes on Windows too. A turn shorter than one heartbeat (10 s) makes no extra query. The list is saved only when it grows. | `lifecycle.mjs` | Windows heartbeat test; end-to-end kill of a real companion and provider |
| A recovering `cancel` warns that a command no heartbeat recorded may still be running, as text and as a `warning` JSON field. It has no time limit in it, is never in `job.error`, and does not print on a repeat `cancel` or when the provider never started. | `lifecycle.mjs`, `council.mjs` | Orphan never signalled; repeat; never-started cases |
| A recorded process alive after a clean exit gets up to 5 s before it counts as a survivor, and each scan's rows are saved before the next look. One that stays is stopped and fails the turn. | `lifecycle.mjs` | Helper exiting by itself; survivor; wrapper exiting during the wait; failed query during the wait |
| On macOS a saved identity counts only with a recorded leader, so without one there is no wait and the first scan's processes are stopped at once. | `lifecycle.mjs` | Fake-provider test with the platform set to darwin |
| The notes saying a session on Grok's default agent cannot switch to explore are corrected. Behaviour is unchanged. | `grok.mjs`, `lifecycle.mjs` | None needed |

## Behaviour change

On Windows, a process that a task leaves running on purpose, such as a dev server, and that lived across a heartbeat now ends with the turn: it is stopped and the turn fails with `owned execution survived the launcher`. This plugin's Linux and macOS paths already did this. So does the Claude-hosted plugin, except after a clean Codex exit on Windows, which it trusts and does not scan. It rests on the code and fake-provider tests and was not run live.

## Reviews

- **Plan.** Codex showed that the warning's first wording, "started in the last seconds", understated the gap, because a shell can start a detached command and exit between two heartbeats; the warning now has no time limit. Codex and Gemini asked for the wait after a clean exit. Grok would have added it only if a live check failed; it was added, because the code path is plain and it costs nothing unless the first scan finds a process. Gemini and Grok narrowed where the warning prints and which decision text to edit. Gemini's option of not failing a turn after a successful stop was rejected; Codex and Grok kept the rule.
- **Diff.** Codex and Grok found independently that the new wait could lose a command known only through a wrapper that exits during it. Each scan's rows are now saved first. Gemini found nothing.
- **Fix.** Grok then found that on macOS without a recorded leader a saved identity proves nothing, so the same loss remained there. There is now no wait on that path. Codex and Gemini found nothing in the first fix, and all three found nothing in the second.

## Verification

- `npm run validate`: **631 total, 596 pass, 35 platform skips, zero failures**, from Git Bash (297.848 s) and from PowerShell (281.080 s), Windows 11 / Node 22.19.0. This includes 9 new tests in `tests/core-unrecorded-command.test.mjs`, and the heartbeat test in `tests/core-review-fixes.test.mjs` now also runs on Windows.
- The tests detect the faults. Restoring the `win32` return fails the Windows heartbeat test and the end-to-end test. Removing the save during the wait fails the wrapper and failed-query tests. Removing the macOS check fails its test.
- Nine local neutral-core pins pass; no pinned module changed.
- Live on the frozen commit, Grok 1.0.70, throwaway repository, scratch state root, five submitted turns:

| Check | Result |
|---|---|
| Companion killed 25 s after the command started | Grok and its wrapper had gone and the command was alive. `job.execution` held grok, conhost, pwsh, conhost and node. `cancel` exited 0 with the warning, and the command was gone when checked 2 s later |
| Companion killed right after the command started, before the first heartbeat | `job.execution` was empty. The command survived `cancel`, which exited 0 with the warning. The script then stopped it |
| Clean `task`, grok-4.6 low, 26 s with a 15 s command | `ok`, processes recorded, nothing left |
| Clean `task`, gemini-3.8-flash low, 36 s with a 15 s command | `ok`, processes recorded, nothing left |
| Clean `ask`, haiku low, 34 s | `ok`, claude and conhost recorded, nothing left. An `ask` with a long answer, because a real Claude `task` here listed no shell tool (see below) |

- Matched offline benchmark, 240 calls against v1.1.4 with fake CLIs: the 12 median differences range from -0.63% to +1.19%, with no consistent direction. The median of all 120 calls per arm is 2,117 ms for v1.1.4 and 2,112 ms for 1.1.5. Framing, fsyncs, process queries, inventory reads and metadata reads are identical. Review input shows +3 B, the same harness effect recorded for 1.1.4.
- **The benchmark cannot show the new cost.** Its fake turns are shorter than a heartbeat. A longer turn now makes one synchronous whole-table process query every 10 s, which took 640-870 ms over eight runs on this machine with 409 processes, as the live record notes. For that time the companion does not read provider output or check for a cancel. The provider is not blocked unless its output pipe fills. This was not measured end to end.
- Runtime **5,355 lines / 31 files**, largest module 583 lines, CLI 267 lines; test source **12,524 lines / 84 files**. Compared with 1.1.4, runtime grows 17 lines and tests 137 lines. Skill **2,987 B**, description **128 B**; defaults, contracts and permissions are unchanged.

| Provider / workload | 1.1.4 median / p95 | 1.1.5 median / p95 | Framing B | Provider input B |
|---|---|---|---|---|
| claude / ask | 2.175 / 2.249 s | 2.161 / 2.239 s | 132 → 132 | 1527 → 1527 |
| claude / reply | 1.852 / 1.934 s | 1.869 / 1.903 s | 132 → 132 | 1527 → 1527 |
| claude / review | 2.023 / 2.114 s | 2.023 / 2.099 s | 185 → 185 | 5869 → 5872 |
| claude / discussion | 1.867 / 1.928 s | 1.869 / 1.894 s | 245 → 245 | 2708 → 2708 |
| gemini / ask | 2.486 / 2.526 s | 2.477 / 2.506 s | 133 → 133 | 1528 → 1528 |
| gemini / reply | 2.338 / 2.398 s | 2.365 / 2.377 s | 133 → 133 | 1528 → 1528 |
| gemini / review | 2.508 / 2.601 s | 2.524 / 2.550 s | 186 → 186 | 6203 → 6206 |
| gemini / discussion | 2.347 / 2.438 s | 2.374 / 2.510 s | 246 → 246 | 2992 → 2992 |
| grok / ask | 1.998 / 2.050 s | 1.994 / 2.017 s | 121 → 121 | 1526 → 1526 |
| grok / reply | 1.857 / 1.914 s | 1.868 / 1.928 s | 121 → 121 | 1526 → 1526 |
| grok / review | 2.135 / 2.218 s | 2.143 / 2.172 s | 174 → 174 | 4702 → 4705 |
| grok / discussion | 1.868 / 1.941 s | 1.872 / 1.900 s | 234 → 234 | 1501 → 1501 |

## Not verified

- **The remaining gap is real.** A command started since the last heartbeat, or started and orphaned between two heartbeats, keeps running. The second live row shows it. `cancel` warns and cannot do more, because nothing it can read links that process to the job.
- The live commands only slept, so whether a surviving command could go on editing files is inferred.
- The cause, Grok and its wrapper ending by themselves, is observed in the process table. Why they end is inferred.
- No live turn hit the new wait, so how often a recorded helper is still exiting at the scan is unknown. It is covered by fake-provider tests only.
- Other providers through a lost companion were not run live; only Grok was. Their clean long turns were.
- **A real Claude `task` here listed no shell tool.** One probe at haiku low passed `--tools` and `--allowedTools` with `Bash`, yet the init event listed Edit, Glob, Grep, NotebookEdit, Read and Write. So no Claude command ran in these checks. It was launched from a Claude Code session's shell and not from Codex, so whether a Codex-launched `task` is the same was not examined. It is separate from this fix.
- grok-4.7, Linux and macOS were not run live. Exact-payload macOS, desktop discovery/wake and the Windows npm Grok shim remain unqualified.
- A first pass of the clean turns ran both plugins at once with the same durations, so each could match and stop the other's command. It was discarded, and the turns above ran one at a time with unique durations.
