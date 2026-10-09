/**
 * The 0.2.0 shims the old npm names become once @agentwares/okgate, -core and -sdk are published
 * (REN-1). They cannot be installed from npm yet, so each runs here from a node_modules tree whose
 * new-name packages are this workspace's code: the CLI's source through tsx, the engine's build.
 *
 * What must hold: the old name runs the new code with the same argv, stdout and exit code; one
 * deprecation line goes to stderr and nothing else does; the CLI runs once, not twice.
 */
import { spawnSync } from "node:child_process";
import {
  cpSync,
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

const tsxLoader = fileURLToPath(import.meta.resolve("tsx"));
const cliSrc = fileURLToPath(new URL("./cli.ts", import.meta.url));
const at = (rel: string): string => fileURLToPath(new URL(`../../../${rel}`, import.meta.url));
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

let dir: string;
let modules: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "okgate-shims-"));
  modules = join(dir, "node_modules", "@agentwares");
  mkdirSync(modules, { recursive: true });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function install(name: string, from: string): void {
  cpSync(from, join(modules, name), { recursive: true });
}

function node(args: string[], opts: { input?: string; cwd?: string } = {}) {
  return spawnSync(process.execPath, args, {
    cwd: opts.cwd ?? dir,
    input: opts.input ?? "",
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", HOME: join(dir, "home") },
  });
}

describe("@agentwares/agentguard 0.2.0 (the CLI shim)", () => {
  beforeEach(() => {
    install("agentguard", at("apps/agentguard-cli/shim"));
    // @agentwares/okgate as npm will serve it: `./cli` is the CLI's entry, here its source
    const okgate = join(modules, "okgate");
    mkdirSync(okgate);
    writeFileSync(
      join(okgate, "package.json"),
      JSON.stringify({
        name: "@agentwares/okgate",
        version: pkg.version,
        type: "module",
        exports: { "./cli": "./cli.js" },
      }),
    );
    writeFileSync(join(okgate, "cli.js"), `export * from ${JSON.stringify(cliSrc)};\n`);
  });
  const shimBin = (): string => join(modules, "agentguard", "cli.js");

  it("runs okgate once: same stdout and exit code, one line on stderr", () => {
    const run = node(["--import", tsxLoader, shimBin(), "--version"]);
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(`${pkg.version}\n`);
    expect(run.stderr.trim().split("\n")).toEqual([
      "@agentwares/agentguard is now @agentwares/okgate (agentguard was renamed okgate); it keeps working, switch when convenient",
    ]);
    const bad = node(["--import", tsxLoader, shimBin(), "no-such-command"]);
    expect(bad.status).toBe(1);
    expect(bad.stdout).toBe("");
  });

  it("answers a coding agent's hook exactly as okgate does, from agentguard.yaml", () => {
    const project = join(dir, "project");
    mkdirSync(join(project, ".agentguard"), { recursive: true });
    writeFileSync(
      join(project, "agentguard.yaml"),
      'hooks:\n  mode: enforce\n  shell:\n    deny: ["terraform destroy*"]\n',
    );
    const input = JSON.stringify({
      session_id: "s",
      cwd: project,
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "terraform destroy" },
    });
    const run = node(["--import", tsxLoader, shimBin(), "hook", "pre-tool-use"], {
      input,
      cwd: project,
    });
    expect(run.status).toBe(0);
    const lines = run.stdout.trim().split("\n");
    expect(lines).toHaveLength(1);
    const answer = JSON.parse(lines[0]!) as {
      hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
    };
    expect(answer.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(JSON.parse(answer.hookSpecificOutput.permissionDecisionReason)).toMatchObject({
      code: "TOOL_DENIED",
    });
    // with AGENTGUARD_KILL=1 in its environment, everything halts
    const killed = spawnSync(
      process.execPath,
      ["--import", tsxLoader, shimBin(), "hook", "pre-tool-use"],
      {
        cwd: project,
        input: input.replace("terraform destroy", "ls"),
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "", HOME: join(dir, "home"), AGENTGUARD_KILL: "1" },
      },
    );
    expect(killed.stdout).toContain("KILLED");
  });

  it("declares both bins, depends on @agentwares/okgate at 0.2.0, and ships what it imports", () => {
    const shim = JSON.parse(
      readFileSync(at("apps/agentguard-cli/shim/package.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(shim).toMatchObject({
      name: "@agentwares/agentguard",
      version: "0.2.0",
      bin: { agentguard: "./cli.js", okgate: "./cli.js" },
      dependencies: { "@agentwares/okgate": "^0.2.0" },
    });
    expect(shim.files).toEqual(
      expect.arrayContaining(["cli.js", "index.js", "index.d.ts", "notice.js"]),
    );
  });
});

describe("@agentwares/agentguard-core 0.2.0 and -sdk 0.2.0 (library shims)", () => {
  it("re-export the engine under the old name, both entry points, with one stderr line", () => {
    install("agentguard-core", at("packages/agentguard-core/shim"));
    // @agentwares/okgate-core as npm will serve it: this workspace's built engine
    symlinkSync(at("packages/agentguard-core"), join(modules, "okgate-core"), "dir");
    writeFileSync(
      join(dir, "main.mjs"),
      `import { Guard, POLICY_FILE, parsePolicy } from "@agentwares/agentguard-core";
import { loadPolicyFile, killSwitchFor } from "@agentwares/agentguard-core/node";
const g = new Guard({ policy: parsePolicy({}), env: { AGENTGUARD_KILL: "1" } });
const killed = await g.killState();
console.log(JSON.stringify({ POLICY_FILE, killed: killed.killed, fns: [typeof loadPolicyFile, typeof killSwitchFor] }));
`,
    );
    const run = node([join(dir, "main.mjs")]);
    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({
      POLICY_FILE: "okgate.yaml",
      killed: true,
      fns: ["function", "function"],
    });
    expect(run.stderr.trim().split("\n")).toHaveLength(1);
    expect(run.stderr).toContain("@agentwares/agentguard-core is now @agentwares/okgate-core");
  });

  it("the SDK shim re-exports @agentwares/okgate-sdk", () => {
    install("agentguard-sdk", at("packages/agentguard-sdk/shim"));
    const sdk = join(modules, "okgate-sdk");
    mkdirSync(sdk);
    writeFileSync(
      join(sdk, "package.json"),
      JSON.stringify({ name: "@agentwares/okgate-sdk", type: "module", exports: "./index.js" }),
    );
    writeFileSync(join(sdk, "index.js"), "export const createGuard = () => 'okgate-sdk';\n");
    writeFileSync(
      join(dir, "main.mjs"),
      `import { createGuard } from "@agentwares/agentguard-sdk";\nconsole.log(createGuard());\n`,
    );
    const run = node([join(dir, "main.mjs")]);
    expect(run.stdout).toBe("okgate-sdk\n");
    expect(run.stderr).toContain("@agentwares/agentguard-sdk is now @agentwares/okgate-sdk");
    const shim = JSON.parse(
      readFileSync(at("packages/agentguard-sdk/shim/package.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(shim).toMatchObject({
      version: "0.2.0",
      dependencies: { "@agentwares/okgate-sdk": "^0.2.0" },
    });
  });
});
