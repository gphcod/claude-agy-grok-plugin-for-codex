# Council for Codex

One Codex plugin, `council`, through which Codex calls Claude Code (`claude`), Gemini (`agy`, the Antigravity CLI) and Grok (`grok`) for questions, discussions, reviews and user-authorized tasks, choosing provider, model and thinking effort per call. It replaces three single-provider Codex plugins (claude_plugin_for_codex 0.5.0, grok_plugin_for_codex 1.1.0, gemini-plugin-for-codex 0.1.2) and is the Codex-hosted twin of [Council for Claude Code](https://github.com/gphcod/codex-agy-grok-plugin-for-claude).

Status: release candidate `1.0.0-rc.4`. macOS passes the test suites, the installed scripts against the real CLIs and the route inside a Codex chat (`docs/qualification/macos-check.md`); Windows 11 passes the test suites and the installed scripts against the real CLIs, and one Grok turn inside `codex exec` (`docs/qualification/windows.md`); Claude and Gemini turns inside Codex are still to run there.

## Install

```bash
codex plugin marketplace add gphcod/claude-agy-grok-plugin-for-codex --ref v1.0.0
codex plugin add council@council-for-codex
```

A Git marketplace follows its `ref` in `~/.codex/config.toml` and refreshes in the background, so pin a release tag. The pinned form in `config.toml`:

```toml
[marketplaces.council-for-codex]
source_type = "git"
source = "https://github.com/gphcod/claude-agy-grok-plugin-for-codex.git"
ref = "v1.0.0"

[plugins."council@council-for-codex"]
enabled = true
```

For a local checkout, `codex plugin marketplace add /absolute/path/to/claude-agy-grok-plugin-for-codex` instead of the Git form. Start a new Codex chat after installing; the skill is `$council`.

Requires Node.js 22.19.0 or later, plus the `claude`, `agy` and `grok` CLIs installed and logged in (any subset works; `setup` reports the rest). The plugin has no runtime dependencies. Check the installation with `$council setup`.

## Call forms

Codex runs one shell call per exchange; the call blocks until the model answers. `<plugin>` is the absolute path of `plugins/council`. Flags go before `--`; the text follows.

POSIX shell:

```sh
node "<plugin>/scripts/council.mjs" ask --to grok --tier consult -- <<'COUNCIL_EOF'
<text>
COUNCIL_EOF
```

PowerShell (the trailing `exit $LASTEXITCODE` keeps the exit code):

```powershell
@'
<text>
'@ | node "<plugin>\scripts\council.mjs" ask --to grok --tier consult --; exit $LASTEXITCODE
```

- If the delimiter occurs alone on a line of the text, pick another one.
- Text over 64 KiB, or in PowerShell over 16 KiB, with non-ASCII characters or with a line starting a quote (straight or curly) and then `@`, goes in a UTF-8 file: `--prompt-file <path>` with stdin `</dev/null` (`$null |` in PowerShell). Requests are capped at 8 MiB.
- A call that carries no text and no `--` (bare `review`, `reply <job> --next-input`, `wait`, `cancel`, `models`, `setup`) reads no stdin and does not wait for it.

Both forms are exercised end to end by `npm run test:e2e` (PowerShell on Windows).

## Verbs

| Verb | Does | Mode |
|---|---|---|
| `ask --to <p>` | New thread, one answer | read-only |
| `reply <job\|thread>`, `reply --thread <id>`, `reply --last` | Delta on an existing thread; the provider is inherited and a conflicting `--to` exits 2; model, effort and tier are inherited unless given | read-only, also after a task |
| `reply <job> --next-input` | Sends the next saved review batch, then the synthesis pass; takes no text and spends no round | read-only |
| `review --to <p> [--base <ref> \| --commit <sha> \| --uncommitted] [--adversarial] [-- focus]` | Structured review from a hash-checked snapshot, delivered in batches of at most 180,000 B | read-only |
| `task --to <p> [--thread <job>] [--allow-command <exact>]…` | Delegated work that may edit the working tree; only when the user authorizes it. `--allow-command` is Gemini-only | edit |
| `wait [job] [--timeout <s>]` | Lists this session's jobs, or awaits one and replays its result; exit 20 when still running. Only after a lost shell handle | — |
| `cancel [job] [--confirm-ended]` | Stops a job and confirms cleanup | — |
| `models [--to <p>] [--refresh]` | The catalog; `--refresh` re-runs `agy models` and `grok models` (Claude has no listing) | — |
| `setup [--to <p>] [--live] [--set <policy.json>]` | Binary, launcher kind, version, login, tiers, sandbox preflight and trade-offs; `--live` makes one paid minimal call per provider; `--set` stores the Claude policy | — |

`wait` and `cancel` start no provider CLI; `models` reads static and cached data unless `--refresh`.

Bare `review` and `--uncommitted` review the working tree against `HEAD` plus untracked files (a clean tree exits 2 `nothing to review`; there is no fallback to a default branch). `--base <ref>` reviews from the merge base with `HEAD`; `--commit <sha>` reviews one commit (first parent for a merge). A shallow clone that lacks the needed history exits 2. Binary, non-UTF-8, submodule and oversized entries are reported as `unreviewed N`, never approved.

## Flags

- `--to claude|gemini|grok`: required on `ask`, `review`, `task`. No inference from the model name.
- `--model <id|alias>`: an exact CLI id or an alias (`fable`, `opus`, `sonnet`, `haiku`, `default`; `argon`, `flash`; `4.7`, `4.6`, `build-fast`). An unknown id passes through and the footer says `model unverified`. `default` means the user's configured Claude model (no `--model` flag); the footer then shows the model Claude reports.
- `--effort low|medium|high|xhigh|max`: one vocabulary. Council clamps downward only, against the model's offered efforts, and shows the clamp in the footer (`gemini-4-argon/high<=xhigh`). Claude accepts all five; Grok tops at `xhigh`; Gemini at `high`. A Gemini effort-suffixed id (`gemini-4-argon-high`) is an explicit effort, and a conflicting `--effort` exits 2.
- `--tier consult|exec|deep`: defaults below; explicit `--model`/`--effort` win; on `reply` an explicit `--tier` overrides the inherited settings.
- `--request-id <id>` (1 to 128 characters, `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`): a repeat with the same input replays the first result and never starts a second CLI; changed input under the same id exits 2. Give one to every review, task, `exec`-tier, deep, `xhigh` or `max` call.
- `--rounds <n>` (or `COUNCIL_CODEX_ROUNDS`): the reply budget, 9 by default.
- `--deadline <s>` (default 14400) and `--inactivity-timeout <s>` (default 1200) start cleanup; `wait --timeout <s>` (default 90) only returns 20. agy's `--print-timeout` is derived from the deadline.
- `--web`: web search, off by default. Grok omits `--disable-web-search`; Claude adds `WebFetch,WebSearch`; Gemini refuses it (exit 2, see trade-offs).
- `--json`: one JSON object (`provider`, `job`, `thread`, `session`, `model`, `modelVerified`, `effort`, `requestedEffort`, `tier`, `round`, `rounds`, `verdict`, `findings`, `coverage`, `batch`, `edited`, `failedCommands`, `costUsd`, `attention`, `exit`, `answerFile`, …).
- `--prompt-file <path>`, `--cwd <dir>`, `--thread <id>`, `--last`.
- Provider-scoped, refused with exit 2 elsewhere and before any job record: `--max-turns <n>` (Claude; review 2, ask/reply 20, task 30 by default; 1 to 100), `--max-budget-usd <n>` (Claude), `--allow-command <exact>` (`task --to gemini` only), `--set` and `--live` (`setup`), `--confirm-ended` (`cancel`).

## Tiers

| Provider | consult | exec | deep |
|---|---|---|---|
| claude | default / high | sonnet / high | default / xhigh |
| grok | grok-4.7 / high | grok-4.7-build-fast / xhigh | grok-4.7 / xhigh |
| gemini | gemini-4-argon / high | gemini-3.8-flash / high | gemini-4-argon / high |

Gemini has no effort above `high`, so its consult and deep tiers coincide. New threads default to `consult`, `task` to `exec`. The footer always prints the model and effort actually used.

## Skill policy

The skill (`plugins/council/skills/council/SKILL.md`, the only model-visible file, under 3,000 B) tells Codex:

- When the user named no model: `ask`, `reply` and `review` only, with `--tier consult`; ask once before a higher effort (not for Gemini); never `task`, never `cancel --confirm-ended`. When the user named a model or family: choose the tier by complexity.
- A `task` only when the user authorizes edits, at its default tier `exec`; bare `wait` lists this session's jobs; on exit 10 read the footer's `attention:`.
- Discussion: findings numbered F1, F2, tagged BLOCKER, MAJOR or MINOR with `file:line`; replies carry only `AGREE`, `CHANGE: …`, `REJECT: …` and new facts; stop when nothing changes or at the round budget; an unresolved REJECT is reported as disagreement. Codex rules on each finding: accepted, rejected or needs-user-waiver.
- Fan-out: one `ask` per provider, issued as parallel shell calls in one turn, each with its own `--request-id` and the same brief; follow-ups use `reply <job>`, never `--last`. Codex CLI 0.163 runs the shell calls of one turn in parallel (S1.4 probe, `docs/spike/codex-host.md`).

## Output, exit codes, blocking

Start line on stderr: `[council] provider=<p> job=<id> thread=<native id|?>[ target=<review target>]`. The answer (a 24 KiB preview; `full: <file>` names the whole answer) is followed by one footer line:

```
council <provider> <ok|needs attention|failed|cancelled> · job <16 chars> · <model>/<effort>[<=requested] · <duration>[ · round N/M][ · edited N][ · unreviewed N][ · batch i/n][ · model unverified][ · full: <file>][ · error: <msg> | · attention: <reason>][ · <recovery hint>]
```

| Exit | Meaning |
|---|---|
| 0 | done |
| 10 | needs attention: review findings, pending or unreviewed coverage, a denied action, an incomplete turn, incomplete or malformed review output, an answer whose `Open questions:` line is not `none`, `cancel --confirm-ended` refused because an owned process is live. Except for findings and coverage, the footer says why: `attention: denied <tool>(<what>)[ (+N more)]`, the incomplete message, or `attention: open questions in the answer` |
| 20 | still running: `wait` timed out, a replayed `--request-id` whose first call is still preparing, or a `cancel` that finds another cancel's deferred cleanup hook still running; nothing was stopped |
| 1 | failed, cancelled, busy, or `preflight_blocked` |
| 2 | invalid input |

Blocking and collection: a call blocks until the model answers, since Codex delivers no completion for a yielded command. If the shell yields, keep collecting the same shell session with the longest wait allowed; use `wait <job>` only after losing the handle; never resubmit (a resubmission with the same `--request-id` would only replay).

Recovery hints in the footer: `next: reply <job> --next-input` (review batches pending), `cleanup pending; next: cancel <job>; do not resume`, `thread locked; next: cancel <job> --confirm-ended after checking the process table; do not resume`, `session not confirmed: start a new ask`, `thread not confirmed; start a new ask`, `coverage unknown`.

## State and recovery

State lives under `~/.codex/council/` (override `COUNCIL_CODEX_HOME`), never in the plugin directory or the workspace (a state root inside the workspace exits 1): `jobs/`, `claims/<provider>/<thread>`, `threads/<provider>-<thread>.json`, `requests/`, `catalog/`, `preflight/`, `trash/`, `policy.json`.

- `--last`, bare `wait` and bare `cancel` are scoped to the current directory (realpath) and the Codex session (`CODEX_THREAD_ID`); a named job id is found across sessions. A native thread is never adopted across workspaces, and a bare native id known for several providers needs `--to`.
- Thread records keep provider, model, effort, tier, round and budget, web and policy version; they are never pruned. Finished job bodies past 100 are pruned through `trash/`; running, lost, cleanup-pending, claim-holding and review-input-pending jobs never are.
- A lost (companion gone) or cleanup-pending job blocks its thread until `cancel <job>` confirms. While the owner companion lives, `cancel` asks it to stop its child; when the owner is gone, `cancel` stops the child through a creation-time-verified identity, marks the job stopped and releases the thread. It never signals a live companion or an unverified process.
- Held output: a child that exits cleanly while something keeps its output open for 12 s marks the job `thread locked`. Only `cancel <job> --confirm-ended` releases that lock, and only after the process table shows neither the owner companion nor any identified child; it refuses with exit 10 otherwise, or when the query fails. It is a user decision: the skill never runs it on its own.
- An unconfirmed session (Grok ended without naming its session) keeps the answer and exit code, but the thread is not resumable: `reply`, `reply --last` and `task --thread` exit 2 with the hint.
- Never delete state by hand.

## Sandbox and preflight

The companion runs inside Codex's sandbox. Before any submission it checks the resources the provider needs; a blocked one exits 1 with `preflight_blocked` and one resource-specific `action:` line, never `cleanup pending`, and zero submissions. The line grants no escalation. Probe results are cached under `preflight/` by executable path, size and modification time, so a warm call starts no probe; filesystem, listener and process-table checks run every call.

Each provider checks council's state root first, so the action line names the real cause. The two right-hand columns are the outcomes measured inside real Codex sessions (codex-cli 0.163.0, macOS) on 2026-11-01 (`docs/spike/codex-host.md`, S1.4); "not measured" means the probe did not run that exact check.

| Provider | Resource | Check | Cached | `workspace-write` | `danger-full-access` |
|---|---|---|---|---|---|
| all | the state root `~/.codex/council` (`COUNCIL_CODEX_HOME`) | directory writable; checked first, before any write | no | **blocked** (EPERM) | ok |
| claude | `<CLAUDE_CONFIG_DIR or ~/.claude>/projects` | directory writable (Claude stores sessions there) | no | **blocked** (EPERM) | ok |
| claude | `claude --version`, `auth status --json`, `--help` (every flag council passes), a deliberate missing-file capability failure | four non-billable probes, no model call | yes | `auth status` **exit 1**; the others not measured | `auth status` exit 0 |
| claude | `ANTHROPIC_BASE_URL` or `https://api.anthropic.com` | network reachable (unverified behind a proxy variable) | yes | **blocked** (network disabled) | ok |
| gemini | `~/.gemini/antigravity-cli/` | directory writable (agy's backend state) | no | **blocked** (EPERM) | ok |
| gemini | `127.0.0.1` | loopback listener can bind | no | **blocked** (EPERM) | ok |
| gemini | `ps` | process table readable | no | **blocked** (exit 127) | ok |
| gemini | `agy --version`, `agy models` | non-billable probes (login evidence) | yes | `agy models` **exit 1** | ok |
| gemini | `https://generativelanguage.googleapis.com/` | network reachable (provisional target) | yes | not measured; the network is disabled | not measured |
| grok | `~/.grok/auth.json` | readable (skipped when `GROK_API_KEY` is set) | no | ok | ok |
| grok | `ps`, or PowerShell `Win32_Process` on Windows | process table readable | no | **blocked** (exit 127) | ok |
| grok | `grok --version`, `grok models` | non-billable probes (`not logged in` blocks) | yes | not measured | not measured |

**Under `workspace-write`, council cannot run any provider:** its own state root and the network are blocked (and so are Claude's session storage, agy's directory, the loopback listener and the process table). Every turn stops at once with `preflight_blocked` naming the state root, and nothing is submitted. Run Codex with `--sandbox danger-full-access`, or keep `workspace-write` and add `~/.codex/council` plus each provider's directories (`~/.claude`, `~/.gemini/antigravity-cli`, `~/.grok`) as writable roots and enable network; the loopback listener (agy) and the process table (all providers' cleanup) must also be allowed, and they were blocked in the measured `workspace-write` session. Windows session A had shown the same for Grok (login and process query blocked under `workspace-write`).

Every provider child, probe and preflight probe carries the five guard variables `COUNCIL_DEPTH`, `CLAUDE_PLUGIN_CODEX_DEPTH`, `GROK_CODEX_DEPTH`, `GROK_BUILD_DEPTH` and `AGY_BRIDGE_DEPTH`, and council refuses to start when any is set, so neither council nor the three replaced plugins can nest from a child.

## Providers and read-only enforcement

| Provider | Read-only turns | Tasks |
|---|---|---|
| claude | `--tools Read,Glob,Grep`, `--permission-mode dontAsk --permission-prompts none`, hooks off, empty strict MCP config, `--setting-sources user`, `--no-chrome`; the standing contract via `--append-system-prompt-file`, the verb's instructions in the input | `acceptEdits` with Read, Glob, Grep, Edit, Write, MultiEdit, NotebookEdit, Bash; `git push`, `git reset --hard`, `rm -rf`, `sudo` denied; hooks and MCP off |
| gemini | `--settings` file from the user's global lists with read-only rules (`write_file`, `edit_file`, `command`, `unsandboxed`, `mcp`, `execute_url` denied), `--sandbox` | `--mode accept-edits`; `--allow-command X` adds `command(X)`/`unsandboxed(X)` and sets `toolPermission` to `request-review` unless the global value is `strict`; a task without it keeps the global value |
| grok | `--agent explore` (or the resume deny list after an edit turn), `--deny MCPTool(*)`, hostile tools disallowed, `--no-subagents`, `--disable-web-search` | default agent, `--deny "Bash(git push*)"`, `--deny "Bash(rm -rf *)"` |

The current verb's permissions are enforced on every launch, so a `reply` after a `task` on the same thread is read-only again. `--web` gives Claude `WebFetch` and `WebSearch` for that call (and the thread keeps it). More read roots, MCP, or web on every call come only from a user-approved `setup --set <policy.json>` (`readRoots`, `allowMcp`, `web`), which applies to every later launch.

## Platforms

| Platform | claude | grok | gemini |
|---|---|---|---|
| macOS | supported; fakes, probes and live S3.5 record | supported; fakes, probes and live S4.6 record | supported; fakes, probes and live S5.6 record |
| Windows | checked: native `claude.exe` from PATH, or a configured JS entry, never a `.cmd`/`.ps1` wrapper | checked: native `grok.exe`; the npm shim is not yet checked | checked: native `agy.exe` |
| Linux | optional, not qualified | optional, not qualified | optional, not qualified |

Windows launches never go through `cmd.exe`; process identity and cleanup use the adapter's ownership evidence. No launcher kind is trusted to exit cleanly yet, so every clean exit is followed by a process-table scan.

## Trade-offs

- **Gemini read-only turns can search the web.** agy's `search_web(*)` deny rule did not block the search (two probes, S1.2), so council cannot switch it off; `--web` is not offered for Gemini and `setup` prints this line.
- **Gemini tasks without `--allow-command` run any command** when the global agy `toolPermission` is `always-proceed`; `setup` warns in that case.
- **A hard-killed companion on Windows** takes its provider child with it, unlike POSIX; `cancel` still recovers the job.
- **A clean exit is not trusted** on any launcher kind until S7 qualifies one: the post-exit scan costs time, and a held pipe locks the thread until `cancel --confirm-ended`.
- **`edited N` on a task** counts the paths the provider's events name plus the working-tree changes between a Git snapshot before the spawn and one after the turn, so an edit made through a shell counts; a change you make in the same tree during the turn counts too. Outside Git, on a failed git call, past 5,000 dirty paths or with a path that is not valid UTF-8 only the events count, and the turn never fails for it; ignored files are invisible to the snapshot. A submodule counts as one path when its dirty state changes; edits inside an already dirty submodule count only if the events name them.
- **Workspace checks around Gemini turns** use the same bounded snapshots: outside Git, or with a partial snapshot and no detected change, the footer says `coverage unknown`; a detected change on a read-only turn is `incomplete` (exit 10).
- **An unconfirmed Grok session** keeps its answer but cannot be resumed; start a new ask.

## Differences from the three replaced plugins

The full tables are in `docs/parity/claude.md`, `docs/parity/grok.md` and `docs/parity/gemini.md`; no row is missing. The intentional differences:

- **All providers.** One verb set (`ask`, `reply`, `review`, `task`, `wait`, `cancel`, `models`, `setup`), `--to` required, one footer grammar and one `--json` key set; one draft-07 review schema with finding ids and `AGREE`/`CHANGE`/`REJECT` decisions; batches of 180,000 B with a findings ledger; malformed or missing review output is exit 10 `incomplete` (the donors exited 1) and keeps the output it received; `review --commit` and `--adversarial` everywhere; `cancel --confirm-ended` instead of deleting lock files.
- **claude_plugin_for_codex 0.5.0.** `ask --task` (read-only) became `task`, which may edit; `fork`, `--profile` variants and `--with-context` are dropped (every review carries the read tools); the default effort comes from the tier instead of `xhigh`, and the exec tier is `sonnet`; the standing contract is the system prompt and the verb's instructions travel in the input; a stored policy applies to resumes too; cancel stops the process group instead of sending an interrupt request; timers are in seconds (`--deadline`, `wait --timeout`) instead of milliseconds; `CLAUDE_COMPANION_TIMINGS` is not ported.
- **grok_plugin_for_codex 1.1.0.** `rescue` became `task`; a clean tree no longer falls back to the default branch; `--base` reviews from the merge base; a review from a subdirectory exits 2 naming the root (a Grok session works only in its cwd); `max` is clamped to `xhigh`; only recorded threads are resumed; `setup` exits 0 with warnings; Grok's own `cancelled` stop is a denial (exit 10) and other stops keep the answer and fail with `incomplete: …`; cost leaves the footer for `--json`.
- **gemini-plugin-for-codex 0.1.2.** One `ask` verb became `ask`, `reply` and `review`; `--sandbox`, the contract and a `--settings` file on every turn; the extra `edit_file(*)` deny rule; caller `--settings JSON` and `--inline-bytes` are dropped; `prune` is automatic; every denial is exit 10 (write-only review denials were a warning); `print_timeout` is exit 1 (was 10) and keeps the answer; a partial snapshot is `coverage unknown` instead of exit 10; an unverified cleanup is exit 1 with the cancel hint instead of 20.

Old native conversations are not adopted into council.

## The twin

Council for Claude Code ([gphcod/codex-agy-grok-plugin-for-claude](https://github.com/gphcod/codex-agy-grok-plugin-for-claude)) is the same design hosted by Claude Code, calling Codex, Gemini and Grok. The two share the verbs, flags, footer, exit codes, state model and adapter interface; `docs/cross-host-contract.md` lists the shared contracts and the labelled host differences (Codex has no slash commands or background tasks, so calls block and the skill carries the call forms; preflight and `--confirm-ended` exist on this host only). Nine host-neutral core modules are pinned in `docs/shared-core.md`; `npm run core:check` verifies the pins and compares them with the twin's once the twin pins an implemented core (until then it prints `comparison deferred`).

## Per-CLI-release checklist

When `claude`, `agy` or `grok` releases a new version:

1. `node plugins/council/scripts/council.mjs setup`: version, login, preflight; Claude warns when the version is not the qualified 2.1.314.
2. `node plugins/council/scripts/council.mjs models --refresh`: the catalog still lists every tier model (Grok warns per missing tier model).
3. Compare `--help` with `docs/spike/<cli>-help.txt`; Claude's preflight fails on a missing flag council passes.
4. Re-run the provider's live record (`npm run test:live`, paid; only where `PLAN.md` names it) and update `docs/qualification/<provider>-macos.md`.
5. If a stream event changed, update the fake and its recorded stream (`tests/fixtures/streams/<cli>.json`) with provenance, then `npm run validate`.

## Development

```bash
npm test             # fake-backed suite; no test starts a real CLI
npm run validate     # suite plus manifest, skill and README checks
npm run test:e2e     # the skill's call forms through sh (and PowerShell on Windows) against the fakes
npm run measure      # per-call framing bytes and the skill size
npm run core:check   # shared-core pins
npm run test:live    # live CLI tests (paid; only where the plan names them)
node scripts/validate-plugin.mjs --installed <dir>   # SHA-256 of every plugin file against an installed copy
```

`PLAN.md` is the procedure; `docs/decisions.md` records every deviation from it.
