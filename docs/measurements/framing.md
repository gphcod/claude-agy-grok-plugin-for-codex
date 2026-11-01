# Framing measurement (S6.5)

Per-call framing is what Codex reads from one `ask` besides the model's answer: council's start line on stderr (`[council] provider=… job=… thread=…`) and its footer line on stdout, with their line ends. `npm run measure` runs one `ask --to <provider> -- Reply with pong` per provider against the repository's fakes (no real CLI, no model call) in a scratch state root and Git workspace, and subtracts the answer. This is the handbook's host-context method ("the ask output with each repository's fake CLI, less the fake answer").

## New: council 1.0.0-rc.1 (measured)

Measured 2026-11-01 on macOS 27.0.1 (arm64), Node 22.19.0, branch `s6`, with `npm run measure`:

| Provider | Start line (stderr) | Footer (stdout) | Framing per ask |
|---|---|---|---|
| claude | 91 B | 85 B | 176 B |
| gemini | 91 B | 84 B | 175 B |
| grok | 89 B | 76 B | 165 B |

Skill: 2,998 B after the S7.1 fixes (2,993 B when measured here, 2,997 B before S7.1), description 168 B (the whole standing cost; one skill, no MCP server).

The footers were `council claude ok · job <16> · claude-opus-5-5/high · 0s · round 1/9`, `council gemini ok · job <16> · gemini-4-argon/high · 0s · round 1/9` and `council grok ok · job <16> · grok-4.7/high · 0s · round 1/9`; the start lines carry the 16-character job id and the 36-character native thread id. The bytes vary with the model name, the duration token (`0s` against the fakes; `1m05s` adds 3 B), the round, and the optional footer tokens (`edited N`, `unreviewed N`, `batch i/n`, `model unverified`, `full: <file>`, `error: …`, a recovery hint). A `--request-id` does not change the length: job ids are always 16 characters.

## Historical (from the handbook, not re-measured here)

Source: github.com/gphcod/handbook `agent_plugin_design_comparison.md` at `e9ad313`, section "Host context cost (static, from the plugin files)" and its method paragraph.

| Plugin | Version | Framing per ask | Provenance |
|---|---|---|---|
| claude_plugin_for_codex | 0.4.2 | 72 B | handbook host-context method, re-measured on 2026-10-16 (macOS 26.7.1, Node 24.21.0) and at `fef7d0b` on 2026-10-17; 0.4.2's runtime differs only in stdin reading, so it was not measured again; unchanged with a request id |
| grok_plugin_for_codex | 1.0.4 | 139 B (151 B with `--request-id`) | same method and run, 2026-10-16 |
| gemini-plugin-for-codex | 0.1.2 | 128 B | separate pinned-fake run on 2026-10-30; the handbook marks it as not a matched cross-plugin result |

## Comparison

Council's framing is larger than either donor's: 165–176 B against 72 B (claude_plugin_for_codex) and 139 B (grok_plugin_for_codex). The difference is the start line, which names the provider, the 16-character job id and the native thread id before the answer (A3.4) so that a lost shell handle can be recovered with `wait <job>`, and the footer, which always prints the model and effort actually used. The historical figures were taken on another machine, Node version and fake set, so the comparison is indicative, not matched.
