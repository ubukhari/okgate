/**
 * agentguard → okgate (REN-1): every old name keeps working. The kill switch above all: a kill
 * switch that silently stops working is the worst failure a rename can cause.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Guard } from "./guard.js";
import { assessHookAction, hookActionFromInput, type HookContext } from "./hook.js";
import {
  OLD_NAMES_UNTIL,
  envTwin,
  oldNamesAccepted,
  renamedToolName,
  resolveToolName,
} from "./names.js";
import {
  FileAuditSink,
  FileKillSwitch,
  findPolicyFile,
  killSwitchFor,
  loadPolicyFile,
  verifyAuditFile,
} from "./node/index.js";
import { parsePolicy } from "./policy.js";
import { extractRules } from "./rules.js";
import { keyFromHeaders } from "./scope.js";

const tool = { name: "crm_get_contact", annotations: { readOnlyHint: true } };
const run = (g: Guard) => g.run({ tool, args: {}, runId: "r" }, async () => ({ ok: true }));

describe("the kill switch under both names", () => {
  it("AGENTGUARD_KILL=1 halts a guard on the new defaults (OKGATE_KILL)", async () => {
    const g = new Guard({
      policy: parsePolicy({ mode: "enforce" }),
      env: { AGENTGUARD_KILL: "1" },
    });
    expect(g.policy.kill.env).toBe("OKGATE_KILL");
    const r = await run(g);
    expect(r.error).toMatchObject({ code: "KILLED", retryable: false });
    expect(r.error?.cause).toContain("AGENTGUARD_KILL=1");
  });

  it("OKGATE_KILL=1 halts, and so does AGENTGUARD_KILL when the policy names its own variable", async () => {
    expect(
      (await run(new Guard({ policy: parsePolicy({}), env: { OKGATE_KILL: "1" } }))).error?.code,
    ).toBe("KILLED");
    const custom = parsePolicy({ kill: { env: "MY_KILL" } });
    for (const env of [{ MY_KILL: "1" }, { AGENTGUARD_KILL: "1" }, { OKGATE_KILL: "true" }])
      expect((await run(new Guard({ policy: custom, env }))).error?.code).toBe("KILLED");
    expect((await run(new Guard({ policy: custom, env: { AGENTGUARD_KILL: "0" } }))).ok).toBe(true);
  });

  it("AGENTGUARD_KILL=1 halts a coding agent's hook in dry-run and enforce", async () => {
    const ctx: HookContext = {
      workspace: "/ws",
      tmpDirs: [],
      stateDir: "/ws/.okgate",
      guardFiles: [],
    };
    for (const mode of ["dry-run", "enforce"] as const) {
      const g = new Guard({
        policy: parsePolicy({ hooks: { mode } }),
        env: { AGENTGUARD_KILL: "1" },
      });
      const action = hookActionFromInput("claude-code", {
        session_id: "s",
        cwd: "/ws",
        tool_name: "Bash",
        tool_input: { command: "ls" },
      })!;
      const r = await g.preflight({
        action,
        assessment: assessHookAction(g.policy, action, ctx),
        runId: "cc_s",
      });
      expect(r.decision).toBe("deny");
      expect(r.error?.code).toBe("KILLED");
    }
  });
});

describe("files on disk under both names", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "okgate-rename-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("finds okgate.yaml first, then agentguard.yaml, else names okgate.yaml", () => {
    expect(findPolicyFile(dir)).toBe(join(dir, "okgate.yaml"));
    writeFileSync(join(dir, "agentguard.yaml"), "mode: dry-run\n");
    expect(findPolicyFile(dir)).toBe(join(dir, "agentguard.yaml"));
    writeFileSync(join(dir, "okgate.yaml"), "mode: enforce\n");
    expect(findPolicyFile(dir)).toBe(join(dir, "okgate.yaml"));
  });

  it("a fresh project gets .okgate/; one with only .agentguard/ keeps it", () => {
    const file = join(dir, "agentguard.yaml");
    writeFileSync(file, "mode: dry-run\n");
    expect(loadPolicyFile(file).stateDir).toBe(join(dir, ".okgate"));

    rmSync(join(dir, ".okgate"), { recursive: true, force: true });
    mkdirSync(join(dir, ".agentguard"));
    const legacy = loadPolicyFile(file);
    expect(legacy.stateDir).toBe(join(dir, ".agentguard"));
    expect(legacy.auditPath).toBe(join(dir, ".agentguard", "audit.jsonl"));
    expect(legacy.killPath).toBe(join(dir, ".agentguard", "KILL"));
    expect(legacy.alsoKillPaths).toEqual([join(dir, ".okgate", "KILL")]);

    // a path the person wrote is kept as written
    writeFileSync(file, "audit:\n  path: logs/a.jsonl\n");
    expect(loadPolicyFile(file).auditPath).toBe(join(dir, "logs", "a.jsonl"));
  });

  it("continues the hash chain in .agentguard/, and verify passes across the cut", async () => {
    // before the rename: the starter policy named .agentguard/ paths, and entries were written
    const file = join(dir, "agentguard.yaml");
    writeFileSync(file, "mode: enforce\nkill:\n  file: .agentguard/KILL\n");
    mkdirSync(join(dir, ".agentguard"));
    const before = new FileAuditSink(join(dir, ".agentguard", "audit.jsonl"));
    const entry = {
      ts: "2026-10-07T00:00:00Z",
      run_id: "r0",
      tool: "x",
      class: "read" as const,
      verb: "read" as const,
      mode: "enforce" as const,
      outcome: "ok" as const,
      args_hash: "h",
    };
    await before.append(entry);
    await before.append(entry);

    // after: the okgate loader picks the same log, and a guard appends to it
    const loaded = loadPolicyFile(file);
    expect(loaded.auditPath).toBe(join(dir, ".agentguard", "audit.jsonl"));
    const g = new Guard({
      policy: loaded.policy,
      audit: new FileAuditSink(loaded.auditPath),
      env: {},
    });
    expect((await run(g)).ok).toBe(true);
    expect(await verifyAuditFile(loaded.auditPath)).toMatchObject({ ok: true, entries: 3 });
    expect(existsSync(join(dir, ".okgate"))).toBe(false);
  });

  it("a KILL file under either name halts; kill writes both that exist; resume clears both", () => {
    const file = join(dir, "okgate.yaml");
    writeFileSync(file, "mode: enforce\n");
    mkdirSync(join(dir, ".okgate"));
    mkdirSync(join(dir, ".agentguard"));
    const loaded = loadPolicyFile(file);
    expect(loaded.killPath).toBe(join(dir, ".okgate", "KILL"));

    writeFileSync(join(dir, ".agentguard", "KILL"), "written by agentguard 0.1.9\n");
    const kill = killSwitchFor(loaded);
    expect(kill.check()).toMatchObject({ killed: true, reason: "written by agentguard 0.1.9" });
    kill.resume();
    expect(kill.check().killed).toBe(false);
    expect(existsSync(join(dir, ".agentguard", "KILL"))).toBe(false);

    kill.kill("incident");
    expect(existsSync(join(dir, ".okgate", "KILL"))).toBe(true);
    expect(existsSync(join(dir, ".agentguard", "KILL"))).toBe(true);
    // an agentguard-era switch on its own path sees it
    expect(new FileKillSwitch(join(dir, ".agentguard", "KILL")).check().killed).toBe(true);
  });
});

describe("hook rules recognise both names", () => {
  const ctx: HookContext = {
    workspace: "/ws",
    tmpDirs: ["/tmp"],
    stateDir: "/ws/.agentguard",
    guardFiles: ["/ws/agentguard.yaml"],
  };
  const assess = (command: string) =>
    assessHookAction(
      parsePolicy({}),
      hookActionFromInput("claude-code", {
        session_id: "s",
        cwd: "/ws",
        tool_name: "Bash",
        tool_input: { command },
      })!,
      ctx,
    );

  it("the agent approving its own held action, under either name", () => {
    for (const cmd of [
      "okgate approve apr_1",
      "npx -y -p @agentwares/agentguard okgate approve apr_1",
      "npx -y -p @agentwares/agentguard@0.1.10 okgate resume",
      "npx -y @agentwares/okgate@0.2.0 deny apr_1",
      "agentguard approve apr_1",
    ])
      expect(assess(cmd).denied?.details, cmd).toMatchObject({ rule: "okgate-self" });
    expect(assess("okgate kill runaway").denied).toBeUndefined();
    expect(assess("npx -p @agentwares/agentguard okgate hooks uninstall").irreversible).toEqual([
      expect.objectContaining({ rule: "guard-config" }),
    ]);
  });

  it("writing either state directory is refused", () => {
    expect(assess("rm .agentguard/KILL").denied).toBeDefined();
    expect(assess("rm .okgate/KILL").denied).toBeDefined();
    expect(assess("cat .okgate/audit.jsonl").denied).toBeUndefined();
  });
});

describe("tool names", () => {
  const served = new Set(["okgate_get_status", "okgate_get_report"]);
  const exists = (n: string) => served.has(n);
  const inside = new Date("2026-11-01T00:00:00Z");
  const after = new Date(Date.parse(`${OLD_NAMES_UNTIL}T00:00:00Z`) + 24 * 60 * 60 * 1000);

  it("maps an old name to the new one inside the window, with a deprecation note", () => {
    expect(renamedToolName("agentguard_get_status")).toBe("okgate_get_status");
    const r = resolveToolName("agentguard_get_status", exists, inside);
    expect(r).toMatchObject({ kind: "renamed", name: "okgate_get_status" });
    expect(r.kind === "renamed" && r.meta["okgate/deprecation"]).toMatchObject({
      renamed_to: "okgate_get_status",
      accepted_until: OLD_NAMES_UNTIL,
    });
    expect(resolveToolName("okgate_get_status", exists, inside)).toEqual({
      kind: "current",
      name: "okgate_get_status",
    });
    // an old name with no new twin fails as any unknown tool does
    expect(resolveToolName("agentguard_nope", exists, inside).kind).toBe("current");
  });

  it("answers TOOL_RENAMED after the window", () => {
    expect(oldNamesAccepted(new Date(`${OLD_NAMES_UNTIL}T23:59:59Z`))).toBe(true);
    expect(oldNamesAccepted(after)).toBe(false);
    const r = resolveToolName("agentguard_get_report", exists, after);
    expect(r.kind).toBe("expired");
    expect(r.kind === "expired" && r.error).toMatchObject({
      code: "TOOL_RENAMED",
      retryable: false,
      fix: expect.stringContaining("okgate_get_report"),
      cause: expect.stringContaining("agentguard_get_report"),
    });
  });
});

describe("other old names", () => {
  it("OKGATE_<X> wins; AGENTGUARD_<X> applies when it is unset", () => {
    expect(envTwin({ AGENTGUARD_CONFIG: "a.yaml" }, "CONFIG")).toBe("a.yaml");
    expect(envTwin({ AGENTGUARD_CONFIG: "a.yaml", OKGATE_CONFIG: "" }, "CONFIG")).toBe("a.yaml");
    expect(envTwin({ AGENTGUARD_CONFIG: "a.yaml", OKGATE_CONFIG: "o.yaml" }, "CONFIG")).toBe(
      "o.yaml",
    );
    expect(envTwin({}, "CONFIG")).toBeUndefined();
  });

  it("an inline check comment under either name", () => {
    const { rules } = extractRules([
      {
        path: "CLAUDE.md",
        text: "- Never push to main. <!-- okgate: no-push main -->\n- Never force push. <!-- agentguard: no-force-push -->\n",
      },
    ]);
    expect(rules.map((r) => r.checks.map((c) => c.via))).toEqual([["inline"], ["inline"]]);
  });

  it("an agent key in X-Okgate-Key or X-Agentguard-Key", () => {
    const key = "agk_0123456789abcdef0123456789abcdef";
    expect(keyFromHeaders(new Headers({ "x-okgate-key": key }))).toBe(key);
    expect(keyFromHeaders(new Headers({ "x-agentguard-key": key }))).toBe(key);
  });
});
