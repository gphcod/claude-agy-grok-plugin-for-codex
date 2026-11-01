# Live all-provider check, macOS (S6.6)

Recorded 2026-11-01 (14:22–14:23 UTC) on macOS 27.0.1 (arm64), Node 22.19.0, branch `s6` at the S6.5 commit. Both commands ran once each, from a scratch working directory (not a Git repository) with a scratch `COUNCIL_CODEX_HOME`, against the installed CLIs: claude 2.1.314 (`/Users/cia/.local/bin/claude`), agy 1.4.12 (`/Users/cia/.local/bin/agy`), grok 1.0.70 (`/Users/cia/.grok/bin/grok`). The host's `CLAUDE*`, `CODEX*`, `GROK*`, `AGY*`, `COUNCIL*` and `ANTHROPIC*` variables were removed from the environment (this run was started from a Claude Code session, whose `ANTHROPIC_BASE_URL` would otherwise have redirected the network check); `HOME` stayed the user's, so every CLI used its own login. No model turn ran: both commands make non-billable probes only (A3.2). Stdin was `/dev/null`.

## `node plugins/council/scripts/council.mjs models --refresh`

Exit 0. `agy models` and `grok models` were re-run (each provider's probe also runs `--version`); Claude has no listing and printed its static catalog. Output:

```
claude (static catalog)
  default: low, medium, high, xhigh, max
  fable: low, medium, high, xhigh, max
  opus: low, medium, high, xhigh, max
  sonnet: low, medium, high, xhigh, max
  haiku: low, medium, high, xhigh, max
  claude-opus-5-5: low, medium, high, xhigh, max
  claude-sonnet-5-5: low, medium, high, xhigh, max
  aliases: fable=fable, opus=opus, sonnet=sonnet, haiku=haiku, default=default
gemini (refreshed 2026-11-01T14:22:58.522Z)
  gemini-4-argon-medium: medium
  gemini-4-argon: low, medium, high
  gemini-4-argon-high: high
  gemini-4-argon-low: low
  gemini-3.8-flash-high: high
  gemini-3.8-flash: low, medium, high
  gemini-3.8-flash-medium: medium
  gemini-3.8-flash-low: low
  aliases: argon=gemini-4-argon, flash=gemini-3.8-flash
grok (refreshed 2026-11-01T14:22:59.370Z)
  grok-4.7: low, medium, high, xhigh
  grok-4.7-build-fast: low, medium, high, xhigh
  grok-4.6: low, medium, high, xhigh
  grok-4.5: low, medium, high, xhigh
  aliases: 4.7=grok-4.7, 4.6=grok-4.6, build-fast=grok-4.7-build-fast
```

The refreshed listings match the S1 records (`docs/spike/agy-models.txt`, `docs/spike/grok-models.txt`): every tier model (`gemini-4-argon`, `gemini-3.8-flash`, `grok-4.7`, `grok-4.7-build-fast`) is listed.

## `node plugins/council/scripts/council.mjs setup`

Exit 0, 5.06 s wall. Cold preflight for all three providers (no cache in the scratch state root). Output:

```
claude: /Users/cia/.local/bin/claude (native) · 2.1.314 (Claude Code) · logged in · tiers consult=default/high exec=sonnet/high deep=default/xhigh · preflight ok
gemini: /Users/cia/.local/bin/agy (native) · 1.4.12 · logged in · tiers consult=gemini-4-argon/high exec=gemini-3.8-flash/high deep=gemini-4-argon/high · preflight ok
  warning: Gemini tasks without --allow-command run any command: the global agy toolPermission is always-proceed
  warning: Gemini read-only turns can search the web; --web is not offered for Gemini
grok: /Users/cia/.grok/bin/grok (native) · grok 1.0.70 (f50904eaee6c) [stable] · logged in · tiers consult=grok-4.7/high exec=grok-4.7-build-fast/xhigh deep=grok-4.7/xhigh · preflight ok
  warning: 2 grok executables on PATH; the first one runs (/Users/cia/.grok/bin/grok)
```

Per provider:

| Provider | Binary (launcher kind) | Version | Login | Preflight | Warnings |
|---|---|---|---|---|---|
| claude | `/Users/cia/.local/bin/claude` (native) | 2.1.314 (the qualified version; no warning) | logged in | ok | none |
| gemini | `/Users/cia/.local/bin/agy` (native) | 1.4.12 | logged in (`agy models` succeeded) | ok | the global agy `toolPermission` is `always-proceed`, so a Gemini task without `--allow-command` runs any command; Gemini read-only turns can search the web |
| grok | `/Users/cia/.grok/bin/grok` (native) | 1.0.70 (f50904eaee6c) [stable] | logged in | ok | two grok executables on PATH (`~/.grok/bin/grok` first, then `~/.local/bin/grok`); the first runs. *Later finding: `~/.local/bin/grok` is a symlink to `~/.grok/bin/grok`, the same binary; since the S1.4 follow-up the probe counts by real path and no longer warns here.* |

Preflight results cached in the scratch state root (every descriptor passed, none unverified):

- claude: state root writable; `~/.claude/projects` writable; `--version`, `auth status --json`, `--help` (every flag council passes) and the missing-file capability probe as expected; `https://api.anthropic.com` reachable.
- gemini: `~/.gemini/antigravity-cli` writable; state root writable; loopback listener on 127.0.0.1; `ps` readable; `agy --version` and `agy models`; `https://generativelanguage.googleapis.com/` reachable.
- grok: `~/.grok/auth.json` readable; state root writable; `ps` readable; `grok --version` and `grok models`.

These ran outside any Codex sandbox (a plain shell); the per-sandbox-mode cells (`workspace-write`, `danger-full-access`) are S7.1's.

## Other live invocations during S6

After `setup`, `claude --version`, `agy --version` and `grok --version` were run once each by hand to confirm the versions in this record (non-billable, no model call). No other real CLI was started in S6; every test ran against the fakes.
