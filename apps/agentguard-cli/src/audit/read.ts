/**
 * Stream a transcript group through agentguard-core's readers. Transcripts run to hundreds of
 * megabytes and most of every line is text the audit never needs, so a substring test decides
 * which lines are parsed at all. Nothing read here is written anywhere: the readers' steps and
 * turns stay in memory, and only `evaluateChecks`' counts reach the cache.
 */
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import {
  ClaudeCodeAuditReader,
  CodexAuditReader,
  stableHash,
  type AuditReaderOptions,
  type AuditStep,
  type TranscriptAudit,
} from "@agentwares/agentguard-core";
import type { TranscriptGroup } from "./sources.js";

const CLAUDE_WANTED = (raw: string): boolean =>
  raw.includes('"type":"assistant"') || raw.includes('"type":"user"');
const CODEX_WANTED = (raw: string): boolean =>
  raw.includes('"session_meta"') ||
  raw.includes('"turn_context"') ||
  raw.includes('"function_call"') ||
  raw.includes('"local_shell_call"') ||
  raw.includes('"custom_tool_call"');

/**
 * Each line of a file, 1-based. `onLine` returns false to stop early. Lines that are not JSON
 * (a transcript being written ends mid-line) are skipped.
 */
async function eachLine(
  path: string,
  wanted: (raw: string, line: number) => boolean,
  onLine: (value: unknown, line: number) => boolean | void,
): Promise<void> {
  const stream = createReadStream(path, { encoding: "utf8", highWaterMark: 1 << 20 });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let n = 0;
  try {
    for await (const raw of lines) {
      n += 1;
      if (raw.length === 0 || !wanted(raw, n)) continue;
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch {
        continue;
      }
      if (onLine(value, n) === false) break;
    }
  } finally {
    lines.close();
    stream.destroy();
  }
}

/** Every step and turn in a group that happened in the repository. */
export async function readGroup(
  group: TranscriptGroup,
  opts: AuditReaderOptions,
): Promise<TranscriptAudit> {
  if (group.client === "codex") {
    const reader = new CodexAuditReader(opts);
    await eachLine(group.files[0]!.path, CODEX_WANTED, (value, line) => {
      reader.add(value, line, 0);
      return reader.relevant;
    });
    return reader.result();
  }
  const reader = new ClaudeCodeAuditReader(opts);
  for (const [i, file] of group.files.entries())
    await eachLine(file.path, CLAUDE_WANTED, (value, line) => reader.add(value, line, i));
  return reader.result();
}

/**
 * The steps behind a few breaks, for the evidence on screen: only the lines that hold them are
 * parsed (and, for Codex, the lines that say where the rollout ran).
 */
export async function fetchSteps(
  group: TranscriptGroup,
  wanted: readonly { file: number; line: number; step: string }[],
  opts: AuditReaderOptions,
): Promise<Map<string, AuditStep>> {
  const out = new Map<string, AuditStep>();
  const byFile = new Map<number, Set<number>>();
  for (const w of wanted) {
    const set = byFile.get(w.file) ?? new Set<number>();
    set.add(w.line);
    byFile.set(w.file, set);
  }
  for (const [fileIndex, lines] of byFile) {
    const file = group.files[fileIndex];
    if (!file) continue;
    const last = Math.max(...lines);
    const reader =
      group.client === "codex" ? new CodexAuditReader(opts) : new ClaudeCodeAuditReader(opts);
    await eachLine(
      file.path,
      (raw, n) =>
        lines.has(n) ||
        (group.client === "codex" &&
          (raw.includes('"session_meta"') || raw.includes('"turn_context"'))),
      (value, n) => {
        reader.add(value, n, fileIndex);
        return n < last;
      },
    );
    for (const step of reader.result().steps) out.set(stableHash(step.id), step);
  }
  return out;
}
