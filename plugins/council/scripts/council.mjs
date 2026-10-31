#!/usr/bin/env node
// Council for Codex: the companion entry. S0 stub: parses the verb, prints usage with exit 2 for every
// verb that is not implemented yet, and implements `setup` as far as resolving the three binaries
// without spawning them. The A4 order (parse → guard → replay → adapter → preflight → admit → turn →
// print) arrives in S2.6.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const VERBS = ["ask", "reply", "review", "task", "wait", "cancel", "models", "setup"];
export const PROVIDERS = ["claude", "gemini", "grok"];
/** Binary names and their override variables (A5.1). */
export const BINARIES = { claude: { name: "claude", env: "COUNCIL_CLAUDE_BIN" }, gemini: { name: "agy", env: "COUNCIL_AGY_BIN" }, grok: { name: "grok", env: "COUNCIL_GROK_BIN" } };

export const USAGE = `usage: node council.mjs <verb> [--to claude|gemini|grok] [flags] -- <text>
verbs: ask, reply, review, task, wait, cancel, models, setup
S0 stub: only \`setup\` (binary resolution, no spawn) is implemented; every other verb exits 2.
`;

/** Find an executable on PATH or through its override variable; no process is started. */
export function resolveBinary(provider, env = process.env, platform = process.platform) {
  const { name, env: envName } = BINARIES[provider];
  const configured = env[envName];
  const windows = platform === "win32";
  const candidates = configured ? [configured]
    : (env.PATH || env.Path || "").split(path.delimiter).filter(Boolean).flatMap((dir) => {
      const base = path.join(dir.replace(/^"|"$/g, ""), name);
      return windows ? [`${base}.exe`, `${base}.cmd`, `${base}.ps1`, base] : [base];
    });
  for (const file of candidates) {
    try {
      const stat = fs.statSync(file);
      if (stat.isFile()) return { provider, name, path: path.resolve(file), source: configured ? envName : "PATH" };
    } catch { /* not here */ }
  }
  return { provider, name, path: null, source: configured ? envName : "PATH" };
}

function setup(env, io) {
  let missing = 0;
  for (const provider of PROVIDERS) {
    const found = resolveBinary(provider, env);
    io.stdout.write(`${provider}: ${found.name} ${found.path ?? "not found"}${found.path ? ` (${found.source})` : ""}\n`);
    if (!found.path) missing += 1;
  }
  io.stdout.write(`council setup (S0 stub): ${PROVIDERS.length - missing}/${PROVIDERS.length} binaries resolved; no process started\n`);
  return 0;
}

/** Entry: returns the exit code. `io` carries stdout/stderr writers so tests need no process. */
export function main(argv, env = process.env, io = { stdout: process.stdout, stderr: process.stderr }) {
  const verb = argv[0];
  if (verb === "--help" || verb === "-h") { io.stdout.write(USAGE); return 0; }
  if (!VERBS.includes(verb)) { io.stderr.write(`council: unknown verb ${JSON.stringify(verb ?? "")}\n${USAGE}`); return 2; }
  if (verb === "setup") return setup(env, io);
  io.stderr.write(`council: ${verb} is not implemented yet\n${USAGE}`);
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
