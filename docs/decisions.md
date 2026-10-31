# Decisions log

Every deviation from `PLAN.md` Part A or Part B, every Part A correction a step discovers, and every provisional default taken where a **[user]** probe is pending. Format: date, what changed, why, which steps it touches. Newest entry last.

## 2026-10-31 S0: scaffold

- Created the S0 skeleton per `PLAN.md` S0.1 to S0.8: Apache-2.0 `LICENSE`, `NOTICE` inventory, `package.json` (Node `>=18.20.8 <19 || >=22.19.0`, no dependencies), manifests, entry stub, skill stub, validator, test runner, docs skeleton.
- GEMINICC (`~/.claude/plugins/cache/gemini-plugin-cc/gemini/2.1.0`) ships no LICENSE file (only `.claude-plugin/plugin.json` naming the author). Per S0.1, nothing from it is copied; its review templates and `review-output.mjs` behaviour are reimplemented when S2.5 needs them. Touches S1.0 (schema written from GROKX, not GEMINICC), S2.5.
- CODEXCC is an installed cache (`2.3.2`), not a Git checkout, so `NOTICE` records its version and the upstream repository instead of a commit. Touches S0.1 only.
- No deviation from Part A or Part B otherwise.
