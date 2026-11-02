// Catalog/setup commands share the normal admission path for --live through an injected callback.
import path from "node:path";
import { UsageError } from "../core/args.mjs";
import { readJson } from "../core/fs.mjs";
import { BINARIES, PROVIDERS, guardedEnv } from "../core/host.mjs";
import { PreflightBlocked, runPreflight, setPolicy } from "../core/preflight.mjs";
import { LauncherError, resolveLauncher } from "../core/launcher.mjs";
import { loadStatic, saveRefreshedCatalog } from "../core/catalog.mjs";
import { TEST_ADAPTER, knownProvider, loadAdapter, catalogFor, tiersFor, checkFlags } from "./plan.mjs";
const writer = (stream) => (text) => stream.write(text);

export function createCatalogCommands({ runTurnVerb, requireWritableRoot }) {
const providerList = (o, env) => (o.to ? [o.to] : [...PROVIDERS, ...(env.COUNCIL_TEST_NULL_ADAPTER === "1" ? [TEST_ADAPTER] : [])]);

/** models [--to p] [--refresh]: the catalog; --refresh re-runs the provider's listing (Claude has none). */
async function modelsVerb(ctx, { options: o }, io) {
  checkFlags("models", o);
  const out = writer(io.stdout), report = [];
  for (const provider of providerList(o, ctx.env)) if (!knownProvider(provider, ctx.env)) throw new UsageError(`unknown provider ${JSON.stringify(provider)}`);
  if (o.refresh) await requireWritableRoot(ctx); // the refreshed catalog is written there; probe nothing first
  for (const provider of providerList(o, ctx.env)) {
    if (!knownProvider(provider, ctx.env)) throw new UsageError(`unknown provider ${JSON.stringify(provider)}`);
    const adapter = await loadAdapter(provider, ctx.env);
    if (!adapter) {
      const statics = loadStatic()[provider];
      report.push({ provider, available: false, models: statics ? Object.keys(statics.models ?? statics.families ?? {}) : [], aliases: statics?.aliases ?? {} });
      continue;
    }
    let refreshed = null, warning = null;
    if (o.refresh && adapter.catalog?.listing !== false) {
      try {
        const launcher = adapter.resolveLauncher(ctx.env);
        if (!launcher) throw new LauncherError(`${provider} CLI is not installed; keeping the saved or static catalog`);
        const probe = await adapter.probe(launcher, guardedEnv(ctx.env)); // a probe is a provider child too (A5.1)
        if (probe?.models) refreshed = saveRefreshedCatalog(ctx.home, provider, probe.models).updatedAt;
        else warning = `${provider} returned no model listing; keeping the saved or static catalog`;
      } catch (error) { warning = error.message; }
    }
    const catalog = catalogFor(adapter, ctx.home);
    report.push({ provider, available: true, refreshedAt: catalog.refreshedAt ?? refreshed, models: Object.entries(catalog.models).map(([id, efforts]) => ({ id, efforts })), aliases: catalog.aliases,
      ...(warning ? { warning } : {}) });
  }
  if (o.json) out(`${JSON.stringify(report)}\n`);
  else for (const r of report) {
    if (!r.available) { out(`${r.provider}: provider not available in this build · static catalog: ${r.models.join(", ") || "none"}\n`); continue; }
    out(`${r.provider}${r.refreshedAt ? ` (refreshed ${r.refreshedAt})` : " (static catalog)"}\n${r.models.map((m) => `  ${m.id}: ${m.efforts.join(", ") || "-"}`).join("\n")}\n`);
    if (Object.keys(r.aliases).length) out(`  aliases: ${Object.entries(r.aliases).map(([a, id]) => `${a}=${id}`).join(", ")}\n`);
    if (r.warning) out(`  warning: ${r.warning}\n`);
  }
  return 0;
}

/** setup [--to p] [--live] [--set policy.json]: binary, login, version, catalog age, tiers, launcher kind, preflight, trade-offs. */
async function setupVerb(ctx, parsed, io, deps) {
  const { options: o } = parsed;
  checkFlags("setup", o);
  const out = writer(io.stdout), report = [];
  if (o.set !== undefined) {
    const supplied = readJson(path.resolve(ctx.cwd, o.set)) ?? (() => { throw new UsageError(`cannot read policy file ${o.set}`); })();
    await requireWritableRoot(ctx); // policy.json lives there
    const policy = setPolicy(ctx.home, supplied);
    out(o.json ? "" : `policy ${policy.version} stored: read roots ${policy.readRoots.length}, web ${policy.web}, MCP ${policy.allowMcp}\n`);
  }
  for (const provider of providerList(o, ctx.env)) {
    if (!knownProvider(provider, ctx.env)) throw new UsageError(`unknown provider ${JSON.stringify(provider)}`);
    const adapter = await loadAdapter(provider, ctx.env);
    if (!adapter) {
      const { name, env: binEnv } = BINARIES[provider] ?? { name: provider, env: null };
      let binary = null;
      try { binary = resolveLauncher({ name, binEnv, env: ctx.env, nativeOnly: provider === "claude" })?.path ?? null; } catch { binary = null; }
      report.push({ provider, available: false, binary, name });
      continue;
    }
    const entry = { provider, available: true, binary: null, kind: null, version: null, loggedIn: null, tiers: tiersFor(adapter)[provider], preflight: null, warnings: [] };
    try {
      const launcher = adapter.resolveLauncher(ctx.env);
      if (!launcher) throw new LauncherError(`${provider} not found: install its CLI or set ${adapter.binEnv}`);
      Object.assign(entry, { binary: launcher.path, kind: launcher.kind });
      const probe = await adapter.probe(launcher, guardedEnv(ctx.env)); // a probe is a provider child too (A5.1)
      Object.assign(entry, { version: probe?.version ?? null, loggedIn: probe?.loggedIn ?? null });
      entry.warnings.push(...(Array.isArray(probe?.warnings) ? probe.warnings : []));
      const pre = await runPreflight({ home: ctx.home, provider, launcher, descriptors: adapter.preflight({ stateRoot: ctx.home, env: ctx.env, platform: deps.platform ?? process.platform, verb: "setup", cwd: ctx.cwd }),
        env: ctx.env, platform: deps.platform ?? process.platform });
      entry.preflight = pre.cached ? "ok (cached)" : "ok";
    } catch (error) {
      entry.preflight = error instanceof PreflightBlocked ? `preflight_blocked: ${error.detail}` : null;
      entry.warnings.push(error.message);
      if (error instanceof PreflightBlocked) entry.action = error.action;
    }
    if (provider === "gemini") entry.warnings.push("Gemini read-only turns can search the web; --web is not offered for Gemini");
    report.push(entry);
  }
  if (o.json) { if (!o.live) out(`${JSON.stringify(report)}\n`); }
  else for (const r of report) {
    if (!r.available) { out(`${r.provider}: ${r.name} ${r.binary ?? "not found"} · provider not available in this build\n`); continue; }
    out(`${r.provider}: ${r.binary ?? "not found"}${r.kind ? ` (${r.kind})` : ""}${r.version ? ` · ${r.version}` : ""}${r.loggedIn === null ? "" : r.loggedIn ? " · logged in" : " · not logged in"}`
      + `${r.tiers ? ` · tiers ${Object.entries(r.tiers).map(([t, v]) => `${t}=${v.model}/${v.effort}`).join(" ")}` : ""} · preflight ${r.preflight ?? "not run"}\n`);
    for (const w of r.warnings) out(`  warning: ${w}\n`);
    if (r.action) out(`  action: ${r.action}\n`);
  }
  if (o.live) {
    let code = 0, attempted = 0;
    const combineExit = (a, b) => [a, b].find((value) => value !== 0 && value !== 10) ?? (a || b);
    for (const r of report.filter((x) => x.available)) {
      if (!r.binary || !r.preflight?.startsWith("ok")) {
        r.live = { provider: r.provider, status: "skipped", exit: 1, error: "provider is not ready; see setup warnings" };
        if (o.to) code = combineExit(code, 1);
        continue;
      }
      attempted += 1;
      const live = { verb: "ask", options: { to: r.provider, tier: "consult", ...(o.json ? { json: true } : {}) }, positionals: [], hasDashDash: true };
      let captured = "";
      const liveIo = o.json ? { ...io, stdout: { write: (text) => { captured += text; return true; } } } : io;
      try {
        code = combineExit(code, await runTurnVerb(ctx, live, "Reply with exactly PASS.", liveIo, deps));
        if (o.json) r.live = JSON.parse(captured);
      } catch (error) {
        const exit = error instanceof UsageError ? 2 : 1;
        r.live = { provider: r.provider, status: error instanceof PreflightBlocked ? "preflight_blocked" : "failed", exit, error: error.message,
          ...(error instanceof PreflightBlocked ? { action: error.action } : {}) };
        if (!o.json) out(`${r.provider}: live check failed: ${error.message}\n`);
        code = combineExit(code, exit);
      }
    }
    if (!attempted) code = combineExit(code, 1);
    if (o.json) out(`${JSON.stringify(report)}\n`);
    return code;
  }
  return 0;
}


return { models: modelsVerb, setup: setupVerb };
}
