// Model catalog (S1.7): static plugins/council/models.json merged with a refreshed listing under <home>/catalog/, alias
// and effort resolution per A3.3. Identical rules for the static and the refreshed catalog.
import fs from "node:fs";
import path from "node:path";
import { UsageError } from "./args.mjs";
import { PLUGIN_ROOT } from "./tiers.mjs";

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
export const PROVIDERS = ["claude", "gemini", "grok"];
const rank = (e) => EFFORTS.indexOf(e);
const SUFFIX = /-(low|medium|high|xhigh|max)$/;

export function loadStatic(file = path.join(PLUGIN_ROOT, "models.json")) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
/** The per-model effort lists of a provider's catalog entry (families and suffixed ids for Gemini). */
function modelTable(entry) {
  if (entry.models) return { ...entry.models };
  const table = {};
  for (const [family, efforts] of Object.entries(entry.families ?? {})) {
    table[family] = [...efforts];
    for (const e of efforts) table[`${family}-${e}`] = [e];
  }
  return table;
}

/**
 * Parses a CLI model listing into {models: {id: efforts[]}}. Gemini: `agy models` lists effort-suffixed ids
 * (`gemini-4-argon-high<TAB>Gemini 4 Argon (High)`); each suffixed id maps to its one effort and the family to the
 * union; ids outside the `route` prefixes are ignored. Grok: `grok models` rows `* id (default)` / `- id`, each with
 * Grok's fixed effort set. Claude has no listing (`listing: false`): returns null.
 */
export function parseModelListing(provider, rawText, entry = loadStatic()[provider]) {
  if (provider === "claude" || entry?.listing === false) return null;
  const models = {};
  if (provider === "gemini") {
    const route = entry?.route ?? ["gemini-"];
    for (const line of String(rawText).split(/\r?\n/)) {
      const id = line.trim().split(/\s+/)[0];
      if (!id || !route.some((p) => id.startsWith(p))) continue;
      const m = SUFFIX.exec(id);
      if (!m) { models[id] ??= []; continue; }
      const family = id.slice(0, -m[0].length);
      models[id] = [m[1]];
      models[family] = [...new Set([...(models[family] ?? []), m[1]])].sort((a, b) => rank(a) - rank(b));
    }
    return { models };
  }
  if (provider === "grok") {
    const efforts = entry?.models ? Object.values(entry.models)[0] : ["low", "medium", "high", "xhigh"];
    for (const line of String(rawText).split(/\r?\n/)) {
      const m = /^\s*[-*]\s+(\S+)/.exec(line);
      if (m) models[m[1]] = [...efforts];
    }
    return { models };
  }
  throw new UsageError(`unknown provider ${provider}`);
}

export const catalogDir = (home) => path.join(home, "catalog");
/** The static entry merged with <home>/catalog/<provider>.json when present (refreshed lists replace the model table). */
export function loadCatalog(home, provider, statics = loadStatic()) {
  const entry = statics[provider];
  if (!entry) throw new UsageError(`unknown provider ${provider}`);
  const catalog = { provider, listing: entry.listing !== false, aliases: { ...(entry.aliases ?? {}) }, suffixed: !!entry.suffixed,
    route: entry.route ?? null, models: modelTable(entry), refreshedAt: null };
  const file = path.join(catalogDir(home), `${provider}.json`);
  if (fs.existsSync(file)) {
    const refreshed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (refreshed && typeof refreshed.models === "object") { catalog.models = { ...refreshed.models }; catalog.refreshedAt = refreshed.updatedAt ?? null; }
  }
  return catalog;
}

/** `--model` resolution: alias inside the provider's catalog, exact id, or pass-through (verified: false). */
export function resolveModel(provider, input, catalog) {
  if (input === undefined || input === null || input === "") throw new UsageError("a model is required");
  const alias = Object.hasOwn(catalog.aliases, input) ? input : null;
  const id = alias ? catalog.aliases[input] : input;
  if (provider === "claude" && id === "default") return { id: null, verified: true, alias: "default" };
  const known = Object.hasOwn(catalog.models, id);
  return { id, verified: known || alias !== null, alias };
}

/**
 * `--effort` resolution (A3.3): downward clamp against the model's own effort list, the lowest offered when the request
 * is below all; Gemini's suffixed id is an explicit effort (passed unchanged; a conflicting --effort exits 2); an unknown
 * model passes the request through unclamped; no request yields no effort.
 */
export function resolveEffort(provider, id, requested, catalog) {
  if (requested !== undefined && !EFFORTS.includes(requested)) throw new UsageError(`unknown effort ${requested}; use ${EFFORTS.join(", ")}`);
  if (id === null) return { effort: requested, requested, clamped: false }; // Claude `default`: the CLI's model, all five accepted
  const suffix = catalog.suffixed ? SUFFIX.exec(id)?.[1] : undefined;
  if (suffix) {
    if (requested !== undefined && requested !== suffix) throw new UsageError(`--model ${id} conflicts with --effort ${requested}`);
    return { effort: suffix, requested: requested ?? suffix, clamped: false, suffixed: true };
  }
  const offered = catalog.models[id];
  if (!offered || requested === undefined) return { effort: requested, requested, clamped: false };
  if (offered.includes(requested)) return { effort: requested, requested, clamped: false };
  const below = offered.filter((e) => rank(e) <= rank(requested)).sort((a, b) => rank(b) - rank(a));
  const effort = below[0] ?? [...offered].sort((a, b) => rank(a) - rank(b))[0];
  return { effort, requested, clamped: true };
}

/** Writes <home>/catalog/<provider>.json from the provider's listing probe; skipped (null) when the provider has no listing. */
export async function refreshCatalog(home, provider, probe, statics = loadStatic()) {
  const entry = statics[provider];
  if (!entry) throw new UsageError(`unknown provider ${provider}`);
  if (entry.listing === false) return null;
  const raw = await probe(provider);
  const parsed = parseModelListing(provider, raw, entry);
  if (!parsed || !Object.keys(parsed.models).length) throw new Error(`${provider} listing produced no models`);
  fs.mkdirSync(catalogDir(home), { recursive: true });
  const file = path.join(catalogDir(home), `${provider}.json`);
  const record = { updatedAt: new Date().toISOString(), models: parsed.models };
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(record, null, 2));
  fs.renameSync(`${file}.tmp`, file);
  return record;
}
