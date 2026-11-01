#!/usr/bin/env node
// Shared-core check (S2.7). (1) The host-neutral modules pinned in docs/shared-core.md must still hash to their pins here.
// (2) When COUNCIL_CC_ROOT names a checkout of the twin (Council for Claude Code) that contains an implemented core and a
// pinned manifest of its own, the same modules are compared byte for byte; otherwise it prints `comparison deferred`.
// It never reports an equality it did not compute. Exit 1 on a local drift or a twin difference.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CORE = "plugins/council/scripts/lib/core";
const sha256 = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

/** The pinned rows of a shared-core.md: `| \`name.mjs\` | <sha256> | ...` under the "Host-neutral modules" heading. */
export function readPins(manifestFile) {
  if (!fs.existsSync(manifestFile)) return null;
  const text = fs.readFileSync(manifestFile, "utf8");
  const section = text.split(/^## /m).find((s) => s.startsWith("Host-neutral modules"));
  if (!section) return null;
  const pins = [...section.matchAll(/^\|\s*`([a-z-]+\.mjs)`\s*\|\s*([0-9a-f]{64})\s*\|/gm)].map((m) => ({ module: m[1], sha256: m[2] }));
  return pins.length ? pins : null;
}

export function check({ root = ROOT, twin = process.env.COUNCIL_CC_ROOT } = {}) {
  const lines = [];
  let failed = false;
  const pins = readPins(path.join(root, "docs", "shared-core.md"));
  if (!pins) return { code: 1, lines: ["no pinned host-neutral modules in docs/shared-core.md"] };
  const drift = pins.filter((p) => !fs.existsSync(path.join(root, CORE, p.module)) || sha256(path.join(root, CORE, p.module)) !== p.sha256);
  if (drift.length) { failed = true; lines.push(`local drift: ${drift.map((p) => p.module).join(", ")} no longer match their pins`); }
  else lines.push(`local pins: ${pins.length} host-neutral modules match docs/shared-core.md`);
  const twinPins = twin ? readPins(path.join(twin, "docs", "shared-core.md")) : null;
  const twinCore = twin ? path.join(twin, CORE) : null;
  if (!twin || !twinPins || !fs.existsSync(twinCore)) {
    lines.push("comparison deferred");
    return { code: failed ? 1 : 0, lines };
  }
  const compared = [], differing = [], absent = [];
  for (const { module } of pins) {
    const theirs = path.join(twinCore, module);
    if (!fs.existsSync(theirs) || !twinPins.some((p) => p.module === module)) { absent.push(module); continue; }
    compared.push(module);
    if (sha256(theirs) !== sha256(path.join(root, CORE, module))) differing.push(module);
  }
  if (differing.length) { failed = true; lines.push(`differs from the twin: ${differing.join(", ")}`); }
  if (compared.length - differing.length) lines.push(`identical with the twin: ${compared.filter((m) => !differing.includes(m)).join(", ")}`);
  if (absent.length) lines.push(`not pinned by the twin: ${absent.join(", ")}`);
  return { code: failed ? 1 : 0, lines };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { code, lines } = check();
  console.log(lines.join("\n"));
  process.exit(code);
}
