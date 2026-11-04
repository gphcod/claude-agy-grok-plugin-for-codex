# Codex-hosted 1.1.6: a Claude task with no shell

Owner date: 2026-11-03 Pacific. [Live record](../measurements/live-git-bash-1.1.6-windows.json), [matched benchmark](../measurements/benchmark-1.1.6-windows.json). Baseline v1.1.5 is 29f3a900aceffe51ca97a2360d0989bebc4c781d. Frozen runtime/test commit: 364763e17dfe1c6ad397d52a4b6ac93d02aabb84. Plugin hash: 75e97b40b1ccf202dfa8b46831cd6b47e57c10bac39a0138be0ad7c928c19e67. Later documentation commits do not change the plugin bytes.

Reviews ran on **Codex 6.1 Sol/high, Grok 4.7/high and Gemini 4 Argon/low**, the owner's settings for this session. Live tests ran on haiku low, the owner's rule being that low models are for testing and not for reviewing. The design reasons are in `docs/decisions.md`.

## The fault

A real Claude `task` listed no `Bash` in its init event, although the plugin passes it in `--tools` and `--allowedTools`. It ran no command and still ended `ok`, exit 0.

With the same flags and settings, only PATH decided it (Claude Code 2.1.316):

| First `git` on PATH | Where that PATH comes from | `Bash` offered |
|---|---|---|
| `D:\Apps\Git\mingw64\bin\git.exe` | Inside a Git Bash shell | No |
| `D:\Apps\Git\cmd\git.exe` | The real Windows PATH | Yes |

Why Claude Code misses Git Bash from the mingw copy is inferred; the location of `git` is what the results correlate with. Git Bash was installed throughout, at `D:\Apps\Git\bin\bash.exe`.

Ruled out by the same probes:

- **`CLAUDE_CODE_USE_POWERSHELL_TOOL=1`**, set in the owner's settings. `Bash` is offered with it set once Git Bash is found.
- **A missing Bash.** Git Bash is already built on MSYS2 (`bash 5.2.37 x86_64-pc-msys`), so installing MSYS2 would add nothing here.

## The fix

| Change | Where | Check |
|---|---|---|
| A task's child gets `CLAUDE_CODE_GIT_BASH_PATH`, only on Windows, only when the first `git` is a mingw copy and that install's `bash.exe` exists, and never over a value the caller set. | `providers/claude.mjs` | Each mingw flavour; a normal PATH, a set value, a missing `bash.exe`, no git and other platforms; only a task's child |
| A task whose init event offers no `Bash` ends in attention (exit 10) with its answer kept. A failed turn still fails. | `providers/claude.mjs` | Init cases; failures combined with no shell; two entry-level runs; the message's size |

## Reviews

- **Plan.** All three found nothing and agreed that attention is right for a finished task with no shell and that the mingw-only condition is right. Codex asked for regression cases combining a missing shell with failures, which were added. Grok noted that `clang64` is not in the list; a task that still has no `Bash` ends in attention rather than a silent `ok`.
- **Diff.** All three found nothing.

## Verification

- `npm run validate`: **639 total, 604 pass, 35 platform skips, zero failures**, from Git Bash (296.341 s) and from PowerShell (281.331 s), Windows 11 / Node 22.19.0. This includes 8 new tests in `tests/claude-git-bash.test.mjs`.
- The tests detect the faults. Giving the variable to every verb fails the task-only test. Removing the init check fails the two tests that expect it.
- Nine local neutral-core pins pass; no pinned module changed.
- Live on the frozen commit, Claude Code 2.1.316 at haiku low, throwaway repositories, scratch state roots, `CLAUDE_*` variables removed:

| Started with | `Bash` offered | The command ran | Result |
|---|---|---|---|
| First `git` the mingw copy, the Git Bash PATH | Yes | Yes | Exit 0, `ok`, `edited 1` |
| First `git` `cmd\git.exe`, the real Windows PATH | Yes | Yes | Exit 0, `ok`, `edited 1` |
| `CLAUDE_CODE_GIT_BASH_PATH` set to a path that does not exist | No | No | Exit 10, the new attention, `edited 0`; the caller's value was kept |

- Matched offline benchmark, 240 calls against v1.1.5 with fake CLIs: the 12 median differences range from -0.48% to +0.81%, with no consistent direction. The median of all 120 calls per arm is 2,186 ms for v1.1.5 and 2,137 ms for 1.1.6. Framing, fsyncs, process queries, inventory reads and metadata reads are identical. Review input shows +3 B, the same harness effect recorded for 1.1.4. Two p95s stand out, one in each arm: claude / discussion at 3.847 s for v1.1.5 and gemini / ask at 4.971 s for 1.1.6. Their medians moved +0.8% and -0.2%, and they were not rerun, so reading them as noise is an interpretation. The benchmark has no `task` workload, so it does not run the new lookup; read-only turns skip it by code.
- Runtime **5,369 lines / 31 files**, largest module 583 lines, CLI 267 lines; test source **12,645 lines / 85 files**. Compared with 1.1.5, runtime grows 14 lines and tests 121 lines. Skill **2,987 B**, description **128 B**; defaults, contracts and permissions are unchanged.

| Provider / workload | 1.1.5 median / p95 | 1.1.6 median / p95 | Framing B | Provider input B |
|---|---|---|---|---|
| claude / ask | 2.229 / 2.288 s | 2.233 / 2.280 s | 132 → 132 | 1527 → 1527 |
| claude / reply | 1.908 / 1.939 s | 1.913 / 1.948 s | 132 → 132 | 1527 → 1527 |
| claude / review | 2.074 / 2.108 s | 2.079 / 2.105 s | 185 → 185 | 5869 → 5872 |
| claude / discussion | 1.915 / 3.847 s | 1.930 / 1.995 s | 245 → 245 | 2708 → 2708 |
| gemini / ask | 2.545 / 2.805 s | 2.541 / 4.971 s | 133 → 133 | 1528 → 1528 |
| gemini / reply | 2.405 / 2.461 s | 2.393 / 2.849 s | 133 → 133 | 1528 → 1528 |
| gemini / review | 2.559 / 2.655 s | 2.562 / 2.625 s | 186 → 186 | 6203 → 6206 |
| gemini / discussion | 2.419 / 2.446 s | 2.422 / 2.495 s | 246 → 246 | 2992 → 2992 |
| grok / ask | 2.058 / 2.364 s | 2.054 / 2.098 s | 121 → 121 | 1526 → 1526 |
| grok / reply | 1.917 / 1.951 s | 1.928 / 1.963 s | 121 → 121 | 1526 → 1526 |
| grok / review | 2.197 / 2.230 s | 2.199 / 2.258 s | 174 → 174 | 4702 → 4705 |
| grok / discussion | 1.924 / 1.948 s | 1.932 / 1.984 s | 234 → 234 | 1501 → 1501 |

## Not verified

- A launch from the Codex app itself. The real Windows PATH with `CLAUDE_*` variables removed stands in for one.
- A real task longer than a heartbeat; these ran about 10 s. The 1.1.5 record's clean Claude turn was an `ask` for this reason, and that stays as recorded.
- Whether the `Bash` deny rules hold on this path. They are unchanged and were not rerun live.
- Other Git layouts, MSYS2 itself, Linux and macOS. On a layout the condition does not cover, a task with no `Bash` ends in attention rather than a silent `ok`.
- An earlier probe of `CLAUDE_CODE_GIT_BASH_PATH` appeared to show it not working. That was a test-script bug that mangled the path, and it is not part of this record.
