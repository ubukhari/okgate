/**
 * agentguard → okgate (REN-1). `init` and `hooks install` wrote the old names into other people's
 * committed files, so the old names have to keep working, not just point somewhere:
 *
 * - an old hook entry still enforces;
 * - an old tool name still works;
 * - the old config file and environment variables still apply;
 * - the kill switch still halts, under either name.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OLD_NAMES_UNTIL } from "@agentwares/agentguard-core";
import { readAuditFile, verifyAuditFile } from "@agentwares/agentguard-core/node";
import { parseArgs } from "./args.js";
import { main } from "./cli.js";
import { runPermissionDiff } from "./commands/permission-diff.js";
import { unconfiguredPolicy } from "./commands/proxy.js";
import { createFileGuard, policyPathFrom, type Io } from "./context.js";
import { INSTALL, npxCommand } from "./install.js";
import { callOwnTool, createOwnTools } from "./proxy/own-tools.js";
import { version } from "./version.js";
import { ProxyRuntime } from "./proxy/runtime.js";
import { createDownstreamServer } from "./proxy/server.js";

const tsxLoader = fileURLToPath(import.meta.resolve("tsx"));
const cliTs = fileURLToPath(new URL("./cli.ts", import.meta.url));

let dir: string;
let home: string;
let out: string[];
let err: string[];
let stdin: string;
let io: Io;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "okgate-rename-"));
  home = join(dir, "home");
  mkdirSync(home);
  out = [];
  err = [];
  stdin = "";
  io = {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    cwd: dir,
    env: { PATH: process.env.PATH, HOME: home, USER: "tester" },
    stdin: async () => stdin,
  };
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A project as agentguard 0.1.x left it: agentguard.yaml, .agentguard/, and its hook entry. */
const OLD_HOOK = "npx -y @agentwares/agentguard@0.1.9 hook pre-tool-use --client claude";
function legacyProject(
  policy = 'version: 1\nhooks:\n  mode: enforce\n  shell:\n    deny: ["terraform destroy*"]\n',
): void {
  writeFileSync(join(dir, "agentguard.yaml"), policy);
  mkdirSync(join(dir, ".agentguard"));
  mkdirSync(join(dir, ".claude"));
  writeFileSync(
    join(dir, ".claude", "settings.json"),
    JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: "^(Bash)$",
            hooks: [
              { type: "command", command: OLD_HOOK, timeout: 30, statusMessage: "agentguard" },
            ],
          },
        ],
      },
    }),
  );
}

const bashInput = (command: string): string =>
  JSON.stringify({
    session_id: "sess-1",
    cwd: dir,
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command },
    tool_use_id: "toolu_1",
  });

async function hook(
  command: string,
  env: Record<string, string> = {},
): Promise<Record<string, unknown> | undefined> {
  stdin = bashInput(command);
  out = [];
  expect(
    await main(["hook", "pre-tool-use", "--client", "claude"], {
      ...io,
      env: { ...io.env, ...env },
    }),
  ).toBe(0);
  return out[0] ? (JSON.parse(out[0]) as Record<string, unknown>) : undefined;
}
const codeOf = (res: Record<string, unknown> | undefined): string | undefined =>
  (
    JSON.parse(
      (res?.hookSpecificOutput as { permissionDecisionReason?: string } | undefined)
        ?.permissionDecisionReason ?? "{}",
    ) as { code?: string }
  ).code;

describe("an old hook entry still enforces", () => {
  it("the command an agentguard-era entry runs reads agentguard.yaml and continues .agentguard/", async () => {
    legacyProject();
    expect(codeOf(await hook("terraform destroy -auto-approve"))).toBe("TOOL_DENIED");
    expect(await hook("ls")).toBeUndefined();
    const log = join(dir, ".agentguard", "audit.jsonl");
    expect(readAuditFile(log)).toHaveLength(2);
    expect(await verifyAuditFile(log)).toMatchObject({ ok: true });
    expect(existsSync(join(dir, ".okgate"))).toBe(false);
  });

  it("runs under the agentguard bin name, as `npx @agentwares/agentguard` starts it", () => {
    legacyProject();
    const bin = join(dir, "bin");
    mkdirSync(bin);
    symlinkSync(cliTs, join(bin, "agentguard"));
    const run = spawnSync(
      process.execPath,
      [
        "--import",
        tsxLoader,
        join(bin, "agentguard"),
        "hook",
        "pre-tool-use",
        "--client",
        "claude",
      ],
      {
        cwd: dir,
        input: bashInput("terraform destroy"),
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "", HOME: home },
      },
    );
    expect(run.status).toBe(0);
    expect(codeOf(JSON.parse(run.stdout) as Record<string, unknown>)).toBe("TOOL_DENIED");
  });

  it("hooks status and uninstall recognise it; install replaces it with one okgate entry", async () => {
    legacyProject();
    await main(["hooks", "status"], io);
    expect(out.join("\n")).toContain(`installed: ${OLD_HOOK}`);

    out = [];
    expect(await main(["hooks", "install"], io)).toBe(0);
    const settings = JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf8")) as {
      hooks: { PreToolUse: { hooks: { command: string; statusMessage: string }[] }[] };
    };
    const entries = settings.hooks.PreToolUse.flatMap((g) => g.hooks);
    expect(entries).toHaveLength(1);
    // the package npm serves the okgate bin from, pinned to this build
    expect(entries[0]!.command).toBe(`${npxCommand(version())} hook pre-tool-use --client claude`);
    expect(entries[0]!.command).toMatch(/okgate(@[^ ]+)? hook pre-tool-use/);
    expect(entries[0]!.statusMessage).toBe("okgate");
    // the original stays backed up once, under the name it was first backed up as
    expect(existsSync(join(dir, ".claude", "settings.json.okgate-backup"))).toBe(true);
    expect(existsSync(join(dir, "okgate.yaml"))).toBe(false); // kept agentguard.yaml

    out = [];
    expect(await main(["hooks", "uninstall"], io)).toBe(0);
    expect(out.join("\n")).toContain("removed Claude Code hook");
  });

  it("an agent may not approve its own held action through either bin", async () => {
    legacyProject(
      'version: 1\nhooks:\n  mode: enforce\n  shell:\n    approval: ["kubectl delete *"]\n',
    );
    const held = await hook("kubectl delete pod x");
    expect(codeOf(held)).toBe("APPROVAL_REQUIRED");
    expect(JSON.stringify(held)).toContain(`${INSTALL} approve apr_`);
    for (const cmd of [
      "agentguard approve apr_x",
      `${INSTALL} approve apr_x`,
      "okgate approve apr_x",
    ])
      expect(codeOf(await hook(cmd)), cmd).toBe("TOOL_DENIED");
  });
});

describe("the kill switch under either name", () => {
  it("AGENTGUARD_KILL=1 halts the hook in dry-run and in enforce", async () => {
    for (const mode of ["dry-run", "enforce"]) {
      writeFileSync(join(dir, "okgate.yaml"), `version: 1\nhooks:\n  mode: ${mode}\n`);
      expect(codeOf(await hook("ls", { AGENTGUARD_KILL: "1" })), mode).toBe("KILLED");
      expect(codeOf(await hook("ls", { OKGATE_KILL: "1" })), mode).toBe("KILLED");
    }
  });

  it("a KILL file an agentguard-era CLI wrote halts; okgate kill reaches both; resume clears both", async () => {
    legacyProject("version: 1\nhooks:\n  mode: dry-run\n");
    writeFileSync(join(dir, ".agentguard", "KILL"), "agentguard kill by ops\n");
    expect(codeOf(await hook("ls"))).toBe("KILLED");
    expect(await main(["resume"], io)).toBe(0);
    expect(await hook("ls")).toBeUndefined();

    mkdirSync(join(dir, ".okgate"));
    expect(await main(["kill", "incident"], io)).toBe(0);
    expect(existsSync(join(dir, ".agentguard", "KILL"))).toBe(true);
    expect(existsSync(join(dir, ".okgate", "KILL"))).toBe(true);
    expect(codeOf(await hook("ls"))).toBe("KILLED");
  });

  it("AGENTGUARD_KILL=1 halts the MCP proxy, and status says so", async () => {
    writeFileSync(join(dir, "okgate.yaml"), "mode: enforce\n");
    const loaded = createFileGuard(
      (await import("@agentwares/agentguard-core/node")).loadPolicyFile(join(dir, "okgate.yaml")),
      { env: { AGENTGUARD_KILL: "1" }, alerts: false },
    );
    const state = await loaded.guard.killState();
    expect(state).toMatchObject({ killed: true, source: "env" });
    // `status` reports every source the guard halts on, not only the KILL file
    out = [];
    expect(await main(["status"], { ...io, env: { ...io.env, AGENTGUARD_KILL: "1" } })).toBe(0);
    expect(out.join("\n")).toMatch(/^kill\s+ON — AGENTGUARD_KILL=1/m);
    out = [];
    expect(await main(["status"], io)).toBe(0);
    expect(out.join("\n")).toMatch(/^kill\s+off/m);
  });
});

describe("the old config and environment variables still apply", () => {
  it("agentguard.yaml is read when there is no okgate.yaml; okgate.yaml wins when both exist", () => {
    const args = parseArgs(["status"]);
    expect(policyPathFrom(args, io)).toBe(join(dir, "okgate.yaml"));
    writeFileSync(join(dir, "agentguard.yaml"), "mode: dry-run\n");
    expect(policyPathFrom(args, io)).toBe(join(dir, "agentguard.yaml"));
    writeFileSync(join(dir, "okgate.yaml"), "mode: enforce\n");
    expect(policyPathFrom(args, io)).toBe(join(dir, "okgate.yaml"));
  });

  it("AGENTGUARD_CONFIG applies when OKGATE_CONFIG is unset", async () => {
    writeFileSync(
      join(dir, "legacy.yaml"),
      'mode: enforce\nhooks:\n  mode: enforce\n  shell:\n    deny: ["rm -rf /*"]\n',
    );
    writeFileSync(join(dir, "new.yaml"), "mode: dry-run\n");
    const args = parseArgs(["status"]);
    expect(policyPathFrom(args, { ...io, env: { AGENTGUARD_CONFIG: "legacy.yaml" } })).toBe(
      join(dir, "legacy.yaml"),
    );
    expect(
      policyPathFrom(args, {
        ...io,
        env: { AGENTGUARD_CONFIG: "legacy.yaml", OKGATE_CONFIG: "new.yaml" },
      }),
    ).toBe(join(dir, "new.yaml"));
    expect(
      codeOf(await hook("rm -rf /tmp/x", { AGENTGUARD_CONFIG: join(dir, "legacy.yaml") })),
    ).toBe("TOOL_DENIED");
    // a named file that is missing is an error, not the no-config mode
    expect(
      unconfiguredPolicy(args, { ...io, env: { AGENTGUARD_CONFIG: "nope.yaml" } }),
    ).toBeUndefined();
  });

  it("init --undo restores an agentguard-era backup; init sees the old proxy entry as itself", async () => {
    writeFileSync(join(dir, "agentguard.yaml"), "mode: dry-run\nupstreams: []\n");
    const original = { mcpServers: { crm: { command: "crm-server" } } };
    writeFileSync(join(dir, ".mcp.json.agentguard-backup"), JSON.stringify(original));
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          agentguard: {
            command: "npx",
            args: [
              "-y",
              "@agentwares/agentguard",
              "proxy",
              "--config",
              join(dir, "agentguard.yaml"),
            ],
          },
        },
      }),
    );
    expect(await main(["init", "--no-probe"], io)).toBe(0);
    expect(out.join("\n")).toContain("already initialized");
    expect(existsSync(join(dir, "okgate.yaml"))).toBe(false);

    out = [];
    expect(await main(["init", "--undo"], io)).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8"))).toEqual(original);
  });

  it("permission-diff still flags a widened agentguard.yaml", () => {
    const git = (...argv: string[]) =>
      execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...argv], { cwd: dir });
    git("init", "-q", "-b", "main");
    writeFileSync(join(dir, "agentguard.yaml"), "mode: dry-run\n");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    writeFileSync(join(dir, "agentguard.yaml"), "mode: enforce\n");
    git("commit", "-q", "-am", "widen");
    const result = runPermissionDiff(dir, { base: "main~1", head: "HEAD" });
    expect(result.files).toEqual(["agentguard.yaml"]);
    expect(result.findings.map((f) => `${f.severity} ${f.file}:${f.path}`)).toContain(
      "widen agentguard.yaml:mode",
    );
  });
});

describe("an old tool name still works", () => {
  async function connected(): Promise<Client> {
    const runtime = new ProxyRuntime({
      loaded: unconfiguredPolicy(parseArgs(["proxy"]), io)!,
      guard: createFileGuard(unconfiguredPolicy(parseArgs(["proxy"]), io)!, {
        alerts: false,
        env: {},
      }).guard,
      configured: false,
      defaultRunId: "r",
      log: () => undefined,
    });
    await runtime.start();
    const server = createDownstreamServer(runtime);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: "rename-test", version: "0" });
    await client.connect(b);
    return client;
  }

  it("tools/list shows only okgate_*; tools/call maps agentguard_* with a note in _meta", async () => {
    const client = await connected();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      "okgate_get_status",
      "okgate_get_report",
      "okgate_verify_audit_log",
    ]);
    for (const old of [
      "agentguard_get_status",
      "agentguard_get_report",
      "agentguard_verify_audit_log",
    ]) {
      const r = (await client.callTool({ name: old, arguments: {} })) as CallToolResult;
      expect(r.isError, old).toBeFalsy();
      expect(r._meta?.["okgate/deprecation"], old).toMatchObject({
        tool: old,
        renamed_to: old.replace("agentguard_", "okgate_"),
        accepted_until: OLD_NAMES_UNTIL,
      });
    }
    const current = (await client.callTool({
      name: "okgate_get_status",
      arguments: {},
    })) as CallToolResult;
    expect(current._meta?.["okgate/deprecation"]).toBeUndefined();
    await client.close();
  });

  it("answers TOOL_RENAMED after the window, with code, cause, fix and retryable: false", async () => {
    const runtime = new ProxyRuntime({
      loaded: unconfiguredPolicy(parseArgs(["proxy"]), io)!,
      guard: createFileGuard(unconfiguredPolicy(parseArgs(["proxy"]), io)!, {
        alerts: false,
        env: {},
      }).guard,
      configured: false,
      defaultRunId: "r",
      log: () => undefined,
    });
    const tools = createOwnTools(runtime);
    const after = new Date(Date.parse(`${OLD_NAMES_UNTIL}T00:00:00Z`) + 86_400_000);
    const r = (await callOwnTool(tools, "agentguard_get_status", {}, "1", after))!;
    expect(r.isError).toBe(true);
    const body = JSON.parse((r.content[0] as { text: string }).text) as Record<string, unknown>;
    expect(body).toMatchObject({
      code: "TOOL_RENAMED",
      retryable: false,
      fix: expect.stringContaining("okgate_get_status"),
      cause: expect.stringContaining("agentguard_get_status"),
    });
    // inside the window the same call runs
    expect(
      (await callOwnTool(tools, "agentguard_get_status", {}, "1", new Date("2026-11-01")))!.isError,
    ).toBeFalsy();
  });
});
