/**
 * `okgate audit [--since 7d|30d|all|YYYY-MM-DD] [--client claude|codex|all] [--json]
 *  [--enforce [--preview] [--yes]]`
 *
 * Which written rules the coding agents broke in this repository: the rules come from the repo's
 * CLAUDE.md, AGENTS.md, GEMINI.md, .cursor/rules (and okgate.yaml `audit.rules`); the
 * sessions are this machine's Claude Code and Codex transcripts whose working directory is in the
 * repo. Per rule: sessions checked, sessions broken, the last three dates — and on screen only,
 * the command or path that broke it. No network, no telemetry, no LLM: nothing leaves the
 * machine. `--json` (what `/okgate:audit` reads) carries counts, rule ids and dates, never a
 * command, a path or a prompt from a transcript.
 *
 * `--enforce` writes the checkable rules into okgate.yaml as hook-mode rules — in dry-run;
 * it never switches `hooks.mode` to enforce — shows the diff, and installs the hook if it is not.
 */
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { findPolicyFile } from "@agentwares/agentguard-core/node";
import {
  NOT_CHECKABLE_HINT,
  applicableNoun,
  describeStep,
  evaluateChecks,
  extractRules,
  planEnforcement,
  stableHash,
  summarizeAudit,
  type AuditClient,
  type AuditContext,
  type AuditStep,
  type GroupAudit,
  type LocatedBreak,
  type Rule,
  type RuleCheck,
  type RuleSummary,
  STATE_DIR,
  envTwin,
} from "@agentwares/agentguard-core";
import { flagBool, flagList, flagString, parseArgs, type ParsedArgs } from "../args.js";
import { homeFrom, type Io } from "../context.js";
import { AuditCache, sha } from "../audit/cache.js";
import { applyEnforcePlan, lineDiff } from "../audit/enforce.js";
import { fetchSteps, readGroup } from "../audit/read.js";
import { findRepo, readConfigRules, readRuleFiles, repoMatcher } from "../audit/repo.js";
import {
  claudeGroups,
  claudeProjectDirs,
  codexGroups,
  sourceDirs,
  type TranscriptGroup,
} from "../audit/sources.js";
import { installedHandlers, hookTarget } from "../hooks/clients.js";
import { version } from "../version.js";
import { hooksCommand } from "./hooks.js";

/** The willingness-to-pay test: a page that says what the team view would be, and one button. */
export const TEAM_HISTORY_URL = "https://agentwares-agentguard.vercel.app/team-history";
export const TEAM_HISTORY_LINE = `Team adherence history across repos and developers is coming — ${TEAM_HISTORY_URL}`;

const CLIENT_LABEL: Record<AuditClient, string> = { "claude-code": "Claude Code", codex: "Codex" };

/** `7d`, `30d`, `24h`, `all`, or a date. Undefined: all history. */
export function parseSince(value: string | undefined, now: Date): number | undefined {
  const v = (value ?? "7d").trim().toLowerCase();
  if (v === "all") return undefined;
  const rel = /^(\d+)\s*([dhw])$/.exec(v);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2] === "h" ? 3_600_000 : rel[2] === "w" ? 7 * 86_400_000 : 86_400_000;
    return now.getTime() - n * unit;
  }
  const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00` : v);
  if (!Number.isFinite(t))
    throw new Error(`--since "${value}": use 7d, 30d, 24h, all or a date (YYYY-MM-DD)`);
  return t;
}

function clientsFrom(args: ParsedArgs): AuditClient[] {
  const names = flagList(args, "client").map((n) => n.trim().toLowerCase());
  if (names.length === 0 || names.includes("all")) return ["claude-code", "codex"];
  return names.map((n) => {
    if (n === "claude" || n === "claude-code") return "claude-code";
    if (n === "codex") return "codex";
    throw new Error(`unknown --client "${n}" (claude, codex or all)`);
  });
}

const pad = (n: number): string => String(n).padStart(2, "0");
const localTime = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const localDay = (ms: number): string => localTime(ms).slice(0, 10);
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

interface Entry {
  group?: TranscriptGroup;
  audit: GroupAudit;
  /** steps kept from a group read this run, for the evidence */
  steps?: Map<string, AuditStep>;
}

interface SourceCount {
  transcripts: number;
  read: number;
  cached: number;
  retained: number;
  /** groups last written before the window: not read */
  older: number;
}

async function pool<T>(
  items: readonly T[],
  size: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const run = async (): Promise<void> => {
    while (next < items.length) await work(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, run));
}

/** The hook-rule list a check would be enforced through, or "audit-only". */
function enforceTarget(check: RuleCheck): string {
  switch (check.spec.kind) {
    case "run-before":
    case "no-commit-to":
      return "audit-only";
    case "no-edit":
      return "hooks.paths.deny";
    case "no-new-deps":
      return check.spec.unlessAsked ? "hooks.shell.approval" : "hooks.shell.deny";
    case "no-rm-outside":
    case "no-publish":
      return "hooks.irreversible.builtins";
    case "no-deploy":
      return "hooks.irreversible.rules";
    default:
      return "hooks.shell.deny";
  }
}

export async function auditCommand(args: ParsedArgs, io: Io): Promise<number> {
  const now = new Date();
  const json = flagBool(args, "json") === true;
  const since = parseSince(flagString(args, "since"), now);
  const clients = clientsFrom(args);
  const home = homeFrom(io);
  const repo = findRepo(resolve(io.cwd, flagString(args, "repo") ?? "."));
  const named = flagString(args, "config") ?? envTwin(io.env, "CONFIG");
  const policyPath =
    named !== undefined ? resolve(repo.checkout, named) : findPolicyFile(repo.checkout);

  // the rules
  const files = readRuleFiles(repo.checkout, flagList(args, "rules"));
  const config = readConfigRules(policyPath);
  const { rules, errors } = extractRules(files, config.rules, basename(policyPath));
  const warnings = [
    ...(config.warning ? [config.warning] : []),
    ...errors.map((e) => `${e.file}:${e.line}: ${e.message}`),
  ];
  const checks = rules.flatMap((r) => r.checks);
  const keys = [...new Set(checks.map((c) => c.key))];

  if (flagBool(args, "enforce")) return enforce(args, io, rules, policyPath, repo.checkout, json);

  // the sessions
  const dirs = sourceDirs(io.env, home, {
    claudeDir: flagString(args, "claude-dir"),
    codexDir: flagString(args, "codex-dir"),
  });
  const groups: TranscriptGroup[] = [
    ...(clients.includes("claude-code")
      ? claudeGroups(claudeProjectDirs(dirs["claude-code"], repo.root))
      : []),
    ...(clients.includes("codex") ? codexGroups(dirs.codex) : []),
  ];
  const cache = new AuditCache(
    resolve(io.cwd, flagString(args, "cache-dir") ?? join(home, STATE_DIR)),
    sha(repo.root),
    flagBool(args, "cache") !== false,
  );
  const inRepo = repoMatcher(repo.root);
  const ctx: AuditContext = {
    repoRoot: repo.root,
    home,
    tmpDirs: [
      tmpdir(),
      io.env.TMPDIR ?? "",
      "/tmp",
      "/private/tmp",
      "/var/folders",
      "/private/var/folders",
    ].filter(Boolean),
  };
  const counts: Record<AuditClient, SourceCount> = {
    "claude-code": { transcripts: 0, read: 0, cached: 0, retained: 0, older: 0 },
    codex: { transcripts: 0, read: 0, cached: 0, retained: 0, older: 0 },
  };
  const entries: Entry[] = [];
  const evidence = !json && flagBool(args, "evidence") !== false;
  await pool(groups, 6, async (group) => {
    const c = counts[group.client];
    c.transcripts += group.files.length;
    const hit = cache.lookup(group, keys);
    if (hit) {
      c.cached += group.files.length;
      entries.push({ group, audit: hit });
      return;
    }
    if (since !== undefined && group.lastWrite < since) {
      c.older += group.files.length;
      return;
    }
    let read;
    try {
      read = await readGroup(group, { inRepo });
    } catch {
      return; // unreadable (permissions, deleted mid-run): skip, never fail the audit
    }
    c.read += group.files.length;
    const audit = evaluateChecks(checks, read, ctx);
    cache.store(group, audit);
    const hasBreaks = Object.values(audit.checks).some((o) => o.breaks.length > 0);
    entries.push({
      group,
      audit,
      ...(evidence && hasBreaks
        ? { steps: new Map(read.steps.map((s) => [stableHash(s.id), s])) }
        : {}),
    });
  });
  const present = new Set(groups.map((g) => cache.groupKey(g)));
  for (const client of clients)
    for (const audit of cache.retained(present, client)) {
      counts[client].retained += 1;
      entries.push({ audit });
    }

  const summary = summarizeAudit(
    rules,
    entries.map((e) => e.audit),
    { since },
  );
  const plan = planEnforcement(rules);
  const enforceable = new Set([
    ...plan.items.map((i) => i.rule.id),
    ...plan.builtins.map((b) => b.rule.id),
    ...plan.irreversible.map((r) => r.rule.id),
  ]);

  if (json) {
    io.out(
      JSON.stringify(
        {
          tool: "okgate audit",
          version: version(),
          repo: repo.root,
          checkout: repo.checkout,
          since: since === undefined ? null : new Date(since).toISOString(),
          until: now.toISOString(),
          rule_files: files.map((f) => f.path),
          sources: counts,
          sessions: {
            total: summary.sessions,
            "claude-code": summary.sessionsByClient["claude-code"],
            codex: summary.sessionsByClient.codex,
          },
          unread_tool_calls: summary.unread,
          rules: summary.rules.map((r) => ({
            id: r.rule.id,
            n: r.rule.n,
            file: r.rule.file,
            line: r.rule.line,
            text: r.rule.text,
            status: r.status,
            checkable: r.rule.checks.length > 0,
            ...(r.rule.silenced ? { marked_not_checkable: true } : {}),
            sessions_broken: r.sessionsBroken,
            last_broken: r.last.map((b) => new Date(b.at).toISOString()),
            checks: r.checks.map((c, k) => ({
              check: c.label,
              kind: c.kind,
              via: c.via,
              enforce: enforceTarget(r.rule.checks[k]!),
              sessions_applicable: c.sessionsApplicable,
              sessions_broken: c.sessionsBroken,
              sessions_on_request: c.sessionsOnRequest,
              sessions_undetermined: c.sessionsUndetermined,
              breaks: c.breaks,
              refused: c.refused,
            })),
          })),
          not_checkable: {
            count: summary.rules.filter((r) => r.status === "not-checkable").length,
            hint: NOT_CHECKABLE_HINT,
          },
          warnings,
          enforce: {
            command: "okgate audit --enforce",
            rules: enforceable.size,
            note: "writes hook-mode rules into okgate.yaml in dry-run; nothing is blocked until hooks.mode is enforce",
          },
          team_history: { available: false, url: TEAM_HISTORY_URL },
          privacy:
            "counts, rule ids and dates only: no command, path or prompt from a transcript is in this output, and nothing was sent anywhere",
        },
        null,
        2,
      ),
    );
    return 0;
  }

  // evidence for the latest breaks, on this screen only
  const lines = new Map<string, string>();
  if (evidence) {
    const wanted = new Map<number, LocatedBreak[]>();
    for (const r of summary.rules)
      for (const b of r.last) {
        const list = wanted.get(b.group) ?? [];
        list.push(b);
        wanted.set(b.group, list);
      }
    for (const [gi, breaks] of wanted) {
      const entry = entries[gi];
      if (!entry?.group) continue;
      let steps = entry.steps;
      if (!steps) {
        try {
          steps = await fetchSteps(entry.group, breaks, { inRepo });
        } catch {
          continue;
        }
      }
      for (const b of breaks) {
        const step = steps.get(b.step);
        if (step) lines.set(`${gi}:${b.step}:${b.what}:${b.index}`, describeStep(step, b, ctx));
      }
    }
  }

  renderHuman(io, {
    root: repo.root,
    since,
    files: files.map((f) => f.path),
    counts,
    clients,
    summary,
    evidence: evidence
      ? (b) =>
          lines.get(`${b.group}:${b.step}:${b.what}:${b.index}`) ?? "(transcript no longer on disk)"
      : () => undefined,
    enforceable: enforceable.size,
    warnings,
  });
  return 0;
}

interface View {
  root: string;
  since?: number;
  files: string[];
  counts: Record<AuditClient, SourceCount>;
  clients: AuditClient[];
  summary: ReturnType<typeof summarizeAudit>;
  evidence: (b: LocatedBreak) => string | undefined;
  enforceable: number;
  warnings: string[];
}

function ruleHead(r: RuleSummary): string {
  const id = `R${r.rule.n}`.padEnd(4);
  return `  ${id} ${clip(r.rule.text, 78)}   (${r.rule.file}:${r.rule.line})`;
}

function renderHuman(io: Io, v: View): void {
  const s = v.summary;
  const window = v.since === undefined ? "all history" : `since ${localDay(v.since)}`;
  io.out(`okgate audit — ${v.root} · ${window}`);
  const read = v.clients.map((c) => {
    const n = v.counts[c];
    const parts = [`${n.read} read`, `${n.cached} from cache`];
    if (n.retained) parts.push(`${n.retained} kept from deleted transcripts`);
    if (n.older) parts.push(`${n.older} older than the window`);
    return `${CLIENT_LABEL[c]}: ${plural(n.transcripts, "transcript")} (${parts.join(", ")})`;
  });
  io.out(read.join(" · "));
  const byClient = v.clients
    .filter((c) => s.sessionsByClient[c] > 0)
    .map((c) => `${CLIENT_LABEL[c]} ${s.sessionsByClient[c]}`);
  io.out(
    `${plural(s.sessions, "session")} in this repository${byClient.length ? ` (${byClient.join(", ")})` : ""}. Read on this machine; nothing was sent anywhere.`,
  );
  if (s.unread > 0)
    io.out(
      `${plural(s.unread, "Codex tool call")} ran JavaScript (\`exec\`), not a command line, and ${s.unread === 1 ? "was" : "were"} not read.`,
    );
  for (const w of v.warnings) io.out(`warning: ${w}`);
  io.out("");

  if (v.files.length === 0 && s.rules.length === 0) {
    io.out(
      "No rule files here (CLAUDE.md, AGENTS.md, GEMINI.md, .cursor/rules, …) and no audit.rules in okgate.yaml: nothing to audit.",
    );
    io.out("");
    io.out(TEAM_HISTORY_LINE);
    return;
  }
  const checkable = s.rules.filter((r) => r.status !== "not-checkable");
  const perFile = new Map<string, number>();
  for (const r of s.rules) perFile.set(r.rule.file, (perFile.get(r.rule.file) ?? 0) + 1);
  io.out(
    `${plural(s.rules.length, "rule")} found (${[...perFile].map(([f, n]) => `${n} in ${f}`).join(", ")}); ${checkable.length} checkable.`,
  );
  if (s.sessions === 0)
    io.out(
      `No Claude Code or Codex sessions in ${v.root} ${window}. Transcripts are read from ~/.claude/projects and ~/.codex/sessions (--claude-dir, --codex-dir); try --since 30d or --since all.`,
    );

  const section = (title: string, list: RuleSummary[], body: (r: RuleSummary) => void): void => {
    if (list.length === 0) return;
    io.out("");
    io.out(title);
    for (const r of list) {
      io.out(ruleHead(r));
      body(r);
    }
  };
  const checkLines = (r: RuleSummary): void => {
    r.rule.checks.forEach((check, k) => {
      const c = r.checks[k]!;
      const noun = applicableNoun(c.kind, check.spec);
      const scope = noun ? ` (${c.sessionsApplicable} ${noun})` : "";
      let verdict: string;
      if (c.sessionsBroken > 0) {
        verdict = `broken in ${c.sessionsBroken} of ${s.sessions} sessions${scope}`;
        const extra: string[] = [];
        if (c.breaks > c.sessionsBroken) extra.push(`${c.breaks} times`);
        if (c.sessionsOnRequest > 0)
          extra.push(`${c.sessionsOnRequest} on a turn that asked for it`);
        if (c.refused > 0) extra.push(`${c.refused} refused by the harness`);
        if (extra.length) verdict += `; ${extra.join(", ")}`;
      } else if (c.sessionsApplicable > 0 || !noun) {
        const n = noun ? c.sessionsApplicable : s.sessions;
        verdict =
          n === 1
            ? `kept in the 1 session${noun ? ` that ${noun}` : ""}`
            : `kept in all ${n} sessions${noun ? ` that ${noun}` : ""}`;
      } else verdict = `nothing in these sessions could break it`;
      if (c.sessionsUndetermined > 0)
        verdict += `; ${c.sessionsUndetermined} more in sessions that do not say who asked (Codex)`;
      io.out(`       ${c.label} — ${verdict}`);
    });
    for (const b of r.last) {
      const what = v.evidence(b);
      io.out(
        `         ${localTime(b.at)}${what ? `  ${what}` : ""}${b.refused ? "  [refused]" : ""}${b.asked ? "  [asked]" : ""}  · session ${b.session.slice(0, 8)}`,
      );
    }
  };
  section(
    "BROKEN",
    s.rules
      .filter((r) => r.status === "broken")
      .sort((a, b) => b.sessionsBroken - a.sessionsBroken),
    checkLines,
  );
  section(
    "KEPT",
    s.rules.filter((r) => r.status === "kept"),
    checkLines,
  );
  section(
    "NOTHING IN THESE SESSIONS COULD BREAK IT",
    s.rules.filter((r) => r.status === "not-applicable"),
    checkLines,
  );
  const notCheckable = s.rules.filter((r) => r.status === "not-checkable");
  if (notCheckable.length > 0) {
    io.out("");
    io.out(
      `NOT CHECKABLE MECHANICALLY (${notCheckable.length}) — ${NOT_CHECKABLE_HINT.replace(/^not checkable mechanically — /, "")}`,
    );
    for (const r of notCheckable)
      io.out(`${ruleHead(r)}${r.rule.silenced ? "  [marked none]" : ""}`);
  }
  io.out("");
  if (v.enforceable > 0)
    io.out(
      `Enforce: okgate audit --enforce   writes ${plural(v.enforceable, "rule")} into okgate.yaml as hook rules, in dry-run (nothing is blocked until hooks.mode: enforce)`,
    );
  io.out(TEAM_HISTORY_LINE);
}

async function enforce(
  args: ParsedArgs,
  io: Io,
  rules: Rule[],
  policyPath: string,
  checkout: string,
  json: boolean,
): Promise<number> {
  const plan = planEnforcement(rules);
  const preview = flagBool(args, "preview") === true;
  const edit = applyEnforcePlan(policyPath, plan);
  const diff = lineDiff(edit.before, edit.after);
  const changed = edit.before !== edit.after;
  const blocked = edit.mode === "enforce" && flagBool(args, "yes") !== true;
  const write = changed && !preview && !blocked;
  if (write) writeFileSync(policyPath, edit.after);

  // the hook: install it (project level) if no okgate hook is in place for Claude Code
  const home = homeFrom(io);
  const installed = (["project", "user"] as const).some((scope) => {
    try {
      return (
        installedHandlers(hookTarget("claude-code", scope, { cwd: checkout, home }, "")).length > 0
      );
    } catch {
      return true; // an unreadable settings file: leave it to `hooks status`
    }
  });
  let hookInstalled = installed;
  const hookOut: string[] = [];
  if (!installed && !preview && !blocked) {
    const sub: Io = { ...io, cwd: checkout, out: (l) => hookOut.push(l) };
    const passthrough = ["hooks", "install"];
    const config = flagString(args, "config");
    if (config) passthrough.push("--config", resolve(io.cwd, config));
    const command = flagString(args, "command");
    if (command) passthrough.push("--command", command);
    await hooksCommand(parseArgs(passthrough), sub);
    hookInstalled = true;
  }

  if (json) {
    io.out(
      JSON.stringify(
        {
          policy: policyPath,
          written: write,
          preview,
          hooks_mode: edit.mode,
          added: edit.added,
          audit_only: plan.auditOnly.map((a) => ({
            rule: a.rule.id,
            check: a.check.label,
            why: a.why,
          })),
          notes: plan.notes,
          hook_installed: hookInstalled,
        },
        null,
        2,
      ),
    );
    return blocked && changed ? 1 : 0;
  }

  if (!changed)
    io.out(`okgate.yaml already has a hook rule for every enforceable rule (${policyPath}).`);
  else {
    io.out(
      `${write ? (edit.created ? "wrote" : "updated") : "would update"} ${policyPath} — ${plural(edit.added.length, "hook rule")}:`,
    );
    for (const line of diff) io.out(`  ${line}`);
  }
  if (plan.auditOnly.length > 0) {
    io.out("");
    io.out("Audit only (a pre-execution hook cannot check these):");
    for (const a of plan.auditOnly) io.out(`  R${a.rule.n} ${a.check.label} — ${a.why}`);
  }
  if (plan.notes.length > 0) {
    io.out("");
    for (const n of plan.notes) io.out(`note: ${n}`);
  }
  io.out("");
  if (blocked && changed) {
    io.out(
      "hooks.mode is enforce in this okgate.yaml, so these rules would block at once. Nothing was written. Rerun with --enforce --yes to add them anyway, or set hooks.mode: dry-run first.",
    );
    return 1;
  }
  if (preview) {
    io.out("Preview only: nothing was written. Run okgate audit --enforce to write it.");
    return 0;
  }
  for (const l of hookOut) io.out(l);
  if (installed) io.out("The okgate hook is already installed (okgate hooks status).");
  io.out(
    `hooks.mode is ${edit.mode}: ${edit.mode === "dry-run" ? "every decision is logged and nothing is blocked. Read okgate report, then set hooks.mode: enforce yourself." : "the rules apply from the next session."}`,
  );
  return 0;
}
