/**
 * Which transcript entry did a person write? The human-turn gate lets an irreversible command
 * run only on a recent turn that a human typed. Models have been seen writing a fake
 * "user: yes, push it" into their own reply and then acting on it; that text sits inside an
 * assistant entry, so it never counts here.
 *
 * Claude Code writes one JSON object per line to the session's `transcript_path` (verified on
 * 7 October 2026 against the hooks reference and local transcripts from Claude Code 2.1.170 to
 * 2.1.286). An entry counts as written by the person only when all of these hold:
 *
 * - `type` is `"user"` and `message.role` is `"user"`;
 * - `isSidechain` is not true (a subagent's transcript: its "user" turns are the parent model's
 *   prompt);
 * - `isMeta` is not true (text the harness injects: skill bodies, reminders, peer messages);
 * - `isCompactSummary` and `isVisibleInTranscriptOnly` are not true (compaction summaries);
 * - no `toolUseResult` and no `tool_result` content block (tool output rides in user entries);
 * - `origin.kind` is `"human"` when an `origin` is present (other kinds seen: `task-notification`,
 *   `peer`, `coordinator`); otherwise `turnOrigin` is `"human"` when present (`peer`,
 *   `task_notification`, `sdk` are not);
 * - with neither label (older versions, queued prompts), the text does not start with a
 *   harness wrapper such as `<command-name>`, `<local-command-stdout>`, `<task-notification>`,
 *   `<bash-input>` or `[Request interrupted`. `require_origin: true` refuses these entries.
 *
 * Web-standard: the caller reads the file and passes the text.
 */

export interface HumanTurn {
  /** ISO timestamp of the entry */
  at: string;
  /** the text the person typed (text blocks joined) */
  text: string;
  uuid?: string;
  /** why this entry counts */
  why: string;
  /** the last assistant text before it, for "yes" answering a question */
  assistantBefore?: string;
}

export interface EntryVerdict {
  genuine: boolean;
  why: string;
}

export interface TranscriptOptions {
  /** refuse entries that carry neither `origin` nor `turnOrigin` */
  requireOrigin?: boolean;
}

export interface TranscriptScan {
  turn?: HumanTurn;
  /** lines read */
  entries: number;
  /** lines that were not JSON (a partial first line of a tail read, a torn write) */
  unreadable: number;
  /** user-role entries passed over, by reason */
  rejected: Record<string, number>;
}

const HARNESS_WRAPPERS = [
  "<command-name>",
  "<command-message>",
  "<command-args>",
  "<local-command-stdout>",
  "<local-command-stderr>",
  "<local-command-caveat>",
  "<task-notification>",
  "<bash-input>",
  "<bash-stdout>",
  "<bash-stderr>",
  "<user-prompt-submit-hook>",
  "<teammate-message",
  "<cross-session",
  "[Request interrupted",
  "Caveat: The messages below were generated",
];

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

function kindOf(label: unknown): string | undefined {
  if (typeof label === "string") return label;
  if (isObject(label) && typeof label.kind === "string") return label.kind;
  return undefined;
}

/** Text blocks of a message, joined. Images and documents contribute nothing. */
export function entryText(entry: unknown): string {
  if (!isObject(entry)) return "";
  const message = entry.message;
  if (!isObject(message)) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is Json => isObject(b) && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n");
}

/** Did a person type this entry? */
export function classifyTranscriptEntry(
  entry: unknown,
  opts: TranscriptOptions = {},
): EntryVerdict {
  if (!isObject(entry)) return { genuine: false, why: "not an object" };
  const message = entry.message;
  if (entry.type !== "user" || !isObject(message) || message.role !== "user")
    return { genuine: false, why: "not a user entry" };
  if (entry.isSidechain === true)
    return { genuine: false, why: "sidechain (a subagent's prompt, written by the parent model)" };
  if (entry.isMeta === true) return { genuine: false, why: "meta (injected by the harness)" };
  if (entry.isCompactSummary === true || entry.isVisibleInTranscriptOnly === true)
    return { genuine: false, why: "compaction summary" };
  const content = message.content;
  if (
    entry.toolUseResult !== undefined ||
    (Array.isArray(content) && content.some((b) => isObject(b) && b.type === "tool_result"))
  )
    return { genuine: false, why: "tool result" };
  if (typeof entry.timestamp !== "string" || Number.isNaN(Date.parse(entry.timestamp)))
    return { genuine: false, why: "no timestamp" };

  const origin = kindOf(entry.origin);
  if (origin !== undefined) {
    if (origin === "human") return { genuine: true, why: "origin.kind: human" };
    return { genuine: false, why: `origin.kind: ${origin}` };
  }
  const turnOrigin = kindOf(entry.turnOrigin);
  if (turnOrigin !== undefined) {
    if (turnOrigin === "human") return { genuine: true, why: "turnOrigin: human" };
    return { genuine: false, why: `turnOrigin: ${turnOrigin}` };
  }
  if (opts.requireOrigin) return { genuine: false, why: "no origin label (require_origin)" };
  const text = entryText(entry).trimStart();
  const wrapper = HARNESS_WRAPPERS.find((w) => text.startsWith(w));
  if (wrapper) return { genuine: false, why: `harness wrapper ${wrapper}` };
  if (text === "" && !(Array.isArray(content) && content.length > 0))
    return { genuine: false, why: "empty" };
  return { genuine: true, why: "user entry with no origin label (older Claude Code)" };
}

function isAssistantText(entry: unknown): string | undefined {
  if (!isObject(entry) || entry.type !== "assistant" || entry.isSidechain === true)
    return undefined;
  const text = entryText(entry);
  return text.trim() ? text : undefined;
}

/**
 * The latest entry a person wrote, scanning from the end of a JSONL transcript (or the tail of
 * one: a partial first line is skipped as unreadable).
 */
export function scanTranscript(jsonl: string, opts: TranscriptOptions = {}): TranscriptScan {
  const lines = jsonl.split("\n");
  const scan: TranscriptScan = { entries: 0, unreadable: 0, rejected: {} };
  let found: { entry: Json; why: string } | undefined;
  let assistantBefore: string | undefined;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!.trim();
    if (!line) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      scan.unreadable += 1;
      continue;
    }
    scan.entries += 1;
    if (!isObject(entry)) continue;
    if (found) {
      assistantBefore = isAssistantText(entry);
      if (assistantBefore !== undefined) break;
      // a question only counts when it is what the person was answering
      if (classifyTranscriptEntry(entry, opts).genuine) break;
      continue;
    }
    const verdict = classifyTranscriptEntry(entry, opts);
    if (verdict.genuine) {
      found = { entry, why: verdict.why };
      continue;
    }
    if (entry.type === "user") scan.rejected[verdict.why] = (scan.rejected[verdict.why] ?? 0) + 1;
  }
  if (found) {
    const e = found.entry;
    scan.turn = {
      at: e.timestamp as string,
      text: entryText(e),
      uuid: typeof e.uuid === "string" ? e.uuid : undefined,
      why: found.why,
      assistantBefore,
    };
  }
  return scan;
}

const AFFIRMATIVE =
  /^(y|yes|yep|yeah|yup|ok|okay|k|sure|go|go ahead|go for it|do it|please do|proceed|approved?|confirm(ed)?|lgtm|sounds good|ship it|yes please|please|correct|right|absolutely|definitely|of course)\b/;

/** A short reply that says yes and nothing else of substance. */
export function isAffirmative(text: string): boolean {
  const t = text
    .trim()
    .toLowerCase()
    .replace(/[.!,]+$/g, "")
    .trim();
  if (!t || t.length > 60) return false;
  return AFFIRMATIVE.test(t);
}

function mentionRegExp(word: string): RegExp | undefined {
  // ASCII words match on word boundaries; anything else (커밋, プッシュ) as a substring
  if (!/^[\x20-\x7e]+$/.test(word)) return undefined;
  const escaped = word
    .trim()
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\s+/g, "\\s+");
  return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`, "i");
}

/** The first of `words` that `text` names, if any. */
export function findMention(text: string, words: readonly string[]): string | undefined {
  for (const word of words) {
    const re = mentionRegExp(word);
    if (re ? re.test(text) : text.includes(word)) return word;
  }
  return undefined;
}

/** Sentences of `text` that ask something: end with `?`. */
function questions(text: string): string[] {
  return text
    .split(/(?<=[?])|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.endsWith("?"));
}

export interface GateInput {
  turn?: HumanTurn;
  /** why there is no turn, when there is none (unreadable transcript, unsupported client) */
  missing?: string;
  now: Date;
  /** when this session's previous irreversible action ran */
  lastIrreversibleAt?: string;
  windowS: number;
  requireMention: boolean;
  /** words that name the action; one must appear */
  mentions: readonly string[];
}

export interface GateVerdict {
  ok: boolean;
  reason: string;
  /** the word the human turn named the action with */
  named?: string;
}

function hhmmss(iso: string): string {
  return iso.slice(11, 19) || iso;
}

/**
 * The human-turn gate for one irreversible action: the latest genuine user entry must come after
 * the session's previous irreversible action, be at most `windowS` old, and (with
 * `requireMention`) name the action — or answer yes to an assistant question that names it.
 */
export function evaluateHumanTurn(input: GateInput): GateVerdict {
  const { turn } = input;
  if (!turn)
    return {
      ok: false,
      reason: `no message typed by a person in the transcript${input.missing ? ` (${input.missing})` : ""}`,
    };
  const at = Date.parse(turn.at);
  if (input.lastIrreversibleAt && at <= Date.parse(input.lastIrreversibleAt)) {
    return {
      ok: false,
      reason: `the latest message typed by a person (${hhmmss(turn.at)}) came before this session's previous irreversible action (${hhmmss(input.lastIrreversibleAt)}); one human turn authorizes one irreversible action`,
    };
  }
  const ageS = Math.max(0, (input.now.getTime() - at) / 1000);
  if (ageS > input.windowS) {
    return {
      ok: false,
      reason: `the latest message typed by a person is ${Math.round(ageS / 60)} min old; the window is ${Math.round(input.windowS / 60)} min`,
    };
  }
  if (!input.requireMention)
    return { ok: true, reason: `a person wrote the latest turn at ${hhmmss(turn.at)}` };
  const named = findMention(turn.text, input.mentions);
  if (named)
    return {
      ok: true,
      reason: `a person wrote the latest turn at ${hhmmss(turn.at)} and it names “${named}”`,
      named,
    };
  if (isAffirmative(turn.text) && turn.assistantBefore) {
    for (const q of questions(turn.assistantBefore)) {
      const asked = findMention(q, input.mentions);
      if (asked)
        return {
          ok: true,
          reason: `a person answered “${turn.text.trim().slice(0, 40)}” at ${hhmmss(turn.at)} to a question naming “${asked}”`,
          named: asked,
        };
    }
  }
  return {
    ok: false,
    reason: `the latest message typed by a person (${hhmmss(turn.at)}) does not name this action (expected one of: ${input.mentions.join(", ")})`,
  };
}
