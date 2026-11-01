# Spike record: Codex host (codex-cli 0.163.0)

Recorded 2026-10-31; S1.4's in-chat probes recorded 2026-11-01. The paid probes ran, with the user's authorization, inside two real Codex sessions on this Mac (`codex exec`, codex-cli 0.163.0, model gpt-6.1-sol at low effort), one under `--sandbox workspace-write` and one under `--sandbox danger-full-access`, each told to run fixed shell commands and change nothing. Two `agy` checks the first sessions' approval review rejected (because the command contained `rm -f`) were rerun in a second pair of sessions. Evidence (outside the repository, in the coordinator's session scratchpad `hostprobe/`): `prompt-a.md`/`prompt-b.md` and `prompt-c.md` (the commands), `events-a.jsonl` (workspace-write) and `events-b.jsonl` (danger-full-access), each line prefixed with an epoch timestamp, `events-c-workspace-write.jsonl` and `events-c-danger-full-access.jsonl` (the agy reruns), `answer-*.md` (the sessions' result tables) and `stderr-*.txt`.

## Thread id env

`CODEX_THREAD_ID` is present in every shell call and equals the session's thread id from the event stream, a UUID v7 (`01a197a0-f83d-7c91-a56d-8bc2b213cca7` in events-a, `01a197a1-05a6-7922-b1dc-3f99563d73a1` in events-b). Also present: `CODEX_SESSION_ID`, `CODEX_TOOL_CALL_ID`, `CODEX_CI`, `CODEX_VERSION`, `CODEX_APPLY_PATCH_PRESERVE_LINE_ENDINGS`; under `workspace-write` also `CODEX_SANDBOX` and `CODEX_SANDBOX_NETWORK_DISABLED`. A7.2 scopes `--last`, bare `wait` and bare `cancel` by it, as both Codex-hosted donors do; the code still treats it as optional (`session: null` when absent, for calls outside Codex).

## Shell concurrency

Two shell calls issued in one turn (`node -e 'console.log(…, Date.now())'; sleep 20; node -e …` each) ran fully in parallel: both started at epoch ms 1793545280348 and both ended at 1793545300401, 20.05 s later (events-a, answer-a). A fan-out may therefore issue its asks as parallel shell calls in one turn (A6, amended 2026-11-01).

## Yield and collection

`sleep 400; echo slept-400` yielded after 10.0 s with the process still running (events-a: the tool returned a session handle and no output). In `codex exec` the model then ended its turn without collecting the shell, so the command's result was never read. The skill's rule is therefore essential: keep collecting the same shell session with the longest wait allowed; `wait <job>` only after the handle is lost; never resubmit.

## Sandbox modes per provider and resource

| Check | `workspace-write` (events-a, events-c-workspace-write) | `danger-full-access` (events-b, events-c-danger-full-access) |
|---|---|---|
| council state root `~/.codex/council` (mkdir) | write failed, EPERM | ok |
| network (`fetch` HEAD to api.anthropic.com) | fails: node exits 139 (`SecItemCopyMatching failed -50`); `CODEX_SANDBOX_NETWORK_DISABLED` is set | ok (HTTP 404) |
| `~/.claude/projects` (mkdir) | write failed, EPERM | ok |
| `claude auth status --json` | exit 1 | exit 0 |
| claude_plugin_for_codex 0.5.0 `setup` | exit 1, `preflight_blocked` for its state directory (EPERM) | exit 0 |
| loopback listener on 127.0.0.1 | EPERM | ok |
| `ps -axo pid,command` | exit 127 | ok |
| `agy models` | exit 1 | exit 0 |
| write under `~/.gemini/antigravity-cli/` | EPERM | ok |
| `~/.grok/auth.json` readable | ok | ok |
| grok_plugin_for_codex 1.1.0 `setup` | exit 0, "ready" (it checks only the login file) | exit 0 |

Consequence: under `workspace-write` council cannot run any provider: its own state root and the network are blocked, and so are Claude's session storage, agy's backend directory, the loopback listener and the process table. Council's preflight stops every turn with `preflight_blocked` and zero submissions. Run Codex with `danger-full-access`, or add `~/.codex/council` and each provider's directories (`~/.claude`, `~/.gemini/antigravity-cli`) as writable roots and enable network; the process table and the loopback listener must also be allowed (they were blocked here). `~/.codex/config.toml` sets no `sandbox_mode`/`approval_policy` keys at the top level (read-only grep), so the chat default applies.

## PowerShell boundary

Windows only; S7.2.

## Install and refresh behaviour

Established from the CLI and read-only inspection:

- `codex plugin --help`: subcommands `add`, `list`, `marketplace` (`add`, `list`, `upgrade`, `remove`), `remove`. `codex plugin add <PLUGIN[@MARKETPLACE]>` or `--marketplace`; `marketplace add` takes "a local or Git marketplace"; `marketplace remove` works "by name" (S8.1's premise); `marketplace upgrade` refreshes Git snapshots.
- `~/.codex/config.toml` (read-only): `[marketplaces.<name>]` with `source_type = "git"`, `source = "https://github.com/gphcod/<repo>.git"`, `ref = "v<tag>"` for the three donors (`claude-plugin-for-codex` v0.5.0, `grok-plugin-for-codex` v1.1.0, `gphcod-agy` v0.1.2); `[plugins."<plugin>@<marketplace>"] enabled = true`. A Git marketplace follows its `ref`, so release pins are tags (A2 confirmed).
- `codex plugin marketplace list`: Git marketplaces are checked out under `~/.codex/.tmp/marketplaces/<name>/` (their `.agents/plugins/marketplace.json` is the root); `codex plugin list` reports `installed, enabled`, the version and the source path per plugin.
- Installed copies live under `~/.codex/plugins/cache/<marketplace>/<plugin>/<version>/` with the plugin's own tree (`.codex-plugin/`, `skills/`, `scripts/`, `schemas/`, …): the hash target for `validate-plugin.mjs --installed` (S6.7).
- Plugin layout per A2 confirmed from the donors' installed trees: `.agents/plugins/marketplace.json` at the repository root, `plugins/<name>/.codex-plugin/plugin.json` with `skills: "./skills/"`, `skills/<skill>/SKILL.md`, optional `agents/openai.yaml`.
- `codex exec --help` lists `-s, --sandbox <SANDBOX_MODE>`, `--full-auto`, `--dangerously-bypass-approvals-and-sandbox`; none was run.

## Surprises

- A yielded shell is not collected by `codex exec` unless the model keeps polling it: the turn ended with `sleep 400` still running.
- grok_plugin_for_codex 1.1.0's `setup` reports ready under `workspace-write` because it checks only the login file, although the process table and the network are blocked there; council's Grok preflight checks the state root and the process table too.
- Codex's approval review rejected commands containing `rm -f` even under `danger-full-access`; the agy checks were rerun without it.
