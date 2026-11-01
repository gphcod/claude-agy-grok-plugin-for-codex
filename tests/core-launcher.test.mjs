// S2.2: launcher resolution (ported from grok_plugin_for_codex tests/launcher.test.mjs) plus Claude's native-only PATH rule
// with the configured-JS exception and the `kind` enum of A5.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { LauncherError, pathCandidates, resolveLauncher, runSync, shimTarget, spawnChild } from "../plugins/council/scripts/lib/core/launcher.mjs";

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "council-launcher-")));
function file(dir, name, text = "", mode = 0o755) {
  const p = path.join(dir, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  fs.chmodSync(p, mode);
  return p;
}
const grok = (over) => resolveLauncher({ name: "grok", binEnv: "COUNCIL_GROK_BIN", ...over });

test("a JavaScript entry runs through this node, a native binary runs directly", () => {
  const dir = tmp();
  for (const name of ["cli.js", "cli.mjs", "cli.cjs"]) {
    const entry = file(dir, name);
    assert.deepEqual(grok({ env: { COUNCIL_GROK_BIN: entry }, platform: "linux", home: dir }), { command: process.execPath, args: [entry], path: entry, kind: "node-script" });
  }
  const native = file(dir, "bin/grok");
  assert.deepEqual(grok({ env: { COUNCIL_GROK_BIN: native }, platform: "linux", home: dir }), { command: native, args: [], path: native, kind: "native" });
  assert.equal(grok({ env: { COUNCIL_GROK_BIN: path.join(dir, "missing") }, platform: "linux", home: dir }), null);
  assert.equal(grok({ env: { PATH: "" }, platform: "linux", home: dir }), null, "nothing on PATH and no fallback");
});

test("a Windows command shim runs its JavaScript entry through node, never through cmd.exe", () => {
  const dir = tmp();
  const entry = file(dir, "node_modules/@xai/grok/dist/cli.js");
  const shim = file(dir, "grok.cmd", '@ECHO off\r\nSETLOCAL\r\n"%_prog%"  "%dp0%\\node_modules\\@xai\\grok\\dist\\cli.js" %*\r\n');
  assert.deepEqual(grok({ env: { COUNCIL_GROK_BIN: shim }, platform: "win32", home: dir }), { command: process.execPath, args: [entry], path: entry, kind: "shim-node" });
  const opaque = file(dir, "other/grok.bat", "@echo off\r\n\"%~dp0\\grok.exe\" %*\r\n");
  assert.throws(() => grok({ env: { COUNCIL_GROK_BIN: opaque }, platform: "win32", home: dir }), (e) => e instanceof LauncherError && /command shim without a JavaScript entry; set COUNCIL_GROK_BIN to grok\.exe/.test(e.message));
  const exe = file(dir, "vendor/grok.exe");
  const forwarding = file(dir, "vendor/grok.cmd", '@echo off\r\n"%~dp0\\grok.exe" %*\r\n');
  assert.deepEqual(grok({ env: { COUNCIL_GROK_BIN: forwarding }, platform: "win32", home: dir }), { command: exe, args: [], path: exe, kind: "shim-native" }, "a shim naming an existing .exe runs it directly");
  assert.deepEqual(shimTarget(forwarding), { kind: "shim-native", entry: exe });
  assert.equal(shimTarget(path.join(dir, "missing.cmd")), null);
  const ps1 = file(dir, "grok.ps1", "& grok.exe $args");
  assert.throws(() => grok({ env: { COUNCIL_GROK_BIN: ps1 }, platform: "win32", home: dir }), /PowerShell wrapper/);
});

// What npm 10's cmd-shim writes into node_modules/.bin for an extensionless node script.
const npmShim = (target, prog = "node") => ["@ECHO off", "GOTO start", ":find_dp0", "SET dp0=%~dp0", "EXIT /b", ":start", "SETLOCAL", "CALL :find_dp0", "",
  `IF EXIST "%dp0%\\${prog}.exe" (`, `  SET "_prog=%dp0%\\${prog}.exe"`, ") ELSE (", `  SET "_prog=${prog}"`, "  SET PATHEXT=%PATHEXT:;.JS;=;%", ")", "",
  `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${target}" %*`, ""].join("\r\n");

test("npm's shim for an extensionless node script runs that script through node; a non-node target is refused", () => {
  const dir = tmp();
  const entry = file(dir, "node_modules/@xai-official/grok/bin/grok", "#!/usr/bin/env node\nrequire('./grok-bootstrap.js');\n");
  const shim = file(dir, "node_modules/.bin/grok.cmd", npmShim("..\\@xai-official\\grok\\bin\\grok"));
  assert.deepEqual(grok({ env: { COUNCIL_GROK_BIN: shim }, platform: "win32", home: dir }), { command: process.execPath, args: [entry], path: entry, kind: "shim-node" });
  const sh = file(dir, "sh/grok.cmd", npmShim("..\\node_modules\\@xai-official\\grok\\bin\\grok", "sh"));
  assert.throws(() => grok({ env: { COUNCIL_GROK_BIN: sh }, platform: "win32", home: dir }), /command shim without a JavaScript entry/);
  file(dir, "plain/node_modules/tool/bin/grok", "MZ not a script");
  const plain = file(dir, "plain/grok.cmd", npmShim("node_modules\\tool\\bin\\grok"));
  assert.throws(() => grok({ env: { COUNCIL_GROK_BIN: plain }, platform: "win32", home: dir }), /command shim without a JavaScript entry/);
});

test("PATH order decides, every candidate is reported, and the native fallback is tried last", () => {
  const dir = tmp();
  const first = file(dir, "a/grok"), second = file(dir, "b/grok");
  file(dir, "c/grok", "", 0o644);
  const env = { PATH: [path.join(dir, "c"), path.join(dir, "a"), "", path.join(dir, "b")].join(":") };
  if (process.platform !== "win32") {
    assert.deepEqual(pathCandidates("grok", env, "linux"), [first, second], "a non-executable file is skipped");
    assert.equal(grok({ env, platform: "linux", home: dir }).command, first);
    assert.equal(grok({ env: { ...env, COUNCIL_GROK_BIN: second }, platform: "linux", home: dir }).command, second, "the override wins");
  }
  const win = tmp();
  const exe = file(win, "x/GROK.EXE"), cmd = file(win, "x/grok.cmd");
  assert.deepEqual(pathCandidates("grok", { Path: `"${path.join(win, "x")}"`, PATHEXT: ".EXE;.CMD" }, "win32"), [exe, cmd], "PATHEXT order, case-insensitive names");
  const home = tmp();
  const installed = file(home, ".grok/bin/grok.exe");
  const fallback = (h) => path.join(h, ".grok", "bin", "grok.exe");
  assert.deepEqual(grok({ env: { PATH: "" }, platform: "win32", home, nativeFallback: fallback }), { command: installed, args: [], path: installed, kind: "native" });
  assert.deepEqual(grok({ env: { PATH: "", USERPROFILE: home }, platform: "win32", nativeFallback: fallback }), { command: installed, args: [], path: installed, kind: "native" }, "the home comes from USERPROFILE");
  assert.equal(grok({ env: { PATH: "", USERPROFILE: tmp() }, platform: "win32", nativeFallback: fallback }), null);
  assert.equal(grok({ env: { PATH: "" }, platform: "linux", home }), null, "no fallback given, none tried");
});

test("Claude's native-only rule: PATH wrappers and non-.exe files are refused on win32, a configured JS entry is accepted", () => {
  const dir = tmp();
  const claude = (over) => resolveLauncher({ name: "claude", binEnv: "COUNCIL_CLAUDE_BIN", nativeOnly: true, ...over });
  file(dir, "wrap/claude.cmd", '"%_prog%" "%dp0%\\cli.js" %*');
  file(dir, "wrap/cli.js");
  assert.throws(() => claude({ env: { PATH: path.join(dir, "wrap"), PATHEXT: ".EXE;.CMD" }, platform: "win32", home: dir }), (e) => e instanceof LauncherError && /cannot launch .*claude\.cmd without a shell; install the native claude executable or set COUNCIL_CLAUDE_BIN/.test(e.message));
  const exe = file(dir, "native/claude.exe");
  assert.deepEqual(claude({ env: { PATH: [path.join(dir, "wrap"), path.join(dir, "native")].join(";"), PATHEXT: ".EXE;.CMD" }, platform: "win32", home: dir }), { command: exe, args: [], path: exe, kind: "native" }, "a later native entry is still found");
  const fake = file(dir, "fake-claude.mjs");
  assert.deepEqual(claude({ env: { COUNCIL_CLAUDE_BIN: fake, PATH: "" }, platform: "win32", home: dir }), { command: process.execPath, args: [fake], path: fake, kind: "node-script" }, "the configured-JS exception");
  assert.throws(() => claude({ env: { COUNCIL_CLAUDE_BIN: path.join(dir, "wrap", "claude.cmd") }, platform: "win32", home: dir }), /cannot launch shell wrapper/);
  assert.throws(() => claude({ env: { COUNCIL_CLAUDE_BIN: file(dir, "claude.ps1", "x") }, platform: "win32", home: dir }), /cannot launch shell wrapper/);
  if (process.platform !== "win32") {
    const posix = file(dir, "posix/claude");
    assert.equal(claude({ env: { PATH: path.join(dir, "posix") }, platform: "linux", home: dir }).kind, "native");
  }
  file(dir, "js/claude.js");
  assert.throws(() => claude({ env: { PATH: path.join(dir, "js"), PATHEXT: ".EXE;.JS" }, platform: "win32", home: dir }), /cannot launch .*claude\.js without a shell/, "a script found on PATH is not accepted without the override");
});

test("spawnChild and runSync launch the resolved command with the adapter's arguments and no shell", async () => {
  const dir = tmp();
  const script = file(dir, "echo.mjs", "process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), stdin: require('fs').readFileSync(0, 'utf8'), depth: process.env.COUNCIL_DEPTH }));", 0o644);
  fs.writeFileSync(script, "import fs from 'node:fs'; process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), stdin: process.stdin.isTTY ? null : fs.readFileSync(0, 'utf8'), depth: process.env.COUNCIL_DEPTH }));");
  const launcher = grok({ env: { COUNCIL_GROK_BIN: script }, platform: "linux", home: dir });
  const sync = runSync(launcher, ["--version", "x y"], { env: { ...process.env, COUNCIL_DEPTH: "1" } });
  assert.equal(sync.status, 0, sync.stderr);
  assert.deepEqual(JSON.parse(sync.stdout), { argv: ["--version", "x y"], stdin: "", depth: "1" });
  const child = spawnChild(launcher, ["--thread", "t"], { cwd: dir, env: { ...process.env, COUNCIL_DEPTH: "1" } });
  child.stdin.end("hello");
  let out = "";
  child.stdout.on("data", (c) => { out += c; });
  const code = await new Promise((resolve) => child.on("close", resolve));
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(out), { argv: ["--thread", "t"], stdin: "hello", depth: "1" });
  if (process.platform !== "win32") assert.equal(spawnChild(launcher, [], { cwd: dir, env: process.env, stdin: "ignore" }).pid > 0, true, "stdin may be ignored");
});

test("runSync bounds a probe: it is stopped at its timeout, gets no stdin, and reports the failure instead of hanging", () => {
  const dir = tmp();
  const hang = file(dir, "hang.mjs", "setTimeout(() => {}, 60000);", 0o644);
  const launcher = grok({ env: { COUNCIL_GROK_BIN: hang }, platform: "linux", home: dir });
  const started = Date.now();
  const r = runSync(launcher, ["--version"], { env: process.env, timeoutMs: 300 });
  assert.ok(Date.now() - started < 5000, "the probe was stopped");
  assert.equal(r.error?.code, "ETIMEDOUT");
  const reader = file(dir, "reader.mjs", "let n = 0; process.stdin.on('data', (c) => { n += c.length; }); process.stdin.on('end', () => console.log(n));", 0o644);
  const read = runSync(grok({ env: { COUNCIL_GROK_BIN: reader }, platform: "linux", home: dir }), [], { env: process.env });
  assert.equal(read.stdout.trim(), "0", "a probe's stdin is closed at once");
});
