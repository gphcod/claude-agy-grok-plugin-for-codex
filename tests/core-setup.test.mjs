// S2.4/S2.6: setup and models through the entry: the preflight runner and its cache, the catalog and its refresh, the
// policy store, and setup --live counted as one submission per available provider.
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { makeWorld, built, BINARY } from "./helpers.mjs";
import { runDescriptor } from "../plugins/council/scripts/lib/core/preflight.mjs";

test("setup reports each provider: the unavailable three by binary, the null adapter by binary, kind, version, login, tiers and preflight", () => {
  const w = makeWorld({ git: false });
  const r = w.call(["setup"], { env: { PATH: "" } });
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split("\n");
  const heads = lines.filter((l) => !l.startsWith("  "));
  assert.deepEqual(heads.slice(0, 3).map((l) => l.split(":")[0]), ["claude", "gemini", "grok"]);
  for (const [i, provider] of ["claude", "gemini", "grok"].entries()) {
    // A provider this build ships is loaded and reports its missing binary; one it lacks is named by binary only.
    if (built(provider)) assert.match(heads[i], new RegExp(`^${provider}: not found · tiers consult=\\S+ exec=\\S+ deep=\\S+ · preflight not run$`));
    else assert.equal(heads[i], `${provider}: ${BINARY[provider][0]} not found · provider not available in this build`);
  }
  assert.match(heads[3], /^null: .*fake-child\.mjs \(node-script\) · null 0\.0\.1 · logged in · tiers consult=null-model\/high exec=null-fast\/high deep=null-model\/xhigh · preflight ok$/);
  assert.deepEqual(w.probes().map((p) => p.probe), ["version", "models", "version"], "setup's own version and listing probes, then the cold preflight probe");
  const warm = w.call(["setup", "--to", "null"]);
  assert.match(warm.stdout, /preflight ok \(cached\)\n$/);
  assert.equal(w.probes().length, 5, "a warm setup still probes version and listing (setup always looks fresh) but the preflight cache answers");
  const json = JSON.parse(w.call(["setup", "--to", "null", "--json"]).stdout);
  assert.deepEqual([json[0].provider, json[0].available, json[0].kind, json[0].version, json[0].loggedIn], ["null", true, "node-script", "null 0.0.1", true]);
  assert.deepEqual(json[0].tiers, { consult: { model: "null-model", effort: "high" }, exec: { model: "null-fast", effort: "high" }, deep: { model: "null-model", effort: "xhigh" } });
  assert.equal(w.fakeCalls().length, 0, "setup submits nothing");
});

test("setup lists the Gemini trade-off and a blocked resource with its action line, and exits 0", () => {
  const w = makeWorld({ git: false });
  const blocked = path.join(w.dir, "login.json");
  const r = w.call(["setup", "--to", "null"], { env: { COUNCIL_NULL_PREFLIGHT_BLOCK: blocked } });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /· preflight preflight_blocked: read access is missing \(ENOENT\)\n  warning: preflight_blocked: null login file .*\n  action: Grant read access to .*login\.json; the host sandbox blocks it\.\n$/);
  const unknown = w.call(["setup", "--to", "openai"]);
  assert.equal(unknown.status, 2);
});

test("setup --set stores a validated policy under the state root; a bad policy exits 1 or 2 and stores nothing", () => {
  const w = makeWorld({ git: false });
  const file = path.join(w.dir, "policy.json");
  fs.writeFileSync(file, JSON.stringify({ readRoots: [w.dir], web: true }));
  const r = w.call(["setup", "--to", "null", "--set", file]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^policy [0-9a-f]{16} stored: read roots 1, web true, MCP false\n/);
  const stored = JSON.parse(fs.readFileSync(path.join(w.home, "policy.json"), "utf8"));
  assert.deepEqual([stored.readRoots, stored.web, stored.allowMcp], [[fs.realpathSync(w.dir)], true, false]);
  fs.writeFileSync(file, JSON.stringify({ hooks: true }));
  assert.equal(w.call(["setup", "--set", file]).status, 1, "an unknown policy field is refused");
  assert.equal(w.call(["setup", "--set", path.join(w.dir, "missing.json")]).status, 2);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(w.home, "policy.json"), "utf8")).readRoots, stored.readRoots, "the stored policy is unchanged");
});

test("setup --live makes exactly one minimal submission per available provider and reports its result", () => {
  const w = makeWorld({ git: false });
  const r = w.call(["setup", "--to", "null", "--live"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /fake answer to: Reply with exactly PASS\.\ncouncil null ok · job [a-z0-9]{16} · null-model\/high/);
  assert.equal(w.fakeCalls().length, 1);
});

test("setup --live --json emits one JSON document containing the report and live result", () => {
  const w = makeWorld({ git: false });
  const result = w.call(["setup", "--to", "null", "--live", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.length, 1);
  assert.equal(report[0].provider, "null");
  assert.equal(report[0].live.exit, 0);
  assert.equal(report[0].live.provider, "null");
  assert.equal(w.fakeCalls().length, 1);
});

test("model refresh and live setup continue when only a subset of provider CLIs is installed", () => {
  const w = makeWorld({ git: false });
  const refreshed = w.call(["models", "--refresh", "--json"]);
  assert.equal(refreshed.status, 0, refreshed.stderr);
  assert.equal(JSON.parse(refreshed.stdout).find((entry) => entry.provider === "null").refreshedAt !== null, true);
  const live = w.call(["setup", "--live", "--json"]);
  assert.equal(live.status, 0, live.stderr);
  const report = JSON.parse(live.stdout);
  assert.equal(report.find((entry) => entry.provider === "null").live.exit, 0);
  for (const entry of report.filter((item) => item.provider !== "null")) assert.equal(entry.live.status, "skipped");
  assert.equal(w.fakeCalls().length, 1);
});

test("models prints the static catalog, says which providers this build lacks, and --refresh writes the listing under the state root", () => {
  const w = makeWorld({ git: false });
  const r = w.call(["models"]);
  assert.equal(r.status, 0, r.stderr);
  if (built("claude")) assert.match(r.stdout, /^claude \(static catalog\)\n/);
  else assert.match(r.stdout, /^claude: provider not available in this build · static catalog: default, fable, opus, sonnet, haiku, claude-opus-5-5, claude-sonnet-5-5\n/);
  if (built("gemini")) assert.match(r.stdout, /\ngemini \(static catalog\)\n  gemini-4-argon: low, medium, high\n/);
  else assert.match(r.stdout, /\ngemini: provider not available in this build · static catalog: gemini-4-argon, gemini-3\.8-flash\n/);
  assert.match(r.stdout, /\nnull \(static catalog\)\n  null-model: low, medium, high, xhigh\n  null-fast: low, medium, high\n  aliases: fast=null-fast\n$/);
  assert.equal(w.probes().length, 0, "models reads static and cached data only");
  const refreshed = w.call(["models", "--to", "null", "--refresh"]);
  assert.match(refreshed.stdout, /^null \(refreshed \d{4}-\d\d-\d\dT[^)]+\)\n/);
  assert.ok(fs.existsSync(path.join(w.home, "catalog", "null.json")));
  assert.deepEqual(w.probes().map((p) => p.probe), ["version", "models"], "the refresh runs the adapter's non-billable probe");
  const json = JSON.parse(w.call(["models", "--to", "null", "--json"]).stdout);
  assert.ok(json[0].refreshedAt);
  assert.deepEqual(json[0].models.map((m) => m.id), ["null-model", "null-fast"]);
  assert.equal(w.call(["models", "--to", "nope"]).status, 2);
});

test("the refreshed catalog drives resolution: a model the listing no longer carries is unverified", () => {
  const w = makeWorld();
  fs.mkdirSync(path.join(w.home, "catalog"), { recursive: true });
  fs.writeFileSync(path.join(w.home, "catalog", "null.json"), JSON.stringify({ updatedAt: "2026-10-31T00:00:00.000Z", models: { "null-model": ["low", "high"] } }));
  const fast = w.call(["ask", "--to", "null", "--model", "fast", "--", "q"]);
  assert.match(fast.stdout.trim().split("\n").at(-1), /null-fast\/high · .* · model unverified$/, "the alias resolves, but its target left the listing");
  const clamped = w.call(["ask", "--to", "null", "--effort", "xhigh", "--", "q"]);
  assert.match(clamped.stdout.trim().split("\n").at(-1), /null-model\/high<=xhigh/, "the refreshed effort list clamps");
});

test("network and listener descriptors: a reachable endpoint passes, an unbindable listener address is blocked", async () => {
  const server = http.createServer((req, res) => { res.writeHead(401); res.end(); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const ok = await runDescriptor({ kind: "network", target: `http://127.0.0.1:${server.address().port}/v1`, timeoutMs: 3000 }, { env: {} });
    assert.deepEqual([ok.ok, ok.status], [true, 401], "an unauthenticated HTTP answer proves transport");
  } finally { server.close(); }
  const bad = await runDescriptor({ kind: "listener", target: "203.0.113.1", timeoutMs: 2000 });
  assert.equal(bad.ok, false);
  assert.match(bad.detail, /loopback listener bind (failed|timed out)/);
  const any = await runDescriptor({ kind: "exec", target: { command: process.execPath, args: ["-e", "process.exit(4)"], expectStatus: null } });
  assert.equal(any.ok, true, "expectStatus null accepts any exit");
});
