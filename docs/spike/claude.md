# Spike record: claude (Claude Code CLI)

Recorded 2026-10-31 on macOS (arm64), Node 22.19.0, by the S1.1 probes. Raw captures stayed in the scratch directory; the sanitized streams are in `tests/fixtures/streams/claude.json` (provenance per scenario in `_provenance`). Every live probe ran once at `--effort low`, `--max-turns` 2 to 6, on a scratch Git repository. Paid calls: 10 (ask, resume, denial, unknown-model (api error, $0), task, review, task-then-reply, review-then-task, full-id, cancel) plus one accidental call, see Surprises. Recorded cost where the stream reported it: $0.36.

## Version and launcher

- `claude --version` → `2.1.314 (Claude Code)`. Resolved from PATH at `/Users/cia/.local/bin/claude` (native executable). Default configured model (init `model` with no `--model`): `claude-opus-5-5`.
- `claude --help` captured as `docs/spike/claude-help.txt` (22,344 B). The Commands list has no `models` entry; `--max-turns` and `--append-system-prompt-file` are absent from the help text and accepted (A2 confirmed, see Effort rules and Headless invocation).
- Alias list from `--help` (`--model`): "an alias for the latest model (e.g. 'fable', 'opus', or 'sonnet') or a model's full name". Observed full ids: `claude-opus-5-5`, `claude-sonnet-5-5` (`--model sonnet` → init `model: claude-sonnet-5-5`; `--model claude-sonnet-5-5` accepted).

## Headless invocation (exact argv)

Read-only (`ask`, `reply`, `review`), as run:

```
claude -p --input-format stream-json --output-format stream-json --verbose --session-id <uuid> \
  --system-prompt-snapshot on --append-system-prompt-file <contract> --max-turns 2 --effort low \
  --permission-mode dontAsk --permission-prompts none --setting-sources user --tools Read,Glob,Grep \
  --mcp-config '{"mcpServers":{}}' --strict-mcp-config --settings '{"disableAllHooks":true}' --no-chrome [--model <id>] [--json-schema <json>]
```

Task (the A5.1 candidate, proven; see Read-only controls):

```
... --permission-mode acceptEdits --permission-prompts none --tools Read,Glob,Grep,Edit,Write,MultiEdit,NotebookEdit,Bash \
  --allowedTools Edit,Write,MultiEdit,NotebookEdit,Bash ... --disallowedTools 'Bash(git push*)' 'Bash(git reset --hard*)' 'Bash(rm -rf *)' 'Bash(sudo *)'
```

`--allowedTools`/`--disallowedTools` are variadic (`<tools...>`), so they were placed last. Exit codes: 0 on success, 1 on `is_error` results, 143 after SIGTERM.

## Stdin shape

One NDJSON line, then EOF, exactly as CLAUDEX `runtime.mjs` `requestLine` writes it: `{"type":"user","session_id":"<uuid>","message":{"role":"user","content":"<prompt>"},"parent_tool_use_id":null}`. The per-turn instructions travelled inside `content` (see Resume form).

## Event names seen

`system/init` (`session_id` = the assigned uuid, `model`, `tools` (e.g. `["Glob","Grep","Read"]`), `permissionMode` (`dontAsk` / `acceptEdits`), `claude_code_version`, `capabilities` incl. `interrupt_receipt_v1`, `slash_commands`, `mcp_servers: []`); `system/thinking_tokens` (on the resume); `assistant` (`message.content` blocks: `text`, `thinking`, `tool_use` with `name` and `input`; the `StructuredOutput` tool_use carries the review JSON); `user` (tool results, incl. `is_error: true` with `<tool_use_error>`; `tool_result_meta[].permission_decision {decision: "accept", source: "config", reason_type: "mode"}` under acceptEdits); `rate_limit_event`; `result` (`subtype`, `is_error`, `result` string, `structured_output`, `permission_denials`, `usage`, `total_cost_usd`, `num_turns`, `session_id`, `modelUsage`, `terminal_reason`). No `permission_denied` event was produced by any probe (see Read-only controls).

## Resume form

`--resume <uuid>` with the same flag set; `system/init.session_id` equals the uuid; `result.num_turns` counts the new turn only. `--model sonnet` on the resume took effect (init `model: claude-sonnet-5-5`; `modelUsage` lists both models). The system prompt is the snapshot: with `--append-system-prompt-file` changed to a file saying `MARKER beta`, Claude quoted `MARKER alpha` from the first turn. This is why per-turn instructions travel in the input (A2, A5.1).

## Read-only controls and their evidence

- `--tools Read,Glob,Grep --permission-mode dontAsk --permission-prompts none`: asked to create a file, Claude answered "none of my tools can write files … denied"; no file appeared; `permission_denials: []`; no `permission_denied` event. The read-only guard is tool absence, not a permission denial.
- Task session (acceptEdits) resumed read-only and asked for another edit: Claude emitted a `tool_use` `Edit`, got `tool_result` `is_error: true` "No such tool available: Edit. Edit is disabled for this session, in subagents as well as here.", answered "denied"; the file was unchanged; `permission_denials: []`. The adapter must detect an attempted edit on a read-only turn from the `tool_use` block plus the error tool result, not from `permission_denied` (recorded in `docs/decisions.md`; S3.3 scope).
- Task launch (A5.1 candidate, Argon's set): `Read` → `Edit` (value 1 → 2) → `Bash` (`node -e "process.exit(0)"; echo $?` → `0`) without any prompt; `permission_denials: []`; `num_turns: 4`; the working tree showed ` M value.mjs`. A review session (`--json-schema`) resumed with the task set appended to README.md through `Bash` without prompts. Decision: this flag set is A5.1's task launch (decisions.md). `bypassPermissions` was not needed.
- `--json-schema` with `schemas/review-output.schema.json` (draft-07, incl. `maximum` on `confidence`): accepted; `result.structured_output` holds the object and `result.result` the same JSON as a string; findings carried `id` and `decision`.

## Effort rules

All five values accepted at the parser (non-billable probe with a missing `--append-system-prompt-file` sentinel: each printed only the file error). An unknown value is not rejected: `--effort ultra` → stderr `Warning: Unknown --effort value 'ultra' — ignoring it and using the default effort. Valid values: low, medium, high, xhigh, max.` and the run continues. Council therefore validates effort itself (A3.3 vocabulary) and never relies on the CLI to refuse.

## Model listing

None. The Commands list has no `models`; `claude models` is taken as a prompt and runs a paid turn (Surprises). The catalog is static aliases plus pass-through (`models.json`, `listing: false`). Unknown id (`--model gpt-6.1-sol`): init echoes `model: gpt-6.1-sol`, a synthetic `assistant` text "There's an issue with the selected model…", `result` with `subtype: "success"`, `is_error: true`, `terminal_reason: "api_error"`, `total_cost_usd: 0`, exit 1, stderr `[claude-code:unrecognized_model] {"model":"gpt-6.1-sol","query_source":"sdk"}`. Fixture `is-error`.

## Process table incl. pgid

`ps -axo pid,ppid,pgid,lstart,command` during the cancel probe: one `claude -p … --session-id 11111111-…-111111111106 …` row with every flag visible (the `--session-id` operand is the ownership evidence); pid 60785, ppid 60783 (the spawning node), pgid 60785 (spawned detached, so Claude leads its own group). No child process of Claude was listed during the turn; after the kill no process remained in the group.

## Cancel behaviour

`kill -TERM -- -<pgid>` 2.76 s after start (after init and a Glob tool_use): the process exited with code 143 after 497 ms, no result event, no survivors in the group, stdout closed with the process (no held pipe). The partial stream ended after a `user` tool_result.

## Timeouts

None built in beyond `--max-turns` (turn bound; donor fixture `limit`: `subtype: "error_max_turns"`, `is_error: true`) and `--max-budget-usd`. Council's `--deadline` and `--inactivity-timeout` stop the process (A3.3).

## Windows launcher kind

Not available on this machine; filled in S7.2 (A2: native executable only from PATH, `.cmd`/`.ps1` wrappers rejected, configured `COUNCIL_CLAUDE_BIN` may name a JS entry).

## Cold preflight probes (A1 budget)

CLAUDEX's four, run by hand: `claude --version`, `claude auth status --json` (`loggedIn: true`, `authMethod: claude.ai`, `configDirectory`, `subscriptionType`; the output also carries `email`, `orgId` and `orgName`, which must never be persisted), `claude --help`, and the capability probe `-p --append-system-prompt-file <missing> --max-turns 1 --tools '' …` (exit 1, `Error: Append system prompt file not found: <path>`). Count: 4 processes, 0.235 s wall in total, no model call.

## Surprises

- `claude models` is not a subcommand: the word is a prompt. Run once by mistake while confirming the absence of a listing; it produced a paid answer. `--help`'s Commands list is the only safe check.
- Read-only turns never produce `permission_denied`: the edit tools are absent, so an attempted edit is a `tool_use` followed by an `is_error` tool result (see above).
- Unknown `--effort` values are ignored with a warning, not rejected.
- `rate_limit_event` and `system/thinking_tokens` events appear in the stream and must be ignored by the reader.
- `result.result` duplicates `structured_output` as a string on `--json-schema` turns; the object is authoritative (A2).
