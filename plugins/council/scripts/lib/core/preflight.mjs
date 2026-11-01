// Preflight (S2.4): a provider-neutral runner over the adapter's resource descriptors, ported from claude_plugin_for_codex
// 0.5.0 lib/preflight.mjs (`startProbe`, blocked-resource checks, the policy file). Cold results are cached under
// <state root>/preflight/ by executable path, size and mtime so a warm call probes nothing; a blocked resource exits 1 as
// `preflight_blocked` with the descriptor's action line, before any provider process starts. The line grants no escalation.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readJson, writeFileAtomic } from "./fs.mjs";
import { processSnapshot } from "./execution.mjs";
import { guardedEnv } from "./host.mjs";

export class PreflightBlocked extends Error {
  constructor(descriptor, detail) {
    super(`preflight_blocked: ${descriptor.why} (${descriptor.kind} ${describeTarget(descriptor.target)}): ${detail}`);
    this.descriptor = descriptor;
    this.detail = detail;
    this.action = descriptor.action ?? "Grant access to the named resource; if the host forbids escalation, stop without retrying.";
  }
}
const describeTarget = (target) => typeof target === "string" ? target : target?.command ? [target.command, ...(target.args ?? [])].join(" ") : JSON.stringify(target);
const PROBE_BYTES = 2_000_000;
const DRAIN_MS = 500;
const PROXY_VARIABLES = ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "https_proxy", "http_proxy", "all_proxy"];

/** One capability probe: settles with the probe's result or failure, never rejects; stopped on timeout or output cap. */
export function startProbe(command, args, { cwd, env = process.env, timeoutMs = 15000 } = {}) {
  return new Promise((resolve) => {
    const out = [], err = [];
    let bytes = 0, failure = null, settled = false, drain = null;
    let child;
    try { child = spawn(command, args, { cwd, env, windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] }); }
    catch (error) { return resolve({ status: null, stdout: "", stderr: "", error: error.message }); }
    const stop = (reason) => { failure ??= reason; child.kill("SIGKILL"); };
    const timer = setTimeout(() => stop(`timed out after ${timeoutMs} ms`), timeoutMs);
    const collect = (target) => (chunk) => { bytes += chunk.length; if (bytes > PROBE_BYTES) return stop("output exceeded the probe limit"); target.push(chunk); };
    child.stdout.on("data", collect(out));
    child.stderr.on("data", collect(err));
    const finish = (status, error) => {
      if (settled) return;
      settled = true; clearTimeout(timer); clearTimeout(drain);
      const text = (chunks) => Buffer.concat(chunks).toString("utf8");
      resolve({ status, stdout: text(out), stderr: text(err), error: error || failure });
    };
    child.on("error", (error) => finish(null, error.message));
    // A descendant that inherited the probe's pipes can hold them open after the probe exits.
    child.on("exit", (status) => { drain = setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); finish(status); }, DRAIN_MS); });
    child.on("close", (status) => finish(status));
  });
}

function checkDirectory(descriptor) {
  const write = descriptor.access === "write";
  try {
    if (write) fs.mkdirSync(descriptor.target, { recursive: true });
    fs.accessSync(descriptor.target, fs.constants.R_OK);
    if (write) {
      const probe = path.join(descriptor.target, `.council-probe-${randomUUID()}`);
      fs.writeFileSync(probe, "", { flag: "wx", mode: 0o600 });
      fs.rmSync(probe, { force: true });
    }
    return { ok: true };
  } catch (error) { return { ok: false, detail: `${write ? "write" : "read"} access is missing (${error.code ?? error.message})` }; }
}
function checkFile(descriptor) {
  try {
    fs.accessSync(descriptor.target, descriptor.access === "write" ? fs.constants.W_OK : fs.constants.R_OK);
    if (!fs.statSync(descriptor.target).isFile()) return { ok: false, detail: "not a regular file" };
    return { ok: true };
  } catch (error) { return { ok: false, detail: `${descriptor.access ?? "read"} access is missing (${error.code ?? error.message})` }; }
}
function checkListener(descriptor) {
  return new Promise((resolve) => {
    const server = net.createServer();
    const timer = setTimeout(() => { server.close(); resolve({ ok: false, detail: "loopback listener bind timed out" }); }, descriptor.timeoutMs ?? 2000);
    server.once("error", (error) => { clearTimeout(timer); resolve({ ok: false, detail: `loopback listener bind failed (${error.code ?? error.message})` }); });
    server.listen(0, descriptor.target || "127.0.0.1", () => { clearTimeout(timer); server.close(() => resolve({ ok: true })); });
  });
}
async function checkNetwork(descriptor, env) {
  if (PROXY_VARIABLES.some((name) => env[name])) return { ok: true, unverified: "proxy transport is unverified without a live request" };
  try {
    const response = await fetch(new URL(descriptor.target).origin, { method: "HEAD", signal: AbortSignal.timeout(descriptor.timeoutMs ?? 8000), redirect: "manual" });
    return { ok: true, status: response.status };
  } catch (error) { return { ok: false, detail: `network access failed (${error.cause?.code || error.name})` }; }
}
async function checkExec(descriptor, env) {
  const { command, args = [], expectStatus = 0, expectText = null, recordOutput = true } = descriptor.target;
  // An exec descriptor starts a provider child: it gets the five guard variables like every turn (A5.1).
  const result = await startProbe(command, args, { env: guardedEnv(env), timeoutMs: descriptor.timeoutMs ?? 15000 });
  if (result.error) return { ok: false, detail: `probe failed: ${result.error}` };
  const text = `${result.stdout}${result.stderr}`;
  if (expectText && !new RegExp(expectText).test(text)) return { ok: false, detail: `probe output did not match ${expectText}` };
  if (expectStatus !== null && result.status !== expectStatus) return { ok: false, detail: `probe exited ${result.status}: ${text.trim().split(/\r?\n/)[0] ?? ""}`.trim() };
  // recordOutput: false keeps a probe's output out of the cache (an account status line naming the user, S3.1).
  return { ok: true, status: result.status, ...(recordOutput === false ? {} : { output: text.slice(0, 2000) }) };
}
function checkProcessTable(descriptor, platform) {
  const snapshot = processSnapshot({ platform, timeout: descriptor.timeoutMs ?? 20000 });
  return snapshot.state === "ok" ? { ok: true, rows: snapshot.rows.length } : { ok: false, detail: snapshot.error ?? "process query returned no table" };
}

/** Runs one descriptor; `kind` ∈ file | dir | exec | listener | process-table | network. */
export async function runDescriptor(descriptor, { env = process.env, platform = process.platform } = {}) {
  switch (descriptor.kind) {
    case "dir": return checkDirectory(descriptor);
    case "file": return checkFile(descriptor);
    case "exec": return checkExec(descriptor, env);
    case "listener": return checkListener(descriptor);
    case "network": return checkNetwork(descriptor, env);
    case "process-table": return checkProcessTable(descriptor, platform);
    default: return { ok: false, detail: `unknown descriptor kind ${descriptor.kind}` };
  }
}

/** The cache key: the launcher's executable path, size and mtime, and the descriptors themselves. */
export function preflightKey(launcher, descriptors, extra = {}) {
  let stat = null;
  try { const s = fs.statSync(launcher.path); stat = { size: s.size, mtimeMs: s.mtimeMs }; } catch { /* a missing binary is probed, never cached */ }
  return createHash("sha256").update(JSON.stringify({ path: launcher.path, stat, descriptors: descriptors.map(({ action, why, ...rest }) => rest), extra })).digest("hex").slice(0, 32);
}
const cacheFile = (home, provider, key) => path.join(home, "preflight", `${provider}-${key}.json`);

/**
 * Cold: every descriptor runs (the non-billable probes of A1) and the results are cached; warm: the cache answers and
 * nothing is spawned. A blocked descriptor throws PreflightBlocked (exit 1) with its action line and zero submissions.
 * `exec` descriptors are the cold probes; `dir`/`file`/`listener`/`process-table` are cheap and re-checked every call
 * when `recheckCheap` is set (they describe the sandbox in effect, which can change between calls).
 */
export async function runPreflight({ home, provider, launcher, descriptors, env = process.env, platform = process.platform, refresh = false, recheckCheap = true }) {
  const key = preflightKey(launcher, descriptors);
  const file = cacheFile(home, provider, key);
  const cached = refresh ? null : readJson(file);
  const results = [];
  let probes = 0;
  // Sandbox checks first (files, directories, listener, process table), then the probes: a blocked resource fails before any probe runs.
  const ordered = [...descriptors.filter((d) => !["exec", "network"].includes(d.kind)), ...descriptors.filter((d) => ["exec", "network"].includes(d.kind))];
  for (const descriptor of ordered) {
    const expensive = descriptor.kind === "exec" || descriptor.kind === "network";
    const prior = cached?.results?.find((r) => r.kind === descriptor.kind && JSON.stringify(r.target) === JSON.stringify(descriptor.target) && r.ok);
    if (prior && (expensive || !recheckCheap)) { results.push({ ...prior, cached: true }); continue; }
    if (expensive || descriptor.kind === "process-table" || descriptor.kind === "listener") probes += 1;
    const outcome = await runDescriptor(descriptor, { env, platform });
    const record = { kind: descriptor.kind, target: descriptor.target, access: descriptor.access ?? null, ...outcome, cached: false };
    if (!outcome.ok) throw new PreflightBlocked(descriptor, outcome.detail);
    results.push(record);
  }
  const value = { key, provider, executable: launcher.path, checkedAt: new Date().toISOString(), results };
  if (!cached || refresh || results.some((r) => !r.cached)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
  }
  return { ...value, cached: Boolean(cached) && results.every((r) => r.cached || !["exec", "network"].includes(r.kind)), probes };
}

// Policy (A3.2 `setup --set`): the Claude policy (read roots, web, MCP) stored under the state root as policy.json.
export const defaultPolicy = () => ({ version: "default-v1", readRoots: [], web: false, allowMcp: false });
export const policyFile = (home) => path.join(home, "policy.json");
export function getPolicy(home) {
  const stored = readJson(policyFile(home));
  return stored ? { ...defaultPolicy(), ...stored } : defaultPolicy();
}
export function setPolicy(home, supplied) {
  const fields = ["readRoots", "web", "allowMcp"];
  if (!supplied || typeof supplied !== "object" || Array.isArray(supplied)) throw new Error("policy must be a JSON object");
  if (Object.keys(supplied).some((k) => !fields.includes(k))) throw new Error(`policy has unknown fields: ${Object.keys(supplied).filter((k) => !fields.includes(k)).join(", ")}`);
  const policy = { ...defaultPolicy(), ...supplied };
  for (const key of ["web", "allowMcp"]) if (typeof policy[key] !== "boolean") throw new Error(`policy ${key} must be boolean`);
  if (!Array.isArray(policy.readRoots) || policy.readRoots.some((v) => typeof v !== "string" || !v.trim())) throw new Error("policy readRoots must be an array of strings");
  policy.readRoots = [...new Set(policy.readRoots.map((root) => {
    if (!path.isAbsolute(root)) throw new Error("readRoots entries must be absolute paths");
    return fs.realpathSync(root);
  }))];
  delete policy.version;
  policy.version = createHash("sha256").update(JSON.stringify(policy)).digest("hex").slice(0, 16);
  fs.mkdirSync(home, { recursive: true });
  writeFileAtomic(policyFile(home), `${JSON.stringify(policy, null, 2)}\n`);
  return policy;
}
