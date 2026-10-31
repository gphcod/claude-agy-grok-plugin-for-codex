# Council for Codex

One Codex plugin, `council`, through which Codex calls Claude Code (`claude`), Gemini (`agy`, the Antigravity CLI) and Grok (`grok`) for questions, discussions, reviews and user-authorized tasks, choosing provider, model and thinking effort per call. It is the Codex-hosted twin of [Council for Claude Code](https://github.com/gphcod/codex-agy-grok-plugin-for-claude).

Status: under construction; `PLAN.md` is the procedure. Nothing is released yet.

## Install

```bash
codex plugin marketplace add gphcod/claude-agy-grok-plugin-for-codex --ref v1.0.0
codex plugin add council@council-for-codex
```

For a local checkout, `codex plugin marketplace add /absolute/path/to/claude-agy-grok-plugin-for-codex` instead of the Git form. A Git marketplace follows its `ref` in `~/.codex/config.toml`, so pin a release tag.

Requires Node.js 18.20.8 or a later 18.x, or Node.js 22.19.0 or later (not Node 20), plus the `claude`, `agy` and `grok` CLIs installed and logged in. The plugin has no runtime dependencies.

## Use

In a Codex chat the skill is `$council`. The companion is `plugins/council/scripts/council.mjs`; the verbs are `ask`, `reply`, `review`, `task`, `wait`, `cancel`, `models` and `setup`, each with `--to claude|gemini|grok`. The full surface is documented in S6 of `PLAN.md`; this README is expanded there.

## Development

```bash
npm test            # fake-backed suite
npm run validate    # suite plus manifest, skill and README checks
npm run test:live   # live CLI tests (paid; only where the plan names them)
```

State lives under `~/.codex/council/` (override `COUNCIL_CODEX_HOME`), never in the plugin directory or the workspace.
