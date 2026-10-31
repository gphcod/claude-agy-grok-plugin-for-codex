# Council for Codex: implementation procedure

One Codex plugin, `council`, through which Codex calls Claude Code (`claude`), Gemini (`agy`, the Antigravity CLI) and Grok (`grok`) for questions, discussions, reviews and user-authorized tasks, choosing provider, model and thinking effort per call. It is the Codex-hosted twin of Council for Claude Code, planned in github.com/gphcod/codex-agy-grok-plugin-for-claude (`PLAN.md`): same verbs, flags, footer, state model and adapter interface, with the host differences isolated and listed.

Status: procedure version, 2026-10-31. Reviewed over two rounds by Codex gpt-6.1-sol (xhigh) and Gemini 4 Argon (high); every finding is resolved in the text (Part C). One owner decision is open: the Claude `exec` tier (A2).

## 0. How to use this document

- **Part A** holds the decisions. Every step in Part B refers to them by number (A3, A7.2). Nothing in Part B may contradict Part A; when a step discovers that a CLI or host fact in Part A is wrong, the step stops, Part A is corrected, the correction is logged in `docs/decisions.md`, and the affected step restarts.
- **Part B** is the procedure: steps S0 to S8. Each step lists its preconditions, numbered actions, the verification that proves each action, the files it leaves behind, and a gate. A step starts only when all of its listed prerequisite gates have passed.
- **Part C** is the review record.

Execution rules:

1. Steps run in the order of the dependency map. S3, S4 and S5 (the three adapters) are independent of each other once S2 is done and may run in parallel, each in its own git worktree and branch, touching only its own provider module, its own uniquely named test files and its own `docs/parity` and `docs/qualification` records. A defect found in the shared core during an adapter step is fixed on `main` in its own commit, then rebased into every open adapter branch; adapter branches never edit `core/` or `council.mjs`.
2. From S2 onward, every code sub-step ends with `npm test` green and one commit whose subject starts with the sub-step id, for example `S2.3: port jobs and claims`. S0 and S1 commit once each at their gate.
3. Everything a step says to **record** goes under `docs/` in the repository, never only into chat.
4. Any deviation from Part A or Part B is written to `docs/decisions.md` (date, what changed, why, which steps it touches) before the deviating commit.
5. Codex or Claude executes the steps. The user authorizes the actions marked **[user]**: installing or uninstalling plugins, editing `~/.codex/config.toml`, tagging a release, running the Windows session, paid installed-route checks inside Codex, `cancel --confirm-ended`, and every `task` that edits a working tree.
6. Live CLI calls cost money and quota; a step runs them only where the procedure names them. Everything else runs against the fakes with a temporary `COUNCIL_CODEX_HOME` and the `COUNCIL_<PROVIDER>_BIN` overrides pointing at the fakes.
7. Where this plan and the Claude-side plan decide the same thing, the wording is the same by design; `docs/cross-host-contract.md` (S2.7) tabulates the shared contracts and the labelled host differences. A change to a shared contract is made in both plans or recorded as a deliberate host difference.
8. References to the Claude-side plan ("as the twin's S2.3") are shorthand only where this document also lists the local cases; a test-port table (S1.8) names each retained case and its substitution.

---

# Part A. Decisions

## A1. Scope

Replace the three installed Codex plugins, claude_plugin_for_codex 0.5.0 (`claude-code-advisor@claude-plugin-for-codex`), grok_plugin_for_codex 1.1.0 (`grok@grok-plugin-for-codex`) and gemini-plugin-for-codex 0.1.2 (`gemini-plugin-for-codex@gphcod-agy`), with one plugin that lets Codex:

- ask any of the three models a question on a new read-only thread,
- continue a discussion with delta replies and stable finding ids,
- request a review of uncommitted changes, of a branch against a base, or of one commit, plain or adversarial, with the input snapshotted, hash-checked and delivered in bounded batches,
- assign a task that may edit the working tree, only when the user authorizes it,
- fan one brief out to several models and compare the answers,
- choose provider, exact model and effort per call, or use a named tier.

Kept from the two Codex-hosted designs the handbook ranks (grok_plugin_for_codex and claude_plugin_for_codex, tied second overall): one companion process and exactly one model-bearing child CLI submission per provider call; one shell call per exchange that blocks until the model answers, since Codex delivers no completion for a yielded command (handbook plan step 8); `wait <job>` only after a lost shell handle, never a resubmission; one model-visible skill under 3,000 B with a description under 170 B; POSIX heredoc and PowerShell here-string call forms exercised end to end in tests; a 24 KiB answer cap with `full: <file>`; `--request-id` replays; exit codes 0/10/20/1/2; a preflight that fails fast with an escalation line when the Codex sandbox blocks a resource; review-input snapshots with batches, a findings ledger and `reply --next-input`.

Permitted companion subprocesses, enumerated: the model-bearing child (exactly one submission per call); `git` for review collection and for the before/after mutation snapshots of a task; the process-table query the lifecycle needs (`ps`, or PowerShell on Windows); and the non-billable capability probes a cold `preflight` makes (Claude: `--version`, auth status, `--help`, one deliberate missing-file capability failure, as claude_plugin_for_codex's `preflight.mjs:268-276` does; agy and grok: `--version` and the listing or auth command named in A5.1), whose results are cached under the state root by executable path, size and mtime so a warm call makes none. S2.4 and S6.0 count them: cold, warm, replay (zero provider processes) and owner-death cancellation.

Not in 1.0: MCP server, daemon, hooks, a coordinating multi-child `panel` process (A6), `--worktree`, Claude's `fork`, Claude `--profile` variants beyond advice/review/adversarial/task, model-quality ranking, Linux qualification before macOS and Windows pass.

## A2. Host and CLI facts (from the three repositories and today's checks; S1 re-checks and records them)

Codex host (codex-cli 0.163.0):

- Plugin layout: `.agents/plugins/marketplace.json` at the repository root (`name`, `interface.displayName`, `plugins[]` with `source: {source: "local", path}`, `policy`, `category`); `plugins/<name>/.codex-plugin/plugin.json` (`name`, `version`, `skills: "./skills/"`, `interface`); `plugins/<name>/skills/<skill>/SKILL.md`, optional `agents/openai.yaml`. Install: `codex plugin marketplace add gphcod/<repo> --ref <tag>` (or an absolute local path), `codex plugin add <plugin>@<marketplace>`; remove with `codex plugin remove`. A Git marketplace follows its `ref` in `~/.codex/config.toml` and refreshes in the background, so release pins are tags.
- The skill is invoked as `$council`. There are no slash commands and no background tasks: the shell call blocks; when the shell yields, Codex keeps collecting the same shell session. `CODEX_THREAD_ID` is in the child environment and is the host session that scopes `--last`, bare `wait` and bare `cancel` (both Codex-hosted donors use it).
- The companion runs inside Codex's sandbox. On Windows session A, `--sandbox workspace-write` blocked Grok's login and the process query; `danger-full-access` passed. agy needs network, a loopback listener, process inspection and writes under `~/.gemini/antigravity-cli/` (gemini-plugin-for-codex `docs/P0.md`). The companion preflights the resources a provider needs and exits 1 with `preflight_blocked` and one resource-specific action line, never `cleanup pending`; the line grants no escalation.
- Windows: PowerShell here-string call form ending in `; exit $LASTEXITCODE`; non-ASCII text or text over 16 KiB goes through `--prompt-file`; the command-line boundary is 32,560 characters. Claude Code resolved from PATH must be its native executable, never a `.cmd`/`.ps1` wrapper; an explicitly configured `COUNCIL_CLAUDE_BIN` may name a `.js`/`.mjs`/`.cjs` entry (claude_plugin_for_codex's resolver rule), which is how the fakes run.

| Provider | CLI | Version | Headless form | Resume | Model | Effort | Read-only enforcement |
|---|---|---|---|---|---|---|---|
| Claude | `claude` | 2.1.314 | `claude -p --input-format stream-json --output-format stream-json --verbose --session-id <uuid> …` | `--resume <uuid>` | `--model <alias\|id>` (`fable`, `opus`, `sonnet`, `haiku`, or a full id) | `--effort low\|medium\|high\|xhigh\|max` | `--tools Read,Glob,Grep`, `--permission-mode dontAsk --permission-prompts none`, `--mcp-config '{"mcpServers":{}}' --strict-mcp-config`, `--settings '{"disableAllHooks":true}'`, `--setting-sources user`, `--no-chrome` |
| Gemini | `agy` | 1.4.12 | `--input-format stream-json --output-format stream-json`, one NDJSON `user` message on stdin | `--conversation <id>` | `--model <id>` | `--effort low\|medium\|high` | `--settings <file>` built by gemini-plugin-for-codex's `sessionSettings` rules (A5.1); plus `--sandbox`; no `--mode accept-edits` on read-only turns |
| Grok | `grok` | 1.0.70 | `--prompt-file <f> --output-format streaming-json` | `-r <session>`; `--session-id <uuid>` for a new one | `--model <id>` | `--effort <e>` | `--agent explore`, `--deny` rules, `--disallowed-tools`, `--no-subagents`, `--disable-web-search` |

Claude facts (claude_plugin_for_codex `events.mjs:54-78`, `envelope.mjs:20-66`): the authoritative answer is the single terminal `result` event (`result.result` for text, validated `result.structured_output` under `--json-schema`), never the `assistant` events, which carry intermediate text and tool calls; `system`/`init` and `result` both carry `session_id`, which must equal the assigned uuid; duplicate, missing or malformed `result` (no string `subtype`, no boolean `is_error`), `is_error`, a turn-limit or budget-limit subtype → failure, never success; denials arrive as streamed `permission_denied` events and in `result.permission_denials`, merged; `--json-schema` accepts draft-07 only (`http://json-schema.org/draft-07/schema#`); `--system-prompt-snapshot on` reuses the first system prompt of a session across resumes, so per-turn instructions must travel in the input, not in the system prompt; `--max-turns` bounds the turn; `--tools` sets the available set and `--allowedTools` only the permission. Claude has no headless model listing (no `models` subcommand), so its catalog is static aliases plus pass-through. A `task` on Claude needs an edit-capable launch whose flag set S1.1 proves (A5.1).

agy facts: `agy models` lists effort-suffixed ids only; suffixed id with a conflicting `--effort`, or `xhigh`/`max`, → "invalid model selection"; `print_timeout` → `finished_reason: "print_timeout"` with exit 0 and status SUCCESS; native results have no `denied_actions`, so a denial is a tool-step error matching `permission (check failed|denied)|approval (required|denied)|user.configured deny` on `step_update.tool_info.error`; session `deny`/`ask` arrays replace the global ones, so the runner merges the global lists before adding rules; `--allow-command` is not an agy flag but a wrapper option that gemini-plugin-for-codex translates into `command(X)` and `unsandboxed(X)` allow rules in the settings file.

Grok facts: `max` → "unknown effort level"; explore and RESUME_DENY recipes, `compatEnv()`, the FORBIDDEN tool check, session confirmation, `--json-schema` inline; review batching per grok_plugin_for_codex 1.1.0.

No CLI clamps; council does (A3.3).

Tiers (`tiers.json`, family and effort stored separately; `default` means the user's configured Claude model, no `--model` flag):

| Provider | consult | exec | deep |
|---|---|---|---|
| claude | default / high | sonnet / high | default / xhigh |
| grok | grok-4.7 / high | grok-4.7-build-fast / xhigh | grok-4.7 / xhigh |
| gemini | gemini-4-argon / high | gemini-3.8-flash / high | gemini-4-argon / high |

Gemini has no effort above high, so its consult and deep tiers coincide; the skill says so. The Claude `exec` tier is an owner decision: Argon keeps `sonnet` as the cheaper execution model (parallel to luna and build-fast); Codex prefers `default` for every tier so the configured model is never silently replaced. `sonnet` stands until the owner decides (Part C).

## A3. Call surface

### A3.1 Call forms

POSIX (flags on argv, text after `--`):

```bash
node "<plugin>/scripts/council.mjs" <verb> --to <provider> [flags] -- <<'COUNCIL_EOF'
<text>
COUNCIL_EOF
```

PowerShell:

```powershell
@'
<text>
'@ | node "<plugin>\scripts\council.mjs" <verb> --to <provider> [flags] --; exit $LASTEXITCODE
```

`<plugin>` is two folders above the skill file; the skill resolves it as an absolute path. One shell call and one companion per provider call; the call blocks until the model answers. A turn makes one call, except a fan-out (A6). Text over 64 KiB, or on Windows PowerShell over 16 KiB or non-ASCII, goes through `--prompt-file <utf-8 file>`. A call that carries no text and no `--` (bare `review`, `reply <job> --next-input`, `wait`, `cancel`, `models`, `setup`) reads no stdin and does not wait for it; any other call with no text uses `</dev/null` (`$null |` in PowerShell).

### A3.2 Verbs

| Verb | Does | Mode |
|---|---|---|
| `ask --to <p>` | New thread, one answer | read-only |
| `reply <job\|thread> \| --thread <job\|thread> \| --last [--next-input]` | Delta on an existing thread. The positional and `--thread` are aliases. Provider inherited and locked (a conflicting `--to` exits 2); model and effort inherited unless `--model`, `--effort` or `--tier` is given explicitly, in which case the explicit value wins for that turn and is persisted. `--next-input` sends the next saved review batch, then synthesis, spending no discussion round; it accepts no text (exit 2) | always read-only, also after a task |
| `review --to <p> [--base <ref> \| --commit <sha> \| --uncommitted] [--adversarial] [focus]` | Structured review from a hash-checked snapshot, delivered in bounded batches; exit 10 when findings exist or coverage is pending or unreviewed | read-only |
| `task --to <p> [--thread <id>] [--allow-command <exact>]…` | Delegated work that may edit the working tree; never started by Codex on its own. `--thread` resumes the recorded native thread with the task's edit mode. `--allow-command` is Gemini-only (exit 2 elsewhere) | edit |
| `wait [job] [--timeout <s>]` | List this session's jobs or await one; replays a finished result; returns 20 without stopping anything. Used only after a lost shell handle | — |
| `cancel [job] [--confirm-ended]` | Stop a job and confirm cleanup (A7.5). `--confirm-ended` **[user]** releases a held-output lock only after the process table shows no owned process (A7.8) | — |
| `models [--to <p>] [--refresh]` | Print the catalog; `--refresh` re-runs `agy models` and `grok models` (Claude has none) | — |
| `setup [--to <p>] [--live] [--set <policy.json>]` | Binary, login, version, catalog age, resolved tiers, launcher kind, sandbox preflight, known trade-offs; `--live` makes one paid minimal call per provider; `--set` stores the Claude policy (read roots, web, MCP) under the state root | — |

`wait` and `cancel` start no provider CLI. `models` reads static and cached data unless `--refresh`. `setup` runs the documented probes. A bare native thread id that matches more than one provider exits 2 and needs `--to`; a job id determines its provider.

### A3.3 Flags

- `--to <claude|gemini|grok>`: required on `ask`, `review`, `task`. No inference from the model name.
- `--model <id|alias>`: exact CLI id, or an alias resolved inside that provider's catalog (`fable`, `opus`, `sonnet`, `haiku`, `default`; `argon`, `flash`; `4.7`, `4.6`, `build-fast`). An unknown id passes through unchanged; the footer then says `model unverified`.
- `--effort low|medium|high|xhigh|max`: one vocabulary. Council clamps downward only, against the catalog's per-model effort list: the greatest offered effort at or below the request, or the lowest offered when the request is below all. A clamp is shown in the footer token (`gemini-4-argon/high<=xhigh`) and as `effort`/`requestedEffort` in `--json`. For Gemini an effort-suffixed id is an explicit effort: the id is passed unchanged, its suffix parsed only to detect a conflicting `--effort`, which exits 2. Claude accepts all five values.
- `--tier consult|exec|deep`: defaults from `tiers.json`; explicit `--model`/`--effort` win over the tier; on `reply`, an explicit `--tier` overrides the inherited settings (the skill passes `--tier consult` only when the user did not ask for the provider, and so may deliberately lower a thread's effort).
- `--thread`, `--last`, `--next-input`, `--base`, `--commit`, `--uncommitted`, `--adversarial`, `--rounds`, `--request-id`, `--json`, `--prompt-file`, `--cwd`.
- `--request-id <id>`: 1 to 128 characters matching `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`. The job id is 16 characters derived from provider, host session, realpath(cwd) and the request id.
- Timing: `--deadline <s>` (execution deadline, starts cleanup), `--inactivity-timeout <s>` (no output for that long, starts cleanup), `wait --timeout <s>` (returns 20, stops nothing). agy's `--print-timeout` is set from the deadline; a `print_timeout` result is exit 1, never 20.
- Provider-scoped flags, rejected with exit 2 elsewhere: `--max-turns <n>` (Claude; default by verb: review 2, ask and reply 20, task 30; range 1..100), `--max-budget-usd <n>` (Claude), `--allow-command <exact>` (repeatable, `task --to gemini` only; translated into `command(X)` and `unsandboxed(X)` allow rules in the merged settings file, never forwarded to agy), `--set <policy.json>` and `--live` (`setup`), `--confirm-ended` (`cancel`).
- `--web`: web search, off by default. Grok: omit `--disable-web-search`. Claude: add `WebFetch,WebSearch` to both `--tools` and `--allowedTools`. Gemini: decided by S1.2's probe (deny rule proven to block the search → read-only turns deny it unless `--web`; otherwise Gemini `--web` exits 2). Any flag an adapter has no tested mapping for exits 2.

### A3.4 Output grammar, exit codes

Start line, stderr, suppressed under `--json`: `[council] provider=<p> job=<id> thread=<native id|?>[ target=<review target>]`.

Footer, stdout, one line: `council <provider> <ok|needs attention|failed|cancelled> · job <16 chars> · <model>/<effort>[<=requested] · <duration>[ · round N/M][ · edited N][ · unreviewed N][ · batch i/n][ · model unverified][ · full: <file>][ · error: <msg>][ · <recovery hint>]`. `round N/M` appears on threaded verbs (`ask` and a fresh `task` print `1/M`; `reply` and `task --thread` print the incremented round), never on `review`; `edited N` only on `task`; `unreviewed N` and `batch i/n` only on reviews and `--next-input` replies. Cost, failed-command count and provider counters go to `--json` (`provider`, `job`, `thread`, `session`, `model`, `modelVerified`, `effort`, `requestedEffort`, `tier`, `round`, `rounds`, `verdict`, `findings`, `coverage`, `batch`, `edited`, `failedCommands`, `costUsd`, `exit`, `answerFile`).

Exit 0 done, 10 needs attention (review findings, pending or unreviewed coverage, denied action, incomplete or malformed review output, `cancel --confirm-ended` refused because an owned process is live), 20 still running, 1 failed/cancelled/busy/preflight blocked, 2 invalid input.

### A3.5 Skill policy

When the user did not name a model: `ask`/`reply`/`review` only, `--tier consult` passed explicitly, ask once before higher effort (not for Gemini), never `task` and never `cancel --confirm-ended`. When the user named a model or family: tier by complexity. Discussion protocol: F1/F2 findings tagged BLOCKER/MAJOR/MINOR with file:line; replies carry only `AGREE`, `CHANGE: …`, `REJECT: …` and new facts; 9-reply budget per thread in the footer (`COUNCIL_CODEX_ROUNDS` or `--rounds` change it); unresolved REJECT is reported as disagreement. Codex adjudicates every finding as accepted, rejected or needs-user-waiver. Blocking rule: keep collecting a yielded shell with the longest wait allowed; `wait <job>` only after losing it; never resubmit. Fan-out recipe per A6.

## A4. Repository layout

```
.agents/plugins/marketplace.json         marketplace "council-for-codex", plugin ./plugins/council
package.json                             type module, engines, scripts test / test:live / test:e2e / validate / measure / core:check
README.md                                install block from S0 on, expanded in S6
plugins/council/
  .codex-plugin/plugin.json              name "council", skills "./skills/", interface block
  skills/council/SKILL.md                only model-visible file; ≤ 3,000 B, description ≤ 170 B (test-enforced)
  skills/council/agents/openai.yaml      display name, short description, default prompt
  contract.md                            F1/F2 protocol, one for all providers; also Claude's standing system contract
  tiers.json  models.json                tiers (A2); static catalog: per-model effort lists, aliases, Gemini family/suffix rule
  prompts/advice.md review.md adversarial-review.md task.md   per-turn instruction templates for every provider (A5.2)
  schemas/review-output.schema.json      one draft-07 schema for all providers (A5.2)
  scripts/council.mjs                    entry: parse → guard → request-id replay → load adapter → preflight → admit → turn → print
  scripts/lib/core/                      args stdin jobs claims heartbeat reader lifecycle execution output launcher git review review-input findings preflight catalog tiers host types fs
  scripts/lib/providers/                 claude.mjs gemini.mjs grok.mjs (dynamic import)
scripts/measure.mjs  scripts/run-tests.mjs  scripts/validate-plugin.mjs  scripts/core-check.mjs
tests/
  fixtures/fake-claude.mjs fake-agy.mjs fake-grok.mjs   fakes that validate the launch contract before answering
  fixtures/null-adapter.mjs fake-child.mjs
  fixtures/build-repos.mjs
  fixtures/review-output.reference.json  committed schema reference with provenance
  core-*.test.mjs  catalog.test.mjs  fakes.test.mjs  skill.test.mjs  cli-smoke.test.mjs  e2e-codex-skill.mjs  <provider>.test.mjs  integration.test.mjs
  live/*.live.test.mjs
docs/
  decisions.md  cross-host-contract.md  shared-core.md  test-port.md  spike/  parity/  measurements/  qualification/
```

No runtime dependencies. Node `>=18.20.8 <19 || >=22.19.0` (Node 20 excluded, as claude_plugin_for_codex records). State lives under the state root (A7), never in the plugin directory or the workspace.

## A5. Adapter interface (frozen in S2.7; identical to the twin's, plus the two lifecycle hooks, which the twin adopts too)

```js
export default {
  id, binEnv,                              // "claude", "COUNCIL_CLAUDE_BIN"
  resolveLauncher(env, platform),          // {command, args, path, kind} | null; kind ∈ native | node-script | shim-native | shim-node; never via cmd.exe
  trustsCleanExit(launcher),               // true only for provider/launcher pairs qualified on Windows
  ownsProcess(row, job, platform),         // job-specific argv evidence via core hasFlagOperand
  maxLineBytes,
  probe(launcher),                         // {version, loggedIn, models: [{id, efforts}] | null}; non-billable
  preflight(ctx),                          // [{kind: file|dir|exec|listener|process-table|network, target, access, timeoutMs, why}]
  catalog,
  buildTurn(request),                      // {args, env, stdin | promptFile, answerFile, readOnly, agent?, contractCarrier}
  beforeTurn?(ctx), afterTurn?(ctx, outcome), // optional, no-op default; called once each at defined boundaries, including after verified cleanup on failure or cancel
  parseEvent(line, state),                 // {threadId?, textDelta?, toolStep?, completed?, fatal?, denied?, incomplete?, structured?, edited?, failedCommand?, costUsd?} | null
  reviewPlan(gitInfo, request),            // {native: false, batches, promptTemplate, schemaCarrier}
  finalizeReview({answerText, structured, unreviewed, batch, ledger}),
};
```

### A5.1 Per provider

- **claude** (from claude_plugin_for_codex `runtime.mjs:72-96`, `engine.mjs`, `events.mjs`, `envelope.mjs`, `preflight.mjs`): `-p --input-format stream-json --output-format stream-json --verbose`, `--session-id <uuid>` on a new thread, `--resume <uuid>` on `reply` and `task --thread`; `--system-prompt-snapshot on --append-system-prompt-file <contract>` where the file is the mode-neutral standing contract (`contract.md`) on every launch; the current verb's instructions (advice, review, adversarial or task template from `prompts/`) travel in that turn's input, because the snapshot reuses the first system prompt across resumes; `--max-turns` per A3.3; `--effort`; `--model` unless `default`; `--permission-mode dontAsk --permission-prompts none --setting-sources user --no-chrome`; read-only turns `--tools Read,Glob,Grep` (plus `WebFetch,WebSearch` in both `--tools` and `--allowedTools` under `--web`); `--mcp-config '{"mcpServers":{}}' --strict-mcp-config` unless the stored policy allows MCP; `--settings '{"disableAllHooks":true}'`; `--json-schema` on reviews. Task launch: the flag set S1.1 proves to let Claude edit files and run commands without prompts (candidate: `--permission-mode acceptEdits --permission-prompts none --tools Read,Glob,Grep,Edit,Write,MultiEdit,NotebookEdit,Bash --allowedTools Edit,Write,MultiEdit,NotebookEdit,Bash --disallowedTools "Bash(git push*)" "Bash(git reset --hard*)" "Bash(rm -rf *)" "Bash(sudo *)"`), hooks and MCP still off; the current verb's permissions are enforced on every launch, so a `reply` after a `task` on the same session is read-only again. Ownership: the `--session-id`/`--resume` uuid operand. Events per A2; `edited` paths come from `assistant` `tool_use` blocks naming `Edit`, `Write`, `MultiEdit`, `NotebookEdit`; `failedCommand` from `Bash` tool results with non-zero exit. Depth variables set on the child: `COUNCIL_DEPTH`, `CLAUDE_PLUGIN_CODEX_DEPTH`.
- **gemini** (from gemini-plugin-for-codex `native.mjs`, `settings.mjs` `sessionSettings`, `outcome.mjs`, `snapshot.mjs`): one NDJSON `user` message on stdin with the contract and the turn's instructions prepended; `--disable-slash-commands --print-timeout <s>s --sandbox`; `--settings <job-dir>/settings.json` on every turn, built exactly as `sessionSettings` does: start from the user's global `permissions` lists and `toolPermission`; on read-only turns filter `allow` down to `read_file(...)`/`read_url(...)`, add `deny` for `write_file(*)`, `command(*)`, `unsandboxed(*)`, `mcp(*)`, `execute_url(*)`, set `agentMode: ""` and `toolPermission` `strict` or `request-review`; on tasks keep the global lists and add `command(X)`/`unsandboxed(X)` for each `--allow-command X`; preserve `strict`. `--mode accept-edits` only on tasks; `--conversation <id>` on `reply` and `task --thread`; `--json-schema <path>` on reviews. Unsuffixed family → `--model <family> --effort <clamped>`; suffixed id → the id alone. Denial per the A2 regex → exit 10; duplicate or missing `result`, `status !== "SUCCESS"`, empty response → exit 1; `print_timeout` → exit 1 (an intentional change from the donor's exit 10, recorded in the parity file). `beforeTurn`/`afterTurn` take bounded Git snapshots around each single agy invocation: on `task` they yield `edited` paths; on a read-only turn a changed workspace → exit 10 `incomplete`; unavailable snapshots report unknown coverage. Ownership: the `--settings` path. agy's language-server child is part of the group to stop. Depth variables: `COUNCIL_DEPTH`, `AGY_BRIDGE_DEPTH`.
- **grok** (from grok_plugin_for_codex 1.1.0 `grok.mjs`, `recipes.mjs`, `review.mjs`, `reader.mjs`, `setup.mjs`): `--prompt-file <f> --output-format streaming-json --model <m> --effort <e> --no-auto-update --always-approve --no-subagents --disallowed-tools <HOSTILE>`, `--disable-web-search` unless `--web`, `--rules <contract>` except on reviews, `--json-schema <inline>` on reviews, `--session-id <uuid>` new / `-r <id>` on `reply` and `task --thread`. Recipes ported whole (explore; default agent with RESUME_DENY after an edit turn; `--deny MCPTool(*)` read-only; `--deny "Bash(git push*)"`, `--deny "Bash(rm -rf *)"` on tasks); `compatEnv()`. `buildTurn` returns `agent`. FORBIDDEN tool advertised on a read-only turn → fail closed. `trustsCleanExit` always false. `preflight` lists Grok's login file (`~/.grok/user-settings.json` or `GROK_API_KEY`) and the process-table query. Ownership: the prompt-file operand. Depth variables: `COUNCIL_DEPTH`, `GROK_CODEX_DEPTH`, `GROK_BUILD_DEPTH`.

Every provider child receives all five guard variables, `COUNCIL_DEPTH`, `CLAUDE_PLUGIN_CODEX_DEPTH`, `GROK_CODEX_DEPTH`, `GROK_BUILD_DEPTH` and `AGY_BRIDGE_DEPTH` (the per-provider lists above name the ones each donor itself reads; the child gets the union), and admission refuses to start when any of them is set, so neither council nor any of the five old plugins can nest from any child. S2.4 tests each legacy entry point's guard against every child environment without submitting model work.

### A5.2 Review schema, prompts, input and normalized result

One schema for all three providers, `schemas/review-output.schema.json`, draft-07 (`claude --json-schema` accepts nothing else): grok_plugin_for_codex's top level (`verdict: approve|needs-attention`, `summary`, `findings[]`, `next_steps[]`, `additionalProperties: false`) with each finding carrying required `id`, `severity: critical|high|medium|low`, `title`, `body`, `file`, `line_start`, `line_end`, `confidence`, `recommendation` and optional `decision: AGREE|CHANGE|REJECT`. The dependency-free validator (`reviewProblem`, extended for `id` and `decision`) runs before any mapping. Grok receives the schema inline, Gemini by path, Claude by `--json-schema`; where a provider cannot enforce the schema, the prompt embeds it and demands raw JSON.

Per-turn prompt templates (`prompts/*.md`) are provider-neutral and rendered by `core/review.mjs` `buildBatchReviewPrompt({adversarial, focus, ledger, batchText, embedSchema})`: the review or adversarial instructions, the user's focus, the prior-findings note on batch 2 and later, the coverage prompt for this batch, and the schema text when `embedSchema` is set.

Normalized result: `{ verdict: approve|changes|incomplete, findings: [{id, severity, file, line, title, text, recommendation?, decision?}], coverage: {reviewed, unreviewed, pending}, incomplete: reason|null }`. critical/high → BLOCKER, medium → MAJOR, low → MINOR; `needs-attention` → `changes`. `coverage` comes from the snapshot index, never from model output. Exit 10 when findings exist, when coverage is unreviewed or pending, when output is malformed or missing, or when an approval accompanies findings.

Review input: the self-contained `review-input.mjs` shared byte for byte by claude_plugin_for_codex 0.5.0 and grok_plugin_for_codex 1.1.0 (snapshot, index, `trackedInput` decoder, batches of at most 180,000 bytes of indexed text, `--next-input` continuation, synthesis pass), plus the identified findings ledger from claude_plugin_for_codex `review-findings.mjs` (`reconcileFindings`, `summarizeFindings`, `priorFindingsNote`, adapted to critical/high blockers and `file:line_start` matching) in `core/findings.mjs`. Collection modes, all through the decoder's `PATCH_FLAGS` (`--raw -z --patch --full-index --no-abbrev …`): `--uncommitted` and bare `review` → `git diff <HEAD or empty tree> PATCH_FLAGS --` plus `git ls-files --others --exclude-standard -z`, no fallback to a default branch, exit 2 `nothing to review` when empty; `--base <ref>` → resolve `<ref>^{commit}`, `MB = git merge-base <oid> HEAD` (exit 2 on failure), `git diff <MB> PATCH_FLAGS --` plus untracked files; `--commit <sha>` → resolve `<sha>^{commit}`, then `git diff-tree --no-commit-id --root PATCH_FLAGS <oid>` for a non-merge commit and `git diff <oid>^1 <oid> PATCH_FLAGS` for a merge (first-parent semantics, stated in the review label), no untracked files; unavailable ancestry (shallow clone) → exit 2, never a clean review. Untracked symlinks are rendered as mode-120000 link-text entries; binary, non-UTF-8, submodule, non-regular, over-cap and over-budget-single-line entries are marked unreviewed. Response artifacts, coverage and ledger updates are published atomically; a failed turn grants no coverage and resolves no finding; a plain reply grants no delivery coverage.

## A6. Fan-out

1.0 has no coordinating process. Because Codex has no background tasks, a fan-out is one `ask` per provider in sequence, each with its own `--request-id`, the same brief and that provider's `consult` tier unless the user chose otherwise; S1.4 records whether Codex CLI 0.163 runs independent shell calls of one turn concurrently, and only if it does the skill says to issue the asks in one turn. Follow-ups use `reply <job>`, never `--last`. A coordinating `panel` verb is a 1.1 candidate with the requirements the twin plan lists.

## A7. State and recovery

1. Root `~/.codex/council/` (override `COUNCIL_CODEX_HOME`) with `jobs/`, `claims/`, `threads/`, `catalog/`, `preflight/`, `trash/`, `policy.json`. Each record carries realpath(cwd) and `session` (`CODEX_THREAD_ID`, or null); `threadId` is the provider's native conversation id. Git root is resolved lazily, only for reviews and task snapshots. State never lives inside the workspace (guard, exit 1).
2. `--last`, bare `wait`, bare `cancel` are scoped to `job.cwd === realpath(cwd)` and `job.session === (CODEX_THREAD_ID ?? null)`, both conditions; a named job id is found across sessions.
3. Claim key = provider + session + realpath(cwd) + request id. Thread locks under `claims/<provider>/<threadId>`; every thread lookup, history query, blocking query and metadata access is namespaced by provider; a bare native id matching several providers exits 2. A native thread is never adopted across workspaces.
4. Request lifecycle: a request id is looked up before anything else; an existing reservation or tombstone recovers the original provider binding and replays (print or await the first result, or `result expired`, exit 1) before any implicit selector, catalog setting, adapter probe or preflight runs, and a replay starts no provider process; a fresh request proceeds claim → prepare → tombstone → run, with the fingerprint taken over the raw inputs before resolution; changed input under the same id exits 2; a claim that fails before preparation completes is released; concurrent identical requests start one CLI.
5. Cancel (`cancelManaged`): while the owner companion is live, `cancel` writes the marker and the owner stops its child (snapshot owned descendants, SIGTERM the group, then SIGKILL; `taskkill /T /F` on Windows), runs `afterTurn` after verified cleanup, and finalizes; when the owner is gone, `cancel` stops the child through a creation-timestamp-verified identity, marks the job stopped and releases claims. Never signals a live companion or an unverified pid. On macOS the snapshot includes `pgid`.
6. Thread records `threads/<provider>-<threadId>.json`: provider, `threadId`, cwd, session, model, effort, tier, round counter, rounds budget, Grok `agent`, Claude policy version. Never pruned.
7. Pruning deletes finished job bodies past 100 through `trash/`; never a running, lost, cleanup-pending, claim-holding or review-input-pending job.
8. A lost or cleanup-pending job blocks its thread until `cancel` confirms; `thread locked` after 12 s of held pipes on a clean exit. A held-output lock that nothing can observe is released only by `cancel <job> --confirm-ended` **[user]**, which first queries the process table and refuses with exit 10 when the owner companion or an identified child is live or the query failed; it releases only when no owned process is observed.
9. `--request-id` on every review, task, deep, xhigh, max call; a repeat never starts a second CLI.

## A8. Platform policy and release gate

macOS and Windows qualified before release; Linux optional, never blocking. Windows: never launch through cmd.exe; identity by the adapter's ownership evidence; PowerShell scans inline with PSModulePath set; both launcher kinds per provider qualified or listed as unsupported. The installed Codex route is driven under `--sandbox workspace-write` and `danger-full-access` on both platforms; an expected `preflight_blocked` under `workspace-write` passes a cell only with the specified output and zero submissions.

Release gate 1.0: Claude and Grok qualified on macOS and Windows; Gemini qualified on macOS; on Windows the agy path is qualified, or `setup` reports Gemini unsupported there and turn verbs `--to gemini` exit 2 on `win32` (gemini-plugin-for-codex never ran on Windows). The released files equal the qualified files apart from the version fields, recorded in S7.4.

---

# Part B. Procedure

## Dependency map

| Step | Needs | Produces | Can run with |
|---|---|---|---|
| S0 Scaffold | this plan | loadable plugin skeleton, README stub, test runner, validator | — |
| S1 Spike and catalog | S0; `claude`, `agy`, `grok` installed and logged in; Codex CLI | `docs/spike/*`, schema and reference fixture, fakes and `fakes.test.mjs`, `tiers.json`, `models.json`, `core/catalog.mjs`, `core/tiers.mjs`, `docs/test-port.md` | — |
| S2 Core port | S1 | provider-neutral core incl. review-input, findings ledger and preflight; `contract.md`; prompt templates; every verb wired against the null adapter; frozen contracts | — |
| S3 Claude adapter | S2 | `providers/claude.mjs`, parity record, live record | S4, S5 |
| S4 Grok adapter | S2 | `providers/grok.mjs`, parity record, live record | S3, S5 |
| S5 Gemini adapter | S2 | `providers/gemini.mjs`, parity record, live record | S3, S4 |
| S6 Integration, skill, docs, measurement | S3, S4, S5 merged | `integration.test.mjs`, SKILL.md, e2e call-form tests, README, CHANGELOG, framing record | — |
| S7 Candidate install, qualification, release | S6 | qualification records incl. installed Codex route, `v1.0.0` | — |
| S8 Migration | S7 | donor jobs drained, `council` promoted, three plugins removed; handbook row | — |

Sources to port from (local checkouts, read-only), all inventoried in `NOTICE` (S0.1):

| Short name | Path |
|---|---|
| CLAUDEX | `/Users/cia/GitCode/claude_plugin_for_codex` at `v0.5.0` (plugin under `plugins/claude-code-advisor`) |
| GROKX | `/Users/cia/GitCode/grok_plugin_for_codex` at `v1.1.0` (plugin under `plugins/grok`) |
| AGYX | `/Users/cia/GitCode/gemini-plugin-for-codex` at `v0.1.2` (skill under `skills/agy`) |
| CODEXCC | `~/.claude/plugins/cache/gphcod-codex/codex/2.3.2` (job-body pruning, 16-char ids, held-pipe wait) |
| GEMINICC | `~/.claude/plugins/cache/gemini-plugin-cc/gemini/2.1.0` (review templates, `review-output.mjs`) |
| COUNCILCC | github.com/gphcod/codex-agy-grok-plugin-for-claude (the twin plan; its core once implemented) |

## S0. Scaffold

Preconditions: the repository github.com/gphcod/claude-agy-grok-plugin-for-codex (empty) is the `origin` of `/Users/cia/GitCode/claude-agy-grok-plugin-for-codex`; Node 22.19.0.

Actions:

1. **S0.1 Licensing and inventory.** CLAUDEX is MIT (Yanchuk original, gphcod fork), GROKX Apache-2.0 (stdevMac original), AGYX MIT (gphcod), CODEXCC Apache-2.0 (OpenAI, gphcod fork), GEMINICC (check its LICENSE; if none, behaviour is reimplemented, not copied). Write `LICENSE` (Apache-2.0) and `NOTICE` listing every copied source with repository, version, commit, the files taken and their SHA-256, and the retained notice text.
2. **S0.2 Package, README stub and test runner.** `package.json`: `"type": "module"`, `"private": true`, `"engines": {"node": ">=18.20.8 <19 || >=22.19.0"}`, scripts `test` → `node scripts/run-tests.mjs`, `test:live` → `node scripts/run-tests.mjs --live`, `test:e2e` → `node tests/e2e-codex-skill.mjs`, `validate` → `npm test && node scripts/validate-plugin.mjs`, `measure` → `node scripts/measure.mjs`, `core:check` → `node scripts/core-check.mjs`. `README.md` stub with the install block and the Node range. `run-tests.mjs` as in the twin: default discovery excludes `tests/live/**` and `*.live.test.mjs`; `--live` selects only them; `--ratio` prints the core test ratio and exits 1 below 1.5; `tests/runner.test.mjs` proves disjointness. Stubs for `measure.mjs` and `core-check.mjs` exit 0 until S6.
3. **S0.3 Manifests.** `.agents/plugins/marketplace.json`: `name` `council-for-codex`, `interface.displayName` `Council for Codex`, one plugin `council` at `./plugins/council`, `policy {installation: "AVAILABLE", authentication: "ON_INSTALL"}`, `category` `Developer Tools`, no marketplace `version` field. `plugins/council/.codex-plugin/plugin.json`: `name` `council`, `version` `0.1.0`, `skills` `./skills/`, `license` `Apache-2.0`, `repository` and `homepage` this repository, `interface` with `displayName` `Council`, `capabilities ["Interactive","Read","Write"]`, three `defaultPrompt` entries; no `mcpServers`, `hooks` or `agents`.
4. **S0.4 Entry stub.** `plugins/council/scripts/council.mjs` exports `main(argv, env, io)`; the stub parses the verb, prints usage with exit 2 for everything not implemented, and implements `setup` as far as resolving the three binaries without spawning them.
5. **S0.5 Skill stub.** `skills/council/SKILL.md` with `name: council`, a one-line description under 170 B, and the required-terms skeleton derived from Part A (`council.mjs`, `ask`, `reply`, `review`, `task`, `wait`, `cancel`, `models`, `setup`, `--to`, `claude`, `gemini`, `grok`, `COUNCIL_EOF`, `@'`, `exit $LASTEXITCODE`, `--prompt-file`, `--request-id`, `never resubmit`, `longest wait`, `20 still running`, `round N/N`, `never repeat it verbatim`, `preflight_blocked`, `--tier consult`, `--next-input`, `unreviewed N`); `skills/council/agents/openai.yaml`.
6. **S0.6 Validator.** `scripts/validate-plugin.mjs` adapted from CLAUDEX `tests/validate-plugin.mjs`: package and plugin versions equal (no marketplace version); names and paths as in S0.3; `skills` path; no MCP, hooks or agents; skill frontmatter, description ≤ 170 B, file ≤ 3,000 B, required terms from S0.5; README install block present; the `engines` parser accepts `>=18.20.8 <19 || >=22.19.0` and is tested with admitted (18.20.8, 22.19.0) and rejected (18.20.7, 20.3.0, 22.0.0) versions.
7. **S0.7 Tests.** `tests/skill.test.mjs`, `tests/manifests.test.mjs`, `tests/runner.test.mjs`, `tests/engines.test.mjs`.
8. **S0.8 Docs skeleton.** `docs/decisions.md` with the S0 entry; `docs/spike/`, `docs/parity/`, `docs/measurements/`, `docs/qualification/` with `.gitkeep`; `docs/shared-core.md`, `docs/cross-host-contract.md`, `docs/test-port.md` headers.

Verification:

```bash
npm run validate
node plugins/council/scripts/council.mjs setup
node plugins/council/scripts/council.mjs ask --to claude -- hello </dev/null
```

The first passes; the second prints the three binary paths without waiting on stdin; the third prints usage and exits 2. **[user]** optionally: `codex plugin marketplace add /Users/cia/GitCode/claude-agy-grok-plugin-for-codex`, `codex plugin add council@council-for-codex`, `$council setup` in a new chat.

Gate: all three pass; commit `S0: scaffold`.

## S1. Capability spike and catalog

Preconditions: S0; `claude`, `agy`, `grok` on PATH and logged in; Codex CLI 0.163.0. Probes write into a scratch directory outside the repository; only records and captured listings go under `docs/spike/`.

Record template `docs/spike/<cli>.md` with the twin's headings (Version and launcher; Headless invocation; Stdin shape; Event names seen; Resume form; Read-only controls and evidence; Effort rules; Model listing; Process table incl. pgid; Cancel behaviour; Timeouts; Windows launcher kind; Surprises), plus `docs/spike/codex-host.md` (Thread id env; Shell concurrency; Yield and collection; Sandbox modes per provider and resource; PowerShell boundary; Install and refresh behaviour).

Actions:

1. **S1.0 Review schema.** Write `plugins/council/schemas/review-output.schema.json` per A5.2 (draft-07, GROKX fields, required finding `id`, optional `decision`, `additionalProperties: false` at root and item level). Commit `tests/fixtures/review-output.reference.json` as the same document with a provenance comment block (GROKX and CLAUDEX schema commits, the transformations applied). Write the shared dependency-free validator now, as `plugins/council/scripts/lib/core/review-validate.mjs` (GROKX `reviewProblem` extended for `id` and `decision`); S2.5 integrates this existing module. `tests/schema.test.mjs` asserts the repository schema deep-equals the fixture, uses the draft-07 `$schema`, and that the validator rejects a missing `id`, an unknown severity, an out-of-range `confidence`, an extra property, and accepts the three `decision` values; it reads repository files only.
2. **S1.1 Claude probes.**
   - `claude --version`; confirm no `models` subcommand; record the alias list from `--help`.
   - Read-only ask with the full A5.1 flag set at `--effort low --max-turns 2`, instructions in the input, text on stdin as CLAUDEX `runtime.mjs` writes it; save the stream; record `system/init`, `assistant` (text and `tool_use` blocks), `result` (`subtype`, `is_error`, `result`, `permission_denials`, `usage`, `total_cost_usd`).
   - Resume with `--resume <uuid>` and confirm the system prompt is the snapshot (a changed `--append-system-prompt-file` on resume has no effect); this is why instructions travel in the input.
   - Effort: all five values; record any rejection. Model: `--model sonnet`, a full id, an unknown id (record the error; it is the pass-through failure case).
   - Denial: a read-only turn asking Claude to create a file; record the `permission_denied` event and `result.permission_denials`; confirm no file.
   - Task mode: on a scratch repository, try the candidate flag set of A5.1 asking Claude to edit one file and run `node -e "process.exit(0)"`; then resume the same session as a read-only `reply` and ask for another edit (expect denial); then a review-originated session resumed as a task. Record which flag set gives edits and commands without prompts and denies writes on the read-only resume; it becomes A5.1's task launch (decision logged). If no set works without `bypassPermissions`, record that and stop under §0.
   - `--json-schema` with the S1.0 schema on a tiny review prompt; record `structured_output`.
   - Process table during a turn: `--session-id <uuid>` visible; children listed with pgid.
   - Cancel: SIGTERM the group; record exit, time and any process still holding the output pipes.
   - Cold preflight probes: run CLAUDEX's four probes by hand and count them; they are the Claude entries of A1's budget.
3. **S1.2 agy probes.** As the twin's S1.2 (version, listing, minimal turn, resume, four effort cases, web tool decision rule, denial signature, `--json-schema`, process table with pgid, cancel, `print_timeout`), plus: read `~/.gemini/antigravity-cli/settings.json` and confirm a session `deny` array replaces the global one; a `command(node check.mjs)`/`unsandboxed(node check.mjs)` allow pair under `--mode accept-edits` runs that command and nothing else; a read-only turn with a global `allow: ["run_command(*)"]` present is still denied after `sessionSettings` filtering.
4. **S1.3 Grok probes.** As the twin's S1.3, plus a 300 KB review input through GROKX's companion to observe batch delivery and `reply --next-input`; record Grok's login file location for `preflight`.
5. **S1.4 Codex host probes [user] for paid steps.** Inside a Codex chat with the three old plugins installed: `printenv CODEX_THREAD_ID` (presence and shape); two independent shell calls in one turn, each `sleep 20; date` (overlap or not); a yielding call (`sleep 400`) and how Codex collects it; the sandbox mode in effect. Then, per provider and per sandbox mode (`workspace-write`, `danger-full-access`), independent resource checks using the donors' own verbs: Claude `$claude setup`; Grok `$grok setup`; agy `$agy ask` with a trivial prompt is a paid call, so instead `agy models` for authentication, a write under `~/.gemini/antigravity-cli/`, a loopback listener bind (`node -e` with `net.createServer().listen(0,'127.0.0.1')`), and `ps -axo pid,command` for process inspection. Record each outcome; they become the preflight descriptors (kind, target, access, timeout, action line). PowerShell boundary on Windows in S7.
6. **S1.5 Fakes.** `tests/fixtures/fake-claude.mjs` (from CLAUDEX `tests/fixtures/fake-claude.mjs` and `streams.json`, with the `structured*` scenarios regenerated in the S1.0 schema shape), `fake-agy.mjs` (from AGYX `test/fake-agy.mjs` and the sanitized `agy-1.4.12` fixtures), `fake-grok.mjs` (from GROKX `tests/fake-grok.mjs`). Each validates the complete launch contract (argv, env, stdin, prompt/settings/schema/contract files, resume identity) before emitting, exits 99 on mismatch, answers its version/login/listing/probe commands, and obeys `COUNCIL_FAKE_SCENARIO`: `ok`, `resume`, `denied`, `effort-error`, `review-findings`, `review-malformed`, `slow`, `hold-pipes`, `large-review` (two batches), plus for Claude `missing-result`, `duplicate-result`, `wrong-session`, `is-error`, `turn-limit`. `tests/fakes.test.mjs` runs every fake in every scenario against the recorded streams.
7. **S1.6 Static catalog and tiers.** `tiers.json` from A2. `models.json`: `claude` with `aliases {fable, opus, sonnet, haiku, default}`, per-model efforts (all five; `default` meaning no flag), `listing: false`; `gemini` and `grok` as in the twin, adjusted to the recorded facts.
8. **S1.7 `core/catalog.mjs` and `core/tiers.mjs`.** As the twin's S1.6 (`parseModelListing`, `loadCatalog`, `resolveModel`, `resolveEffort`, `refreshCatalog`, `resolveTier`) with `default` → `{id: null, verified: true}` for Claude and `refreshCatalog` skipping `listing: false`. `tests/catalog.test.mjs`: the twin's Gemini and Grok cases, `claude --model default`, `claude --effort max` (no clamp), `claude --model gpt-6.1-sol` → `verified: false`, `claude --effort low` on `sonnet`; no Codex-provider or `ultra` cases.
9. **S1.8 Test-port table.** `docs/test-port.md`: for every test case this plan takes from the twin or a donor, the source (repository, commit, file, test name), the target test file, and the substitution (provider, host variable `COUNCIL_CODEX_HOME`, session env `CODEX_THREAD_ID`), or "dropped" with the reason (Codex-provider cases, `ultra`, slash-command `splitLeading` cases, Claude-host background-task cases).

Verification: `npm test` passes, including `schema.test.mjs`, `fakes.test.mjs`, `catalog.test.mjs`.

Gate: four spike records complete; `docs/decisions.md` has the Claude task launch, the Gemini `--web` decision, the agy denial signature, the Codex concurrency finding, the per-provider sandbox outcomes, and the cold-preflight probe counts; `docs/test-port.md` filled; commit `S1: spike and catalog`.

## S2. Core port

Preconditions: S1.

Module mapping (source → `plugins/council/scripts/lib/core/`):

| Source | Core module | Change |
|---|---|---|
| GROKX `lib/args.mjs` (`parseArgv`) | `args.mjs` | `SPEC` gains `to`, `commit`, `uncommitted`, `adversarial`, `refresh`, `web`, `next-input`, `prompt-file`, `cwd`, `max-turns`, `max-budget-usd`, `allow-command` (repeatable, array), `set`, `live`, `confirm-ended`; returns `{verb, options, positionals, hasDashDash}`; on `reply`, a first positional becomes `options.thread` when neither `--thread` nor `--last` is set; on `wait`/`cancel` a single positional becomes `options.job`; no `splitLeading` (Codex has no slash commands) |
| GROKX `grok.mjs` (`readStdin`, `readText`, `--prompt-file`) + CLAUDEX `claude-companion.mjs:233` (no-focus skip) | `stdin.mjs` | 10 s deadline; when `(verb === "review" || next-input) && !prompt-file && !positionals.length && !hasDashDash` return `""` without reading stdin; `--next-input` with any text → exit 2; one text source only (stdin, `--prompt-file`, positionals); 8 MiB cap |
| GROKX `lib/jobs.mjs` + CODEXCC `lib/jobs.mjs:56,109-124` | `jobs.mjs` | root `COUNCIL_CODEX_HOME` → `~/.codex/council`; 16-character ids on both routes; fields `provider`, `session`, `threadId`; `candidates()` by cwd and session together; `prune()` from CODEXCC excluding review-input-pending jobs; request fingerprint and tombstones per A7.4; thread queries take the provider; bare native id with several provider matches → `UsageError` |
| GROKX `lib/claims.mjs` + CODEXCC `claimHeld` | `claims.mjs` | `claims/<provider>/<threadId>`; `claimHeld` |
| GROKX beat functions | `heartbeat.mjs` | extracted |
| GROKX `lib/reader.mjs` | `reader.mjs` | generic line reader delegating to `adapter.parseEvent`, first fatal latched; Grok FORBIDDEN check moves to the grok adapter |
| GROKX `lib/lifecycle.mjs` + CODEXCC `lib/lifecycle.mjs` (12 s `PIPE_WAIT_MS`, `thread locked`) + CLAUDEX `process.mjs` (held-output lock, liveness against pid reuse) | `lifecycle.mjs` | `runManagedTurn(adapter, request)` with `beforeTurn`/`afterTurn` at defined boundaries (after verified cleanup on failure or cancel); group stop with descendant snapshot; `cancelManaged`; `cancel --confirm-ended` per A7.8 |
| GROKX `lib/execution.mjs` + `lib/winargs.mjs` | `execution.mjs` | `ownsExecution` delegates to `adapter.ownsProcess`; exports `hasFlagOperand` over `row.argv` and `row.raw`; darwin `pgid=`; empty-command-line list covers `claude`, `agy`, `grok`, `node` and `.exe` variants; depth guard over the five variables of A5.1; PowerShell inline |
| GROKX `lib/output.mjs`, `lib/answer.mjs` | `output.mjs` | A3.4 grammar; 24 KiB cap |
| GROKX `lib/launcher.mjs` + CLAUDEX `preflight.mjs` `resolveExecutable` | `launcher.mjs` | `binEnv`, PATH, Windows shim → JS entry, Claude's native-only PATH rule with the configured-JS exception, `kind` enum |
| CLAUDEX `preflight.mjs` (`startProbe`, blocked-resource checks, policy file) | `preflight.mjs` | provider-neutral runner over the adapter's descriptors; cold results cached under `preflight/`; blocked → exit 1 `preflight_blocked` with the descriptor's action line and zero submissions; `setup --set` |
| CLAUDEX `review.mjs` (`gatherReview`, git runner) + GROKX `review.mjs` (`reviewProblem`, `renderReview`, `untrackedEntry` link text) | `git.mjs`, `review.mjs` | the three collection modes of A5.2 over `PATCH_FLAGS`; validator with `id`/`decision`; `buildBatchReviewPrompt`; severity map |
| GROKX `lib/review-input.mjs` (byte-identical to CLAUDEX's) | `review-input.mjs` | copied whole |
| CLAUDEX `lib/review-findings.mjs` | `findings.mjs` | identified ledger: `reconcileFindings`, `summarizeFindings`, `priorFindingsNote`, critical/high blockers, `file:line_start` matching, atomic publication with coverage |
| GROKX `grok.mjs` orchestration (fingerprint, replay, thread resolution, inheritance, wait/cancel dispatch) | `council.mjs` + `lifecycle.mjs` | ported as the entry in the A4 order |
| new | `host.mjs` | host constants: state root env and default, session env name (`CODEX_THREAD_ID`), depth variable list, binary names, PowerShell rules |
| new | `types.mjs` | JSDoc typedefs of the A5 object and the request, frozen in S2.7 |
| S1.7 | `catalog.mjs`, `tiers.mjs` | in place |
| GROKX `lib/fs.mjs` | `fs.mjs` | unchanged |

Actions:

1. **S2.1 Null adapter and fake child.** As the twin's S2.1 (profiles for id discovery, input and output; scenarios `ok`, `slow`, `hold-pipes`, `exit-nonzero`, `huge-line`, `fragmented-frames`, `no-completion`, `fail-then-success`), loaded only under `COUNCIL_TEST_NULL_ADAPTER=1`; plus `beforeTurn`/`afterTurn` recording calls.
2. **S2.2 Port args, stdin, fs, output, launcher, host.** Tests (`tests/core-args.test.mjs` and siblings): option arity, `--flag=value`, repeatable `--allow-command`, unknown flag → 2; `reply k3f9 -- <text>` and `reply --thread k3f9 -- <text>` equivalent; `reply k3f9 -- "follow up" </dev/null`; bare `review` and `reply <job> --next-input` return at once without stdin; `--next-input` with text → 2; two text sources → 2; stdin deadline shortened through `COUNCIL_STDIN_DEADLINE_MS`; `--prompt-file` (BOM, CRLF, non-ASCII); start line, footer and `--json` for every A3.4 combination; 24 KiB cap; launcher resolution for PATH, `binEnv`, missing binary; `win32` fixtures: `.cmd` with a `.js` entry, `.cmd` with a node-shebang script, `.cmd` without a JS entry (throws), and for Claude: PATH `.cmd` rejected, configured `COUNCIL_CLAUDE_BIN=…/fake-claude.mjs` accepted; `host.mjs` reads `CODEX_THREAD_ID`.
3. **S2.3 Port jobs, claims, heartbeat.** Tests: both id routes produce 16 characters; `COUNCIL_CODEX_HOME` override; claim key includes provider; two providers with the same native `threadId` keep separate claims, history, inheritance and cancellation; a bare native id matching two providers → 2; `/tmp` vs `/private/tmp` through a test-created symlink (junction on Windows); `--last` ignores another session's job and another cwd's job; a named id resolves across sessions; prune moves finished bodies past 100 through `trash/` and never a running, lost, cleanup-pending, claim-holding or review-input-pending job; thread record survives prune; claim released when prepare throws; tombstone replay prints the first result or `result expired` without spawning; changed input under the same id → 2; two concurrent identical requests spawn one child; a replay of `reply --last --request-id <id>` after another provider's job became latest, or after catalog or tier changes, recovers the original provider and spawns nothing.
4. **S2.4 Port reader, execution, lifecycle, preflight.** Tests: `maxLineBytes` exceeded fails closed; fragmented frames; missing completion → 1; latched fatal; `trustsCleanExit` false → post-exit scan; held pipes beyond 12 s → `thread locked`; heartbeat before the job record; cancel with owner live / owner gone / mismatched timestamp; pgid reparenting on darwin; depth guard over all five variables; `--deadline` and `--inactivity-timeout` → 1; `wait --timeout` → 20; discovered-id claim and collision; `beforeTurn`/`afterTurn` called once each on success, denial, timeout, cancellation and spawn failure, with `afterTurn` after verified cleanup; preflight: a blocked descriptor → 1 `preflight_blocked` with its action line and zero child spawns; cached cold results make a warm call probe nothing; state root inside the workspace refused; `cancel --confirm-ended` refuses (exit 10) with a live owner, a live owned child or a failed query, and releases only when none is observed; subprocess counters for cold, warm, replay (zero provider processes) and owner-death cancellation; `win32` tests with a fake PowerShell runner (PSModulePath, `ThreadCount=0`, `=ascii`/`xhex`/`-` decoding, self-identity ticks, kill refusal on mismatch, `winargs` cases from GROKX).
5. **S2.5 Port git, review, review-input, findings; write contract and templates.** `tests/fixtures/build-repos.mjs` builds: root-commit repo, three-commit repo with a shallow clone, merge commit, symlink change, untracked symlink to an outside file, renamed file with a space, 500 KB change set. Write `contract.md` from GROKX's contract with a provider-neutral tag (also Claude's standing system contract); `prompts/advice.md` from CLAUDEX `profiles/advice.txt`, `prompts/review.md` and `prompts/adversarial-review.md` from CLAUDEX `profiles/review.txt`/`adversarial.txt` merged with GEMINICC's templates and updated to the A5.2 field names, `prompts/task.md` written new for edit-capable work (scoped edits and verification commands within the request, repository content untrusted, no `git push`, `git reset --hard`, `rm -rf`, no recursive agents). Tests: the three collection modes (`--commit` on root, ordinary and merge commits with 53-entry-class decoding, `--commit` in the shallow clone → 2, bad ref → 2, `--base` with dirty tree and untracked symlink, `--uncommitted` on a clean tree → 2); outside symlink contributes link text only; size limit → unreviewed; validator cases of S1.0; approval with findings → `changes` 10; `needs-attention` without findings → 10; unrecognized output → `incomplete`; templates render and reject a missing placeholder; `buildBatchReviewPrompt` with and without prior findings and embedded schema; ported from CLAUDEX `review-batches.test.mjs` and GROKX `review-batches.test.mjs` per the test-port table: 500 KB rollout, snapshot tampering, workspace change, failed and invalid responses, early major finding then clean synthesis, identified resolution, unchanged findings, failed publication, binary input through synthesis.
6. **S2.6 Entry wiring.** `council.mjs` in the A4 order: (1) parse argv, honour `--cwd`; (2) guards: depth variables, state root outside the workspace; (3) `--request-id` lookup and replay before anything else (A7.4); (4) resolve provider (`--to`, or the job or thread record on `reply`/`task --thread`/`wait`/`cancel`; conflicting `--to` → 2; ambiguous bare native id → 2), compute the fingerprint, dynamic `import()` of `./lib/providers/<p>.mjs` (absent → 2 `provider <p> not available in this build`); (5) resolve tier, model, effort; (6) `adapter.preflight(ctx)` through the cached runner; (7) admit, `runManagedTurn`, print. `wait` loads no adapter. `cancel`, `--confirm-ended` and any recovery path that needs ownership inspection (owner-death cancellation, the post-exit scan of a lost job) load the recorded provider's module for `ownsProcess` only, bypassing preflight, probes and `buildTurn`, and start zero provider processes (the donor's `control.inspect()` route, GROKX `lifecycle.mjs:320-335`). `models` and `setup` iterate `["claude","gemini","grok"]`. `tests/cli-smoke.test.mjs`: `--help`, unknown verb or flag → 2, missing `--to` → 2, depth guard → 1, replay bypassing preflight (a blocked descriptor and a finished request → the first result, no probe).
7. **S2.7 Freeze.** `docs/decisions.md` "S2 freeze". `core/types.mjs` typedefs. `docs/cross-host-contract.md`: a table of the shared contracts (verbs and aliases, inheritance and explicit-tier rule, effort edges including the lower-bound rule, round accounting, footer and `--json` grammar, review result and coverage, state layout, adapter shapes incl. the two hooks) with the twin's wording, and the labelled host differences (host session env, blocking rule, PowerShell form, `--prompt-file`, preflight, review-input batching and ledger, `--confirm-ended`, Claude provider instead of Codex). `docs/shared-core.md`: a pinned shared-module manifest, two tables: host-neutral modules intended to stay identical (`claims`, `heartbeat`, `reader`, `tiers`, `fs`, `review-input`, `findings`, and `jobs`/`execution` once both hosts read their constants from `host.mjs`) with hashes and the shared regression tests, and host-adapted modules (`host`, `preflight`, `args`, `stdin`, `lifecycle`, `output`, `launcher`, `git`, `review`, `catalog`) with the per-module reason. `core-check.mjs` compares against `COUNCIL_CC_ROOT` only when that checkout contains an implemented, pinned core, otherwise prints `comparison deferred` and exits 0; it never reports equality it did not compute.

Verification:

```bash
npm test
node scripts/run-tests.mjs --ratio
node plugins/council/scripts/council.mjs ask --to claude -- hi </dev/null
COUNCIL_TEST_NULL_ADAPTER=1 COUNCIL_CODEX_HOME="$(mktemp -d)" node plugins/council/scripts/council.mjs ask --to null -- hi </dev/null
```

Gate: first two pass (ratio ≥ 1.5); third exits 2 `provider claude not available in this build`; fourth prints the fake answer and a `council null ok` footer; commit `S2.7: freeze`.

## S3. Claude adapter

Preconditions: S2. Sources: CLAUDEX `scripts/lib/runtime.mjs:72-96` (launch args), `engine.mjs` (turn, max turns, budget), `events.mjs:54-78` and `envelope.mjs:20-66` (event handling, terminal checks, answer extraction), `admission.mjs` (conversation rules), `preflight.mjs` (resources, probes, policy). Not ported: `state.mjs`, `recovery.mjs`, `timing.mjs`, the rest of `envelope.mjs` (core), `fork`, `--profile` variants outside advice/review/adversarial/task, `profiles/task.txt` (read-only; replaced by `prompts/task.md`).

Actions:

1. **S3.1 Skeleton.** `providers/claude.mjs`: `binEnv: "COUNCIL_CLAUDE_BIN"`, launcher with the native-only PATH rule and configured-JS exception, `trustsCleanExit` false until S7 proves a launcher kind clean, `ownsProcess` via `hasFlagOperand` on the session uuid, `probe` running `--version` and the CLAUDEX capability probe, `preflight` descriptors: Claude's state directory (write), the state root (write), network (CLAUDEX's check), the four cold probes (exec).
2. **S3.2 buildTurn.** `ask` → new uuid, read-only flag set, `contract.md` as the snapshot system prompt, `prompts/advice.md` plus the text in the input; `reply` → `--resume`, read-only set, delta in the input; `task` and `task --thread` → the S1.1 task launch, `prompts/task.md` plus the brief in the input; `review` → read-only set, `--json-schema`, `buildBatchReviewPrompt` output in the input. `--web` adds `WebFetch,WebSearch` to `--tools` and `--allowedTools`; policy allows MCP or read roots through `setup --set`; `default` omits `--model`; `--max-turns` per A3.3.
3. **S3.3 parseEvent and finalizeReview.** `system/init`: `session_id` must equal the assigned uuid (else fatal), emit `threadId`; `assistant`: record first-assistant timing, collect `edited` from `tool_use` blocks (`Edit`, `Write`, `MultiEdit`, `NotebookEdit`: `file_path`/`notebook_path`), never emit `textDelta`; `permission_denied` → recorded denial; `system/api_retry` → counter; `result`: duplicate → fatal; `session_id` mismatch → fatal; non-string `subtype` or non-boolean `is_error` → fatal `malformed_result`; merge `permission_denials`; any denial → `denied` (exit 10); `is_error` or `subtype !== "success"` (turn limit, budget limit) → fatal with the message; otherwise `textDelta` = `structured_output` (JSON) when present, else `result`, empty → fatal; `completed` with usage and cost. EOF without `result` → fatal. `finalizeReview` validates `structured_output` with the shared validator into A5.2 and updates the ledger.
4. **S3.4 Tests against fake-claude.** Every verb; `ask → task --thread → reply → task --thread` and `review → task --thread → reply` asserting the complete effective flag set (tools, allowed, disallowed, permission mode, system-prompt file, input prefix) on every transition; `--web` tool set on fresh and resumed turns; review with two batches then synthesis via `--next-input`, early major finding then clean synthesis keeps the blocker, identified `REJECT` resolves it; `missing-result`, `duplicate-result`, `wrong-session`, `is-error`, `turn-limit` → 1; `denied` → 10; `--model default` omits the flag; unknown model → `model unverified`; ownership rows; preflight blocked → 1 with zero spawns; cold/warm probe counts.
5. **S3.5 Live tests.** `tests/live/claude.live.test.mjs`: version, one `ask` at `--effort low --max-turns 2`, one `reply`, one `review --uncommitted` on a small fixture, one authorized `task` **[user]** on a scratch repository followed by a read-only `reply` that is denied an edit, cancel. Record in `docs/qualification/claude-macos.md`.
6. **S3.6 Parity record.** `docs/parity/claude.md` over CLAUDEX's `ask [--task] [--profile …]`, `review [--base] [--adversarial] [--with-context]`, `reply <handle>|--last [--next-input]`, `fork`, `wait`, `cancel`, `setup [--live] [--set]`, footer fields, `action:` hints, caveats (held-output lock → `cancel --confirm-ended`, Windows locked sessions, `fsync` cost), each marked same / renamed / intentionally different (`task` added; `fork` and `--with-context` dropped; footer grammar; per-turn instructions in the input) / missing. Nothing missing at the gate.

Verification: `npm test`; live file once; `node plugins/council/scripts/council.mjs ask --to claude --effort low -- Reply with pong </dev/null` prints `pong` and `council claude ok · job … · default/low · …`.

Gate: parity record with no "missing" row; branch merged with the full fake suite green.

## S4. Grok adapter

Preconditions: S2. Sources: GROKX `grok.mjs:140-160` (recipe selection, `agent`), `lib/recipes.mjs`, `lib/review.mjs` (inline schema carrier, `reviewProblem`), `lib/setup.mjs` (`parseModels`, login check), `lib/reader.mjs` (FORBIDDEN, session confirmation, edit paths, stop reason, cost, usage).

Actions:

1. **S4.1 Skeleton.** `providers/grok.mjs`: `binEnv: "COUNCIL_GROK_BIN"`, `ownsProcess` via `hasFlagOperand(row, "--prompt-file", promptFile, …)`, `trustsCleanExit: () => false`, `maxLineBytes` from the GROKX reader, `probe` running `--version` and `models` through `parseModels`, `preflight` descriptors: Grok's login file (read), the state root (write), the process-table query (process-table; PowerShell on Windows), so a `workspace-write` sandbox that hides the login or the query fails before spawn with `preflight_blocked` naming the resource.
2. **S4.2 buildTurn.** `recipe()` and `compatEnv()` ported whole; `compatEnv` sets `GROK_CODEX_DEPTH`, `GROK_BUILD_DEPTH` and `COUNCIL_DEPTH`. Recipe choice: `ask` → explore; `reply` on a thread whose record says `agent: default` → RESUME_DENY, else explore; `task` → write recipe; `review` → explore plus `--json-schema <inline S1.0 schema>` and no `--rules`, with the batch prompt from `buildBatchReviewPrompt` in the prompt file. `--web` omits `--disable-web-search`. `--session-id <uuid>` on new threads, `-r` on `reply` and `task --thread`. `buildTurn` returns `agent`.
3. **S4.3 parseEvent.** From the GROKX reader: session confirmation on the end event (`session not confirmed` otherwise), advertised tool catalogue checked against FORBIDDEN and MCP tool calls on read-only turns (fatal, fail closed), text deltas, `tool_call`/`tool_call_update` edit paths, `end_turn` stop reason, structured output, cost, usage, `max_turns_reached`.
4. **S4.4 finalizeReview.** Validate with the shared validator, map into A5.2, `coverage` from the snapshot index, ledger update.
5. **S4.5 Tests against fake-grok.** Every verb; `ask → task --thread → reply → task --thread` asserting recipe, `-r` and `agent` persistence; forbidden tool advertised → 1 before any text; `--web`; `max` clamped with footer `grok-4.7/xhigh<=max`; two concurrent jobs with the same model and effort never cross-match in the post-exit scan; two-batch review with `--next-input`, blocker persistence and identified resolution; preflight blocked (hidden login file) → 1 with zero spawns.
6. **S4.6 Live tests.** `tests/live/grok.live.test.mjs`: version, `models`, one `ask` at `--effort low`, one `reply`, one `review --uncommitted`, `models --refresh --to grok`, `setup --to grok`, cancel. Record in `docs/qualification/grok-macos.md`.
7. **S4.7 Parity record.** `docs/parity/grok.md` over GROKX's `ask`, `reply [--next-input]`, `review`, `rescue`, `wait`, `cancel`, `setup`, `--web`, `GROK_CODEX_ROUNDS`, footer fields (`$cost` to `--json`), caveats (`session not confirmed`, Windows scan, `workspace-write` failure → preflight), the batch cap change (256 KiB → 180,000 B) and the unified schema with `id`/`decision`.

Verification and gate as in S3, footer `council grok ok · job … · grok-4.7/low · …`.

## S5. Gemini adapter

Preconditions: S2. Sources: AGYX `lib/native.mjs` (launch, `denial` regex), `lib/settings.mjs` (`configuredPolicy`, `sessionSettings`), `lib/outcome.mjs` (`classify`, `applyOutcome`), `lib/snapshot.mjs` (before/after Git snapshots), `references/operations.md`; GEMINICC `lib/review-output.mjs`. Not ported: AGYX `store.mjs`, `process.mjs`, `util.mjs` (core), `release`, `prune`, `result RUN_ID --wait` (→ `wait`, `cancel --confirm-ended`).

Actions:

1. **S5.1 Skeleton.** `binEnv: "COUNCIL_AGY_BIN"`, `ownsProcess` on the `--settings` path, `trustsCleanExit: () => false`, `probe` running `--version` and `models` (authentication evidence), `preflight` descriptors: network, loopback listener bind, `~/.gemini/antigravity-cli/` (write), the state root (write), process inspection. On `win32` when unsupported, `buildTurn` throws the A8 message.
2. **S5.2 buildTurn.** Per A5.1: settings file per job from `configuredPolicy` + `sessionSettings` semantics (read-only filtering and denies; task merge with `command(X)`/`unsandboxed(X)` from `--allow-command`; strict preserved), `--sandbox` always, `--mode accept-edits` only on tasks, contract and turn instructions prepended, `--conversation` on resumes, `--json-schema` on reviews, model and effort rules; `AGY_BRIDGE_DEPTH` and `COUNCIL_DEPTH` on the child.
3. **S5.3 parseEvent, hooks and finalizeReview.** `conversation_id` from init, step updates or result; text deltas with the 4 MiB frame cap; tool steps; the A2 denial regex → denied (exit 10); terminal `result`: duplicate or missing, `status !== "SUCCESS"`, empty response → fatal (exit 1); `finished_reason: "print_timeout"` → fatal `print_timeout` (exit 1, never 10 or 20); `structured_output` → structured; usage deltas. `beforeTurn`/`afterTurn` take the AGYX bounded snapshots around each single invocation: `task` → `edited` paths and `failedCommands`; read-only turn with a changed workspace → exit 10 `incomplete`; unavailable snapshot → unknown coverage. `finalizeReview` through the shared validator into A5.2 with the ledger.
4. **S5.4 Review prompt.** The batch prompt from `buildBatchReviewPrompt` with `embedSchema` when agy's `--json-schema` is not enforced (S1.2 records which); `--adversarial` selects the adversarial template.
5. **S5.5 Tests against fake-agy.** Every verb; `ask → task --thread → reply → task --thread` asserting settings content, `--sandbox`, `--mode` and `--conversation` per transition; merged-settings cases (global deny retained, global `run_command(*)` allow filtered out on read-only turns, `--allow-command` only under task, strict preserved); denial regex → 10; duplicate result, missing result, `status: "ERROR"`, empty response, `print_timeout` → 1; suffix conflict → 2; `xhigh` clamped with footer `gemini-4-argon/high<=xhigh`; two concurrent jobs distinguished by settings paths; stop path kills a fake language-server child incl. one reparented to pid 1; snapshot cases (read-only turn with a concurrent workspace change → 10; task reports edited files; unavailable snapshot → unknown); preflight blocked (listener bind fails) → 1 with zero spawns.
6. **S5.6 Live tests.** `tests/live/agy.live.test.mjs`: version, `models`, one `ask` at `--effort low`, one `reply`, one `review --uncommitted`, `models --refresh --to gemini`, `setup --to gemini`, cancel, the four effort cases. Record in `docs/qualification/gemini-macos.md`.
7. **S5.7 Parity record.** `docs/parity/gemini.md` over AGYX's `ask [--edit] [--conversation] [--allow-command] [--settings] [--inline-bytes]`, `result RUN_ID [--wait]`, `cancel`, `release --confirm-ended`, `prune`, exit meanings (donor 10 incomplete → council 10 attention or 1 for `print_timeout`, recorded as intentional; 20 unknown → council 20 or `cancel`), caveats.

Verification and gate as in S3, footer `council gemini ok · job … · gemini-4-argon/low · …`.

## S6. Integration, skill, documentation, measurement

Preconditions: S3, S4, S5 merged on `main`; `npm test` green.

Actions:

1. **S6.0 Cross-provider integration tests.** `tests/integration.test.mjs`: three jobs in one session and cwd (sequential, and concurrent when S1.4 found concurrency), bare `wait`, provider lock on `reply`, read-only after task for all three, `models --refresh` and `setup`, replay and cancel isolation, review batch continuation across a companion restart, subprocess counters for cold, warm, replay and owner-death cancellation per provider. Integration gate before anything else in S6.
2. **S6.1 Skill.** Write `SKILL.md` from GROKX's and CLAUDEX's skills: both call forms, the delimiter and `--prompt-file` rules, the no-stdin rule for bare `review`/`--next-input`, the verb list, the tier table, the A3.5 policy including the blocking rule and the `--confirm-ended` restriction, the A6 fan-out recipe, `--request-id` rules, footer and exit-code line, discussion protocol. ≤ 3,000 B, description ≤ 170 B; the validator's required terms (S0.5) hold.
3. **S6.2 Call-form e2e.** `tests/e2e-codex-skill.mjs` adapted from CLAUDEX: extract fenced blocks matching ```` /```(?:bash|sh|powershell|pwsh)?\r?\n([\s\S]*?)```/g ```` that contain `scripts/council.mjs`; assert both the POSIX (`<<'COUNCIL_EOF'`) and PowerShell (`@' … '@ |`) forms exist; substitute `<plugin>`, `<verb>`, `<provider>`, `[flags]`, `<text>`; run through `sh` and, on Windows, `powershell.exe` and `pwsh` when present, against all three fakes; parse `council <provider> ok · job <16 chars>` from the last line; assert the prompt bytes the fake received; cases: leading flags, literal `--` in the text, multiline, delimiter collision, `'@` inside the text via `--prompt-file`, bare `review --to <p>` without `--` exits promptly.
4. **S6.3 README.** Install (`codex plugin marketplace add gphcod/claude-agy-grok-plugin-for-codex --ref v1.0.0`, `codex plugin add council@council-for-codex`, the `config.toml` pin form), both call forms, verbs and flags, tiers, effort rules, blocking and collection rules, state root and recovery incl. `cancel --confirm-ended`, sandbox and preflight table per provider and resource, platform table, per-CLI-release checklist, trade-offs, parity differences from the three plugins, the twin relationship.
5. **S6.4 CHANGELOG.** `1.0.0` entry.
6. **S6.5 Measurement.** `scripts/measure.mjs` runs `ask` once per provider against the fakes and prints per-call framing bytes and the skill size; `docs/measurements/framing.md` records them beside the historical figures with their provenance (claude_plugin_for_codex 0.4.2, 72 B per ask, handbook host-context method; grok_plugin_for_codex 1.0.4, 139 B, 2026-10-16), labelled historical versus new. `core:check` runs; its result (`comparison deferred` while the twin has no implemented core) goes into `docs/shared-core.md`.
7. **S6.6 Live all-provider check.** `node plugins/council/scripts/council.mjs models --refresh` and `node plugins/council/scripts/council.mjs setup` against the real CLIs; record in `docs/qualification/macos-setup.md`.
8. **S6.7 Version.** `1.0.0-rc.1` in `package.json` and `plugin.json`; `npm run validate`.

Verification: `npm run validate`; `npm run test:e2e`; `npm run measure` prints three rows.

Gate: all green; commit `S6.7: 1.0.0-rc.1`.

## S7. Candidate install, qualification and release

Preconditions: S6.

Actions:

1. **S7.0 Candidate install [user].** Capture the baseline: `codex plugin list` and the `[marketplaces.*]`/`[plugins.*]` sections of `~/.codex/config.toml` into `docs/qualification/baseline.md`; back up `config.toml`. `codex plugin marketplace add /Users/cia/GitCode/claude-agy-grok-plugin-for-codex` (local path), `codex plugin add council@council-for-codex`; start a new chat; verify the installed runtime, skill, prompts and schema hashes equal the candidate's (`scripts/validate-plugin.mjs --installed <cache path>`); keep the old plugins installed. Record the restoration steps.
2. **S7.1 macOS matrix [user] for paid cells.** `docs/qualification/matrix.md` with one row per cell and columns: provider, verb and flags, route (direct companion / installed `$council`), sandbox (`workspace-write` / `danger-full-access`), fixture (live / fake `large-review`), Node version, launcher kind, expected exit and output, evidence (job id or output file). Rows: `ask`, `reply --last`, `reply <job>`, `reply --next-input` (fake `large-review`, offline), `review --uncommitted`, `review --base`, `review --commit` (root and merge fixtures, offline; one live), `review --adversarial`, `task` **[user]**, `wait`, `cancel`, `cancel --confirm-ended` (fake held-output, offline), `models --refresh`, `setup`, `setup --live`, one fan-out per A6. An expected `preflight_blocked` cell passes only with the specified line and zero submissions.
3. **S7.2 Windows session [user].** At Node 18.20.8 and 22.19.0: `npm run validate`, `npm run test:e2e` in `powershell.exe` and `pwsh`; `where.exe claude grok agy` kinds; the matrix for claude and grok per launcher kind via `COUNCIL_<P>_BIN` (native Claude only; wrapper rejection recorded as negative tests); the installed route under both sandboxes; `cancel` with the post-exit scan; the Gemini attempt and its A8 outcome; the PowerShell boundary check. Record in `docs/qualification/windows.md`.
4. **S7.3 Release gate check (A8).** Every cell has its expected outcome; a cell whose outcome differs from the expectation blocks; fix, re-run, re-tick.
5. **S7.4 Tag [user].** Versions to `1.0.0`; CHANGELOG date; `npm run validate` again; record that the released files equal the qualified files apart from the version fields (hash list); commit `S7.4: 1.0.0`; `git tag v1.0.0`; push `main` and the tag.

Gate: A8 satisfied; `v1.0.0` on origin.

## S8. Migration

Preconditions: S7. Every action **[user]**-authorized.

1. **S8.0 Drain the donors.** Enumerate the saved job records under each donor's configured state root, honouring its override variable and workspace namespaces (`CLAUDE_COMPANION_STATE_ROOT` or `~/.codex/claude-plugin-for-codex/workspaces/*/jobs`, `GROK_CODEX_PLUGIN_STATE` or `~/.grok/codex-plugin/state/v5/jobs`, `AGY_STATE_DIR` or `~/.cache/codex-agy/runs`); extract each unfinished handle, job id or run id; collect it with the donor's own command and an explicit identifier (`$claude wait <handle>`, `$grok wait <job>`, `$agy result <run>`), since none of the three lists jobs without one; finish or cancel running work; resolve lost or cleanup-pending jobs; archive their state directories (`~/.codex/claude-plugin-for-codex`, `~/.grok/codex-plugin/state`, `~/.cache/codex-agy`) read-only under `docs/qualification/migration/` paths noted, not copied into the repository. Record in `docs/qualification/migration.md` that old native conversations are not adopted into council.
2. **S8.1 Promote.** The local-path marketplace from S7.0 and the Git marketplace share the name `council-for-codex`, and `codex plugin marketplace remove` works by name, so: replace the source in place if the CLI supports it; otherwise `codex plugin remove council@council-for-codex`, `codex plugin marketplace remove council-for-codex` (the local one), then `codex plugin marketplace add gphcod/claude-agy-grok-plugin-for-codex --ref v1.0.0` and `codex plugin add council@council-for-codex`. Never remove `council-for-codex` afterwards. New chat; `$council setup` shows three providers; installed hashes equal the tag.
3. **S8.2 Replay the old smoke lists.** Each replaced plugin's documented smoke through `$council`, ticked in the migration record.
4. **S8.3 Remove.** `codex plugin remove claude-code-advisor@claude-plugin-for-codex`, `codex plugin remove grok@grok-plugin-for-codex`, `codex plugin remove gemini-plugin-for-codex@gphcod-agy`; `codex plugin marketplace remove` for each of the three only if nothing else uses it; `config.toml` keeps every unrelated entry (diff against the S7.0 baseline).
5. **S8.4 Handbook.** Add Council for Codex (and the twin's) rows to `agent_plugin_design_comparison.md` in github.com/gphcod/handbook with framing figures, platform evidence and install commits; update `machines.md`'s plugin table; pull request there.

Verification: `codex plugin list` contains `council@council-for-codex`, none of the three old ids, and otherwise equals the baseline; **[user]** a Codex chat answers `$council ask --to grok hello` with a footer.

Gate: handbook pull request opened; migration record complete. Done.

---

# Part C. Review record

## Round 1 (2026-10-31)

The draft went to Codex gpt-6.1-sol (xhigh) and Gemini 4 Argon (high) with eight questions. Both read the draft, the committed twin plan, the three donor repositories and the handbook; Codex also reproduced the `trackedInput` decoder failure on `git diff-tree -p` output and decoded the same root commit with `PATCH_FLAGS`.

### Answers to the questions

| Q | Codex | Argon | Decision |
|---|---|---|---|
| Q1 naming | keep `council`/`$council`/`council-for-codex`/`~/.codex/council` | same | kept; prose says "Council for Codex" and "Council for Claude Code" |
| Q2 Claude task mode | `dontAsk` plus an explicit edit-capable tool set and approved Bash patterns; acceptance unproved until tested | `acceptEdits --permission-prompts none` with explicit `--tools` and `--allowedTools` incl. Bash and a disallow list | S1.1 probes Argon's set first, Codex's second; decision logged (A5.1) |
| Q3 Claude tiers | `default` for all three | keep `sonnet` for exec | disagreement recorded; `sonnet` stands pending the owner (A2) |
| Q4 fan-out | sequential; concurrent only if the host probe proves it; defer `panel` | same | kept (A6) |
| Q5 batching for all three | keep, with schema, ledger and lifecycle contracts | keep | kept (A5.2) |
| Q6 preflight contract | yes, with replay before preflight and real resource checks | yes, with adapter-level `preflight` for Grok and Gemini | kept (A1, A2, S2.6) |
| Q7 shared core | pinned pure modules only; no broad byte identity before host inputs are separated | narrow the identical list; parameterize through `host.mjs` | kept (S2.7, `docs/shared-core.md`) |
| Q8 executable as written | no | no | revised as below |

### Codex gpt-6.1-sol, 21 findings

| # | Sev | Finding | Resolution |
|---|---|---|---|
| F1 | BLOCKER | The two donor review schemas are incompatible (fields, drafts); "superset" undecided; test depended on another checkout | one draft-07 schema, GROKX fields plus required `id` and optional `decision`; committed reference fixture; tests read repository files (A5.2, S1.0) |
| F2 | BLOCKER | CLAUDEX's task profile is read-only and `--system-prompt-snapshot on` freezes the first system prompt | mode-neutral standing contract as system prompt; per-turn instructions in the input; new `prompts/task.md`; permissions enforced per launch; S1.1 proves the transitions |
| F3 | BLOCKER | `git diff-tree -p` output cannot feed `trackedInput` | `--no-commit-id --root PATCH_FLAGS`; merge commits first-parent; shallow ancestry → 2 (A5.2); the twin adopts `--no-commit-id` |
| F4 | MAJOR | `review-input.mjs` has no findings ledger | CLAUDEX `review-findings.mjs` ported as `core/findings.mjs`; tests for both donors' cases |
| F5 | MAJOR | Claude terminal validation and answer extraction lost | A2 facts and S3.3 port the donor's checks; `result.result`/`structured_output`; merged denials; fake scenarios added |
| F6 | MAJOR | `--live`, `--set`, `--allow-command`, `--max-turns` missing from the contracts; `--allow-command` is a wrapper flag | A3.2/A3.3 define them, provider-scoped; translated into settings rules, never forwarded |
| F7 | MAJOR | Claude `--web` granted permission without exposing the tools | both `--tools` and `--allowedTools` (A3.3, S3.2) |
| F8 | MAJOR | S0 validator gate could not pass (README, marketplace version, engines parser) | README stub in S0.2; no marketplace version; parser adapted and tested (S0.6) |
| F9 | MAJOR | Unqualified twin references imported inapplicable tests and `splitLeading` | test-port table (S1.8); `splitLeading` dropped; S4 expanded |
| F10 | MAJOR | Process budget contradicted the preflight port and task snapshots | A1 enumerates permitted subprocesses and the cached cold probes; counters tested |
| F11 | MAJOR | Host spike did not prove preflight behaviour; AGYX has no `setup` | S1.4 uses donor verbs and independent resource checks per sandbox; descriptors with access and timeout |
| F12 | MAJOR | Adapter interface lacked lifecycle hooks for snapshots | optional `beforeTurn`/`afterTurn` (A5); the twin adopts them |
| F13 | MAJOR | `thread` vs `session` naming; ambiguous bare native ids | `session` for the host, `threadId` for the native id (A7); ambiguous id → 2 |
| F14 | MAJOR | Recursion guard omitted `AGY_BRIDGE_DEPTH` | added (A5.1) |
| F15 | MAJOR | Byte-identical core coupling not achievable as specified | pinned manifest, narrowed list, `review-input` host-neutral, `comparison deferred` when no counterpart (S2.7) |
| F16 | MAJOR | Shared semantics drifted; explicit tier vs inheritance undefined | `docs/cross-host-contract.md`; effort lower-bound and round rules restored; explicit `--tier` overrides inheritance (A3.3) |
| F17 | MAJOR | Windows fakes conflicted with Claude's native-only rule | configured-JS exception kept; wrapper rejection as negative tests (A2, S2.2) |
| F18 | MAJOR | Installed qualification preceded installation | S7.0 candidate install with baseline and hash check; S8.1 promotes the tag |
| F19 | MAJOR | Qualification lacked expected outcomes; sandboxes not exercised | matrix columns incl. sandbox, route, fixture, expected outcome; offline cells separated (S7.1); released-equals-qualified record (S7.4) |
| F20 | MINOR | Source inventory omitted CODEXCC and gemini-plugin-cc; historical figures unlabelled | NOTICE inventory (S0.1); provenance labels (S6.5) |
| F21 | MAJOR | Migration could remove recovery tools for active donor jobs | S8.0 drains the donors first |

### Gemini 4 Argon, 15 findings

| # | Sev | Finding | Resolution |
|---|---|---|---|
| F1 | BLOCKER | Incompatible schemas; draft 2020-12 rejected by Claude; no ledger; `streams.json` fixtures in the old shape; non-hermetic test | as Codex F1 and F4; fixtures regenerated (S1.5) |
| F2 | BLOCKER | `profiles/task.txt` forbids edits; `advice.txt` omitted | as Codex F2; `prompts/advice.md` added |
| F3 | BLOCKER | Answer taken from `assistant` events breaks on uncommitted streams and multi-turn runs; `edited` collection unspecified | as Codex F5; `edited` from `tool_use` blocks (A5.1, S3.3) |
| F4 | BLOCKER | `--commit` and `--base` incompatible with `trackedInput`; `--uncommitted` fallback; untracked symlinks | as Codex F3; `--base` through `merge-base`; no fallback; link-text entries (A5.2) |
| F5 | BLOCKER | gemini-plugin-cc cache not in the source table; batch prompt composition unspecified | GEMINICC added; `buildBatchReviewPrompt` (A5.2, S2.5) |
| F6 | MAJOR | Bare `review`/`--next-input` would wait 10 s on stdin; `reply <job> --` collision; `--next-input` must refuse text | `stdin.mjs` and `args.mjs` rules (S2 table, S2.2, A3.1) |
| F7 | MAJOR | Preflight ran before replay and before the adapter was loaded | A4 order; S2.6 |
| F8 | MAJOR | Byte-identical list overstated | as Codex F15 |
| F9 | MAJOR | `cancel --confirm-ended` missing from A3; AGYX's live-process refusal rule | A3.2/A3.3/A3.5; refusal rule in A7.8 |
| F10 | MAJOR | `--allow-command`, `--set`, `--live`, `--max-turns` missing | as Codex F6; `--max-turns` defaults by verb |
| F11 | MAJOR | Gemini `print_timeout` 1 vs 10; settings construction; snapshot scope | exit 1 everywhere; `sessionSettings` semantics (A5.1); snapshots per invocation via hooks |
| F12 | MAJOR | S4 collapsed into a cross-reference; no Grok preflight; 180,000 B cap; depth variables | S4.1–S4.7 written out |
| F13 | MAJOR | CLAUDEX e2e test needs adapted regexes, markers, footer parsing, `pwsh` | S6.2 |
| F14 | MINOR | Validator gate before README and skill terms exist; engines regex | as Codex F8; terms skeleton in S0.5 |
| F15 | MINOR | `</dev/null` and `[user]` marks | S6.6 commands need no stdin by A3.1; S8 chat check marked |

Where the reviewers disagreed: the Claude `exec` tier (Codex `default`, Argon `sonnet`); recorded in A2 for the owner. Both reviewers also asked that the twin plan receive the shared corrections: `--no-commit-id` on `diff-tree`, the optional lifecycle hooks, the explicit-tier-overrides-inheritance rule, and merged global permission lists for Gemini; applied to the twin the same day.

## Round 2

Both reviewers received the resolutions and the revised text.

- Gemini 4 Argon: "no objections".
- Codex gpt-6.1-sol: five resolutions incomplete, each adopted verbatim afterwards. F1: the schema test in S1 relied on a validator scheduled for S2 → the validator is written in S1.0 and S2.5 integrates it. F10: ordinary `cancel` and owner-death recovery need `ownsProcess` → they load the recorded provider's inspection code only, bypassing preflight, probes and `buildTurn`, starting no provider process (S2.6). F14: per-provider guard variables did not stop cross-provider legacy recursion → every child receives all five variables (A5.1). F18: the local and Git marketplaces share a name and removal works by name → S8.1 replaces or removes-then-adds and never removes `council-for-codex` afterwards. F21: the donors list no jobs without an identifier → S8.0 enumerates their state roots and collects each job by its handle, job id or run id.

The plan was committed after these five edits.
