/**
 * Read the end of a coding agent's transcript and find the latest turn a person typed. Long
 * sessions write tens of megabytes; the latest human turn is almost always near the end, so read
 * the last 1 MB first and widen only when it holds none.
 */
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { scanTranscript, type HumanTurn, type TranscriptScan } from "@agentwares/agentguard-core";

const STEPS = [1 << 20, 8 << 20, 64 << 20];

export interface TranscriptEvidence {
  turn?: HumanTurn;
  /** why there is no turn */
  missing?: string;
  scan?: TranscriptScan;
}

function readTail(path: string, bytes: number, size: number): string {
  const length = Math.min(bytes, size);
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, size - length);
    return buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

export function humanTurnFromTranscript(
  path: string | undefined,
  opts: { requireOrigin?: boolean } = {},
): TranscriptEvidence {
  if (!path) return { missing: "the hook input carried no transcript_path" };
  if (!existsSync(path)) return { missing: `no transcript at ${path}` };
  let size: number;
  try {
    size = statSync(path).size;
  } catch (err) {
    return {
      missing: `transcript unreadable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  let scan: TranscriptScan | undefined;
  for (const step of STEPS) {
    try {
      scan = scanTranscript(readTail(path, step, size), opts);
    } catch (err) {
      return {
        missing: `transcript unreadable: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (scan.turn || step >= size) break;
  }
  if (scan?.turn) return { turn: scan.turn, scan };
  return {
    missing:
      size > STEPS[STEPS.length - 1]! ? "none in the last 64 MB of the transcript" : undefined,
    scan,
  };
}
