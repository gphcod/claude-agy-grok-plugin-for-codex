// S1.7: catalog and tier resolution against the recorded listings (docs/spike/*-models.txt) and the static models.json.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { parseModelListing, loadCatalog, resolveModel, resolveEffort, refreshCatalog, loadStatic } from "../plugins/council/scripts/lib/core/catalog.mjs";
import { resolveTier, loadTiers } from "../plugins/council/scripts/lib/core/tiers.mjs";
import { UsageError } from "../plugins/council/scripts/lib/core/args.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const spike = (f) => fs.readFileSync(path.join(ROOT, "docs", "spike", f), "utf8");
const home = () => fs.mkdtempSync(path.join(os.tmpdir(), "council-catalog-"));
const cat = (p, h = home()) => loadCatalog(h, p);
const resolve = (p, model, effort, catalog = cat(p)) => { const m = resolveModel(p, model, catalog); return { ...m, ...resolveEffort(p, m.id, effort, catalog) }; };

test("the recorded listings parse: Gemini suffixed ids and families, Grok plain ids, Claude none", () => {
  const gemini = parseModelListing("gemini", spike("agy-models.txt")).models;
  assert.deepEqual(gemini["gemini-4-argon"], ["low", "medium", "high"]);
  assert.deepEqual(gemini["gemini-4-argon-high"], ["high"]);
  assert.deepEqual(gemini["gemini-3.8-flash"], ["low", "medium", "high"]);
  assert.ok(!("claude-opus-5-5-low" in gemini) && !("gpt-oss-120b-medium" in gemini), "only gemini- ids are routed");
  const grok = parseModelListing("grok", spike("grok-models.txt")).models;
  assert.deepEqual(Object.keys(grok), ["grok-4.7", "grok-4.7-build-fast", "grok-4.6", "grok-4.5"]);
  assert.deepEqual(grok["grok-4.6"], ["low", "medium", "high", "xhigh"]);
  assert.equal(parseModelListing("claude", "anything"), null);
});

test("Gemini: clamp, suffix conflict, suffixed id alone, family verified, alias", () => {
  assert.deepEqual(resolve("gemini", "gemini-4-argon", "xhigh"), { id: "gemini-4-argon", verified: true, alias: null, effort: "high", requested: "xhigh", clamped: true });
  assert.throws(() => resolve("gemini", "gemini-4-argon-high", "medium"), UsageError);
  const alone = resolve("gemini", "gemini-4-argon-high");
  assert.deepEqual([alone.id, alone.effort, alone.clamped, alone.verified], ["gemini-4-argon-high", "high", false, true]);
  assert.equal(resolve("gemini", "gemini-4-argon-high", "high").effort, "high", "a matching --effort is no conflict");
  assert.deepEqual(resolve("gemini", "argon", "high"), { id: "gemini-4-argon", verified: true, alias: "argon", effort: "high", requested: "high", clamped: false });
  assert.equal(resolve("gemini", "flash", "max").effort, "high");
  assert.deepEqual(resolve("gemini", "gemini-9-unknown", "xhigh"), { id: "gemini-9-unknown", verified: false, alias: null, effort: "xhigh", requested: "xhigh", clamped: false });
});

test("Grok: max clamps to xhigh, low stays low, aliases, unknown id passes through", () => {
  assert.deepEqual(resolve("grok", "grok-4.7", "max"), { id: "grok-4.7", verified: true, alias: null, effort: "xhigh", requested: "max", clamped: true });
  assert.equal(resolve("grok", "grok-4.7", "low").effort, "low");
  assert.deepEqual(resolve("grok", "build-fast", "xhigh"), { id: "grok-4.7-build-fast", verified: true, alias: "build-fast", effort: "xhigh", requested: "xhigh", clamped: false });
  assert.equal(resolve("grok", "4.6", "high").id, "grok-4.6");
  assert.deepEqual(resolve("grok", "grok-9", "max"), { id: "grok-9", verified: false, alias: null, effort: "max", requested: "max", clamped: false });
});

test("Claude: default means no --model flag, all five efforts, unknown id unverified, sonnet at low", () => {
  assert.deepEqual(resolve("claude", "default", "high"), { id: null, verified: true, alias: "default", effort: "high", requested: "high", clamped: false });
  assert.deepEqual(resolve("claude", "default", "max"), { id: null, verified: true, alias: "default", effort: "max", requested: "max", clamped: false });
  assert.equal(resolve("claude", "opus", "max").clamped, false);
  assert.deepEqual(resolve("claude", "gpt-6.1-sol", "high"), { id: "gpt-6.1-sol", verified: false, alias: null, effort: "high", requested: "high", clamped: false });
  assert.deepEqual(resolve("claude", "sonnet", "low"), { id: "sonnet", verified: true, alias: "sonnet", effort: "low", requested: "low", clamped: false });
  assert.equal(resolve("claude", "claude-sonnet-5-5", "xhigh").verified, true);
  assert.throws(() => resolve("claude", "sonnet", "ultra"), /unknown effort ultra/);
});

test("the lower-bound rule: a request below every offered effort takes the lowest offered", () => {
  const catalog = { ...cat("grok"), models: { "grok-x": ["medium", "high"] } };
  assert.deepEqual(resolveEffort("grok", "grok-x", "low", catalog), { effort: "medium", requested: "low", clamped: true });
  assert.deepEqual(resolveEffort("grok", "grok-x", "max", catalog), { effort: "high", requested: "max", clamped: true });
  assert.deepEqual(resolveEffort("grok", "grok-x", undefined, catalog), { effort: undefined, requested: undefined, clamped: false });
});

test("refresh honours the state root, skips Claude, and the refreshed list wins over the static one", async () => {
  const h = home();
  const probe = async (p) => (p === "grok" ? "You are logged in.\n\nAvailable models:\n  * grok-5 (default)\n  - grok-4.7\n" : spike("agy-models.txt"));
  const record = await refreshCatalog(h, "grok", probe);
  assert.ok(fs.existsSync(path.join(h, "catalog", "grok.json")));
  assert.deepEqual(Object.keys(record.models), ["grok-5", "grok-4.7"]);
  const refreshed = loadCatalog(h, "grok");
  assert.equal(refreshed.refreshedAt, record.updatedAt);
  assert.equal(resolve("grok", "grok-5", "xhigh", refreshed).verified, true);
  assert.equal(resolve("grok", "grok-4.6", "xhigh", refreshed).verified, false, "a refreshed listing replaces the static model table");
  assert.equal(resolve("grok", "build-fast", "high", refreshed).id, "grok-4.7-build-fast", "aliases survive a refresh");
  assert.equal(await refreshCatalog(h, "claude", probe), null);
  assert.ok(!fs.existsSync(path.join(h, "catalog", "claude.json")));
  const gemini = await refreshCatalog(h, "gemini", probe);
  assert.deepEqual(gemini.models["gemini-3.8-flash"], ["low", "medium", "high"]);
  await assert.rejects(() => refreshCatalog(h, "grok", async () => "nothing here"), /produced no models/);
});

test("tiers come from tiers.json exactly as A2 states, and explicit model or effort wins", () => {
  const tiers = loadTiers();
  assert.deepEqual(tiers.claude, { consult: { model: "default", effort: "high" }, exec: { model: "sonnet", effort: "high" }, deep: { model: "default", effort: "xhigh" } });
  assert.deepEqual(tiers.grok, { consult: { model: "grok-4.7", effort: "high" }, exec: { model: "grok-4.7-build-fast", effort: "xhigh" }, deep: { model: "grok-4.7", effort: "xhigh" } });
  assert.deepEqual(tiers.gemini.consult, tiers.gemini.deep, "Gemini has no effort above high, so consult and deep coincide");
  assert.deepEqual(resolveTier("grok", "exec"), { tier: "exec", model: "grok-4.7-build-fast", effort: "xhigh", explicit: { model: false, effort: false } });
  assert.deepEqual(resolveTier("claude", "consult", { effort: "low" }), { tier: "consult", model: "default", effort: "low", explicit: { model: false, effort: true } });
  assert.deepEqual(resolveTier("gemini", undefined, { model: "flash" }), { tier: null, model: "flash", effort: undefined, explicit: { model: true, effort: false } });
  assert.throws(() => resolveTier("grok", "ultra"), UsageError);
  assert.throws(() => resolveTier("codex", "consult"), UsageError);
  for (const [provider, table] of Object.entries(tiers)) for (const { model, effort } of Object.values(table)) {
    const r = resolve(provider, model, effort);
    assert.equal(r.verified, true, `${provider} tier model ${model} is in the catalog`);
    assert.equal(r.clamped, false, `${provider} tier effort ${effort} needs no clamp`);
  }
  assert.deepEqual(Object.keys(loadStatic()).filter((k) => !k.startsWith("_")), ["claude", "gemini", "grok"]);
});
