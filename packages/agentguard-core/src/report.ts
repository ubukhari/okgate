/**
 * The incident-shaped report: what this run did, what it would have destroyed or spent, where
 * it was halted — from the audit log alone. Also the mutation diff for `okgate diff`.
 */
import type { AuditEntry } from "./audit.js";
import type { MutationVerb } from "./classify.js";
import { NO_LIST_PRICE_REASON } from "./spend.js";

export interface RunSummary {
  runId: string;
  agent?: string;
  startedAt: string;
  endedAt: string;
  calls: number;
  writes: number;
  faked: number;
  blocked: number;
  halted: number;
  errors: number;
  usd: number;
  mode: string;
}

export interface Halt {
  seq: number;
  ts: string;
  code: string;
  tool: string;
  cause: string;
}

export interface Report {
  runId?: string;
  runs: RunSummary[];
  entries: number;
  byClass: Record<string, number>;
  byOutcome: Record<string, number>;
  /** dry-run material — what enforce mode would have let through */
  wouldHave: {
    creates: number;
    updates: number;
    deletes: number;
    sends: number;
    executes: number;
    spends: number;
    spendUsd: number;
    mutations: number;
  };
  /** what actually happened upstream */
  did: { writes: number; deletes: number; sends: number; spendUsd: number };
  halts: Halt[];
  /** spend the caps could not measure: models with no list price, charged $0 */
  unpriced: { tool: string; calls: number }[];
  topTools: { tool: string; calls: number; class: string }[];
  mutations: AuditEntry[];
  upstreams: string[];
  /** hook mode: the coding agent's own shell commands, file edits and tool calls */
  hooks: HookSummary;
}

export interface HookSummary {
  calls: number;
  shell: number;
  edits: number;
  tools: number;
  clients: string[];
  /** irreversible calls (push, merge, publish, send, rm outside the workspace, …) */
  irreversible: number;
  /** irreversible calls that ran because a person's turn authorized them */
  onHumanTurn: number;
  /** calls that ran once after `okgate approve` */
  approved: number;
  /** enforce: irreversible calls held for approval */
  irreversibleHeld: number;
  /** enforce: every call refused or held */
  refused: number;
  /** dry-run: what enforce mode would have refused; these ran */
  wouldHave: {
    seq: number;
    ts: string;
    tool: string;
    summary: string;
    code: string;
    cause: string;
  }[];
}

export function listRuns(entries: readonly AuditEntry[]): RunSummary[] {
  const byRun = new Map<string, RunSummary>();
  for (const e of entries) {
    const run = byRun.get(e.run_id) ?? {
      runId: e.run_id,
      agent: e.agent,
      startedAt: e.ts,
      endedAt: e.ts,
      calls: 0,
      writes: 0,
      faked: 0,
      blocked: 0,
      halted: 0,
      errors: 0,
      usd: 0,
      mode: e.mode,
    };
    run.calls += 1;
    run.endedAt = e.ts > run.endedAt ? e.ts : run.endedAt;
    run.startedAt = e.ts < run.startedAt ? e.ts : run.startedAt;
    if (e.class === "write" || e.class === "spend") run.writes += 1;
    if (e.outcome === "faked") run.faked += 1;
    if (e.outcome === "blocked" || e.outcome === "pending") run.blocked += 1;
    if (e.outcome === "halted") run.halted += 1;
    if (e.outcome === "error") run.errors += 1;
    if ((e.outcome === "ok" || e.outcome === "faked") && typeof e.usd === "number")
      run.usd = round(run.usd + e.usd);
    byRun.set(e.run_id, run);
  }
  return [...byRun.values()].sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
}

export function latestRunId(entries: readonly AuditEntry[]): string | undefined {
  return listRuns(entries)[0]?.runId;
}

export function buildReport(all: readonly AuditEntry[], opts: { runId?: string } = {}): Report {
  const runId = opts.runId;
  const entries = runId ? all.filter((e) => e.run_id === runId) : all;
  const byClass: Record<string, number> = {};
  const byOutcome: Record<string, number> = {};
  const wouldHave = {
    creates: 0,
    updates: 0,
    deletes: 0,
    sends: 0,
    executes: 0,
    spends: 0,
    spendUsd: 0,
    mutations: 0,
  };
  const did = { writes: 0, deletes: 0, sends: 0, spendUsd: 0 };
  const halts: Halt[] = [];
  const unpriced = new Map<string, number>();
  const tools = new Map<string, { calls: number; class: string }>();
  const mutations: AuditEntry[] = [];
  const upstreams = new Set<string>();

  const bump = (verb: MutationVerb, target: typeof wouldHave): void => {
    if (verb === "create") target.creates += 1;
    else if (verb === "delete") target.deletes += 1;
    else if (verb === "send") target.sends += 1;
    else if (verb === "execute") target.executes += 1;
    else if (verb === "spend") target.spends += 1;
    else target.updates += 1;
  };

  for (const e of entries) {
    byClass[e.class] = (byClass[e.class] ?? 0) + 1;
    byOutcome[e.outcome] = (byOutcome[e.outcome] ?? 0) + 1;
    if (e.upstream) upstreams.add(e.upstream);
    if (e.reason?.startsWith(NO_LIST_PRICE_REASON))
      unpriced.set(e.tool, (unpriced.get(e.tool) ?? 0) + 1);
    const t = tools.get(e.tool) ?? { calls: 0, class: e.class };
    t.calls += 1;
    tools.set(e.tool, t);
    if (e.outcome === "faked") {
      wouldHave.mutations += 1;
      bump(e.mutation?.verb ?? e.verb, wouldHave);
      if (typeof e.usd === "number") wouldHave.spendUsd = round(wouldHave.spendUsd + e.usd);
      mutations.push(e);
    } else if (e.outcome === "ok" && (e.class === "write" || e.class === "spend")) {
      did.writes += 1;
      if (e.verb === "delete") did.deletes += 1;
      if (e.verb === "send") did.sends += 1;
      if (typeof e.usd === "number") did.spendUsd = round(did.spendUsd + e.usd);
    }
    if (e.outcome === "halted" || e.outcome === "blocked" || e.outcome === "pending") {
      halts.push({
        seq: e.seq,
        ts: e.ts,
        code: e.error?.code ?? e.outcome.toUpperCase(),
        tool: e.tool,
        cause: e.error?.cause ?? e.reason ?? "",
      });
    }
  }
  const topTools = [...tools.entries()]
    .map(([tool, v]) => ({ tool, ...v }))
    .sort((a, b) => b.calls - a.calls)
    .slice(0, 10);
  const hooks = summarizeHooks(entries);
  return {
    hooks,
    runId,
    runs: listRuns(entries),
    entries: entries.length,
    byClass,
    byOutcome,
    wouldHave,
    did,
    halts,
    unpriced: [...unpriced].map(([tool, calls]) => ({ tool, calls })),
    topTools,
    mutations,
    upstreams: [...upstreams],
  };
}

export function summarizeHooks(entries: readonly AuditEntry[]): HookSummary {
  const out: HookSummary = {
    calls: 0,
    shell: 0,
    edits: 0,
    tools: 0,
    clients: [],
    irreversible: 0,
    onHumanTurn: 0,
    approved: 0,
    irreversibleHeld: 0,
    refused: 0,
    wouldHave: [],
  };
  const clients = new Set<string>();
  for (const e of entries) {
    const h = e.hook;
    if (!h) continue;
    out.calls += 1;
    clients.add(h.client);
    if (e.counters?.shell_commands) out.shell += 1;
    else if (e.counters?.file_edits) out.edits += 1;
    else out.tools += 1;
    if (h.irreversible?.length) out.irreversible += 1;
    if (h.decision === "allow" && h.irreversible?.length && h.human_turn?.ok) out.onHumanTurn += 1;
    if (h.decision === "allow" && h.approval_id) out.approved += 1;
    if (h.decision === "deny") out.refused += 1;
    if (h.decision === "deny" && h.irreversible?.length) out.irreversibleHeld += 1;
    if (h.would)
      out.wouldHave.push({
        seq: e.seq,
        ts: e.ts,
        tool: e.tool,
        summary: h.summary,
        code: h.would.code,
        cause: h.would.cause,
      });
  }
  out.clients = [...clients];
  return out;
}

function renderHooks(h: HookSummary, lines: string[]): void {
  if (h.calls === 0) return;
  lines.push(`## Coding-agent hooks (${h.clients.join(", ")})`);
  lines.push("");
  const kinds = [
    h.shell ? `${h.shell} shell command${plural(h.shell)}` : "",
    h.edits ? `${h.edits} file edit${plural(h.edits)}` : "",
    h.tools ? `${h.tools} tool call${plural(h.tools)}` : "",
  ].filter(Boolean);
  let line = `${h.calls} call${plural(h.calls)} checked: ${kinds.join(", ")}.`;
  if (h.irreversible > 0) {
    const parts = [`${h.onHumanTurn} ran on a person's turn`];
    if (h.approved) parts.push(`${h.approved} after \`okgate approve\``);
    if (h.irreversibleHeld) parts.push(`${h.irreversibleHeld} held for approval`);
    const ranOther = h.irreversible - h.onHumanTurn - h.approved - h.irreversibleHeld;
    if (ranOther > 0) parts.push(`${ranOther} ran in dry-run without one`);
    line += ` ${h.irreversible} irreversible: ${parts.join(", ")}.`;
  }
  if (h.refused) line += ` ${h.refused} refused or held in all.`;
  lines.push(line);
  lines.push("");
  if (h.wouldHave.length > 0) {
    lines.push(`### What enforce mode would have stopped (hooks.mode: dry-run — these ran)`);
    lines.push("");
    lines.push("| # | when | code | command | why |");
    lines.push("|---|------|------|---------|-----|");
    for (const w of h.wouldHave.slice(0, 50))
      lines.push(
        `| ${w.seq} | ${w.ts} | \`${w.code}\` | \`${escapeCell(w.summary).replace(/`/g, "'")}\` | ${escapeCell(w.cause)} |`,
      );
    lines.push("");
    lines.push(
      "Set `hooks.mode: enforce` in the policy file (okgate.yaml) when this list looks right.",
    );
    lines.push("");
  }
}

export function renderReportMarkdown(report: Report): string {
  const lines: string[] = [];
  const scope = report.runId
    ? `run \`${report.runId}\``
    : `${report.runs.length} run${report.runs.length === 1 ? "" : "s"}`;
  lines.push(`# okgate report — ${scope}`);
  lines.push("");
  if (report.entries === 0) {
    lines.push(
      "No tool calls recorded. Point your agent at the proxy (or run `okgate hooks install` for a coding agent) and run it once.",
    );
    return lines.join("\n");
  }
  const first = report.runs[report.runs.length - 1]!;
  const last = report.runs[0]!;
  lines.push(
    `${report.entries} tool calls between ${first.startedAt} and ${last.endedAt}` +
      (report.upstreams.length ? ` across ${report.upstreams.join(", ")}` : "") +
      ".",
  );
  lines.push("");

  const w = report.wouldHave;
  if (w.mutations > 0) {
    lines.push("## What this run would have done (dry-run, nothing was executed)");
    lines.push("");
    const parts: string[] = [];
    if (w.deletes) parts.push(`**deleted ${w.deletes} record${plural(w.deletes)}**`);
    if (w.updates) parts.push(`updated ${w.updates}`);
    if (w.creates) parts.push(`created ${w.creates}`);
    if (w.sends) parts.push(`sent ${w.sends} message${plural(w.sends)}`);
    if (w.executes) parts.push(`executed ${w.executes} command${plural(w.executes)}`);
    if (w.spendUsd) parts.push(`**spent $${w.spendUsd.toFixed(2)}**`);
    lines.push(`It would have ${parts.join(", ")}.`);
    lines.push("");
    lines.push(
      "Run `okgate diff` for the record-by-record mutation diff. Flip `mode: enforce` when it looks right.",
    );
    lines.push("");
  }
  const d = report.did;
  if (d.writes > 0) {
    lines.push("## What actually happened upstream");
    lines.push("");
    const parts = [`${d.writes} write${plural(d.writes)}`];
    if (d.deletes) parts.push(`${d.deletes} delete${plural(d.deletes)}`);
    if (d.sends) parts.push(`${d.sends} send${plural(d.sends)}`);
    if (d.spendUsd) parts.push(`$${d.spendUsd.toFixed(2)} spent`);
    lines.push(parts.join(", ") + ".");
    lines.push("");
  }
  renderHooks(report.hooks, lines);
  if (report.unpriced.length > 0) {
    lines.push("## Spend the caps could not measure");
    lines.push("");
    lines.push(
      `${report.unpriced.reduce((n, u) => n + u.calls, 0)} call${plural(report.unpriced.reduce((n, u) => n + u.calls, 0))} had no list price and were recorded at **$0**, so they did **not** count against \`caps.*.spend_usd\`:`,
    );
    lines.push("");
    for (const u of report.unpriced)
      lines.push(`- \`${u.tool}\` — ${u.calls} call${plural(u.calls)}`);
    lines.push("");
    lines.push(
      "Add a price under `spend.models` in the policy file (okgate.yaml) to bring them under the cap.",
    );
    lines.push("");
  }
  if (report.halts.length > 0) {
    lines.push("## Where okgate stepped in");
    lines.push("");
    lines.push("| # | when | code | tool | why |");
    lines.push("|---|------|------|------|-----|");
    for (const h of report.halts.slice(0, 50)) {
      lines.push(`| ${h.seq} | ${h.ts} | \`${h.code}\` | \`${h.tool}\` | ${escapeCell(h.cause)} |`);
    }
    lines.push("");
  }
  lines.push("## Calls");
  lines.push("");
  lines.push(`By class: ${fmtRecord(report.byClass)}`);
  lines.push(`By outcome: ${fmtRecord(report.byOutcome)}`);
  lines.push("");
  lines.push("| tool | class | calls |");
  lines.push("|------|-------|-------|");
  for (const t of report.topTools) lines.push(`| \`${t.tool}\` | ${t.class} | ${t.calls} |`);
  lines.push("");
  if (!report.runId && report.runs.length > 1) {
    lines.push("## Runs");
    lines.push("");
    lines.push("| run | agent | started | calls | writes | faked | blocked | halted | $ |");
    lines.push("|-----|-------|---------|-------|--------|-------|---------|--------|---|");
    for (const r of report.runs.slice(0, 30)) {
      lines.push(
        `| \`${r.runId}\` | ${r.agent ?? "-"} | ${r.startedAt} | ${r.calls} | ${r.writes} | ${r.faked} | ${r.blocked} | ${r.halted} | ${r.usd.toFixed(2)} |`,
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}

/** `okgate diff`: one block per faked mutation, oldest first. */
export function renderMutationDiff(
  entries: readonly AuditEntry[],
  opts: { runId?: string } = {},
): string {
  const faked = entries.filter(
    (e) => e.outcome === "faked" && (!opts.runId || e.run_id === opts.runId),
  );
  if (faked.length === 0) return "No dry-run mutations recorded.\n";
  const out: string[] = [];
  for (const e of faked) {
    const m = e.mutation ?? { tool: e.tool, verb: e.verb, args: e.args };
    const marker =
      m.verb === "delete"
        ? "-"
        : m.verb === "create"
          ? "+"
          : m.verb === "send"
            ? ">"
            : m.verb === "spend"
              ? "$"
              : "~";
    const header = `${marker}${marker}${marker} ${m.verb.toUpperCase()} via ${e.upstream ? `${e.upstream}/` : ""}${m.tool}${m.target ? ` (${m.target})` : ""}${typeof m.usd === "number" && m.usd > 0 ? ` $${m.usd.toFixed(2)}` : ""}  [#${e.seq} ${e.ts}]`;
    out.push(header);
    const body = JSON.stringify(m.args ?? {}, null, 2).split("\n");
    for (const line of body) out.push(`${marker} ${line}`);
    out.push("");
  }
  const w = buildReport(faked).wouldHave;
  out.push(
    `${faked.length} mutation${plural(faked.length)} would have run: ${w.deletes} delete${plural(w.deletes)}, ${w.updates} update${plural(w.updates)}, ${w.creates} create${plural(w.creates)}, ${w.sends} send${plural(w.sends)}, ${w.executes} execute${plural(w.executes)}${w.spendUsd ? `, $${w.spendUsd.toFixed(2)}` : ""}.`,
  );
  return out.join("\n") + "\n";
}

function plural(n: number): string {
  return n === 1 ? "" : "s";
}
function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
function fmtRecord(r: Record<string, number>): string {
  return Object.entries(r)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${v}`)
    .join(", ");
}
function escapeCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ").slice(0, 200);
}
