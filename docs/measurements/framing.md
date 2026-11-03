# Framing measurements

Framing is the stderr startup line plus the stdout footer, with line ends, excluding the provider's answer. Since 1.1.0 startup is `[council] provider=<p> job=<id>[ target=<review target>]`; native ids remain in JSON, saved state and wait. `npm run measure` performs a simple fake ask; the matched benchmark additionally measures ask/reply/review/discussion against identical pinned fakes.

## 1.1.0 matched Windows benchmark (2026-11-02)

Windows 11 x64, Node 22.19.0; 1.0.0 vs 1.1.0, ten samples/arm/provider/workload, 100 retained jobs, alternating arm order. Defaults stay Opus 5.5/high, Argon/medium and Grok 4.7/high. [Raw benchmark](benchmark-1.1.0-windows.json), [qualification and full timing table](../qualification/efficiency-1.1.0-windows.md), [native usage spot checks](live-1.1.0-windows.json).

| Provider | Ask framing, 1.0.0 → 1.1.0 | Advice input bytes | First recovery-handle median |
|---|---|---|---|
| claude | 176 → 132 | 1882 → 1527 | 518.7 → 1259.6 ms |
| gemini | 177 → 133 | 1883 → 1528 | 1498.8 → 1400.9 ms |
| grok | 165 → 121 | 1881 → 1526 | 1094.7 → 1106.4 ms |

Every ordinary call saves 44 B by omitting the repeated UUID; footer fields are unchanged. Review framing is 229 → 185 B for Claude, 230 → 186 for Gemini and 218 → 174 for Grok; discussion is 289 → 245, 290 → 246 and 278 → 234 B. Description 168 → 128 B; final skill 2,965 → 2,963 B (2,908 B at the earlier runtime benchmark stage). Native input spot checks shrink by 118/84/74 tokens, with one pair/provider, separate from the approximately 19% reduction in wrapper-controlled advice bytes. No price or general latency reduction is claimed.

Framing varies with duration, model name, round and optional recovery/coverage tokens. The immediate-init fake does not model Gemini's new advantage when native initialization is delayed. Claude's first handle is later because of the added capability preflight.

## Host collection follow-up

The final skill names the shell and outer exec/wait yield controls, with waits capped at 60 seconds. Five matched host probes per arm compare it with the earlier 1.1.0 guidance and claude_plugin_for_codex 0.4.2. [Host evidence](host-collection-1.1.0-windows.json) and the [qualification](../qualification/efficiency-1.1.0-windows.md) separate collection counts and cached host tokens from CLI timing and provider input. Only SKILL.md differs from the frozen runtime benchmark payload; every other plugin file is byte-identical.

## Historical: 1.0.0-rc.1 on macOS

Measured 2026-11-01 on macOS 27.0.1 (arm64), Node 22.19.0, branch `s6`, with `npm run measure`:

| Provider | Start line (stderr) | Footer (stdout) | Framing per ask |
|---|---|---|---|
| claude | 91 B | 85 B | 176 B |
| gemini | 91 B | 84 B | 175 B |
| grok | 89 B | 76 B | 165 B |

Historical skill: 2,998 B after the S7.1 fixes (2,993 B when measured here, 2,997 B before S7.1), description 168 B (the whole standing cost; one skill, no MCP server).

The footers were `council claude ok · job <16> · claude-opus-5-5/high · 0s · round 1/9`, `council gemini ok · job <16> · gemini-4-argon/high · 0s · round 1/9` and `council grok ok · job <16> · grok-4.7/high · 0s · round 1/9`; the start lines carry the 16-character job id and the 36-character native thread id. The bytes vary with the model name, the duration token (`0s` against the fakes; `1m05s` adds 3 B), the round, and the optional footer tokens (`edited N`, `unreviewed N`, `batch i/n`, `model unverified`, `full: <file>`, `error: …`, a recovery hint). A `--request-id` does not change the length: job ids are always 16 characters.

## Historical (from the handbook, not re-measured here)

Source: github.com/gphcod/handbook `agent_plugin_design_comparison.md` at `e9ad313`, section "Host context cost (static, from the plugin files)" and its method paragraph.

| Plugin | Version | Framing per ask | Provenance |
|---|---|---|---|
| claude_plugin_for_codex | 0.4.2 | 72 B | handbook host-context method, re-measured on 2026-10-16 (macOS 26.7.1, Node 24.21.0) and at `fef7d0b` on 2026-10-17; 0.4.2's runtime differs only in stdin reading, so it was not measured again; unchanged with a request id |
| grok_plugin_for_codex | 1.0.4 | 139 B (151 B with `--request-id`) | same method and run, 2026-10-16 |
| gemini-plugin-for-codex | 0.1.2 | 128 B | separate pinned-fake run on 2026-10-30; the handbook marks it as not a matched cross-plugin result |

## Comparison with historical individual plugins

1.1.0's default Claude/Gemini/Grok asks frame 132/133/121 B. Against the historical individual wrappers above, Claude is 60 B larger, Gemini 5 B larger, and Grok 18 B smaller (30 B smaller with request id). Hosts, Node versions and fake sets differ, so these are output-size comparisons, not matched speed or backend-token results. The provider, recovery job, model/effort and round remain available; native ids are no longer repeated on stderr.
