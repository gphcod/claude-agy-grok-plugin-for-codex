// Tiers (A2): family and effort stored separately in plugins/council/tiers.json. Shared with the twin by design.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { UsageError } from "./args.mjs";

export const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const TIERS = ["consult", "exec", "deep"];
let cached = null;
export function loadTiers(file = path.join(PLUGIN_ROOT, "tiers.json")) {
  if (!cached || cached.file !== file) cached = { file, tiers: JSON.parse(fs.readFileSync(file, "utf8")) };
  return cached.tiers;
}
/**
 * The model and effort a tier names for a provider, with explicit `--model`/`--effort` overrides winning (A3.3).
 * `tier` undefined means no tier: only the overrides apply, and a missing model or effort stays undefined.
 */
export function resolveTier(provider, tier, overrides = {}, tiers = loadTiers()) {
  const table = tiers[provider];
  if (!table) throw new UsageError(`unknown provider ${provider}`);
  if (tier !== undefined && !TIERS.includes(tier)) throw new UsageError(`unknown tier ${tier}; use consult, exec or deep`);
  const base = tier ? table[tier] : {};
  return { tier: tier ?? null, model: overrides.model ?? base.model, effort: overrides.effort ?? base.effort,
    explicit: { model: overrides.model !== undefined, effort: overrides.effort !== undefined } };
}
