# Decisions log

Every deviation from `PLAN.md` Part A or Part B, every Part A correction a step discovers, and every provisional default taken where a **[user]** probe is pending. Format: date, what changed, why, which steps it touches. Newest entry last.

## 2026-10-31 S0: scaffold

- Created the S0 skeleton per `PLAN.md` S0.1 to S0.8: Apache-2.0 `LICENSE`, `NOTICE` inventory, `package.json` (Node `>=18.20.8 <19 || >=22.19.0`, no dependencies), manifests, entry stub, skill stub, validator, test runner, docs skeleton.
- GEMINICC (`~/.claude/plugins/cache/gemini-plugin-cc/gemini/2.1.0`) ships no LICENSE file (only `.claude-plugin/plugin.json` naming the author). Per S0.1, nothing from it is copied; its review templates and `review-output.mjs` behaviour are reimplemented when S2.5 needs them. Touches S1.0 (schema written from GROKX, not GEMINICC), S2.5.
- CODEXCC is an installed cache (`2.3.2`), not a Git checkout, so `NOTICE` records its version and the upstream repository instead of a commit. Touches S0.1 only.
- No deviation from Part A or Part B otherwise.

## 2026-10-31 S1: spike and catalog

Part A corrections (§0: the step stopped, Part A was corrected, the step continued):

- **A5.1 grok, login file.** Part A named `~/.grok/user-settings.json` or `GROK_API_KEY`. On grok 1.0.70 the credential file is `~/.grok/auth.json` (mode 0600); `user-settings.json` does not exist and GROKX never references it. Corrected to `~/.grok/auth.json` (or `GROK_API_KEY`). Touches S4.1 preflight descriptors.
- **A2 agy, denial signature.** Part A said native results have no `denied_actions`. Observed: a deny-rule denial is a tool step `ERROR` matching the A2 regex with no `denied_actions`; a prompt-style denial under `toolPermission: request-review` (a command outside the allow pair) sets `result.denied_actions: [{action: "command", display_name: "RunCommand"}]`, empties `response`, keeps `status: "SUCCESS"` and prints a `jetski: no output produced …` stderr line. Both are denials (exit 10). Touches S5.3, fakes (`denied`, `denied-prompt`).
- **A2 Claude, effort.** All five values are accepted; an unknown value is not rejected but ignored with a stderr warning ("Unknown --effort value 'ultra' — ignoring it and using the default effort"). Council validates the vocabulary itself (A3.3) and never relies on the CLI. Touches S3.2.
- **A2 Claude, denials on read-only turns.** Read-only turns carry no edit tool, so an attempted edit produces no `permission_denied` event and an empty `result.permission_denials`: it appears as an `assistant` `tool_use` block followed by a `user` `tool_result` with `is_error: true` ("No such tool available: Edit …"). The donor's `permission_denied` shape stays valid for a present-but-denied tool. Added to A2; S3.3 must treat an edit-tool `tool_use` with an error result on a read-only turn as an attempted edit (exit 10 `denied` is the proposed mapping; question for the judge).
- **A2 Claude, unknown model.** `--model gpt-6.1-sol` → init echoes the id, synthetic assistant text, `result` `subtype: "success"`, `is_error: true`, `terminal_reason: "api_error"`, cost 0, exit 1, stderr `[claude-code:unrecognized_model]`. Recorded as the pass-through failure case (fixture `is-error`).
- **A2 Grok facts added.** `--add-dir` is refused by a session ("additionalDirectories is not supported"); reviews run with `cwd` at the repository root. `end.modelUsage` names `grok-4.7-build` for `--model grok-4.7`. New `thought` events appear in 1.0.70 streams. `max` error text: `unknown effort level 'max'; use one of: xhigh, high, medium, low`.
- **A3.3 Gemini `--web` decided.** The `search_web(*)` deny rule did not block the search (two probes: tool `search_web` DONE with and without the rule). Read-only Gemini turns cannot deny web search; Gemini `--web` exits 2; `setup` lists the trade-off. Touches S5.2, S6.1.
- **A5.1 gemini, `--allow-command` scope (fact added, rule unchanged).** The allow pair restricts other commands only when the merged `toolPermission` is `strict` or `request-review`; under the user's global `always-proceed` (kept by AGYX `sessionSettings` on edit turns) every command ran. Open question for the judge: should council force `request-review` on tasks unless the global value is `strict`? Provisional: A5.1 as written (preserve the global value).

Decisions the gate asks for:

- **Claude task launch (S1.1).** Argon's candidate set is A5.1's task launch: `--permission-mode acceptEdits --permission-prompts none --tools Read,Glob,Grep,Edit,Write,MultiEdit,NotebookEdit,Bash --allowedTools Edit,Write,MultiEdit,NotebookEdit,Bash --disallowedTools "Bash(git push*)" "Bash(git reset --hard*)" "Bash(rm -rf *)" "Bash(sudo *)"`, hooks and MCP off. Evidence (`docs/spike/claude.md`): Read → Edit → Bash with no prompt and `permission_denials: []`; the same session resumed read-only could not edit (tool absent); a review session resumed with the set edited through Bash. Codex's `dontAsk` variant was not needed; `bypassPermissions` not used.
- **Gemini `--web`: exits 2** (above).
- **agy denial signature: both shapes** (above); the regex `permission (check failed|denied)|approval (required|denied)|user.configured deny` matched every observed tool-step error ("permission check failed … Matches user-configured deny rule", "permission check failed … user denied permission to run command").
- **Codex concurrency: pending user probe → provisional sequential fan-out (A6).** S1.4's chat probes are [user]; `docs/spike/codex-host.md` records the offline facts. Until the probe runs, the skill issues fan-out asks one per turn.
- **Per-provider sandbox outcomes: pending user probe → provisional.** Preflight descriptors are taken from A2's recorded facts (Windows session A for Grok; AGYX `docs/P0.md` for agy; CLAUDEX preflight for Claude); S6.0/S7.1 re-check them under both sandbox modes.
- **Cold-preflight probe counts.** Claude 4 (`--version`, `auth status --json`, `--help`, missing-file capability probe; 0.235 s wall, no model call); agy 2 (`--version`, `models`); grok 2 (`--version`, `models`). `agy --help` and `grok --help` were captured once for the records and are not preflight probes.

Deviations and additions:

- **Accidental paid call.** `claude models` was run to confirm the absence of a listing; Claude has no such subcommand and treated the word as a prompt (one paid turn). The `--help` Commands list is the only safe check; the fakes exit 99 on `models`.
- **S1.2 settings probes substituted.** "Session `deny` array replaces the global one" and "global `allow: ["run_command(*)"]` still denied" would have required editing `~/.gemini/antigravity-cli/settings.json`, which has no `deny` array. Instead the existing global `allow: ["command(which)"]` and `toolPermission: "always-proceed"` served: with a session file lacking that allow and carrying `command(*)` in `deny`, `which node` was denied and `init.permission_mode` read `request-review`; session lists and `toolPermission` replace the global ones. A5.1's merge rule stands.
- **S1.3 batch probe at `--effort low`** through GROKX with an isolated `GROK_CODEX_PLUGIN_STATE`; one `review` and one `reply --next-input` (batches u1–u2, u3–u4 of 552 KB; pending 4 → 2). Synthesis was not reached (two more paid calls); the delivery mechanism is recorded.
- **Grok cancel probe retried once**: the first attempt used `--add-dir` and failed before any model call.
- **Fake scenarios beyond the S1.5 list**, each with provenance in the stream fixture: Claude `tool-absent`, `task`; agy `denied-prompt`, `effort-conflict`, `print-timeout`, `task`, `web`. Claude `denied` is the donor's fixture (not observed live).
- **`core/args.mjs` created in S1** with only `UsageError` (catalog and tiers need it); S2.2 ports `parseArgv` into it.
- **`tests/fixtures/review-output.reference.json`** carries its provenance as a draft-07 `$comment`; `schema.test.mjs` compares the schema with the fixture minus `$comment`.
- **Claude `permission_denied` fixture** is the donor's; no live probe produced one (see the A2 correction).
