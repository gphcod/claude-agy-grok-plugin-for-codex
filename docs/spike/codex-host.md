# Spike record: Codex host (codex-cli 0.163.0)

Recorded 2026-10-31. S1.4's paid parts run inside a Codex chat and are **[user]**; this record holds what was established without a chat (CLI help, read-only config and cache inspection) and marks the rest "pending user probe". Where a later S1 action depends on a pending probe, `docs/decisions.md` records the provisional default.

## Thread id env

`CODEX_THREAD_ID` presence and shape inside a Codex shell call: **pending user probe** (`printenv CODEX_THREAD_ID`). Both Codex-hosted donors read it (GROKX `jobs.mjs`, CLAUDEX `state.mjs`); A7.2 scopes `--last`, bare `wait` and bare `cancel` by it. Provisional: the variable is treated as optional (`session: null` when absent), as both donors do.

## Shell concurrency

Two independent shell calls in one turn (`sleep 20; date` each): **pending user probe**. Provisional (A6): fan-out is sequential, one `ask` per provider; the skill does not say to issue the asks in one turn until the probe shows overlap.

## Yield and collection

A yielding call (`sleep 400`) and how Codex collects it: **pending user probe**. Provisional: the handbook rule kept in A1/A3.5 (keep collecting the yielded shell with the longest wait; `wait <job>` only after a lost handle; never resubmit).

## Sandbox modes per provider and resource

Per-provider resource checks under `workspace-write` and `danger-full-access` (`$claude setup`, `$grok setup`, `agy models`, a write under `~/.gemini/antigravity-cli/`, a loopback listener bind, `ps -axo pid,command`): **pending user probe**. Provisional preflight descriptors come from A2's recorded facts (Windows session A: `workspace-write` blocked Grok's login file read and the process query; agy needs network, a loopback listener, process inspection and writes under `~/.gemini/antigravity-cli/`; Claude needs its config directory, the state root and network). `~/.codex/config.toml` sets no `sandbox_mode`/`approval_policy` keys at the top level (read-only grep), so the chat default applies. No `CODEX_*` variable was present in this (Claude Code) shell.

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

None established without a chat.
