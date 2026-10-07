/**
 * The audit's own copy of the counts, one small file per transcript group under
 * `~/.agentguard/audit-cache-v1/`, the way seatledger keeps its own (PROD-1A):
 *
 * 1. Speed: a group whose files are unchanged (same size and mtime) is not read again for checks
 *    it already answered.
 * 2. History: Claude Code deletes transcripts older than `cleanupPeriodDays` (30 by default). The
 *    counts already taken from a deleted transcript stay here, so a 30- or 90-day audit keeps its
 *    history. Delete the directory to forget it.
 *
 * Only what `GroupAudit` holds is written — session ids, times, line numbers, hashed call ids and
 * per-check counts — plus SHA-256 hashes of the repository and transcript paths. Never a command,
 * a path, a prompt or anything else a transcript says.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  AuditClient,
  CheckBreak,
  CheckOutcome,
  GroupAudit,
} from "@agentwares/agentguard-core";
import type { TranscriptGroup } from "./sources.js";

export const CACHE_DIR = "audit-cache-v1";
/** Bump when the readers or the checks change what they count: every entry is then re-read. */
export const ENGINE = "1";

export const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

type WireBreak = [
  at: number,
  session: string,
  step: string,
  file: number,
  line: number,
  what: 0 | 1 | 2,
  index: number,
  asked: 0 | 1 | 2,
  refused: 0 | 1,
];

interface Wire {
  v: 1;
  engine: string;
  repo: string;
  group: string;
  client: AuditClient;
  files: [src: string, size: number, mtimeMs: number][];
  sessions: [id: string, client: AuditClient, start: number, end: number, turnsKnown: 0 | 1][];
  unread: number;
  checks: Record<string, { a: string[]; b: WireBreak[] }>;
}

export interface CacheEntry {
  repo: string;
  group: string;
  client: AuditClient;
  files: [string, number, number][];
  audit: GroupAudit;
}

const WHAT = ["command", "path", "call"] as const;

function encodeBreak(b: CheckBreak): WireBreak {
  return [
    b.at,
    b.session,
    b.step,
    b.file,
    b.line,
    WHAT.indexOf(b.what) as 0 | 1 | 2,
    b.index,
    b.asked === null ? 2 : b.asked ? 1 : 0,
    b.refused ? 1 : 0,
  ];
}

function decodeBreak(w: WireBreak): CheckBreak {
  return {
    at: w[0],
    session: w[1],
    step: w[2],
    file: w[3],
    line: w[4],
    what: WHAT[w[5]] ?? "call",
    index: w[6],
    asked: w[7] === 2 ? null : w[7] === 1,
    refused: w[8] === 1,
  };
}

export function fileSignature(group: TranscriptGroup): [string, number, number][] {
  return group.files.map((f) => [sha(f.path), f.size, Math.round(f.mtimeMs)]);
}

export class AuditCache {
  private readonly dir: string;
  private readonly entries = new Map<string, CacheEntry>();

  constructor(
    home: string,
    private readonly repo: string,
    private readonly enabled = true,
  ) {
    this.dir = join(home, CACHE_DIR);
    if (!enabled) return;
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      try {
        const w = JSON.parse(readFileSync(join(this.dir, name), "utf8")) as Wire;
        if (w.v !== 1 || w.engine !== ENGINE || w.repo !== repo) continue;
        this.entries.set(w.group, {
          repo: w.repo,
          group: w.group,
          client: w.client,
          files: w.files,
          audit: {
            sessions: w.sessions.map(([id, client, start, end, known]) => ({
              id,
              client,
              start,
              end,
              turnsKnown: known === 1,
            })),
            unread: w.unread,
            checks: Object.fromEntries(
              Object.entries(w.checks).map(([k, c]): [string, CheckOutcome] => [
                k,
                { applicable: c.a, breaks: c.b.map(decodeBreak) },
              ]),
            ),
          },
        });
      } catch {
        // a partial write from an interrupted run: re-read from the transcript
      }
    }
  }

  groupKey(group: TranscriptGroup): string {
    return sha(`${this.repo}\u0000${group.key}`);
  }

  /** The cached counts for a group, if its files are unchanged and every check is answered. */
  lookup(group: TranscriptGroup, keys: readonly string[]): GroupAudit | undefined {
    const hit = this.entries.get(this.groupKey(group));
    if (!hit) return undefined;
    if (JSON.stringify(hit.files) !== JSON.stringify(fileSignature(group))) return undefined;
    if (!keys.every((k) => hit.audit.checks[k])) return undefined;
    return hit.audit;
  }

  /** Counts kept from groups whose transcripts are gone (deleted by the client's cleanup). */
  retained(present: ReadonlySet<string>, client: AuditClient): GroupAudit[] {
    const out: GroupAudit[] = [];
    for (const e of this.entries.values())
      if (e.client === client && !present.has(e.group)) out.push(e.audit);
    return out;
  }

  /** Best effort: a cache that cannot be written only costs speed and history. */
  store(group: TranscriptGroup, audit: GroupAudit): void {
    const key = this.groupKey(group);
    const files = fileSignature(group);
    const prev = this.entries.get(key);
    // checks this run did not ask for stay valid while the files are unchanged
    const checks =
      prev && JSON.stringify(prev.files) === JSON.stringify(files)
        ? { ...prev.audit.checks, ...audit.checks }
        : audit.checks;
    const merged: GroupAudit = { ...audit, checks };
    this.entries.set(key, {
      repo: this.repo,
      group: key,
      client: group.client,
      files,
      audit: merged,
    });
    if (!this.enabled) return;
    const wire: Wire = {
      v: 1,
      engine: ENGINE,
      repo: this.repo,
      group: key,
      client: group.client,
      files,
      sessions: merged.sessions.map((s) => [s.id, s.client, s.start, s.end, s.turnsKnown ? 1 : 0]),
      unread: merged.unread,
      checks: Object.fromEntries(
        Object.entries(merged.checks).map(([k, c]) => [
          k,
          { a: c.applicable, b: c.breaks.map(encodeBreak) },
        ]),
      ),
    };
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const file = join(this.dir, `${key.slice(0, 32)}.json`);
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(wire), { mode: 0o600 });
      renameSync(tmp, file);
    } catch {
      // read-only home, full disk: the next run reads the transcripts again
    }
  }
}
