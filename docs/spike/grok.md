# Spike record: grok (Grok CLI)

Recorded 2026-10-31 on macOS (arm64), Node 22.19.0, by the S1.3 probes. Sanitized streams: `tests/fixtures/streams/grok.json`. Probes ran once at `--effort low` (xhigh once, on a one-word prompt) on scratch Git repositories. Paid turns: 7 direct (ask, resume, xhigh, review, cancel ×2 incl. the failed first attempt that reached no model, large-review cancel) plus 2 through the GROKX companion (review batch 1, `--next-input` batch 2). Recorded cost: $0.04 direct + $0.19 companion.

## Version and launcher

`grok --version` → `grok 1.0.70 (f50904eaee6c) [stable]`; PATH `/Users/cia/.grok/bin/grok`. `grok --help` → `docs/spike/grok-help.txt`: `--effort <e>` is an alias of `--reasoning-effort`; `--allow <RULE>`, `--deny <RULE>`, `--permission-mode <MODE>`, `--max-turns <N>`, `--json-schema <SCHEMA>`, `--prompt-file`, `--rules`, `-r/--resume`, `-s/--session-id`, `--sandbox <PROFILE>`, `--agent`, `--disallowed-tools`, `--no-subagents`, `--disable-web-search`, `--add-dir` are listed; `--no-auto-update` is hidden and accepted (A5.1).

## Headless invocation (exact argv)

```
grok --prompt-file <f> --output-format streaming-json --model grok-4.7 --effort low --no-auto-update \
  --agent explore --always-approve --no-subagents --disable-web-search --disallowed-tools <HOSTILE> --deny 'MCPTool(*)' \
  --rules <contract> --session-id <uuid>          # read-only; reviews: --json-schema '<inline json>' and no --rules
```

Exit 0 on `end_turn`, 1 on an `error` event (effort), 143 after SIGTERM.

## Stdin shape

None; the prompt is the `--prompt-file` operand (UTF-8). stdin was closed at spawn.

## Event names seen

`available_commands` (`tools: ["read_file","list_dir","grep"]` under explore, `commands: ["compact"]`; emitted three times per turn), `thought` (reasoning deltas with a `signature`; new since GROKX's 1.0.46 reader, ignored), `text` (`data` deltas; on reviews the JSON arrives as text deltas too), `tool_call` (`toolName`, `rawInput`), `tool_call_update` (`status`, `content`, `rawOutput`), `usage`, `end` (`stopReason: "end_turn"`, `sessionId`, `requestId`, `cwd`, `usage`, `num_turns`, `total_cost_usd`, `total_cost_usd_ticks`, `modelUsage`, `structuredOutput` on reviews), `error` (`message`, `cwd`).

## Resume form

`-r <session uuid>` with the same recipe; `end.sessionId` equals the id (session confirmation); the model remembered the first turn ("pong 2").

## Read-only controls and their evidence

The explore recipe advertised only `read_file`, `list_dir`, `grep`; no edit or shell tool appeared in the catalogue or in calls. The reader's FORBIDDEN check (GROKX) remains the guard; fixture `denied` is the donor's default-agent catalogue (synthetic). `--deny MCPTool(*)` accepted. Inline `--json-schema` with the S1.0 schema: `end.structuredOutput` holds the validated object (findings with `id`), the same JSON streamed as `text` deltas.

## Effort rules

`--effort xhigh` → SUCCESS. `--effort max` → stdout `{"type":"error","message":"--effort/--reasoning-effort: unknown effort level 'max'; use one of: xhigh, high, medium, low","cwd":…}`, stderr `Error: --effort/--reasoning-effort: unknown effort level 'max'; use one of: xhigh, high, medium, low`, exit 1, no model call.

## Model listing

`grok models` → `docs/spike/grok-models.txt`: `You are logged in with grok.com.`, `Default model: grok-4.6`, rows `- grok-4.7`, `- grok-4.7-build-fast`, `* grok-4.6 (default)`, `- grok-4.5` (GROKX `parseModels` shape). `--model grok-4.7` is reported in `end.modelUsage` as `grok-4.7-build` (cost accounting name); the footer keeps the requested id.

## Login file

`~/.grok/auth.json` (mode 0600, 1.8 KB) exists; `~/.grok/user-settings.json` does not. `grok models` prints the login state. A5.1 corrected: preflight reads `~/.grok/auth.json` (or `GROK_API_KEY`) and the process-table query.

## Process table incl. pgid

`grok --prompt-file <path> …` visible with the full operand (ownership evidence); pid 62077, pgid 62077 (detached spawn); no child processes listed during the turn or left after the kill.

## Cancel behaviour

`kill -TERM -- -<pgid>` 3.3 s after start (after the catalogue and a `list_dir` call): exit 143 after 846 ms, no `end` event, no survivors, pipes closed with the process.

## Timeouts

None built in beyond `--max-turns`; council's deadline and inactivity timeout stop the process.

## Review batching through GROKX (300 KB input)

GROKX 1.1.0 `review --effort low --request-id spike-batch-1` on a 552 KB staged change set (6 files, isolated `GROK_CODEX_PLUGIN_STATE`): exit 10, footer `-- grok needs attention · job 95761141 · grok-4.7@low · 5s · $0.09 · unreviewed 4 · review 95761141 · coverage partial · pending 4 · next: reply 95761141 --next-input`; batch 1 covered `u1–u2` (mod0, mod1). `reply 95761141 --next-input --effort low`: a new job `qyfv` delivered `u3–u4`, footer `… unreviewed 2 · review 95761141 · coverage partial · pending 2 · next: reply qyfv --next-input`. Delivery is bounded by GROKX's 256 KiB inline cap per batch; council uses 180,000 B (A5.2), so the same input yields more batches. The job directory held `answer.md`, `beat`, `done`, `events.jsonl`, `meta.json`, `prompt.md`, `request.json`, `review-input/`.

## Windows launcher kind

Not available; S7.2.

## Surprises

- `--add-dir` is refused: `Couldn't create session: additionalDirectories is not supported: a session works only in its cwd` (error event, exit 1). Reviews must run with `cwd` at the repository root.
- `thought` events and triple `available_commands` per turn.
- `modelUsage` names `grok-4.7-build` for `--model grok-4.7`.
- The login file is `~/.grok/auth.json`, not `user-settings.json`.
