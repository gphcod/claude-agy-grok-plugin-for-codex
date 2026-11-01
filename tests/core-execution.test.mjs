// S2.4: process snapshots, ownership through adapter.ownsProcess and hasFlagOperand, identity, evidence, the depth guard,
// darwin pgid reparenting, and the Windows query encoding (ported from grok_plugin_for_codex tests/execution-ownership.test.mjs
// and windows-scan.test.mjs).
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { processSnapshot, sameIdentity, companionState, selfIdentity, ownsExecution, ownsRecordedInvocation, startTime, hasFlagOperand, ownedExecution, stopIdentity, currentIdentity,
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

test("macOS ownership needs the adapter's evidence and the complete recorded invocation: same launcher or the provider's native binary", () => {
  const raw = (text) => ({ pid: 101, argv: null, raw: text });
  assert.ok(ownsExecution(raw(`grok ${grokArgs.join(" ")}`), job, "darwin", grokLike));
  assert.ok(ownsExecution(raw(`/Users/me/.grok/bin/grok ${grokArgs.join(" ")}`), job, "darwin", grokLike), "the same native binary under another path");
  const npm = { ...job, argv: ["node", "/npm/lib/node_modules/grok/bin/grok", ...grokArgs] };
  assert.ok(ownsExecution(raw(`/Users/me/.grok/bin/grok ${grokArgs.join(" ")}`), npm, "darwin", grokLike), "F2: the native grok behind a multi-element node launcher");
  assert.ok(ownsRecordedInvocation(raw(`/opt/grok ${grokArgs.join(" ")}`), npm, "grok"), "the binary name is passed explicitly");
  // S2.9: a program path with spaces is matched by suffix; it is owned when the path exists, and ambiguous (unknown) when not.
  const spaced = raw(`/Users/First Last/.grok/bin/grok ${grokArgs.join(" ")}`);
  assert.equal(ownsRecordedInvocation(spaced, npm, "grok", (p) => p === "/Users/First Last/.grok/bin/grok"), true);
  assert.equal(ownsRecordedInvocation(spaced, npm, "grok", () => false), null, "a wrapper's arguments or a path: cannot tell");
  assert.equal(ownsRecordedInvocation(raw(`/bin/sh -c /x/notgrok ${grokArgs.join(" ")}`), npm, "grok", () => false), false, "a program not ending in /grok is not ours");
  assert.equal(ownsRecordedInvocation(raw(`/opt/grok ${grokArgs.join(" ")}`), npm, null), false, "without a binary name only the recorded launcher matches");
  assert.equal(ownsExecution(raw(`/usr/bin/notgrok ${grokArgs.join(" ")}`), npm, "darwin", grokLike), false);
  assert.equal(ownsExecution(raw(`grok ${grokArgs.join(" ")}`), job, "darwin", null), false, "no adapter, no ownership");
  assert.equal(ownsExecution(raw(`grok ${grokArgs.join(" ")}`), job, "darwin", { ...grokLike, ownsProcess: () => false }), false, "darwin goes through adapter.ownsProcess too");
  const node = { ...job, argv: ["/Applications/Tools Folder/node", "/project/fake.mjs", ...grokArgs] };
  assert.ok(ownsExecution(raw(node.argv.join(" ")), node, "darwin", grokLike), "a launcher path with spaces, recorded whole");
  assert.equal(ownsExecution(raw(`/usr/bin/node /other.mjs ${grokArgs.join(" ")}`), node, "darwin", grokLike), false, "another script under the same node");
  for (const text of [`cat ${grokArgs.join(" ")}`, `/usr/bin/notgrok ${grokArgs.join(" ")}`, `grok ${grokArgs.join(" ")} backup`, `node -e "x" -- --prompt-file ${prompt} tail`, `grok --prompt-file ${prompt}`]) {
    assert.equal(ownsExecution(raw(text), job, "darwin", grokLike), false, text);
  }
  assert.equal(ownsExecution(raw(`grok ${grokArgs.join(" ")}`), { ...job, childArgs: [] }, "darwin", grokLike), false, "a record from before launch owns nothing by text");
});

test("startTime: numeric ticks as BigInt, macOS lstart text as local epoch seconds, anything else null", () => {
  assert.equal(startTime("123"), 123n);
  assert.equal(startTime("Sat Oct 31 12:00:05 2026"), BigInt(new Date(2026, 9, 31, 12, 0, 5).getTime() / 1000));
  assert.equal(startTime("Mon Oct 5 09:03:00 2026"), BigInt(new Date(2026, 9, 5, 9, 3, 0).getTime() / 1000), "single-digit day as the snapshot normalizes it");
  assert.ok(startTime("Sat Oct 31 12:00:05 2026") > startTime("Sat Oct 31 11:59:59 2026"), "compared as times, not text");
  for (const bad of [undefined, null, "", "0x10", "Sat Foo 31 12:00:00 2026", "Sat Oct 31 12:00 2026"]) assert.equal(startTime(bad), null, String(bad));
});

test("macOS groups (S2.8 F1, S2.9): followed under a live owned leader; otherwise adopted only by a persisted identity, the rest unverified", () => {
  const at = (sec, min = 0) => `Sat Oct 31 12:${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")} 2026`;
  const ms = (sec, min = 0) => new Date(2026, 9, 31, 12, min, sec).getTime();
  const base = { ...job, pid: 201, leader: { pid: 201, stamp: at(0) }, execution: [] };
  const leader = row(201, { argv: null, raw: `grok ${grokArgs.join(" ")}`, pgid: 201, stamp: at(0) });
  const child = row(202, { ppid: 201, pgid: 201, argv: null, raw: "sh -c sleep 60", stamp: at(1) });
  const member = row(203, { ppid: 1, pgid: 201, argv: null, raw: "node helper.js", stamp: at(2) });
  const stranger = row(300, { ppid: 1, pgid: 300, argv: null, raw: "node other.js", stamp: at(2) });
  assert.deepEqual(owned(base, table(leader, child, member, stranger), "darwin"), ["owned", [201, 202, 203]], "the live leader's group is followed");
  const early = row(204, { ppid: 1, pgid: 201, argv: null, raw: "node early.js", stamp: "Sat Oct 31 11:59:00 2026" });
  const before = ownedExecution(base, table(leader, early), "darwin", [], grokLike);
  assert.deepEqual([before.state, before.rows.map((r) => r.pid), before.unverified.map((r) => r.pid)], ["unknown", [201], [204]], "a member born before its leader is not adopted, and not ignored");
  // The leader is gone: a real descendant recorded at a heartbeat and reparented to pid 1 is adopted by its identity.
  const recorded = { ...base, execution: [{ pid: 203, stamp: at(2) }] };
  assert.deepEqual(owned(recorded, table(member, stranger), "darwin"), ["owned", [203]]);
  // S2.9 (b): without the leader's own recorded identity a persisted row adopts nothing; the member is unverified.
  const { leader: _, ...leaderless } = recorded;
  const noLeader = ownedExecution(leaderless, table(member), "darwin", [], grokLike);
  assert.deepEqual([noLeader.state, noLeader.rows, noLeader.unverified.map((r) => r.pid)], ["unknown", [], [203]]);
  // S2.9 (a), Argon's reproduction: pid 201 now held by a process created 12:00:05; member 206 from 12:00:01 predates it.
  const holder = row(201, { ppid: 1, pgid: 201, argv: null, raw: "node new-leader.js", stamp: at(5) });
  const predates = row(206, { ppid: 1, pgid: 201, argv: null, raw: "node helper.js", stamp: at(1) });
  const argon = ownedExecution(base, table(holder, predates), "darwin", [], grokLike);
  assert.deepEqual([argon.state, argon.rows, argon.unverified.map((r) => r.pid)], ["unknown", [], [206]]);
  // S2.9: a member born after the cleanup-pending job ended (12:00:10 > 12:00:05) may be a surviving descendant's child:
  // not adopted, unverified, never gone, so the confirming cancel keeps the claim.
  const ended = { ...recorded, endedAt: new Date(ms(5)).toISOString() };
  const afterEnd = ownedExecution(ended, table(row(203, { ppid: 1, pgid: 201, argv: null, raw: "node helper.js", stamp: at(10) })), "darwin", [], { ...grokLike });
  assert.deepEqual([afterEnd.state, afterEnd.rows, afterEnd.unverified.map((r) => r.pid)], ["unknown", [], [203]]);
  const unrelated = row(205, { ppid: 1, pgid: 201, argv: null, raw: "node unrelated.js", stamp: at(1, 10) });
  assert.equal(ownedExecution(ended, table(unrelated), "darwin", [], grokLike).state, "unknown", "with the new leader gone nothing proves the group id was reused");
  // A live process holds pid 201 with another creation time: the group id was reused. Members born at or after that new
  // leader are unrelated (gone); one that predates it stays unverified.
  const reused = row(201, { ppid: 1, pgid: 201, argv: null, raw: "node new-leader.js", stamp: at(0, 10) });
  const fresh = ownedExecution(ended, table(reused, unrelated), "darwin", [], grokLike);
  assert.deepEqual([fresh.state, fresh.rows, fresh.unverified], ["gone", [], undefined]);
  const older = row(207, { ppid: 1, pgid: 201, argv: null, raw: "node older.js", stamp: at(0, 5) });
  const mixed = ownedExecution(ended, table(reused, unrelated, older), "darwin", [], grokLike);
  assert.deepEqual([mixed.state, mixed.unverified.map((r) => r.pid)], ["unknown", [207]]);
  // A descendant spawned after the last snapshot, while the job runs: not adopted, reported unverified, so not gone.
  const late = row(206, { ppid: 1, pgid: 201, argv: null, raw: "node late.js", stamp: at(30) });
  const pending = ownedExecution(recorded, table(late), "darwin", [], grokLike);
  assert.deepEqual([pending.state, pending.rows, pending.unverified.map((r) => r.pid)], ["unknown", [], [206]]);
  // No recorded leader identity at all: any live member of group job.pid without evidence is unverified, never gone.
  const blind = ownedExecution({ ...job, pid: 201 }, table(late), "darwin", [], grokLike);
  assert.deepEqual([blind.state, blind.rows, blind.unverified.map((r) => r.pid)], ["unknown", [], [206]]);
  // The test runner's group: a launched row that shares another group never pulls that group in.
  const shared = row(201, { argv: null, raw: `grok ${grokArgs.join(" ")}`, pgid: 77, stamp: at(0) });
  const shell = row(78, { ppid: 1, pgid: 77, argv: null, raw: "-zsh", stamp: "Sat Oct 31 11:00:00 2026" });
  assert.deepEqual(owned(base, table(shared, shell), "darwin"), ["owned", [201]]);
  const linuxRoot = { ...leader, argv: job.argv }, linuxChild = { ...child, argv: ["sh", "-c", "sleep 60"] }, linuxMember = { ...member, argv: ["node", "helper.js"] };
  assert.deepEqual(owned(base, table(linuxRoot, linuxChild, linuxMember), "linux"), ["owned", [201, 202]], "pgid is a darwin rule only");
  assert.deepEqual(ownedExecution(base, table(leader), "darwin", [], null), { state: "unknown", rows: [], error: "ownership evidence unavailable: the provider module is not loaded" }, "F3: no adapter, unknown");
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
