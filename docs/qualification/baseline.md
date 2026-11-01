# S7.0 candidate install: baseline and restoration (macOS)

Date: 2026-11-01. codex-cli 0.163.0. Authorized by the user ("install candidates").

## Baseline before the install

`~/.codex/config.toml` was backed up to `~/.codex/config.toml.before-council-s7.0`. Only the `[marketplaces.*]` and `[plugins.*]` sections are copied here. The rest of the file holds unrelated settings, including credentials for other tools, and stays out of the repository.

```toml
[marketplaces.openai-bundled]
source_type = "local"
source = "/Users/cia/.codex/.tmp/bundled-marketplaces/openai-bundled"

[marketplaces.openai-primary-runtime]
source_type = "local"
source = "/Users/cia/.cache/codex-runtimes/codex-primary-runtime/plugins/openai-primary-runtime"

[marketplaces.claude-plugin-for-codex]
source_type = "git"
source = "https://github.com/gphcod/claude_plugin_for_codex.git"
ref = "v0.5.0"

[marketplaces.grok-plugin-for-codex]
source_type = "git"
source = "https://github.com/gphcod/grok_plugin_for_codex.git"
ref = "v1.1.0"

[marketplaces.gphcod-agy]
source_type = "git"
source = "https://github.com/gphcod/gemini-plugin-for-codex.git"
ref = "v0.1.2"

[plugins."documents@openai-primary-runtime"]
enabled = true

[plugins."pdf@openai-primary-runtime"]
enabled = true

[plugins."spreadsheets@openai-primary-runtime"]
enabled = true

[plugins."presentations@openai-primary-runtime"]
enabled = false

[plugins."template-creator@openai-primary-runtime"]
enabled = true

[plugins."visualize@openai-bundled"]
enabled = true

[plugins."chrome@openai-bundled"]
enabled = true

[plugins."browser@openai-bundled"]
enabled = true

[plugins."codex-app-tools@openai-bundled"]
enabled = true

[plugins."unified-computer-use@openai-bundled"]
enabled = true

[plugins."computer-use@openai-bundled"]
enabled = true

[plugins."claude-code-advisor@claude-plugin-for-codex"]
enabled = true

[plugins."grok@grok-plugin-for-codex"]
enabled = true

[plugins."gemini-plugin-for-codex@gphcod-agy"]
enabled = true

```

`codex plugin list` showed the three plugins council will replace, all installed and enabled: `claude-code-advisor@claude-plugin-for-codex` 0.5.0, `grok@grok-plugin-for-codex` and `gemini-plugin-for-codex@gphcod-agy`.

## Install

```
codex plugin marketplace add /Users/cia/GitCode/claude-agy-grok-plugin-for-codex
codex plugin add council@council-for-codex
```

Installed plugin root: `/Users/cia/.codex/plugins/cache/council-for-codex/council/1.0.0-rc.1`. The config gained exactly these two sections:

```toml
[marketplaces.council-for-codex]
source_type = "local"
source = "/Users/cia/GitCode/claude-agy-grok-plugin-for-codex"

[plugins."council@council-for-codex"]
enabled = true
```

`node scripts/validate-plugin.mjs --installed /Users/cia/.codex/plugins/cache/council-for-codex/council/1.0.0-rc.1` printed `installed copy matches plugins/council/: 36 files, SHA-256` and exited 0. The old plugins stay installed until S8.

A new `codex exec --json -s danger-full-access` session asked for `$council setup`. It read the installed skill, ran `node <installed root>/scripts/council.mjs setup`, and reported claude, gemini and grok as installed, logged in and preflight ok.

## Restoration

```
codex plugin remove council@council-for-codex
codex plugin marketplace remove council-for-codex
```

If the config differs from the baseline afterwards, restore the backup: `cp ~/.codex/config.toml.before-council-s7.0 ~/.codex/config.toml`. The installed cache directory `~/.codex/plugins/cache/council-for-codex/` can then be removed.
