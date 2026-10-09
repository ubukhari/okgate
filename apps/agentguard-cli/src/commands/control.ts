/**
 * `okgate kill|resume|approve|deny|approvals` — the human side of the loop.
 */
import { KILL_ENV, LEGACY_KILL_ENV } from "@agentwares/agentguard-core";
import { flagBool, flagString, type ParsedArgs } from "../args.js";
import { createFileGuard, loadPolicyFor, readRegistration, type Io } from "../context.js";

async function pokeHttp(
  io: Io,
  reg: ReturnType<typeof readRegistration>,
  path: string,
  body?: unknown,
): Promise<void> {
  if (!reg) return;
  try {
    const res = await fetch(`${reg.baseUrl}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${reg.token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok)
      io.err(
        `running proxy at ${reg.baseUrl} answered ${res.status} (the file switch still applies)`,
      );
  } catch {
    io.err(
      `no proxy answering at ${reg.baseUrl} (stale ${reg.pid}?) — the file switch still applies`,
    );
  }
}

export async function killCommand(args: ParsedArgs, io: Io): Promise<number> {
  const loaded = loadPolicyFor(args, io, { allowMissingEnv: true });
  const { kill } = createFileGuard(loaded, { alerts: false, env: io.env });
  const reason =
    args.positionals.join(" ") ||
    flagString(args, "reason") ||
    `okgate kill by ${io.env.USER ?? "operator"}`;
  kill.kill(reason);
  await pokeHttp(io, readRegistration(loaded), "/kill", { reason });
  io.out(
    `KILLED: ${kill.path} written — every tool call through this policy now returns KILLED. Clear with: okgate resume`,
  );
  return 0;
}

export async function resumeCommand(args: ParsedArgs, io: Io): Promise<number> {
  const loaded = loadPolicyFor(args, io, { allowMissingEnv: true });
  const { kill } = createFileGuard(loaded, { alerts: false, env: io.env });
  kill.resume();
  await pokeHttp(io, readRegistration(loaded), "/resume");
  io.out(`resumed: ${kill.path} removed`);
  for (const name of new Set([loaded.policy.kill.env, KILL_ENV, LEGACY_KILL_ENV]))
    if (io.env[name] && io.env[name] !== "0" && io.env[name]!.toLowerCase() !== "false")
      io.err(
        `note: ${name} is set in this shell's environment; proxies started from it stay killed`,
      );
  return 0;
}

export async function decideCommand(
  decision: "approved" | "denied",
  args: ParsedArgs,
  io: Io,
): Promise<number> {
  const id = args.positionals[0];
  if (!id) {
    io.err(
      `usage: okgate ${decision === "approved" ? "approve" : "deny"} <approval-id> [--by name] [--note text]`,
    );
    return 1;
  }
  const loaded = loadPolicyFor(args, io, { allowMissingEnv: true });
  const { guard } = createFileGuard(loaded, { alerts: false, env: io.env });
  const record = await guard.decide(
    id,
    decision,
    flagString(args, "by") ?? io.env.USER ?? "cli",
    flagString(args, "note"),
  );
  if (!record) {
    io.err(`no approval ${id} — pending ones: okgate approvals`);
    return 1;
  }
  io.out(
    `${record.status}: ${record.tool} (${record.id}, run ${record.run_id})${record.status === "approved" ? " — the agent may now retry the identical call once" : ""}`,
  );
  return 0;
}

export async function approvalsCommand(args: ParsedArgs, io: Io): Promise<number> {
  const loaded = loadPolicyFor(args, io, { allowMissingEnv: true });
  const { guard } = createFileGuard(loaded, { alerts: false, env: io.env });
  const list = await guard.approvals.list(flagBool(args, "all") ? undefined : "pending");
  if (flagBool(args, "json")) {
    io.out(JSON.stringify(list, null, 2));
    return 0;
  }
  if (list.length === 0) {
    io.out(flagBool(args, "all") ? "no approvals recorded" : "no pending approvals");
    return 0;
  }
  for (const r of list) {
    io.out(
      `${r.id}  ${r.status.padEnd(9)} ${r.tool}  run ${r.run_id}${r.agent ? ` agent ${r.agent}` : ""}  expires ${r.expires_at}`,
    );
    io.out(`  args: ${JSON.stringify(r.args).slice(0, 300)}`);
    if (r.status === "pending") io.out(`  → okgate approve ${r.id}   |   okgate deny ${r.id}`);
  }
  return 0;
}
