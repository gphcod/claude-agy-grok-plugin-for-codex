// Launcher resolution (S2.2), ported from grok_plugin_for_codex 1.1.0 lib/launcher.mjs with claude_plugin_for_codex
// 0.5.0 preflight.mjs `resolveExecutable`'s Claude rule: the adapter names its `binEnv` and binary; the override wins,
// then PATH (PATHEXT order on Windows), then an optional native fallback. A Windows .cmd/.bat shim runs as
// `node <entry>` (an npm-style JS target or a node-shebang script) or names a native .exe; it never runs through
// cmd.exe. Under `nativeOnly` (Claude) a PATH hit that is a wrapper or not an .exe is refused, while a configured
// `binEnv` may name a .js/.mjs/.cjs entry (how the fakes run). `kind` ∈ native | node-script | shim-native | shim-node.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

export class LauncherError extends Error {}
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const NODE_SHEBANG = /^#!.*\bnode\b/;

/** The JavaScript entry of an npm-style shim, the native .exe it forwards to, or null. */
export function shimTarget(shim) {
  let text;
  try { text = fs.readFileSync(shim, "utf8"); } catch { return null; }
  const resolve = (target) => path.resolve(path.dirname(shim), target.replace(/\\/g, "/"));
  for (const m of text.matchAll(/"%~?dp0%?[\\/]*([^"]+\.[cm]?js)"/gi)) {
    if (isFile(resolve(m[1]))) return { kind: "shim-node", entry: resolve(m[1]) };
  }
  if (/SET\s+"_prog=(%dp0%\\)?node(\.exe)?"/i.test(text)) {
    for (const m of text.matchAll(/"%_prog%"\s+"%~?dp0%?[\\/]*([^"]+)"/gi)) {
      const entry = resolve(m[1]);
      let head = "";
      try { head = fs.readFileSync(entry, "utf8").slice(0, 200); } catch { continue; }
      if (NODE_SHEBANG.test(head)) return { kind: "shim-node", entry };
    }
  }
  for (const m of text.matchAll(/"%~?dp0%?[\\/]*([^"]+\.exe)"/gi)) {
    if (isFile(resolve(m[1]))) return { kind: "shim-native", entry: resolve(m[1]) };
  }
  return null;
}

/** Every `name` executable on PATH, in PATH order (PATHEXT order within a directory on Windows). */
export function pathCandidates(name, env = process.env, platform = process.platform) {
  const exts = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  const names = platform === "win32" ? exts.map((e) => `${name}${e.toLowerCase()}`) : [name];
  const found = [];
  for (const entry of (env.PATH ?? env.Path ?? "").split(platform === "win32" ? ";" : ":")) {
    const dir = entry.trim().replace(/^"|"$/g, "");
    if (!dir) continue;
    let actual = null;
    if (platform === "win32") { try { actual = fs.readdirSync(dir); } catch { continue; } }
    for (const candidate of names) {
      const file = path.join(dir, actual?.find((n) => n.toLowerCase() === candidate) ?? candidate);
      if (!isFile(file) || found.includes(file)) continue;
      if (platform !== "win32") { try { fs.accessSync(file, fs.constants.X_OK); } catch { continue; } }
      found.push(path.resolve(file));
    }
  }
  return found;
}

/**
 * The launcher for a provider binary, or null when none is found. `nativeFallback` is a path tried after PATH (Grok's
 * `~/.grok/bin/grok.exe` on Windows).
 */
export function resolveLauncher({ name, binEnv, env = process.env, platform = process.platform, nativeOnly = false, nativeFallback = null,
  home = (platform === "win32" ? env.USERPROFILE : env.HOME) || os.homedir() } = {}) {
  const configured = binEnv && env[binEnv] ? path.resolve(env[binEnv]) : null;
  let found = configured, rejected = null;
  if (!found) {
    for (const candidate of pathCandidates(name, env, platform)) {
      const ext = path.extname(candidate).toLowerCase();
      if (nativeOnly && platform === "win32" && ext !== ".exe") { rejected = candidate; continue; }
      found = candidate; break;
    }
  }
  if (!found && nativeFallback) { const fallback = typeof nativeFallback === "function" ? nativeFallback(home) : nativeFallback; if (fallback && isFile(fallback)) found = fallback; }
  if (!found) {
    if (rejected) throw new LauncherError(`cannot launch ${rejected} without a shell; install the native ${name} executable or set ${binEnv} to its absolute path`);
    return null;
  }
  if (!isFile(found)) return null;
  const ext = path.extname(found).toLowerCase();
  if (/^\.[cm]?js$/.test(ext)) {
    if (nativeOnly && !configured) throw new LauncherError(`${found} is a script; set ${binEnv} to run ${name} through node`);
    return { command: process.execPath, args: [found], path: found, kind: "node-script" };
  }
  if (ext === ".cmd" || ext === ".bat" || ext === ".ps1") {
    if (nativeOnly) throw new LauncherError(`cannot launch shell wrapper ${found} without a shell; install the native ${name} executable or set ${binEnv} to its absolute path`);
    if (ext === ".ps1") throw new LauncherError(`${found} is a PowerShell wrapper; set ${binEnv} to the ${name} executable`);
    const target = shimTarget(found);
    if (!target) throw new LauncherError(`${found} is a command shim without a JavaScript entry; set ${binEnv} to ${name}.exe`);
    return target.kind === "shim-native" ? { command: target.entry, args: [], path: target.entry, kind: "shim-native" }
      : { command: process.execPath, args: [target.entry], path: target.entry, kind: "shim-node" };
  }
  if (nativeOnly && platform === "win32" && ext !== ".exe") throw new LauncherError(`cannot launch ${found} without a shell; install the native ${name} executable or set ${binEnv} to its absolute path`);
  return { command: found, args: [], path: found, kind: "native" };
}

/** A model-bearing child: its own process group on POSIX, pipes for stdout/stderr, stdin piped or ignored. */
export function spawnChild(launcher, args, { cwd, env, stdin = "pipe", platform = process.platform }) {
  return spawn(launcher.command, [...launcher.args, ...args], {
    cwd, env, stdio: [stdin, "pipe", "pipe"], shell: false, windowsHide: true, detached: platform !== "win32",
  });
}
/** A non-billable probe (version, listing): bounded and never fed stdin. */
export function runSync(launcher, args, { env, cwd, timeoutMs = 15000 } = {}) {
  return spawnSync(launcher.command, [...launcher.args, ...args], {
    cwd, env, encoding: "utf8", shell: false, windowsHide: true, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
  });
}
