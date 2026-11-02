# Windows check (2026-11-01)

Windows 11 Enterprise 10.0.26200, Node 22.19.0, Git for Windows, PowerShell 5.1. agy 1.4.12, grok 1.0.70, Claude Code 2.1.314.

## Tests

`npm test`: all tests pass or are skipped for the platform reasons below; `npm run test:e2e` passes in `sh` and PowerShell (31 cases); `node scripts/validate-plugin.mjs` passes.

## Real CLIs, from the installed plugin's scripts

`setup`, `ask` on claude, gemini and grok; `review` on claude.

## agy read-only and cancel (S7.2's Gemini attempt)

The global `toolPermission` here is `always-proceed`, so the turn's own settings file is what restricts a read-only turn.

- A read-only turn asked to create a file, edit a file and run `whoami`: all three denied by the deny rules (exit 10, footer names the denial), and no file changed.
- `task` created the file it was asked to, `edited 1`.
- `cancel` on a streaming turn: 3 s, `cancelled`, no `agy.exe` left; ownership by the `--settings` operand works on the Windows command line.
- `reply` resumes the conversation; `review` returns structured output.

## Windows behaviour worth knowing

- libuv puts non-detached children in a kill-on-close job object, so a hard-killed companion takes its provider child with it. Only a detached process outlives it. `cancel` still confirms cleanup and releases the claim.
- `generativelanguage.googleapis.com` fails its TLS handshake on this managed network while agy works, so on Windows a TLS refusal of that stand-in target counts as a reachable network.
- Tests for what Windows lacks are skipped by platform: file names with a tab, newline or quote; FIFOs; `chmod` removing read access; POSIX signals, process groups and exec bits; symlinks without Developer Mode.

## Inside a Codex chat

`codex exec --sandbox danger-full-access` with `$council` at 1.0.0-rc.4 (2026-11-02): Codex loaded the skill, ran its PowerShell form, and Grok answered with exit 0 and the footer `council grok ok`. Under `workspace-write` the skill stops at `preflight_blocked` and submits nothing, as the README says.

## Not checked

The npm grok shim. Claude, Gemini 4 Argon and Grok have now completed live reviews from this Codex chat through the Git marketplace installation; see `review-2026-11-02.md`.
