/**
 * okgate's own tools: what an MCP client sees when the proxy has no upstream servers. That is
 * the proxy started with no `okgate.yaml` at all (an "Add to Cursor" button, a registry
 * install, a Glama build) or with a policy that lists none.
 *
 * Three read-only answers: status, a run's report and a verify of the audit log. They call no
 * upstream, write no file, and are not recorded in the audit log they read. With upstreams
 * configured they are not listed, so an agent's tool surface behind the proxy is unchanged.
 */
import { createToolContext, defineTool, listToolManifest, toolError } from "@agentwares/mcp-kit";
import {
  buildReport,
  latestRunId,
  listRuns,
  parseAuditJsonl,
  renderReportMarkdown,
  resolveToolName,
  verifyChain,
  type AuditEntry,
  type Caps,
} from "@agentwares/agentguard-core";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { RUN } from "../install.js";
import type { ProxyRuntime } from "./runtime.js";

export const INIT_COMMAND = `${RUN} init`;

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const runIdInput = z
  .string()
  .min(1)
  .max(128)
  .optional()
  .describe(
    "Run to read, as it appears in the audit log (for example run_20261007093015_ab12, or the X-Run-Id an HTTP client sent). Omit it for the most recent run.",
  );

const counters = z
  .record(z.string(), z.number())
  .describe(
    "counter name (tool_calls, writes, deletes, emails, spend_usd or a custom one) → value",
  );

/** The audit file, read without creating it. A line that is not JSON is reported, not thrown. */
function readAudit(path: string): { exists: boolean; entries: AuditEntry[]; error?: string } {
  if (!existsSync(path)) return { exists: false, entries: [] };
  try {
    return { exists: true, entries: parseAuditJsonl(readFileSync(path, "utf8")) };
  } catch (err) {
    return { exists: true, entries: [], error: err instanceof Error ? err.message : String(err) };
  }
}

function unreadable(path: string, error: string): Error {
  return toolError({
    code: "AUDIT_UNREADABLE",
    cause: `the audit log at ${path} could not be read: ${error}`,
    fix: "call okgate_verify_audit_log to see where it breaks; a hand-edited or truncated line has to be restored from a copy",
    retryable: false,
  });
}

function numbers(caps: Caps): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(caps)) if (typeof v === "number") out[k] = v;
  return out;
}

function nextStep(runtime: ProxyRuntime): string {
  if (!runtime.configured)
    return `okgate is guarding nothing: no policy file at ${runtime.loaded.path}. Run \`${INIT_COMMAND}\` in the project directory: it writes okgate.yaml in dry-run mode and routes the project's MCP servers through okgate (backup kept, \`--undo\` restores). Then restart the MCP client.`;
  if (runtime.policy.upstreams.length === 0)
    return `${runtime.loaded.path} lists no upstream servers, so okgate is guarding nothing. Add the MCP servers your agent uses under \`upstreams:\` in that file (it has commented examples), then restart the MCP client.`;
  return "okgate is running; run your agent, then read okgate_get_report.";
}

const StatusOutput = z.object({
  configured: z
    .boolean()
    .describe("true when a policy file was found and loaded; false means okgate guards nothing"),
  policy_path: z.string().describe("absolute path of the policy file read, or looked for"),
  mode: z
    .enum(["dry-run", "enforce"])
    .describe("dry-run fakes writes and spends and records them; enforce lets allowed calls run"),
  upstreams: z
    .array(
      z.object({
        name: z.string().describe("upstream name from the policy"),
        connected: z.boolean().describe("whether okgate is connected to it"),
        tools: z.number().int().describe("tools it exposes"),
        transport: z.enum(["stdio", "http"]).describe("how okgate reaches it"),
        error: z.string().optional().describe("why it is not connected"),
      }),
    )
    .describe("the MCP servers this proxy fronts; empty means none are configured"),
  run_id: z
    .string()
    .nullable()
    .describe(
      "run the usage is for: the requested run_id, else the latest run in the log, else null",
    ),
  caps: z
    .object({ per_run: counters, per_day: counters })
    .describe("limits from the policy; a counter that is absent has no cap"),
  used: z
    .object({ per_run: counters, per_day: counters })
    .describe("what that run, and today, have used against the caps"),
  remaining: z
    .record(
      z.string(),
      z.object({ per_run: z.number().optional(), per_day: z.number().optional() }),
    )
    .describe("budget left per capped counter, per run and per day"),
  kill_switch: z
    .object({
      on: z.boolean().describe("true halts every tool call with KILLED"),
      reason: z.string().optional().describe("why it was pulled"),
      source: z.string().optional().describe("file, env or memory"),
    })
    .describe("the kill switch state"),
  pending_approvals: z.number().int().describe("destructive calls waiting for a human decision"),
  audit_log: z
    .object({
      path: z.string().describe("absolute path of the hash-chained JSONL audit log"),
      entries: z.number().int().describe("entries in it; 0 when it does not exist yet"),
    })
    .describe("where every tool call is recorded"),
  next_step: z.string().describe("the one thing to do next, with the command when there is one"),
});

const ReportOutput = z.object({
  configured: z.boolean().describe("false when no policy file was found (okgate guards nothing)"),
  audit_log_path: z.string().describe("absolute path of the audit log the report was built from"),
  run_id: z.string().nullable().describe("the run reported on; null when the log has no runs"),
  runs_in_log: z.number().int().describe("how many runs the audit log holds"),
  tool_calls: z.number().int().describe("tool calls in this run"),
  would_have: z
    .object({
      creates: z.number().int(),
      updates: z.number().int(),
      deletes: z.number().int(),
      sends: z.number().int(),
      executes: z.number().int(),
      spends: z.number().int(),
      spend_usd: z.number(),
    })
    .describe("what dry-run mode faked: what the run would have done had the calls executed"),
  did: z
    .object({
      writes: z.number().int(),
      deletes: z.number().int(),
      sends: z.number().int(),
      spend_usd: z.number(),
    })
    .describe("what actually executed upstream"),
  halts: z
    .array(
      z.object({
        seq: z.number().int().describe("audit entry number"),
        ts: z.string().describe("ISO time of the call"),
        code: z.string().describe("CAP_EXCEEDED, LOOP_DETECTED, KILLED, APPROVAL_REQUIRED, …"),
        tool: z.string().describe("the tool that was stopped"),
        cause: z.string().describe("why"),
      }),
    )
    .describe("every call okgate stopped, in order"),
  top_tools: z
    .array(z.object({ tool: z.string(), calls: z.number().int(), class: z.string() }))
    .describe("the most-called tools with their class (read, write, spend)"),
  markdown: z.string().describe("the same report `okgate report` prints, as Markdown"),
});

const VerifyOutput = z.object({
  configured: z.boolean().describe("false when no policy file was found (okgate guards nothing)"),
  path: z.string().describe("absolute path of the audit log checked"),
  exists: z.boolean().describe("false when no call has been recorded yet; an absent log verifies"),
  ok: z.boolean().describe("true when every entry's hash and prev_hash recompute"),
  entries: z.number().int().describe("entries checked"),
  head_hash: z
    .string()
    .nullable()
    .describe(
      "hash of the last entry; record it with the count to detect entries cut from the end",
    ),
  broken_at: z.number().int().nullable().describe("seq of the first entry that does not verify"),
  reason: z.string().nullable().describe("why verification failed"),
});

export function createOwnTools(runtime: ProxyRuntime) {
  const status = defineTool({
    name: "okgate_get_status",
    title: "okgate status",
    description:
      "Report what okgate is guarding right now: the policy file it loaded (or that none was found), dry-run or enforce mode, each upstream MCP server and whether it connected, a run's cap usage and remaining budget, the kill switch, and pending approvals. Call it first to learn whether okgate is set up; next_step says what to do when it is not. For what a run did, use okgate_get_report; to check the log was not edited, okgate_verify_audit_log. Reads local files only and changes nothing.",
    input: z.strictObject({ run_id: runIdInput }),
    output: StatusOutput,
    annotations: { title: "okgate status", ...READ_ONLY },
    async handler({ run_id }) {
      const { loaded, guard } = runtime;
      const audit = readAudit(loaded.auditPath);
      if (audit.error) throw unreadable(loaded.auditPath, audit.error);
      const runId = run_id ?? latestRunId(audit.entries) ?? null;
      const state = await guard.status(runId ?? "(none yet)");
      const pending = await guard.approvals.list("pending");
      return {
        configured: runtime.configured,
        policy_path: loaded.path,
        mode: runtime.policy.mode,
        upstreams: runtime.upstreamStatus(),
        run_id: runId,
        caps: { per_run: numbers(state.caps.per_run), per_day: numbers(state.caps.per_day) },
        used: state.usage,
        remaining: state.remaining,
        kill_switch: {
          on: state.killed.killed,
          ...(state.killed.reason ? { reason: state.killed.reason } : {}),
          ...(state.killed.source ? { source: state.killed.source } : {}),
        },
        pending_approvals: pending.length,
        audit_log: { path: loaded.auditPath, entries: audit.entries.length },
        next_step: nextStep(runtime),
      };
    },
  });

  const report = defineTool({
    name: "okgate_get_report",
    title: "okgate run report",
    description:
      "Summarize one run from okgate's audit log: how many tool calls, what dry-run mode faked (records it would have created, updated or deleted, messages sent, dollars spent), what really ran upstream, and every call okgate halted with its code and cause. Defaults to the most recent run. Use it after an agent run, before switching a policy from dry-run to enforce; for live caps and the kill switch use okgate_get_status. Read-only: reads the audit file and does not record this call.",
    input: z.strictObject({ run_id: runIdInput }),
    output: ReportOutput,
    annotations: { title: "okgate run report", ...READ_ONLY },
    handler({ run_id }) {
      const { loaded } = runtime;
      const audit = readAudit(loaded.auditPath);
      if (audit.error) throw unreadable(loaded.auditPath, audit.error);
      const runs = listRuns(audit.entries);
      if (run_id && !runs.some((r) => r.runId === run_id)) {
        throw toolError({
          code: "NOT_FOUND",
          cause: `no run "${run_id}" in the audit log at ${loaded.auditPath}`,
          fix: `call again without run_id for the latest run${
            runs.length
              ? `; runs in the log: ${runs
                  .slice(0, 5)
                  .map((r) => r.runId)
                  .join(", ")}`
              : "; the log has no runs yet"
          }`,
          retryable: false,
        });
      }
      const runId = run_id ?? latestRunId(audit.entries) ?? null;
      const built = buildReport(audit.entries, { runId: runId ?? undefined });
      const markdown = runId
        ? renderReportMarkdown(built)
        : `# okgate report\n\nNo runs recorded in ${loaded.auditPath} yet. ${nextStep(runtime)}`;
      return {
        configured: runtime.configured,
        audit_log_path: loaded.auditPath,
        run_id: runId,
        runs_in_log: runs.length,
        tool_calls: runId ? audit.entries.filter((e) => e.run_id === runId).length : 0,
        would_have: {
          creates: built.wouldHave.creates,
          updates: built.wouldHave.updates,
          deletes: built.wouldHave.deletes,
          sends: built.wouldHave.sends,
          executes: built.wouldHave.executes,
          spends: built.wouldHave.spends,
          spend_usd: built.wouldHave.spendUsd,
        },
        did: {
          writes: built.did.writes,
          deletes: built.did.deletes,
          sends: built.did.sends,
          spend_usd: built.did.spendUsd,
        },
        halts: built.halts,
        top_tools: built.topTools,
        markdown,
      };
    },
  });

  const verify = defineTool({
    name: "okgate_verify_audit_log",
    title: "Verify okgate audit log",
    description:
      "Recompute the hash chain of okgate's audit log (JSONL, one entry per tool call) and say whether any entry was edited, removed from the middle or reordered, naming the first broken entry. Returns the entry count and head hash; record both elsewhere, because entries cut from the end of the file still verify. Use it before trusting okgate_get_report. Takes no arguments: it checks the log the loaded policy names. Read-only; a log that does not exist yet verifies as empty.",
    input: z.strictObject({}),
    output: VerifyOutput,
    annotations: { title: "Verify okgate audit log", ...READ_ONLY },
    async handler() {
      const { loaded } = runtime;
      const audit = readAudit(loaded.auditPath);
      if (audit.error) {
        return {
          configured: runtime.configured,
          path: loaded.auditPath,
          exists: true,
          ok: false,
          entries: 0,
          head_hash: null,
          broken_at: null,
          reason: audit.error,
        };
      }
      const result = await verifyChain(audit.entries);
      return {
        configured: runtime.configured,
        path: loaded.auditPath,
        exists: audit.exists,
        ok: result.ok,
        entries: result.entries,
        // an empty chain's head is the genesis hash, which is not an entry anyone can record
        head_hash: result.entries > 0 ? (result.head ?? null) : null,
        broken_at: result.brokenAt ?? null,
        reason: result.reason ?? null,
      };
    },
  });

  return [status, report, verify];
}

export type OwnTool = ReturnType<typeof createOwnTools>[number];

/** Own tools are served only when the proxy fronts no upstream at all. */
export function ownToolsActive(runtime: ProxyRuntime): boolean {
  return runtime.upstreamStatus().length === 0;
}

/** The MCP `tools/list` entries for the own tools. */
export function ownToolList(tools: readonly OwnTool[]): Tool[] {
  return listToolManifest(tools) as Tool[];
}

/**
 * Run an own tool. An `okgate_*` name (the product's name before the rename) runs its
 * `okgate_*` twin with a deprecation note in `_meta` until OLD_NAMES_UNTIL, then answers
 * TOOL_RENAMED. tools/list shows only the new names.
 */
export async function callOwnTool(
  tools: readonly OwnTool[],
  name: string,
  args: unknown,
  requestId?: string,
  now: Date = new Date(),
): Promise<CallToolResult | undefined> {
  const resolved = resolveToolName(name, (n) => tools.some((t) => t.name === n), now);
  if (resolved.kind === "expired")
    return {
      isError: true,
      content: [{ type: "text", text: JSON.stringify(resolved.error) }],
      _meta: { httpStatus: 404 },
    };
  const tool = tools.find((t) => t.name === resolved.name);
  if (!tool) return undefined;
  const result = (await tool.invoke(args, createToolContext({ requestId }))) as CallToolResult;
  if (resolved.kind === "renamed")
    return { ...result, _meta: { ...result._meta, ...resolved.meta } };
  return result;
}
