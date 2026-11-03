// Shared CLI paths and timing defaults; one source for planning and dispatch.
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
export const SCHEMA_PATH = path.join(PLUGIN_ROOT, "schemas", "review-output.schema.json");
/** The reply budget a thread uses until `--rounds` sets one; COUNCIL_CODEX_ROUNDS changes it (A3.5). */
export const DEFAULT_ROUNDS = 9;
/** Seconds without an event, and in total, before a turn is stopped (A3.3 timing defaults, from GROKX). */
export const INACTIVITY_S = 1200;
export const DEADLINE_S = 14400;
export const WAIT_S = 90;
export const CANCEL_S = 30;
