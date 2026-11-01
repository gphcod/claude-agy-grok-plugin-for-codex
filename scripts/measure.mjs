#!/usr/bin/env node
// S6.5: per-call framing bytes and the skill size, measured against the fakes (no real CLI, no model call).
// Framing is what Codex reads from one call besides the model's answer: the start line on stderr and the footer line
// on stdout (with their line ends). Method as claude_plugin_for_codex 0.5.0 tests/measure.mjs (`metadataBytes`, the
// companion's own lines around the answer); results are recorded in docs/measurements/framing.md.
// Usage: npm run measure [-- --json]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = path.join(ROOT, "plugins", "council", "scripts", "council.mjs");
const SKILL = path.join(ROOT, "plugins", "council", "skills", "council", "SKILL.md");
const FAKES = { claude: ["COUNCIL_CLAUDE_BIN", "fake-claude.mjs"], gemini: ["COUNCIL_AGY_BIN", "fake-agy.mjs"], grok: ["COUNCIL_GROK_BIN", "fake-grok.mjs"] };
const bytes = (text) => Buffer.byteLength(text, "utf8");

/** One `ask` per provider in a scratch state root and Git workspace; returns one row per provider. */
export function measure() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "council-measure-")));
  try {
    const work = path.join(dir, "work");
    fs.mkdirSync(work);
    const git = (args) => spawnSync("git", args, { cwd: work, encoding: "utf8" });
    git(["init", "-q", "-b", "main"]);
    git(["-c", "user.email=m@example.invalid", "-c", "user.name=m", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "base"]);
    fs.mkdirSync(path.join(dir, ".grok"));
    fs.writeFileSync(path.join(dir, ".grok", "auth.json"), "{}", { mode: 0o600 });
    // The caller's own host and provider variables never reach the measured calls.
    const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|CODEX|GROK|AGY|COUNCIL|ANTHROPIC)/i.test(k)));
    const env = { ...base, HOME: dir, USERPROFILE: dir, COUNCIL_CODEX_HOME: path.join(dir, "state"), CODEX_THREAD_ID: "measure", HTTPS_PROXY: "http://127.0.0.1:9",
      ...Object.fromEntries(Object.values(FAKES).map(([name, file]) => [name, path.join(ROOT, "tests", "fixtures", file)])) };
    return Object.keys(FAKES).map((provider) => {
      const r = spawnSync(process.execPath, [ENTRY, "ask", "--to", provider, "--", "Reply with pong"], { cwd: work, env, input: "", encoding: "utf8", timeout: 60000 });
      if (r.status !== 0) throw new Error(`${provider}: ask exited ${r.status}: ${r.stdout}${r.stderr}`);
      const out = r.stdout.trimEnd().split("\n");
      const footer = `${out.at(-1)}\n`;
      const answer = r.stdout.slice(0, r.stdout.length - footer.length);
      return { provider, startLineBytes: bytes(r.stderr), footerBytes: bytes(footer), framingBytes: bytes(r.stderr) + bytes(footer), answerBytes: bytes(answer), footer: footer.trimEnd() };
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export function skillSize() {
  const text = fs.readFileSync(SKILL, "utf8");
  const description = /^description: (.+)$/m.exec(text)?.[1] ?? "";
  return { skillBytes: bytes(text), descriptionBytes: bytes(description) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rows = measure();
  const skill = skillSize();
  if (process.argv.includes("--json")) console.log(JSON.stringify({ platform: process.platform, node: process.version, rows, ...skill }, null, 2));
  else {
    console.log("provider  start line B  footer B  framing B  (one ask against the fake)");
    for (const r of rows) console.log(`${r.provider.padEnd(8)}  ${String(r.startLineBytes).padStart(12)}  ${String(r.footerBytes).padStart(8)}  ${String(r.framingBytes).padStart(9)}`);
    console.log(`skill: ${skill.skillBytes} B (description ${skill.descriptionBytes} B)`);
  }
}
