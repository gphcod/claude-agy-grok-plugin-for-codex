// S2.4: the provider-neutral preflight runner, its cache, the blocked path and the policy store.
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { PreflightBlocked, defaultPolicy, getPolicy, preflightKey, runDescriptor, runPreflight, setPolicy, startProbe } from "../plugins/council/scripts/lib/core/preflight.mjs";

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "council-preflight-")));
const script = (dir, name, body) => { const file = path.join(dir, name); fs.writeFileSync(file, body); return file; };
const launcherFor = (file) => ({ command: process.execPath, args: [file], path: file, kind: "node-script" });
const counter = (dir) => { const file = path.join(dir, "count"); return { file, count: () => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).length : 0) }; };

test("descriptors: dir, file, exec, listener and process-table report ok or a detail", async () => {
  const dir = tmp();
  assert.deepEqual(await runDescriptor({ kind: "dir", target: path.join(dir, "new"), access: "write" }), { ok: true });
  assert.ok(fs.existsSync(path.join(dir, "new")), "a write check creates the directory");
  assert.deepEqual(fs.readdirSync(path.join(dir, "new")), [], "and leaves no probe file behind");
  assert.match((await runDescriptor({ kind: "dir", target: path.join(dir, "missing"), access: "read" })).detail, /read access is missing \(ENOENT\)/);
  const file = script(dir, "f.txt", "x");
  assert.deepEqual(await runDescriptor({ kind: "file", target: file, access: "read" }), { ok: true });
  assert.match((await runDescriptor({ kind: "file", target: path.join(dir, "nope"), access: "read" })).detail, /ENOENT/);
  assert.match((await runDescriptor({ kind: "file", target: dir, access: "read" })).detail, /not a regular file/);
  const ok = await runDescriptor({ kind: "exec", target: { command: process.execPath, args: ["-e", "console.log('2.1.314')"], expectText: "2\\.1\\.314" } });
  assert.deepEqual([ok.ok, ok.status, ok.output.trim()], [true, 0, "2.1.314"]);
  assert.match((await runDescriptor({ kind: "exec", target: { command: process.execPath, args: ["-e", "process.exit(3)"] } })).detail, /probe exited 3/);
  assert.deepEqual((await runDescriptor({ kind: "exec", target: { command: process.execPath, args: ["-e", "console.error('Error: Append system prompt file not found: x'); process.exit(1)"], expectStatus: 1, expectText: "file not found" } })).ok, true, "a deliberate failure can be the expected outcome");
  assert.match((await runDescriptor({ kind: "exec", target: { command: path.join(dir, "no-such-binary"), args: [] } })).detail, /probe failed/);
  assert.deepEqual(await runDescriptor({ kind: "listener", target: "127.0.0.1" }), { ok: true });
  const table = await runDescriptor({ kind: "process-table", target: "ps" });
  assert.equal(table.ok, true, table.detail);
  assert.ok(table.rows > 0);
  assert.match((await runDescriptor({ kind: "bogus", target: "x" })).detail, /unknown descriptor kind/);
  const proxy = await runDescriptor({ kind: "network", target: "https://api.example.invalid" }, { env: { HTTPS_PROXY: "http://proxy" } });
  assert.deepEqual([proxy.ok, proxy.unverified], [true, "proxy transport is unverified without a live request"]);
  const server = net.createServer((socket) => socket.destroy());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const refused = await runDescriptor({ kind: "network", target: `http://127.0.0.1:${server.address().port}`, timeoutMs: 2000 }, { env: {} });
  server.close();
  assert.equal(refused.ok, false, "a connection that is torn down fails the network check");
});

test("startProbe bounds time and output and never rejects", async () => {
  const slow = await startProbe(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { timeoutMs: 300 });
  assert.match(slow.error, /timed out after 300 ms/);
  const big = await startProbe(process.execPath, ["-e", "process.stdout.write('x'.repeat(3_000_000))"], { timeoutMs: 5000 });
  assert.match(big.error, /exceeded the probe limit/);
  const missing = await startProbe(path.join(tmp(), "none"), []);
  assert.ok(missing.error);
  const fine = await startProbe(process.execPath, ["-e", "console.log('ok')"]);
  assert.deepEqual([fine.status, fine.stdout.trim(), fine.error], [0, "ok", null]);
});

test("cold preflight runs every probe and caches; a warm call probes nothing; a changed binary re-probes; --refresh forces it", async () => {
  const home = tmp();
  const { file, count } = counter(home);
  const bin = script(home, "fake-bin.mjs", "import fs from 'node:fs'; fs.appendFileSync(process.env.COUNT_FILE, 'probe\\n'); console.log('1.0.0');");
  const launcher = launcherFor(bin);
  const descriptors = [
    { kind: "dir", target: path.join(home, "state"), access: "write", why: "state root", action: "Set COUNCIL_CODEX_HOME." },
    { kind: "exec", target: { command: process.execPath, args: [bin, "--version"] }, why: "version probe", action: "Install the binary." },
    { kind: "exec", target: { command: process.execPath, args: [bin, "auth"] }, why: "login probe", action: "Log in." },
  ];
  const env = { ...process.env, COUNT_FILE: file };
  const cold = await runPreflight({ home, provider: "null", launcher, descriptors, env });
  assert.deepEqual([cold.cached, cold.probes, count()], [false, 2, 2]);
  assert.ok(fs.existsSync(path.join(home, "preflight", `null-${cold.key}.json`)));
  const warm = await runPreflight({ home, provider: "null", launcher, descriptors, env });
  assert.deepEqual([warm.cached, warm.probes, count()], [true, 0, 2], "a warm call spawns no probe");
  assert.ok(warm.results.filter((r) => r.kind === "exec").every((r) => r.cached));
  assert.equal(warm.results.find((r) => r.kind === "dir").cached, false, "cheap sandbox checks are re-run");
  const refreshed = await runPreflight({ home, provider: "null", launcher, descriptors, env, refresh: true });
  assert.deepEqual([refreshed.cached, count()], [false, 4]);
  fs.appendFileSync(bin, "\n// changed");
  const changed = await runPreflight({ home, provider: "null", launcher, descriptors, env });
  assert.deepEqual([changed.cached, count()], [false, 6], "a binary update re-probes");
  assert.notEqual(preflightKey(launcher, descriptors), cold.key);
  assert.equal(preflightKey(launcher, descriptors), preflightKey(launcher, descriptors.map((d) => ({ ...d, why: "other words", action: "other" }))), "prose does not change the key");
});

test("a blocked descriptor stops the run with preflight_blocked, the action line and zero later probes", async () => {
  const home = tmp();
  const { file, count } = counter(home);
  const bin = script(home, "bin.mjs", "import fs from 'node:fs'; fs.appendFileSync(process.env.COUNT_FILE, 'probe\\n');");
  const descriptors = [
    { kind: "file", target: path.join(home, "login.json"), access: "read", why: "the login file", action: "Grant read access to the login file; the host sandbox blocks it." },
    { kind: "exec", target: { command: process.execPath, args: [bin] }, why: "version probe", action: "Install." },
  ];
  await assert.rejects(runPreflight({ home, provider: "null", launcher: launcherFor(bin), descriptors, env: { ...process.env, COUNT_FILE: file } }), (e) => {
    assert.ok(e instanceof PreflightBlocked);
    assert.match(e.message, /^preflight_blocked: the login file \(file .*login\.json\): read access is missing \(ENOENT\)$/);
    assert.equal(e.action, "Grant read access to the login file; the host sandbox blocks it.");
    return true;
  });
  assert.equal(count(), 0, "the probe after the blocked descriptor never ran");
  assert.ok(!fs.existsSync(path.join(home, "preflight")), "nothing is cached on a blocked run");
  const bad = new PreflightBlocked({ kind: "listener", target: "127.0.0.1", why: "agy needs a loopback listener" }, "bind failed (EPERM)");
  assert.equal(bad.action, "Grant access to the named resource; if the host forbids escalation, stop without retrying.");
});

test("the policy store: defaults, validation, realpath read roots and a version hash", () => {
  const home = tmp();
  assert.deepEqual(getPolicy(home), defaultPolicy());
  const root = tmp();
  const policy = setPolicy(home, { readRoots: [root], web: true });
  assert.deepEqual([policy.readRoots, policy.web, policy.allowMcp], [[fs.realpathSync(root)], true, false]);
  assert.match(policy.version, /^[0-9a-f]{16}$/);
  assert.deepEqual(getPolicy(home), policy);
  assert.throws(() => setPolicy(home, { web: "yes" }), /web must be boolean/);
  assert.throws(() => setPolicy(home, { readRoots: ["relative"] }), /absolute/);
  assert.throws(() => setPolicy(home, { hooks: true }), /unknown fields: hooks/);
  assert.throws(() => setPolicy(home, []), /must be a JSON object/);
  assert.notEqual(setPolicy(home, { allowMcp: true }).version, policy.version);
});

test("an exec descriptor with recordOutput false keeps the probe output out of the result and the cache (core fix for S3.1)", async () => {
  const dir = tmp();
  const file = script(dir, "auth.mjs", "console.log(JSON.stringify({ loggedIn: true, email: 'someone@example.com' }));");
  const descriptor = { kind: "exec", target: { command: process.execPath, args: [file], expectText: '"loggedIn":\\s*true', recordOutput: false }, why: "auth" };
  const direct = await runDescriptor(descriptor);
  assert.deepEqual(direct, { ok: true, status: 0 });
  const home = path.join(dir, "state");
  await runPreflight({ home, provider: "x", launcher: launcherFor(file), descriptors: [descriptor] });
  const cached = fs.readdirSync(path.join(home, "preflight")).map((f) => fs.readFileSync(path.join(home, "preflight", f), "utf8")).join("");
  assert.ok(!cached.includes("someone@example.com"), "the account line is never persisted");
  const shown = await runDescriptor({ ...descriptor, target: { ...descriptor.target, recordOutput: true } });
  assert.match(shown.output, /someone@example\.com/, "the default still records output");
});
