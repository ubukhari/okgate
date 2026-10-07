/**
 * `agentguard proxy` — stdio by default (what MCP clients spawn), `--http` for Streamable HTTP
 * with the control endpoints. Logs go to stderr only; stdout is the MCP channel.
 */
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { serveStdio } from "@agentwares/mcp-kit";
import { Guard, defaultPolicy, resolveAgent } from "@agentwares/agentguard-core";
import { FileKillSwitch, resolvePath, type LoadedPolicy } from "@agentwares/agentguard-core/node";
import { flagBool, flagNumber, flagString, type ParsedArgs } from "../args.js";
import { createFileGuard, loadPolicyFor, policyPathFrom, type Io } from "../context.js";
import { startHttpProxy } from "../proxy/http.js";
import { INIT_COMMAND } from "../proxy/own-tools.js";
import { ProxyRuntime } from "../proxy/runtime.js";
import { createDownstreamServer } from "../proxy/server.js";

export function newRunId(now: Date = new Date()): string {
  return `run_${now
    .toISOString()
    .replace(/[-:.TZ]/g, "")
    .slice(0, 14)}_${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * The policy agentguard runs on when no `agentguard.yaml` exists and none was named: the
 * defaults, no upstreams, paths resolved where the file would be. It is what an install button
 * or a registry install starts before `init` has run. Nothing is written for it: the guard built
 * on it keeps counters, audit and approvals in memory, so the proxy leaves no `.agentguard/` in
 * whatever directory the client spawned it in.
 *
 * `undefined` when a policy file exists, or when one was named with `--config` or
 * `AGENTGUARD_CONFIG` — a named file that is missing is still an error.
 */
export function unconfiguredPolicy(args: ParsedArgs, io: Io): LoadedPolicy | undefined {
  if (flagString(args, "config") !== undefined || io.env.AGENTGUARD_CONFIG) return undefined;
  const path = policyPathFrom(args, io);
  if (existsSync(path)) return undefined;
  const policy = defaultPolicy();
  const baseDir = dirname(path);
  return {
    policy,
    path,
    baseDir,
    stateDir: resolvePath(policy.state.dir, baseDir),
    auditPath: resolvePath(policy.audit.path, baseDir),
    killPath: resolvePath(policy.kill.file, baseDir),
  };
}

async function serveOverStdio(runtime: ProxyRuntime): Promise<number> {
  const server = createDownstreamServer(runtime);
  const stop = async (): Promise<void> => {
    await runtime.close();
  };
  process.once("SIGINT", () => void stop().then(() => process.exit(0)));
  process.once("SIGTERM", () => void stop().then(() => process.exit(0)));
  await serveStdio(server);
  await stop();
  return 0;
}

export async function proxyCommand(args: ParsedArgs, io: Io): Promise<number> {
  const log = (line: string): void => io.err(`[agentguard] ${line}`);
  const modeOverride = flagString(args, "mode");
  const http = flagBool(args, "http") === true;

  // No policy file and none named: serve agentguard's own read-only tools over stdio rather than
  // exit, so a client that installed it from a button or a registry gets a working server that
  // says how to set it up. `--http` still needs a policy (it writes its control token beside it).
  const unconfigured = http ? undefined : unconfiguredPolicy(args, io);
  if (unconfigured) {
    if (modeOverride === "dry-run" || modeOverride === "enforce")
      unconfigured.policy.mode = modeOverride;
    const runtime = new ProxyRuntime({
      loaded: unconfigured,
      guard: new Guard({
        policy: unconfigured.policy,
        env: io.env,
        kill: new FileKillSwitch(unconfigured.killPath),
      }),
      configured: false,
      defaultRunId: flagString(args, "run-id") ?? newRunId(),
      log,
    });
    await runtime.start();
    log(
      `no policy file at ${unconfigured.path}: serving agentguard's own read-only tools only. To guard your MCP servers, run \`${INIT_COMMAND}\` in the project directory.`,
    );
    return serveOverStdio(runtime);
  }

  const loaded = loadPolicyFor(args, io);
  if (modeOverride === "dry-run" || modeOverride === "enforce") loaded.policy.mode = modeOverride;

  const agentName = flagString(args, "agent");
  let agent = undefined;
  if (agentName) {
    const resolved = await resolveAgent(loaded.policy, { name: agentName });
    if (resolved.error) {
      io.err(
        `unknown agent "${agentName}" — agents in agentguard.yaml: ${loaded.policy.agents.map((a) => a.name).join(", ") || "none"}`,
      );
      return 1;
    }
    agent = resolved.agent;
  }

  let approvalBase: { baseUrl: string; token: string } | undefined;
  const fileGuard = createFileGuard(loaded, {
    log,
    env: io.env,
    approvalUrl: (r) =>
      approvalBase
        ? `${approvalBase.baseUrl}/approve/${r.id}?token=${approvalBase.token}`
        : undefined,
    onEvent: (e) => {
      if (e.type === "APPROVAL_DECIDED") return;
      log(`${e.type} ${e.tool} (run ${e.runId})${e.error ? `: ${e.error.cause}` : ""}`);
      if (e.type === "APPROVAL_REQUIRED" && e.approval)
        log(`approve with: agentguard approve ${e.approval.id}`);
    },
  });
  const runtime = new ProxyRuntime({
    loaded,
    guard: fileGuard.guard,
    agent,
    defaultRunId: flagString(args, "run-id") ?? newRunId(),
    log,
  });
  await runtime.start();
  const killed = await fileGuard.kill.check();
  if (killed.killed)
    log(
      `kill switch is ON (${killed.reason}); every call returns KILLED until \`agentguard resume\``,
    );
  if (runtime.upstreamStatus().length === 0)
    log(
      `${loaded.path} lists no upstreams: serving agentguard's own read-only tools only. Add servers under \`upstreams:\` to guard them.`,
    );

  if (http) {
    const server = await startHttpProxy({
      runtime,
      port: flagNumber(args, "port") ?? 8788,
      host: flagString(args, "host") ?? "127.0.0.1",
      token: io.env.AGENTGUARD_HTTP_TOKEN,
    });
    approvalBase = { baseUrl: server.url.replace(/\/mcp$/, ""), token: server.token };
    log(
      `Streamable HTTP at ${server.url} · GET ${approvalBase.baseUrl}/health · control token in ${loaded.stateDir}/http.json`,
    );
    log(
      `point your agent at ${server.url} (send X-Run-Id per run; Authorization: Bearer <agent key> for scoped agents)`,
    );
    const stop = async (): Promise<void> => {
      await server.close();
      await runtime.close();
      process.exit(0);
    };
    process.once("SIGINT", () => void stop());
    process.once("SIGTERM", () => void stop());
    await new Promise<never>(() => undefined);
  }

  return serveOverStdio(runtime);
}
