#!/usr/bin/env node
// Plugin metadata, skill and README checks (S0.6), adapted from claude_plugin_for_codex tests/validate-plugin.mjs.
// Run after the suite: `npm run validate`. Exports the engines parser so tests/engines.test.mjs can prove it.
// `--installed <dir>` (S6.7) instead compares the SHA-256 of every file under plugins/council/ with an installed copy
// (for example ~/.codex/plugins/cache/council-for-codex/council/<version>), lists every difference and exits 1 on any.
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const PLUGIN = path.join(ROOT, "plugins", "council");
export const REPO_URL = "https://github.com/gphcod/claude-agy-grok-plugin-for-codex";
export const SKILL_BYTES = 3000;
export const DESCRIPTION_BYTES = 170;
/** Terms the skill must carry (S0.5), derived from Part A. */
export const REQUIRED_TERMS = ["council.mjs", "ask", "reply", "review", "task", "wait", "cancel", "models", "setup", "--to",
  "claude", "gemini", "grok", "COUNCIL_EOF", "@'", "exit $LASTEXITCODE", "--prompt-file", "--request-id", "never resubmit",
  "longest wait", "20 still running", "round N/N", "never repeat it verbatim", "preflight_blocked", "--tier consult",
  "--next-input", "unreviewed N", "attention:", "open questions", "`wait` lists", "tier exec"];

const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const parseVersion = (v) => {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  if (!m) throw new Error(`not a version: ${v}`);
  return m.slice(1).map(Number);
};
const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/**
 * Does `version` satisfy the engines `range`? Supported forms, joined by `||`: space-separated comparators
 * `>=X.Y.Z`, `>X.Y.Z`, `<=X.Y.Z`, `<X[.Y[.Z]]`, `^X.Y.Z`. Anything else throws.
 */
export function satisfiesEngines(version, range) {
  const actual = parseVersion(version);
  return range.split("||").some((part) => part.trim().split(/\s+/).every((comparator) => {
    const m = /^(>=|<=|>|<|\^)(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(comparator);
    if (!m) throw new Error(`Unsupported engines form: ${comparator}`);
    const [, op, major, minor = "0", patch = "0"] = m;
    const bound = [Number(major), Number(minor), Number(patch)];
    const c = compare(actual, bound);
    if (op === ">=") return c >= 0;
    if (op === ">") return c > 0;
    if (op === "<=") return c <= 0;
    if (op === "<") return c < 0;
    return c >= 0 && actual[0] === bound[0];
  }));
}

export function validate() {
  const pkg = JSON.parse(read("package.json"));
  const manifest = JSON.parse(read("plugins/council/.codex-plugin/plugin.json"));
  const marketplace = JSON.parse(read(".agents/plugins/marketplace.json"));
  const skill = read("plugins/council/skills/council/SKILL.md");
  const readme = read("README.md");

  assert.equal(pkg.version, manifest.version, "package.json and plugin.json versions must agree");
  assert.ok(!("version" in marketplace), "the marketplace carries no version field");
  assert.ok(!marketplace.plugins.some((p) => "version" in p), "marketplace plugin entries carry no version field");
  assert.equal(marketplace.name, "council-for-codex");
  assert.equal(marketplace.interface.displayName, "Council for Codex");
  assert.equal(marketplace.plugins.length, 1);
  assert.equal(marketplace.plugins[0].name, "council");
  assert.deepEqual(marketplace.plugins[0].source, { source: "local", path: "./plugins/council" });
  assert.deepEqual(marketplace.plugins[0].policy, { installation: "AVAILABLE", authentication: "ON_INSTALL" });
  assert.equal(marketplace.plugins[0].category, "Developer Tools");
  assert.equal(manifest.name, "council");
  assert.equal(manifest.skills, "./skills/");
  assert.equal(manifest.license, "Apache-2.0");
  assert.equal(manifest.repository, REPO_URL);
  assert.equal(manifest.homepage, REPO_URL);
  assert.equal(manifest.interface.displayName, "Council");
  assert.deepEqual(manifest.interface.capabilities, ["Interactive", "Read", "Write"]);
  assert.equal(manifest.interface.defaultPrompt.length, 3);
  for (const key of ["mcpServers", "hooks", "agents"]) assert.ok(!(key in manifest), `plugin.json must not declare ${key}`);
  assert.deepEqual(fs.readdirSync(path.join(PLUGIN, "skills")), ["council"], "one model-visible skill");
  for (const dir of ["mcp", ".mcp.json", "hooks", "commands"]) assert.ok(!fs.existsSync(path.join(PLUGIN, dir)), `${dir} must not exist`);
  assert.ok(fs.existsSync(path.join(PLUGIN, "skills", "council", "agents", "openai.yaml")), "agents/openai.yaml");

  const front = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(skill);
  assert.ok(front, "the skill needs frontmatter");
  assert.match(front[1], /^name: council$/m);
  const description = /^description: (.+)$/m.exec(front[1])?.[1];
  assert.ok(description, "the skill needs a one-line description");
  const descriptionBytes = Buffer.byteLength(description);
  assert.ok(descriptionBytes <= DESCRIPTION_BYTES, `skill description is ${descriptionBytes} B; the limit is ${DESCRIPTION_BYTES}`);
  const skillBytes = Buffer.byteLength(skill);
  assert.ok(skillBytes <= SKILL_BYTES, `SKILL.md is ${skillBytes} B; the limit is ${SKILL_BYTES}`);
  for (const term of REQUIRED_TERMS) assert.ok(skill.includes(term), `skill is missing ${JSON.stringify(term)}`);

  assert.match(readme, /codex plugin marketplace add gphcod\/claude-agy-grok-plugin-for-codex/, "README install block");
  assert.match(readme, /codex plugin add council@council-for-codex/, "README install block");
  assert.ok(readme.replace(/\s+/g, " ").includes("Requires Node.js 22.19.0 or later"),
    "README must state the engines range");

  assert.equal(pkg.engines.node, ">=22.19.0");
  const nodeSupport = { "18.20.8": false, "20.3.0": false, "22.0.0": false, "22.18.9": false,
    "22.19.0": true, "24.0.0": true };
  for (const [version, expected] of Object.entries(nodeSupport)) {
    assert.equal(satisfiesEngines(version, pkg.engines.node), expected, `engines ${pkg.engines.node} and Node ${version}`);
  }
  return { version: pkg.version, skillBytes, descriptionBytes };
}

/** Relative path → SHA-256 of every regular file under `dir`, with `/` separators; symlinks and other types are listed as such. */
export function digests(dir) {
  const out = {};
  const walk = (rel) => {
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const name = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(name);
      else out[name] = entry.isFile() ? createHash("sha256").update(fs.readFileSync(path.join(dir, name))).digest("hex") : `not a regular file (${entry.isSymbolicLink() ? "symlink" : "other"})`;
    }
  };
  walk("");
  return out;
}

/** Compares plugins/council/ (or `source`) with an installed copy: `{ files, differences: [{file, kind}] }`, kind ∈ missing | extra | changed. */
export function compareInstalled(installed, source = PLUGIN) {
  if (!fs.existsSync(installed) || !fs.statSync(installed).isDirectory()) throw new Error(`installed copy ${installed} is not a directory`);
  const ours = digests(source), theirs = digests(installed);
  const differences = [];
  for (const file of Object.keys(ours).sort()) {
    if (!(file in theirs)) differences.push({ file, kind: "missing" });
    else if (theirs[file] !== ours[file]) differences.push({ file, kind: "changed" });
  }
  for (const file of Object.keys(theirs).sort()) if (!(file in ours)) differences.push({ file, kind: "extra" });
  return { files: Object.keys(ours).length, differences };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf("--installed");
  if (at >= 0) {
    const dir = process.argv[at + 1];
    if (!dir) { console.error("usage: validate-plugin.mjs --installed <dir>"); process.exit(2); }
    let result;
    try { result = compareInstalled(path.resolve(dir)); } catch (error) { console.error(`validate-plugin: ${error.message}`); process.exit(2); }
    for (const d of result.differences) console.log(`${d.kind}: ${d.file}`);
    console.log(result.differences.length ? `installed copy differs from plugins/council/: ${result.differences.length} of ${result.files} files` : `installed copy matches plugins/council/: ${result.files} files, SHA-256`);
    process.exit(result.differences.length ? 1 : 0);
  }
  const result = validate();
  console.log(`plugin metadata, skill (${result.skillBytes} B, description ${result.descriptionBytes} B) and README ok: council ${result.version}`);
}
