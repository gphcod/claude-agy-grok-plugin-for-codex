// Text input (S2.2): ported from grok_plugin_for_codex 1.1.0 grok.mjs `readStdin`/`readText` with the no-focus rule of
// claude_plugin_for_codex 0.5.0 claude-companion.mjs:233. Text comes from exactly one place: stdin, --prompt-file (UTF-8,
// BOM dropped) or the positionals after `--`. A bare `review`, a `--next-input` reply and every control verb read no
// stdin and do not wait for it (A3.1).
import fs from "node:fs";
import { UsageError, CONTROL_VERBS } from "./args.mjs";

/** Seconds stdin may stay open without a byte or its end before a call stops reading it. */
export const STDIN_IDLE_S = 10;
export const STDIN_DEADLINE_ENV = "COUNCIL_STDIN_DEADLINE_MS";
/** The request byte cap (A3.1: 8 MiB). */
export const REQUEST_BYTES = 8 * 1024 * 1024;

/**
 * Reads stdin to its end; a terminal gives none. A caller can leave a pipe open and silent (a Bash tool holding a heredoc
 * elsewhere in the command), so reading stops after `idleMs` without a byte or the end: with nothing read it resolves
 * null, and after part of an input it is a usage error. Over the byte cap it is refused.
 */
export function readStdin(stream = process.stdin, idleMs = STDIN_IDLE_S * 1000, cap = REQUEST_BYTES) {
  if (stream.isTTY) return Promise.resolve("");
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0, timer = null;
    const finish = (settle, value) => {
      clearTimeout(timer);
      stream.off("data", onData).off("end", onEnd).off("error", onError);
      settle(value);
    };
    const destroy = () => { stream.on("error", () => {}).destroy(); };
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        destroy(); // An open handle would keep the process alive after main().
        if (chunks.length) finish(reject, new UsageError(`stdin sent nothing for ${idleMs / 1000} s before its end; close it after the input`));
        else finish(resolve, null);
      }, idleMs);
    };
    const onData = (chunk) => {
      bytes += chunk.length;
      if (bytes > cap) { destroy(); return finish(reject, new UsageError(`stdin exceeds the request byte limit of ${cap} bytes; pass paths instead of contents`)); }
      chunks.push(chunk); arm();
    };
    const onEnd = () => finish(resolve, Buffer.concat(chunks).toString("utf8"));
    const onError = (error) => finish(reject, error);
    stream.on("data", onData).on("end", onEnd).on("error", onError);
    arm();
  });
}

/** Whether this call reads no stdin at all: control verbs, and a bare review or `--next-input` with no text source. */
export function skipsStdin({ verb, options, positionals, hasDashDash }) {
  if (CONTROL_VERBS.includes(verb) || verb === "help") return true;
  return (verb === "review" || Boolean(options["next-input"])) && options["prompt-file"] === undefined && !positionals.length && !hasDashDash;
}

/** The turn's text from exactly one source. `env` carries the stdin deadline override; `stream` is stdin. */
export async function readText(parsed, { stream = process.stdin, env = process.env } = {}) {
  const { verb, options, positionals } = parsed;
  const file = options["prompt-file"];
  if (skipsStdin(parsed)) {
    if (options["next-input"] && (file !== undefined || positionals.length)) throw new UsageError("--next-input accepts no text: it sends the next saved review batch");
    return "";
  }
  const idleMs = env[STDIN_DEADLINE_ENV] ? Number(env[STDIN_DEADLINE_ENV]) : STDIN_IDLE_S * 1000;
  const raw = await readStdin(stream, idleMs);
  // A pipe left open with nothing sent is no input when arguments or a file carry the text, and refused otherwise.
  if (raw === null && file === undefined && !positionals.length) {
    throw new UsageError(`stdin stayed open for ${idleMs / 1000} s with no input; close it after the input, or pipe nothing (</dev/null, or $null | in PowerShell) when there is none`);
  }
  const stdin = (raw ?? "").replace(/\r?\n$/, "");
  if ([stdin.trim(), file !== undefined, positionals.length].filter(Boolean).length > 1) throw new UsageError("give the text on stdin, in --prompt-file or as arguments, not more than one");
  let text;
  if (file !== undefined) {
    const bytes = fs.readFileSync(file);
    if (bytes.length > REQUEST_BYTES) throw new UsageError(`--prompt-file exceeds the request byte limit of ${REQUEST_BYTES} bytes`);
    text = bytes.toString("utf8").replace(/^﻿/, "");
  } else text = positionals.length ? positionals.join(" ") : stdin;
  if (options["next-input"] && text.trim()) throw new UsageError("--next-input accepts no text: it sends the next saved review batch");
  if (TEXT_REQUIRED.has(verb) && !options["next-input"] && !text.trim()) throw new UsageError(`${verb} needs text on stdin, in --prompt-file or after --`);
  return text;
}
const TEXT_REQUIRED = new Set(["ask", "reply", "task"]);
