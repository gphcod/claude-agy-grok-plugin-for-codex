// S4.1: the Grok adapter skeleton: the A5 interface, launcher, ownership by the --prompt-file operand, the non-billable
// probe (version, `grok models` through parseModels, tier warnings), and the preflight descriptors; through `setup` and
// `models --refresh` against tests/fixtures/fake-grok.mjs.
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { makeWorld, ROOT } from "./helpers.mjs";
import grok from "../plugins/council/scripts/lib/providers/grok.mjs";
import { assertAdapter } from "../plugins/council/scripts/lib/core/types.mjs";
import { hasFlagOperand, ownsExecution, ownedExecution } from "../plugins/council/scripts/lib/core/execution.mjs";

const FAKE = path.join(ROOT, "tests", "fixtures", "fake-grok.mjs");
function world() {
  const w = makeWorld({ git: false });
  fs.mkdirSync(path.join(w.dir, ".grok"), { recursive: true });
  fs.writeFileSync(path.join(w.dir, ".grok", "auth.json"), "{}", { mode: 0o600 });
  w.env.COUNCIL_GROK_BIN = FAKE;
  delete w.env.COUNCIL_TEST_NULL_ADAPTER;
  w.grok = (args, opts = {}) => w.call(args, { ...opts, env: opts.env ?? {} });
  w.launches = () => w.fakeCalls().filter((c) => !c.mismatch && !c.probe);
  return w;
}

test("the module implements the frozen A5 interface", () => {
  assert.equal(assertAdapter(grok, "grok"), grok);
  assert.equal(grok.binEnv, "COUNCIL_GROK_BIN");
  assert.equal(grok.trustsCleanExit({ kind: "native" }), false);
  assert.equal(grok.trustsCleanExit({ kind: "shim-native" }), false);
  assert.equal(grok.maxLineBytes, 1024 * 1024);
  assert.deepEqual(Object.keys(grok.catalog.models), ["grok-4.7", "grok-4.7-build-fast", "grok-4.6", "grok-4.5"]);
});

test("preflight descriptors: login file from the per-call HOME, state root, process table, then the probes", () => {
  const env = { HOME: "/home/someone", COUNCIL_GROK_BIN: FAKE };
  const d = grok.preflight({ stateRoot: "/state", env, platform: "darwin", verb: "ask", cwd: "/w" });
  assert.deepEqual(d.map((x) => [x.kind, x.access ?? null]), [["file", "read"], ["dir", "write"], ["process-table", null], ["exec", null], ["exec", null]]);
  assert.equal(d[0].target, "/home/someone/.grok/auth.json");
  assert.equal(d[1].target, "/state");
  assert.deepEqual(d[3].target.args.slice(-1), ["--version"]);
  assert.deepEqual(d[4].target.args.slice(-1), ["models"]);
  assert.ok(new RegExp(d[4].target.expectText).test("You are logged in with grok.com.\n"));
  assert.equal(new RegExp(d[4].target.expectText).test("You are not logged in.\n"), false);
  assert.deepEqual(grok.preflight({ stateRoot: "/state", env: { ...env, GROK_API_KEY: "k" }, platform: "darwin" }).map((x) => x.kind), ["dir", "process-table", "exec", "exec"]);
  assert.equal(grok.preflight({ stateRoot: "C:\\s", env: { USERPROFILE: "C:\\Users\\u", COUNCIL_GROK_BIN: FAKE }, platform: "win32" })[0].target, path.join("C:\\Users\\u", ".grok", "auth.json"));
});

test("probe and setup: version, login, models through parseModels; a tier model missing from `grok models` is a warning", async () => {
  const w = world();
  const launcher = grok.resolveLauncher(w.env);
  const probe = await grok.probe(launcher, w.env);
  assert.deepEqual([probe.version, probe.loggedIn, probe.models.map((m) => m.id), probe.warnings], ["grok 1.0.70 (f50904eaee6c) [stable]", true, ["grok-4.7", "grok-4.7-build-fast", "grok-4.6", "grok-4.5"], []]);
  const out = await grok.probe(launcher, { ...w.env, COUNCIL_FAKE_LOGGED_OUT: "1" });
  assert.deepEqual([out.loggedIn, out.models], [false, null]);
  assert.match(out.warnings[0], /Grok is not logged in/);
  const short = path.join(w.dir, "short-grok.mjs");
  fs.writeFileSync(short, `if (process.argv[2] === "models") console.log("You are logged in with grok.com.\\n  - grok-4.7\\n  * grok-4.6 (default)"); else console.log("grok 1.0.70");\n`);
  const missing = await grok.probe(grok.resolveLauncher({ ...w.env, COUNCIL_GROK_BIN: short }), w.env);
  assert.deepEqual(missing.warnings, ["tier exec: model grok-4.7-build-fast is not in `grok models`"]);
  const setup = w.grok(["setup", "--to", "grok"]);
  assert.equal(setup.status, 0, setup.stderr);
  assert.match(setup.stdout, /^grok: .*fake-grok\.mjs \(node-script\) · grok 1\.0\.70 \(f50904eaee6c\) \[stable\] · logged in · tiers consult=grok-4\.7\/high exec=grok-4\.7-build-fast\/xhigh deep=grok-4\.7\/xhigh · preflight ok\n$/);
  const warned = w.grok(["setup", "--to", "grok"], { env: { COUNCIL_GROK_BIN: short } });
  assert.match(warned.stdout, /\n {2}warning: tier exec: model grok-4\.7-build-fast is not in `grok models`\n/);
  assert.equal(w.launches().length, 0, "setup submits nothing");
});

test("models --refresh --to grok re-reads the listing into the catalog", () => {
  const w = world();
  const r = w.grok(["models", "--to", "grok", "--refresh"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^grok \(refreshed [^)]+\)\n {2}grok-4\.7: low, medium, high, xhigh\n/);
  assert.ok(fs.existsSync(path.join(w.home, "catalog", "grok.json")));
});

test("ownership: the exact --prompt-file operand; two jobs with the same model and effort never cross-match", () => {
  const mk = (id) => {
    const promptFile = `/state/jobs/${id}/prompt.md`;
    const childArgs = ["--prompt-file", promptFile, "--output-format", "streaming-json", "--model", "grok-4.7", "--effort", "low", "--no-auto-update", "--agent", "explore", "--session-id", "00000001-0000-4000-8000-00000000000" + id.at(-1)];
    return { id, dir: `/state/jobs/${id}`, pid: 0, promptFile, childArgs, argv: ["/Users/u/.grok/bin/grok", ...childArgs] };
  };
  const a = mk("aaaaaaaaaaaaaaa1"), b = mk("aaaaaaaaaaaaaaa2");
  const rowA = { pid: 11, ppid: 1, stamp: "1", argv: a.argv, raw: a.argv.join(" ") }, rowB = { pid: 12, ppid: 1, stamp: "1", argv: b.argv, raw: b.argv.join(" ") };
  for (const platform of ["linux", "win32"]) {
    assert.deepEqual([grok.ownsProcess(rowA, a, platform, hasFlagOperand), grok.ownsProcess(rowB, a, platform, hasFlagOperand)], [true, false], platform);
    assert.deepEqual([grok.ownsProcess(rowB, b, platform, hasFlagOperand), grok.ownsProcess(rowA, b, platform, hasFlagOperand)], [true, false], platform);
  }
  const raw = (row) => ({ ...row, argv: null });
  assert.deepEqual([ownsExecution(raw(rowA), a, "darwin", grok), ownsExecution(raw(rowB), a, "darwin", grok)], [true, false]);
  assert.deepEqual([ownsExecution(raw(rowB), b, "darwin", grok), ownsExecution(raw(rowA), b, "darwin", grok)], [true, false]);
  const snap = { state: "ok", rows: [rowA, rowB] };
  assert.deepEqual(ownedExecution(a, snap, "linux", [], grok).rows.map((r) => r.pid), [11]);
  assert.deepEqual(ownedExecution(b, snap, "linux", [], grok).rows.map((r) => r.pid), [12]);
  assert.equal(grok.ownsProcess({ argv: ["grok", "--rules", a.promptFile] }, a, "linux", hasFlagOperand), false);
  assert.equal(grok.ownsProcess(rowA, { childArgs: a.childArgs }, "linux", hasFlagOperand), true, "the operand is read from the recorded argv when promptFile is absent");
});

test("probe warns about several grok executables on PATH only when COUNCIL_GROK_BIN does not choose one", { skip: process.platform === "win32" }, async () => {
  const w = world();
  const bins = [path.join(w.dir, "a"), path.join(w.dir, "b")];
  for (const dir of bins) {
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "grok"), `#!${process.execPath}\nimport(${JSON.stringify(FAKE)});\n`, { mode: 0o755 });
  }
  const env = { ...w.env, PATH: bins.join(path.delimiter) };
  delete env.COUNCIL_GROK_BIN;
  const launcher = grok.resolveLauncher(env, "darwin");
  assert.equal(launcher.path, path.join(bins[0], "grok"));
  const probe = await grok.probe(launcher, env, "darwin");
  assert.deepEqual(probe.warnings, [`2 grok executables on PATH; the first one runs (${path.join(bins[0], "grok")})`]);
  assert.deepEqual((await grok.probe(grok.resolveLauncher(w.env), w.env, "darwin")).warnings, []);
});
