/**
 * agentguard with no upstream servers: its own read-only tools, as an MCP client sees them.
 * In-process over InMemoryTransport, against temp directories, so every file the proxy reads or
 * (must not) write is checked for real.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Guard, parsePolicy } from "@agentwares/agentguard-core";
import {
  FileKillSwitch,
  loadPolicyFile,
  type LoadedPolicy,
} from "@agentwares/agentguard-core/node";
import { parseArgs } from "../args.js";
import { unconfiguredPolicy } from "../commands/proxy.js";
import { createFileGuard, type Io } from "../context.js";
import { createCrmMcpServer, seedState } from "../fixtures/crm-server.js";
import { ProxyRuntime } from "./runtime.js";
import { createDownstreamServer } from "./server.js";

const OWN = ["agentguard_get_status", "agentguard_get_report", "agentguard_verify_audit_log"];

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agentguard-own-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function ioFor(dir: string, env: NodeJS.ProcessEnv = {}): Io {
  return { out: () => undefined, err: () => undefined, cwd: dir, env };
}

async function connect(
  runtime: ProxyRuntime,
): Promise<{ client: Client; instructions: string | undefined }> {
  await runtime.start();
  const server = createDownstreamServer(runtime);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "agent", version: "test" });
  await client.connect(clientT);
  cleanups.push(async () => {
    await client.close();
    await server.close();
    await runtime.close();
  });
  return { client, instructions: client.getInstructions() };
}

/** The proxy as `npx @agentwares/agentguard` starts it in a directory with no policy file. */
async function unconfigured(dir: string, env: NodeJS.ProcessEnv = {}) {
  const loaded = unconfiguredPolicy(parseArgs(["proxy"]), ioFor(dir, env));
  expect(loaded).toBeDefined();
  const runtime = new ProxyRuntime({
    loaded: loaded!,
    guard: new Guard({ policy: loaded!.policy, env, kill: new FileKillSwitch(loaded!.killPath) }),
    configured: false,
    defaultRunId: "run_unconfigured",
    log: () => undefined,
  });
  return connect(runtime);
}

/** A real policy file with no upstreams, on the file-backed guard the CLI uses. */
function configured(dir: string, yaml = "mode: dry-run\n"): { loaded: LoadedPolicy; guard: Guard } {
  writeFileSync(join(dir, "agentguard.yaml"), yaml);
  const loaded = loadPolicyFile(join(dir, "agentguard.yaml"), { env: {} });
  return { loaded, guard: createFileGuard(loaded, { alerts: false, env: {} }).guard };
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

const body = (r: CallToolResult): Record<string, unknown> =>
  JSON.parse(r.content.find((c) => c.type === "text")?.text ?? "{}") as Record<string, unknown>;

/** What scripts/check-tool-schemas.mjs enforces on every served tool, plus the directory rules. */
function schemaFindings(tool: Tool): string[] {
  const out: string[] = [];
  const schema = tool.inputSchema as {
    properties?: Record<string, { description?: string }>;
    additionalProperties?: unknown;
  };
  if (!/^agentguard_[a-z]+(_[a-z]+)+$/.test(tool.name)) out.push("not namespaced agentguard_*");
  if (!tool.description || tool.description.length < 40) out.push("description too thin");
  if (schema.additionalProperties !== false) out.push("additionalProperties is not false");
  for (const [field, spec] of Object.entries(schema.properties ?? {}))
    if (!spec.description) out.push(`field ${field} undescribed`);
  if (!tool.title) out.push("no title");
  if (tool.annotations?.readOnlyHint !== true) out.push("not readOnlyHint");
  if (tool.annotations?.destructiveHint !== false) out.push("destructiveHint not false");
  if (!tool.outputSchema) out.push("no outputSchema");
  return out;
}

describe("no upstreams: agentguard's own tools", () => {
  it("lists exactly the three read-only tools, each titled, annotated and strict", async () => {
    const { client, instructions } = await unconfigured(tempDir());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(OWN);
    for (const tool of tools)
      expect({ [tool.name]: schemaFindings(tool) }).toEqual({ [tool.name]: [] });
    expect(instructions).toContain("npx -y @agentwares/agentguard init");
  });

  it("with no policy file, answers every tool and writes nothing where it was started", async () => {
    const dir = tempDir();
    const { client } = await unconfigured(dir);

    const status = await call(client, "agentguard_get_status");
    expect(status.isError).toBeFalsy();
    expect(status.structuredContent).toMatchObject({
      configured: false,
      policy_path: join(dir, "agentguard.yaml"),
      mode: "dry-run",
      upstreams: [],
      run_id: null,
      kill_switch: { on: false },
      pending_approvals: 0,
      audit_log: { path: join(dir, ".agentguard", "audit.jsonl"), entries: 0 },
    });
    expect(String(status.structuredContent?.next_step)).toContain(
      "npx -y @agentwares/agentguard init",
    );

    const report = await call(client, "agentguard_get_report");
    expect(report.isError).toBeFalsy();
    expect(report.structuredContent).toMatchObject({
      configured: false,
      run_id: null,
      runs_in_log: 0,
    });
    expect(String(report.structuredContent?.markdown)).toContain("No runs recorded");

    const verify = await call(client, "agentguard_verify_audit_log");
    expect(verify.structuredContent).toMatchObject({
      configured: false,
      exists: false,
      ok: true,
      entries: 0,
      head_hash: null,
    });

    expect(readdirSync(dir)).toEqual([]);
  });

  it("reports the kill switch from the environment", async () => {
    const { client } = await unconfigured(tempDir(), { AGENTGUARD_KILL: "1" });
    const status = await call(client, "agentguard_get_status");
    expect(status.structuredContent).toMatchObject({ kill_switch: { on: true } });
  });

  it("reads the runs another agentguard process recorded, and verifies the chain", async () => {
    const dir = tempDir();
    const { loaded, guard } = configured(dir, "mode: dry-run\ncaps:\n  per_run: { writes: 5 }\n");
    // Another proxy on the same policy ran an agent: a read, a faked delete, a faked create.
    const exec = async (): Promise<unknown> => ({ ok: true });
    await guard.run({ tool: { name: "crm_list_contacts" }, args: {}, runId: "run_a" }, exec);
    await guard.run(
      { tool: { name: "crm_delete_contact" }, args: { id: "c_1" }, runId: "run_a" },
      exec,
    );
    await guard.run(
      { tool: { name: "crm_create_contact" }, args: { name: "n", email: "n@x" }, runId: "run_a" },
      exec,
    );

    const { client } = await connect(
      new ProxyRuntime({ loaded, guard, defaultRunId: "run_b", log: () => undefined }),
    );
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(OWN);

    const status = await call(client, "agentguard_get_status");
    expect(status.structuredContent).toMatchObject({
      configured: true,
      run_id: "run_a",
      caps: { per_run: { writes: 5 } },
      used: { per_run: { writes: 2 } },
      remaining: { writes: { per_run: 3 } },
      audit_log: { entries: 3 },
    });
    expect(String(status.structuredContent?.next_step)).toContain("upstreams:");

    const report = await call(client, "agentguard_get_report");
    expect(report.structuredContent).toMatchObject({
      configured: true,
      run_id: "run_a",
      runs_in_log: 1,
      tool_calls: 3,
      would_have: { deletes: 1, creates: 1 },
      did: { writes: 0 },
    });
    expect(String(report.structuredContent?.markdown)).toContain("run_a");

    const verify = await call(client, "agentguard_verify_audit_log");
    expect(verify.structuredContent).toMatchObject({ exists: true, ok: true, entries: 3 });
    expect(verify.structuredContent?.head_hash).toMatch(/^[0-9a-f]{64}$/);

    // An edited entry breaks the chain, and the tool says where.
    const lines = readFileSync(loaded.auditPath, "utf8").trimEnd().split("\n");
    lines[1] = lines[1]!.replace("crm_delete_contact", "crm_get_contact");
    writeFileSync(loaded.auditPath, lines.join("\n") + "\n");
    const broken = await call(client, "agentguard_verify_audit_log");
    expect(broken.structuredContent).toMatchObject({ ok: false, broken_at: 2 });
  });

  it("errors carry code, cause, fix and retryable", async () => {
    const { client } = await unconfigured(tempDir());

    const unknownRun = await call(client, "agentguard_get_report", { run_id: "run_nope" });
    expect(unknownRun.isError).toBe(true);
    expect(body(unknownRun)).toMatchObject({ code: "NOT_FOUND", retryable: false });
    expect(String(body(unknownRun).fix)).toContain("without run_id");

    const misspelled = await call(client, "agentguard_get_status", { runid: "run_a" });
    expect(misspelled.isError).toBe(true);
    expect(body(misspelled)).toMatchObject({ code: "INVALID_INPUT", retryable: false });
  });

  it("is not listed once an upstream is configured: the agent's tool surface is unchanged", async () => {
    const policy = parsePolicy({ mode: "dry-run" });
    const crmServer = createCrmMcpServer(seedState());
    const [upClientT, upServerT] = InMemoryTransport.createLinkedPair();
    await crmServer.connect(upServerT);
    const upstream = new Client({ name: "agentguard", version: "test" });
    await upstream.connect(upClientT);
    cleanups.push(() => crmServer.close());
    const loaded: LoadedPolicy = {
      policy,
      path: "/tmp/agentguard.yaml",
      baseDir: "/tmp",
      stateDir: "/tmp/.agentguard",
      auditPath: "/tmp/audit.jsonl",
      killPath: "/tmp/KILL",
    };
    const { client, instructions } = await connect(
      new ProxyRuntime({
        loaded,
        guard: new Guard({ policy, env: {} }),
        defaultRunId: "run_test",
        log: () => undefined,
        clients: { crm: upstream },
      }),
    );
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("crm_delete_contact");
    for (const own of OWN) expect(names).not.toContain(own);
    expect(instructions).toContain("Tool calls pass through agentguard");
    const res = await call(client, "agentguard_get_status");
    expect(body(res)).toMatchObject({ code: "UNKNOWN_TOOL" });
  });
});

describe("unconfiguredPolicy", () => {
  it("applies only when no policy file exists and none was named", () => {
    const dir = tempDir();
    expect(unconfiguredPolicy(parseArgs([]), ioFor(dir))?.path).toBe(join(dir, "agentguard.yaml"));
    expect(
      unconfiguredPolicy(parseArgs(["proxy", "--config", "x.yaml"]), ioFor(dir)),
    ).toBeUndefined();
    expect(
      unconfiguredPolicy(parseArgs(["proxy"]), ioFor(dir, { AGENTGUARD_CONFIG: "x.yaml" })),
    ).toBeUndefined();
    writeFileSync(join(dir, "agentguard.yaml"), "mode: enforce\n");
    expect(unconfiguredPolicy(parseArgs(["proxy"]), ioFor(dir))).toBeUndefined();
  });
});
