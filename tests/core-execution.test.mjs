// S2.4: process snapshots, ownership through adapter.ownsProcess and hasFlagOperand, identity, evidence, the depth guard,
// darwin pgid reparenting, and the Windows query encoding (ported from grok_plugin_for_codex tests/execution-ownership.test.mjs
// and windows-scan.test.mjs).
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { processSnapshot, sameIdentity, companionState, selfIdentity, ownsExecution, hasFlagOperand, ownedExecution, stopIdentity, currentIdentity,
  recordRecoveryEvidence, recoveryEvidence, parseWindowsCommandLine, depthGuard, executionController } from "../plugins/council/scripts/lib/core/execution.mjs";
import { DEPTH_VARIABLES } from "../plugins/council/scripts/lib/core/host.mjs";

const row = (pid, extra = {}) => ({ pid, ppid: 1, stamp: "100", argv: ["grok", "--version"], raw: "grok --version", name: "grok", ...extra });
const prompt = path.join("/state/jobs/aaaaaaaaaaaaaaaa", "prompt.md");
const grokArgs = ["--prompt-file", prompt, "--session-id", "00000001-0000-4000-8000-000000000001", "--output-format", "streaming-json"];
const job = { dir: "/state/jobs/aaaaaaaaaaaaaaaa", argv: ["grok", ...grokArgs], childArgs: grokArgs, promptFile: prompt };
/** A Grok-shaped adapter: ownership by the --prompt-file operand (the adapter's job-specific evidence). */
const grokLike = { id: "grok", ownsProcess: (r, j, platform, has) => has(r, "--prompt-file", j.promptFile ?? path.join(j.dir, "prompt.md"), platform) };
const table = (...rows) => ({ state: "ok", rows });
const encode = (s) => { let result = ""; for (let i = 0; i < s.length; i++) result += s.charCodeAt(i).toString(16).padStart(4, "0"); return result; };
const owned = (j, snap, platform = "linux", adapter = grokLike) => { const r = ownedExecution(j, snap, platform, [], adapter); return [r.state, r.rows.map((x) => x.pid).sort((a, b) => a - b)]; };

test("the depth guard refuses when any of the five variables is set, and names them", () => {
  assert.equal(depthGuard({ PATH: "/bin" }), null);
  for (const name of DEPTH_VARIABLES) assert.match(depthGuard({ [name]: "1" }), new RegExp(`refusing a nested call: ${name} set`));
  assert.match(depthGuard({ COUNCIL_DEPTH: "1", AGY_BRIDGE_DEPTH: "1" }), /COUNCIL_DEPTH, AGY_BRIDGE_DEPTH/);
  assert.equal(depthGuard({ COUNCIL_DEPTH: "" }), null, "an empty value is unset");
});

test("hasFlagOperand: exact argv pairs on Linux and Windows, whole-word pairs in macOS raw text", () => {
  assert.ok(hasFlagOperand({ argv: ["grok", "--prompt-file", prompt] }, "--prompt-file", prompt, "linux"));
  assert.equal(hasFlagOperand({ argv: ["grok", "--prompt-file", `${prompt}.bak`] }, "--prompt-file", prompt, "linux"), false);
  assert.equal(hasFlagOperand({ argv: ["grok", "--rules", prompt] }, "--prompt-file", prompt, "linux"), false);
  assert.ok(hasFlagOperand({ argv: ["grok.exe", "--prompt-file", "C:\\A\\prompt.md"] }, "--prompt-file", "c:/a/prompt.md", "win32"), "separators and case normalized on Windows");
  assert.equal(hasFlagOperand({ argv: ["grok", "--prompt-file", "/STATE/x"] }, "--prompt-file", "/state/x", "linux"), false, "case preserved elsewhere");
  assert.ok(hasFlagOperand({ argv: null, raw: `/usr/local/bin/grok --prompt-file ${prompt} --effort low` }, "--prompt-file", prompt, "darwin"));
  assert.equal(hasFlagOperand({ argv: null, raw: `grok --prompt-file ${prompt}.backup` }, "--prompt-file", prompt, "darwin"), false, "never a prefix of another word");
  assert.equal(hasFlagOperand({ argv: null, raw: `node -e "console.log('--prompt-file ${prompt}')"` }, "--prompt-file", prompt, "darwin"), false, "a quoted mention is not the operand");
  assert.equal(hasFlagOperand({ argv: null, raw: `cat ${prompt}` }, "--prompt-file", prompt, "darwin"), false, "the path alone is not the flag pair");
  assert.equal(hasFlagOperand({ argv: null, raw: null }, "--prompt-file", prompt, "darwin"), false);
  assert.equal(hasFlagOperand({ argv: ["x"] }, "--prompt-file", undefined, "linux"), false);
});

test("ownsExecution delegates to the adapter; without an adapter nothing is owned", () => {
  assert.ok(ownsExecution(row(101, { argv: job.argv }), job, "linux", grokLike));
  assert.ok(ownsExecution(row(101, { argv: ["node", "/opt/grok/cli.js", ...grokArgs] }), job, "linux", grokLike), "a shim run through node owns the same operand");
  for (const args of [["cat", prompt], ["grok", "--prompt-file", `${prompt}.backup`], ["grok", "--rules", prompt]]) assert.equal(ownsExecution(row(101, { argv: args }), job, "linux", grokLike), false);
  assert.equal(ownsExecution(row(101, { argv: job.argv }), job, "linux", null), false);
  const aliased = { ...job, dir: "/alias/jobs/aaaaaaaaaaaaaaaa" };
  assert.ok(ownsExecution(row(101, { argv: job.argv }), aliased, "linux", grokLike), "ownership follows the operand recorded at launch, not a later spelling of the directory");
  assert.equal(ownsExecution(row(101, { argv: ["grok", "--prompt-file", path.join("/alias/jobs/aaaaaaaaaaaaaaaa", "prompt.md")] }), aliased, "linux", grokLike), false);
});

test("macOS: owned descendants are found through pgid, including a member reparented to pid 1", () => {
  const root = row(201, { argv: null, raw: `grok ${grokArgs.join(" ")}`, pgid: 201, stamp: "Sat Oct 31 12:00:00 2026" });
  const child = row(202, { ppid: 201, pgid: 201, argv: null, raw: "sh -c sleep 60", stamp: "Sat Oct 31 12:00:01 2026" });
  const orphan = row(203, { ppid: 1, pgid: 201, argv: null, raw: "node helper.js", stamp: "Sat Oct 31 12:00:02 2026" });
  const stranger = row(300, { ppid: 1, pgid: 300, argv: null, raw: "node other.js", stamp: "Sat Oct 31 12:00:02 2026" });
  assert.deepEqual(owned(job, table(root, child, orphan, stranger), "darwin"), ["owned", [201, 202, 203]]);
  assert.deepEqual(owned(job, table(orphan, stranger), "darwin"), ["gone", []], "a group with no owned row is nobody's");
  assert.deepEqual(owned(job, table(root, child, stranger, row(304, { ppid: 1, pgid: 300, argv: null, raw: "x" })), "linux"), ["owned", [201, 202]], "pgid is a darwin rule only");
});

test("a Windows row with an inaccessible command line is unknown only when it could be ours; unreadable names are unknown", () => {
  const inaccessible = (pid, extra = {}) => row(pid, { argv: null, raw: null, inaccessible: true, name: "grok.exe", ...extra });
  const root = row(201, { argv: job.argv, raw: job.argv.join(" "), stamp: "500" });
  assert.equal(owned(job, table(root, inaccessible(900)), "win32")[0], "owned", "a stranger's process is not evidence");
  assert.equal(owned({ ...job, pid: 900 }, table(inaccessible(900)), "win32")[0], "unknown", "the launched pid");
  assert.equal(owned(job, table(root, inaccessible(202, { ppid: 201, stamp: "600" })), "win32")[0], "unknown", "an owned descendant");
  assert.equal(owned({ ...job, execution: [{ pid: 300, stamp: "700" }] }, table(inaccessible(300, { stamp: "700" })), "win32")[0], "unknown", "a known identity");
  for (const name of ["claude", "agy", "grok.exe", "node", "node.exe"]) assert.equal(owned(job, table(row(201, { raw: "", argv: null, name })), "win32")[0], "unknown", name);
  assert.equal(owned(job, table(row(201, { raw: "", argv: null, name: "explorer.exe" })), "win32")[0], "gone", "an unrelated binary with an empty line is not ours");
  assert.equal(ownedExecution(job, { state: "unknown", rows: [], error: "boom" }).error, "boom");
});

test("Windows process list uses complete framing, ASCII as is and reversible UTF-16 for the rest", () => {
  const raw = '"C:\\É User\\grok.exe" --prompt-file "C:\\É User\\prompt.md"';
  const good = `ok\n123\t1\t999\tx${encode(raw)}\t=grok.exe\t3\ncomplete\n`;
  const read = (stdout, extra = {}) => processSnapshot({ platform: "win32", powershell: () => ({ status: 0, stdout, ...extra }) });
  const result = read(good);
  assert.equal(result.state, "ok"); assert.equal(result.rows[0].raw, raw); assert.equal(result.rows[0].name, "grok.exe");
  assert.deepEqual(result.rows[0].argv, ["C:\\É User\\grok.exe", "--prompt-file", "C:\\É User\\prompt.md"]);
  const ascii = read('ok\n126\t1\t999\t="C:\\Grok\\grok.exe" --prompt-file "C:\\a b\\prompt.md"\tx0067\t3\ncomplete\n');
  assert.deepEqual([ascii.rows[0].raw, ascii.rows[0].name], ['"C:\\Grok\\grok.exe" --prompt-file "C:\\a b\\prompt.md"', "g"]);
  const hidden = read("ok\n124\t1\t999\t-\t=grok.exe\t1\ncomplete\n");
  assert.deepEqual([hidden.state, hidden.rows[0].raw, hidden.rows[0].argv, hidden.rows[0].inaccessible], ["ok", null, null, true]);
  assert.deepEqual(read("ok\n125\t1\t999\t-\t=grok.exe\t0\ncomplete\n"), table(), "ThreadCount=0 rows are filtered");
  for (const text of [good.replace("complete\n", ""), good.replace("999", "bad"), good.replace("=grok.exe", "x67"), good.replace("=grok.exe", "grok.exe"), good.replace("=grok.exe", "-"),
    good.replace("=grok.exe", "=gr\u00f6k.exe"), good.replace(`x${encode(raw)}`, encode(raw)), good.replace("\t3\n", "\n"), good.replace("\t3\n", "\tx\n"), "", "ok\ntruncated\ncomplete\n"]) {
    assert.equal(read(text).state, "unknown", JSON.stringify(text));
  }
  assert.equal(read(good, { status: 1 }).state, "unknown");
  assert.equal(read(good, { error: new Error("timeout") }).state, "unknown");
  let script = null;
  processSnapshot({ platform: "win32", powershell: (s) => { script = s; return { status: 0, stdout: "ok\r\ncomplete\r\n" }; } });
  assert.ok(script.startsWith("$env:PSModulePath=\"$PSHOME\\Modules\";$ErrorActionPreference='Stop';"), "PSModulePath injected");
  assert.equal(script.match(/CimCmdlets\\Get-CimInstance Win32_Process -Property \$props/g).length, 2);
  assert.ok(!/::|Add-Type|\[Convert\]|\[Text\./.test(script));
});

test("a query that fails or times out is unknown and names its cause; malformed output stays a plain unknown", () => {
  const stderr = "CimCmdlets\\Get-CimInstance : The module 'CimCmdlets' could not be loaded. For more information, run 'Import-Module \r\nCimCmdlets'.\r\nAt line:3 char:154\r\n+ ...\r\n";
  const failed = processSnapshot({ platform: "win32", powershell: () => ({ status: 1, stdout: "", stderr }) });
  assert.deepEqual(failed, { state: "unknown", rows: [], error: "process query failed: CimCmdlets\\Get-CimInstance : The module 'CimCmdlets' could not be loaded. For more information, run 'Import-Module CimCmdlets'." });
  assert.deepEqual(processSnapshot({ platform: "win32", timeout: 20000, powershell: () => ({ status: null, stdout: "", error: Object.assign(new Error("spawnSync powershell.exe ETIMEDOUT"), { code: "ETIMEDOUT" }) }) }), { state: "unknown", rows: [], error: "process query timed out after 20 s" });
  assert.deepEqual(processSnapshot({ platform: "win32", powershell: () => ({ status: 1, stdout: "", stderr: "" }) }), { state: "unknown", rows: [], error: "process query failed: exit code 1" });
  assert.deepEqual(processSnapshot({ platform: "darwin", run: () => ({ status: 2, stdout: "", stderr: "ps: illegal option -- w\n" }) }), { state: "unknown", rows: [], error: "process query failed: ps: illegal option -- w" });
  assert.deepEqual(processSnapshot({ platform: "win32", powershell: () => ({ status: 0, stdout: "ok\r\n" }) }), { state: "unknown", rows: [] });
  assert.deepEqual(processSnapshot({ platform: "darwin", pid: 42, run: () => ({ status: 1, stdout: "" }) }), table(), "an absent targeted pid is gone");
  const uid = process.getuid?.() ?? 0;
  const output = `42 1 42 ${uid} Z Mon Oct  5 10:00:00 2026 grok --prompt-file x\n`;
  assert.deepEqual(processSnapshot({ platform: "darwin", pid: 42, run: () => ({ status: 0, stdout: output }) }), table(), "zombies do not live");
  const live = processSnapshot({ platform: "darwin", run: () => ({ status: 0, stdout: `43 1 43 ${uid} S Mon Oct  5 10:00:00 2026 grok --prompt-file x\n44 43 43 -2 S Mon Oct  5 10:00:00 2026 nobody\n` }) });
  assert.deepEqual(live.rows.map((r) => [r.pid, r.pgid, r.raw]), [[43, 43, "grok --prompt-file x"]], "darwin rows carry pgid; another uid's row is skipped (nobody is -2)");
});

test("Linux keeps an exiting process as its children's parent; a zombie is gone", { skip: process.platform === "win32" }, () => {
  const proc = fs.mkdtempSync(path.join(os.tmpdir(), "proc-"));
  fs.mkdirSync(path.join(proc, "sys/kernel/random"), { recursive: true });
  fs.writeFileSync(path.join(proc, "sys/kernel/random/boot_id"), "boot1\n");
  const put = (pid, state, flags, argv, ppid = 1) => {
    fs.mkdirSync(path.join(proc, String(pid)));
    fs.writeFileSync(path.join(proc, String(pid), "stat"), `${pid} (x) ${state} ${ppid} ${pid} ${pid} 0 -1 ${flags} ${"0 ".repeat(12)}777 0\n`);
    fs.writeFileSync(path.join(proc, String(pid), "cmdline"), argv.map((a) => `${a}\0`).join(""));
  };
  put(201, "S", 0x400104, job.argv); put(202, "S", 0x400100, ["sh", "-c", "sleep 60"], 201); put(203, "R", 0x40050c, []); put(204, "S", 0x400100, ["sleep", "60"], 203); put(205, "Z", 0x40010c, []);
  const snap = processSnapshot({ platform: "linux", proc });
  assert.deepEqual(snap.rows.map((r) => [r.pid, r.raw, r.exiting ?? false, r.pgid]).sort(), [[201, job.argv.join(" "), true, 201], [202, "sh -c sleep 60", false, 202], [203, "", true, 203], [204, "sleep 60", false, 204]]);
  assert.deepEqual(processSnapshot({ platform: "linux", pid: 205, proc }), table());
  assert.deepEqual(owned(job, snap, "linux"), ["owned", [201, 202]]);
  const known = { ...job, execution: [{ pid: 203, stamp: "777", boot: "boot1", raw: "grok --prompt-file x" }] };
  assert.deepEqual(owned(known, snap, "linux"), ["owned", [201, 202, 203, 204]]);
});

test("companion identity includes birth and boot, never just PID or heartbeat; Windows start times compare within 5 s", () => {
  const identity = row(101, { boot: "boot1" });
  const j = { ...job, companionPid: 101, companionIdentity: identity };
  assert.equal(companionState(j, table(identity)), "live");
  assert.equal(companionState(j, table(row(101, { boot: "boot2" }))), "gone");
  assert.equal(companionState(j, table(row(101, { boot: "boot1", stamp: "101" }))), "gone");
  assert.equal(companionState({ ...j, companionIdentity: null }, table(identity)), "unknown");
  assert.equal(companionState(j, { state: "unknown", rows: [] }), "unknown");
  assert.equal(companionState(j, table()), "gone");
  const ticks = (ms) => String(BigInt(ms) * 10000n + 621355968000000000n);
  const win = { ...job, companionPid: 101, companionIdentity: { pid: 101, startedMs: 1_000_000 } };
  assert.equal(companionState(win, table(row(101, { stamp: ticks(1_000_040) }))), "live");
  assert.equal(companionState(win, table(row(101, { stamp: ticks(1_006_000) }))), "gone");
  assert.equal(companionState(win, table(row(101, { stamp: "0" }))), "unknown");
  assert.equal(companionState(win, table(row(101, { argv: null, raw: null, inaccessible: true, stamp: ticks(1_000_040) }))), "live", "a hidden command line is judged by birth time");
  assert.ok(sameIdentity(identity, { ...identity }) && !sameIdentity(identity, { ...identity, stamp: "x" }) && !sameIdentity(null, identity));
  const self = selfIdentity("win32");
  assert.equal(self.pid, process.pid);
  assert.ok(Math.abs(self.startedMs - (Date.now() - process.uptime() * 1000)) < 1000);
});

test("this process's own identity reads as live in a real snapshot, and currentIdentity finds it", { skip: process.platform === "win32" }, () => {
  const me = currentIdentity(process.pid);
  assert.ok(me && me.pid === process.pid, JSON.stringify(me));
  assert.equal(companionState({ companionPid: process.pid, companionIdentity: me }, processSnapshot({ pid: process.pid })), "live");
  assert.equal(currentIdentity(2 ** 22 - 1), null);
  const controller = executionController({ adapter: grokLike });
  assert.equal(controller.self().pid, process.pid);
  assert.equal(controller.platform, process.platform);
});

test("a process older than an owned pid is not its child; backend discovery does not depend on its dead launcher; unreadable candidates are unknown", () => {
  const root = row(201, { argv: job.argv, raw: job.argv.join(" "), stamp: "500" });
  const child = row(202, { ppid: 201, stamp: "600" });
  const stale = row(203, { ppid: 201, stamp: "400" });
  assert.deepEqual(owned(job, table(root, child, stale), "win32"), ["owned", [201, 202]]);
  const native = row(201, { argv: job.argv, raw: job.argv.join(" ") });
  const nativeChild = row(202, { ppid: 201, argv: ["node", "sleep"], raw: "node sleep" });
  const result = ownedExecution({ ...job, pid: 200 }, table(native, nativeChild), "linux", [], grokLike);
  assert.deepEqual([result.state, result.rows.map((r) => r.pid)], ["owned", [201, 202]]);
  const orphan = { ...nativeChild, ppid: 1 };
  assert.equal(ownedExecution({ ...job, execution: result.rows }, table(orphan), "linux", [], grokLike).state, "owned");
  assert.equal(ownedExecution({ ...job, execution: result.rows }, table({ ...orphan, stamp: "reused" }), "linux", [], grokLike).state, "gone");
  assert.equal(owned(job, table(row(201, { raw: "", argv: null, name: "grok" })), "win32")[0], "unknown");
  assert.equal(ownedExecution(job, { state: "unknown", rows: [] }).state, "unknown");
});

test("stopIdentity revalidates before signalling, sends SIGTERM or SIGKILL as asked, and holds a Windows handle", () => {
  const original = row(201); const killed = [];
  const kill = (pid, signal) => killed.push([pid, signal]);
  assert.equal(stopIdentity(original, { platform: "linux", snapshot: () => table({ ...original, stamp: "reused" }), kill }), "gone");
  assert.equal(stopIdentity(original, { platform: "linux", snapshot: () => ({ state: "unknown", rows: [] }), kill }), "unknown");
  assert.deepEqual(killed, []);
  assert.equal(stopIdentity(original, { platform: "linux", snapshot: () => table(original), kill }), "sent");
  assert.equal(stopIdentity(original, { platform: "linux", snapshot: () => table(original), kill, signal: "SIGTERM" }), "sent");
  assert.deepEqual(killed, [[201, "SIGKILL"], [201, "SIGTERM"]]);
  assert.equal(stopIdentity(original, { platform: "darwin", snapshot: () => table({ ...original, raw: "other" }), kill }), "unknown", "ps birth stamps have only second precision");
  assert.equal(stopIdentity({ ...original, pid: process.pid }, { platform: "linux" }), "unknown", "never this process");
  assert.equal(stopIdentity(original, { platform: "linux", snapshot: () => table(original), kill: () => { throw Object.assign(new Error(), { code: "ESRCH" }); } }), "gone");
  let called = false;
  const outcome = stopIdentity(original, { platform: "win32", powershell: (script, env, timeout) => {
    called = true; assert.match(script, /\$h=\$p.Handle/); assert.match(script, /CreationDate/); assert.ok(script.startsWith("$env:PSModulePath="));
    assert.equal(env.CC_KILL_STAMP, original.stamp); assert.equal(env.CC_KILL_RAW, original.raw); assert.equal(timeout, 123);
    return { status: 0, stdout: "sent\n" };
  }, timeout: 123 });
  assert.ok(called); assert.equal(outcome, "sent");
  assert.equal(stopIdentity(original, { platform: "win32", powershell: () => ({ status: 0, stdout: "mismatch\n" }) }), "mismatch", "kill refused on a timestamp or command-line mismatch");
  assert.equal(stopIdentity(original, { platform: "win32", powershell: () => ({ status: 1, stdout: "" }) }), "unknown");
});

test("immutable cleanup evidence is owner-specific and survives a recovery caller's exit", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "council-evidence-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const j = { ...job, dir, ownerToken: "a".repeat(32) };
  recordRecoveryEvidence(j, [row(201)]); recordRecoveryEvidence(j, [row(202)]); recordRecoveryEvidence(j, []);
  assert.deepEqual(recoveryEvidence(j).map((r) => r.pid).sort(), [201, 202]);
  assert.throws(() => recoveryEvidence({ ...j, ownerToken: "b".repeat(32) }), /unreadable cleanup evidence/);
  assert.deepEqual(recoveryEvidence({ ...j, dir: path.join(dir, "none") }), []);
});

test("parseWindowsCommandLine splits a command line the way CommandLineToArgvW does", () => {
  const cases = [['"C:\\Program Files\\x.exe" a "b c" d', ["C:\\Program Files\\x.exe", "a", "b c", "d"]], ['x a\\"b', ["x", 'a"b']], ['x "a\\\\"', ["x", "a\\"]],
    ['x "a""b"', ["x", 'a"b']], ["x   a\tb", ["x", "a", "b"]], ['x ""', ["x", ""]], ["  x", ["x"]], ['"unterminated', ["unterminated"]], ["x a\\\\b", ["x", "a\\\\b"]]];
  for (const [line, expected] of cases) assert.deepEqual(parseWindowsCommandLine(line), expected, line);
});
