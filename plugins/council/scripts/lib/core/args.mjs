// Argument parsing, ported from grok_plugin_for_codex 1.1.0 lib/args.mjs `parseArgv` (S2.2). Options are matched by
// arity, never by guessing: a value option takes the next token (or an inline =value), a boolean takes none, a
// repeatable option collects every occurrence, anything else that starts with a dash is an error. Free text is never
// re-tokenized. No `splitLeading`: Codex has no slash commands (S2 mapping table).
export const VERBS = ["ask", "reply", "review", "task", "wait", "cancel", "models", "setup"];
export const TURN_VERBS = ["ask", "reply", "review", "task"];
export const CONTROL_VERBS = ["wait", "cancel", "models", "setup"];
export const SPEC = {
  value: ["to", "tier", "model", "effort", "thread", "base", "commit", "timeout", "inactivity-timeout", "deadline", "rounds", "prompt-file",
    "request-id", "cwd", "max-turns", "max-budget-usd", "set"],
  bool: ["last", "json", "web", "next-input", "uncommitted", "adversarial", "refresh", "live", "confirm-ended", "help"],
  repeat: ["allow-command"],
};
export const USAGE = "usage: council.mjs <ask|reply|review|task|wait|cancel|models|setup> [--to claude|gemini|grok] [--options] [-- text, or text on stdin]";

/** Invalid input: exit 2. */
export class UsageError extends Error {}

function option(token, spec, next) {
  const [key, inline] = token.slice(2).split(/=(.*)/s, 2);
  if (spec.bool.includes(key)) return { key, value: inline === undefined ? true : inline !== "false", used: 0 };
  if (spec.value.includes(key) || spec.repeat.includes(key)) {
    const value = inline ?? next();
    if (value === undefined) throw new UsageError(`Missing value for ${token}`);
    return { key, value, used: inline === undefined ? 1 : 0, repeat: spec.repeat.includes(key) };
  }
  throw new UsageError(`Unknown option ${token}. Put -- before the text if it starts with a dash.`);
}

/** `--options` anywhere before `--`; every other token, and everything after `--`, is a positional. */
export function parseOptions(argv, spec = SPEC) {
  const options = {};
  const positionals = [];
  let hasDashDash = false, leading = 0;
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] === "-h" && spec.bool.includes("help") ? "--help" : argv[i];
    if (token === "--") { hasDashDash = true; leading = positionals.length; positionals.push(...argv.slice(i + 1)); break; }
    if (!token.startsWith("--")) {
      if (token.startsWith("-") && token !== "-") throw new UsageError(`Unknown option ${token}. Put -- before the text if it starts with a dash.`);
      positionals.push(token); continue;
    }
    const found = option(token, spec, () => argv[i + 1]);
    if (found.repeat) options[found.key] = [...(options[found.key] ?? []), found.value];
    else options[found.key] = found.value;
    i += found.used;
  }
  return { options, positionals, hasDashDash, leading: hasDashDash ? leading : positionals.length };
}

/**
 * The whole command line: the verb, its options, the positionals that are text, and whether `--` was present.
 * `reply <job|thread> …`: a first positional names the thread unless --thread or --last does; `wait <job>` and
 * `cancel <job>`: a single positional names the job.
 */
export function parseArgv(argv, spec = SPEC) {
  const [verb, ...rest] = argv;
  if (verb === "--help" || verb === "-h") return { verb: "help", options: { help: true }, positionals: [], hasDashDash: false };
  if (!VERBS.includes(verb)) throw new UsageError(verb === undefined ? USAGE : `unknown verb ${JSON.stringify(verb)}. ${USAGE}`);
  const parsed = parseOptions(rest, spec);
  const { options, positionals } = parsed;
  // `reply k3f9 text`, `reply k3f9 -- text`, `reply --json k3f9 -- text`: a positional before any `--` names the thread,
  // wherever the flags stand; text after `--` stays text.
  if (verb === "reply" && !options.thread && !options.last && parsed.leading > 0) options.thread = positionals.shift();
  if ((verb === "wait" || verb === "cancel") && positionals.length) {
    if (positionals.length > 1) throw new UsageError(`${verb} accepts one job or thread id`);
    options.job = positionals.shift();
  }
  const { leading, ...shape } = parsed;
  return { verb, ...shape, options, positionals };
}

/** Positive integer option. */
export function positiveInt(value, name) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw new UsageError(`${name} needs a positive integer`);
  return n;
}
/** Seconds within the timer range, or the fallback when the option is absent. */
export function seconds(value, fallback, name) {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(n) || n <= 0 || n * 1000 > 2147483647) throw new UsageError(`--${name} needs a finite positive number of seconds within the timer range`);
  return n;
}
