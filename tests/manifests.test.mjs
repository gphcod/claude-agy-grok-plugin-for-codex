import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { ROOT, PLUGIN, validate } from "../scripts/validate-plugin.mjs";

const json = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), "utf8"));
/** Whether this build ships a provider's module (S3–S5 each add one). */
const built = (provider) => fs.existsSync(path.join(PLUGIN, "scripts", "lib", "providers", `${provider}.mjs`));
const BINARY = { claude: ["claude", "COUNCIL_CLAUDE_BIN"], gemini: ["agy", "COUNCIL_AGY_BIN"], grok: ["grok", "COUNCIL_GROK_BIN"] };

test("marketplace and plugin manifests name council, agree on versions and ship no MCP, hooks or agents", () => {
  const marketplace = json(".agents/plugins/marketplace.json");
  const manifest = json("plugins/council/.codex-plugin/plugin.json");
  const pkg = json("package.json");
  assert.equal(marketplace.name, "council-for-codex");
  assert.equal(marketplace.plugins[0].name, "council");
  assert.equal(marketplace.plugins[0].source.path, "./plugins/council");
  assert.ok(!("version" in marketplace));
  assert.equal(manifest.name, "council");
  assert.equal(manifest.version, pkg.version);
  assert.equal(manifest.skills, "./skills/");
  assert.doesNotMatch(JSON.stringify(manifest), /mcpServers|"hooks"|"agents"/);
  assert.equal(pkg.type, "module");
  assert.equal(pkg.private, true);
  assert.ok(!pkg.dependencies, "no runtime dependencies");
  assert.ok(fs.existsSync(path.join(PLUGIN, "scripts", "council.mjs")));
});

test("the validator passes on the checked-out tree and runs as a script", () => {
  const result = validate();
  assert.equal(result.version, json("package.json").version);
  const run = spawnSync(process.execPath, [path.join(ROOT, "scripts", "validate-plugin.mjs")], { encoding: "utf8", cwd: ROOT });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /ok: council /);
});

test("the entry resolves binaries on setup without stdin, without spawning, and refuses providers this build lacks with exit 2", () => {
  const entry = path.join(PLUGIN, "scripts", "council.mjs");
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "council-manifests-"));
  const env = { ...process.env, PATH: "", COUNCIL_CODEX_HOME: state };
  for (const name of Object.keys(env)) if (/^(COUNCIL_(?!CODEX_HOME)|CLAUDE_PLUGIN_CODEX_DEPTH|GROK_CODEX_DEPTH|GROK_BUILD_DEPTH|AGY_BRIDGE_DEPTH)/.test(name)) delete env[name];
  const setup = spawnSync(process.execPath, [entry, "setup"], { encoding: "utf8", env, stdio: ["pipe", "pipe", "pipe"], timeout: 10000 });
  assert.equal(setup.status, 0, setup.stderr);
  const heads = setup.stdout.split("\n").filter((l) => l && !l.startsWith("  "));
  for (const [i, provider] of ["claude", "gemini", "grok"].entries()) {
    if (built(provider)) assert.match(heads[i], new RegExp(`^${provider}: not found · .* · preflight not run$`));
    else assert.equal(heads[i], `${provider}: ${BINARY[provider][0]} not found · provider not available in this build`);
  }
  const fake = path.join(ROOT, "tests", "fixtures", "fake-grok.mjs");
  const configured = spawnSync(process.execPath, [entry, "setup", "--to", "grok"], { encoding: "utf8", env: { ...env, COUNCIL_GROK_BIN: fake }, timeout: 10000 });
  if (built("grok")) assert.match(configured.stdout, /^grok: .*fake-grok\.mjs \(node-script\) · /);
  else assert.match(configured.stdout, /^grok: grok .*fake-grok\.mjs · provider not available in this build\n$/);
  const ask = spawnSync(process.execPath, [entry, "ask", "--to", "claude", "--", "hello"], { encoding: "utf8", env, input: "", timeout: 10000 });
  if (built("claude")) { assert.equal(ask.status, 1); assert.match(ask.stderr, /claude not found: install its CLI or set COUNCIL_CLAUDE_BIN/); }
  else { assert.equal(ask.status, 2); assert.match(ask.stderr, /provider claude not available in this build/); }
  const unknown = spawnSync(process.execPath, [entry, "frobnicate"], { encoding: "utf8", env, input: "", timeout: 10000 });
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /usage: council\.mjs/);
});
