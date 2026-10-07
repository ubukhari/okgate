/**
 * The adherence engine on synthetic transcripts in the shapes Claude Code and Codex write
 * (checked against local transcripts, structure only, 7 Oct 2026). Every command, path and
 * prompt below is made up.
 */
import { describe, expect, it } from "vitest";
import {
  ClaudeCodeAuditReader,
  CodexAuditReader,
  addedPackages,
  describeStep,
  evaluateChecks,
  isDeploy,
  runsRequired,
  summarizeAudit,
  type AuditContext,
  type GroupAudit,
  type TranscriptAudit,
} from "./adherence.js";
import { checkKey, extractRules, type CheckSpec } from "./rules.js";
import { isWithin, parseShell } from "./shell.js";

const REPO = "/work/acme";
const ctx: AuditContext = { repoRoot: REPO, home: "/home/dev", tmpDirs: ["/tmp"] };
const inRepo = (cwd: string): boolean => isWithin(cwd, REPO);

let clock = Date.parse("2026-10-01T10:00:00Z");
const tick = (): string => {
  clock += 60_000;
  return new Date(clock).toISOString();
};

interface Opts {
  session?: string;
  cwd?: string;
  branch?: string;
  sidechain?: boolean;
}

let ids = 0;
const cc = {
  call(
    name: string,
    input: Record<string, unknown>,
    o: Opts = {},
  ): { entry: Record<string, unknown>; id: string } {
    const id = `toolu_${(ids += 1)}`;
    return {
      id,
      entry: {
        type: "assistant",
        timestamp: tick(),
        sessionId: o.session ?? "s1",
        cwd: o.cwd ?? REPO,
        gitBranch: o.branch ?? "feature/x",
        isSidechain: o.sidechain ?? false,
        message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
      },
    };
  },
  bash(command: string, o: Opts = {}) {
    return cc.call("Bash", { command, description: "synthetic" }, o);
  },
  result(id: string, extra: Record<string, unknown> = {}, o: Opts = {}): Record<string, unknown> {
    return {
      type: "user",
      timestamp: tick(),
      sessionId: o.session ?? "s1",
      cwd: o.cwd ?? REPO,
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] },
      toolUseResult: { stdout: "", stderr: "" },
      ...extra,
    };
  },
  human(text: string, o: Opts = {}): Record<string, unknown> {
    return {
      type: "user",
      timestamp: tick(),
      sessionId: o.session ?? "s1",
      cwd: o.cwd ?? REPO,
      origin: { kind: "human" },
      message: { role: "user", content: text },
    };
  },
  say(text: string, o: Opts = {}): Record<string, unknown> {
    return {
      type: "assistant",
      timestamp: tick(),
      sessionId: o.session ?? "s1",
      cwd: o.cwd ?? REPO,
      message: { role: "assistant", content: [{ type: "text", text }] },
    };
  },
};

type Line = Record<string, unknown> | { entry: Record<string, unknown> };
const flat = (lines: Line[]): Record<string, unknown>[] =>
  lines.map((l) =>
    "entry" in l && typeof l.entry === "object" ? (l.entry as Record<string, unknown>) : l,
  );

function readClaude(...files: Line[][]): TranscriptAudit {
  const reader = new ClaudeCodeAuditReader({ inRepo });
  files.forEach((lines, f) => flat(lines).forEach((e, i) => reader.add(e, i + 1, f)));
  return reader.result();
}

function evaluate(
  spec: CheckSpec,
  audit: TranscriptAudit,
): { applicable: string[]; broken: string[]; asked: (boolean | null)[] } {
  const key = checkKey(spec);
  const out = evaluateChecks([{ spec, key }], audit, ctx).checks[key]!;
  return {
    applicable: out.applicable,
    broken: out.breaks.map((b) => {
      const step = audit.steps.find((s) => b.step && s.line === b.line && s.file === b.file)!;
      return describeStep(step, b, ctx);
    }),
    asked: out.breaks.map((b) => b.asked),
  };
}

describe("git rules", () => {
  it("no-push: named branches, HEAD:main, and a bare push from a checked-out main", () => {
    const a = readClaude([
      cc.bash("git push origin feature/x"),
      cc.bash("git push origin main"),
      cc.bash("git push origin HEAD:main", { branch: "feature/x" }),
      cc.bash("git push", { branch: "main" }),
      cc.bash("cd ../other && git push", { branch: "main" }),
      cc.bash("git -C ../other push", { branch: "main" }),
    ]);
    expect(evaluate({ kind: "no-push", branches: ["main"] }, a).broken).toEqual([
      "git push origin main",
      "git push origin HEAD:main",
      "git push",
    ]);
  });

  it("no-push: a subagent's gitBranch is not trusted (it can be the session's, not its worktree's)", () => {
    const a = readClaude([
      cc.bash("git push", { branch: "main", sidechain: true }),
      cc.bash("git push origin main", { branch: "agent/x", sidechain: true }),
    ]);
    expect(evaluate({ kind: "no-push", branches: ["main"] }, a).broken).toEqual([
      "git push origin main",
    ]);
  });

  it("no-push: what Claude Code recorded the push did wins over the checkout", () => {
    const push = cc.bash("git push", { branch: "main" });
    const a = readClaude([
      push,
      cc.result(push.id, { toolUseResult: { gitOperation: { push: { branch: "feature/y" } } } }),
    ]);
    expect(evaluate({ kind: "no-push", branches: ["main"] }, a)).toMatchObject({
      applicable: ["s1"],
      broken: [],
    });
  });

  it("no-commit-to: a commit while main is checked out, unless the line switched branch first", () => {
    const a = readClaude([
      cc.bash("git commit -m one", { branch: "main" }),
      cc.bash("git checkout -b fix && git commit -m two", { branch: "main" }),
      cc.bash("git commit -m three", { branch: "feature/x" }),
    ]);
    expect(evaluate({ kind: "no-commit-to", branches: ["main"] }, a).broken).toEqual([
      "git commit -m one",
    ]);
  });

  it("no-force-push: -f, --force*, clustered flags and +refspecs", () => {
    const a = readClaude([
      cc.bash("git push -f origin feature/x"),
      cc.bash("git push --force-with-lease"),
      cc.bash("git push -uf origin feature/x"),
      cc.bash("git push origin +feature/x"),
      cc.bash("git push origin feature/x"),
      cc.bash("git push --force origin main"),
    ]);
    expect(evaluate({ kind: "no-force-push", branches: [] }, a).broken).toHaveLength(5);
    expect(evaluate({ kind: "no-force-push", branches: ["main"] }, a).broken).toEqual([
      "git push --force origin main",
    ]);
  });

  it("no-verify: --no-verify, -n on commit, hooks switched off by environment", () => {
    const a = readClaude([
      cc.bash("git commit --no-verify -m wip"),
      cc.bash("git commit -nm wip"),
      cc.bash("HUSKY=0 git commit -m wip"),
      cc.bash("git commit -m fine"),
      cc.bash("git push -n origin feature/x"),
    ]);
    expect(evaluate({ kind: "no-verify" }, a).broken).toEqual([
      "git commit --no-verify -m wip",
      "git commit -nm wip",
      "git commit -m wip",
    ]);
  });
});

describe("run-before: the command ran after the last edit, before each gate", () => {
  const spec: CheckSpec = { kind: "run-before", command: "pnpm check", before: "push" };

  it("kept when the check ran after the last edit", () => {
    const a = readClaude([
      cc.call("Edit", { file_path: `${REPO}/src/a.ts`, old_string: "a", new_string: "b" }),
      cc.bash("pnpm check 2>&1 | tail -5"),
      cc.bash("git push origin feature/x"),
      cc.bash("pnpm run check && git push origin feature/x"),
    ]);
    expect(evaluate(spec, a)).toMatchObject({ applicable: ["s1"], broken: [] });
  });

  it("broken when it never ran, or ran before the last edit", () => {
    const a = readClaude([
      cc.call("Write", { file_path: `${REPO}/src/a.ts`, content: "x" }),
      cc.bash("git push origin feature/x"),
      cc.bash("pnpm check"),
      cc.call("Edit", { file_path: `${REPO}/README.md`, old_string: "a", new_string: "b" }),
      cc.bash("gh pr create --fill"),
    ]);
    expect(evaluate(spec, a).broken).toEqual(["git push origin feature/x", "gh pr create --fill"]);
  });

  it("follows each worktree on its own: another tree's edit or check does not count", () => {
    const wa = `${REPO}/.claude/worktrees/a`;
    const wb = `${REPO}/.claude/worktrees/b`;
    const a = readClaude([
      cc.call(
        "Edit",
        { file_path: `${wa}/src/x.ts`, old_string: "a", new_string: "b" },
        { cwd: wa, sidechain: true },
      ),
      cc.bash("pnpm check", { cwd: wa, sidechain: true }),
      cc.call("Write", { file_path: `${REPO}/docs/notes.md`, content: "x" }),
      cc.call(
        "Edit",
        { file_path: `${wb}/src/y.ts`, old_string: "a", new_string: "b" },
        { cwd: wb, sidechain: true },
      ),
      cc.bash("git push origin agent/a", { cwd: wa, sidechain: true }),
      cc.bash("git push origin agent/b", { cwd: wb, sidechain: true }),
    ]);
    expect(evaluate(spec, a).broken).toEqual(["git push origin agent/b"]);
  });

  it("not applicable to a session that never pushed", () => {
    const a = readClaude([cc.call("Write", { file_path: `${REPO}/a.ts`, content: "x" })]);
    expect(evaluate(spec, a)).toEqual({ applicable: [], broken: [], asked: [] });
  });

  it("families: @tests, @lint, @typecheck", () => {
    const cmd = (line: string) => parseShell(line)[0]!;
    expect(runsRequired(cmd("pnpm test"), "@tests")).toBe(true);
    expect(runsRequired(cmd("pnpm --filter api test"), "@tests")).toBe(true);
    expect(runsRequired(cmd("npx vitest run"), "@tests")).toBe(true);
    expect(runsRequired(cmd("go test ./..."), "@tests")).toBe(true);
    expect(runsRequired(cmd("pnpm build"), "@tests")).toBe(false);
    expect(runsRequired(cmd("pnpm lint"), "@lint")).toBe(true);
    expect(runsRequired(cmd("npx tsc --noEmit"), "@typecheck")).toBe(true);
    expect(runsRequired(cmd("npm run check"), "npm check")).toBe(true);
    expect(runsRequired(cmd("pnpm checkout"), "pnpm check")).toBe(false);
  });
});

describe("package managers and dependencies", () => {
  it("use pnpm: npm and yarn package commands break it; npx and npm --version do not", () => {
    const a = readClaude([
      cc.bash("npm install"),
      cc.bash("npm run build"),
      cc.bash("yarn"),
      cc.bash("npx prettier --check ."),
      cc.bash("npm --version"),
      cc.bash("pnpm install --frozen-lockfile"),
    ]);
    expect(
      evaluate({ kind: "package-manager", use: "pnpm", forbid: ["npm", "yarn", "bun"] }, a).broken,
    ).toEqual(["npm install", "npm run build", "yarn"]);
  });

  it("knows which commands add a package", () => {
    const added = (line: string) => addedPackages(parseShell(line)[0]!);
    expect(added("pnpm add zod")).toEqual(["zod"]);
    expect(added("pnpm --filter api add -D @types/node")).toEqual([]);
    expect(added("pnpm add -D @types/node --filter api")).toEqual(["@types/node"]);
    expect(added("npm i left-pad@1.3.0")).toEqual(["left-pad@1.3.0"]);
    expect(added("npm install")).toEqual([]);
    expect(added("npm install -g vercel")).toEqual([]);
    expect(added("pip install -r requirements.txt")).toEqual([]);
    expect(added("python -m pip install requests")).toEqual(["requests"]);
    expect(added("cargo add serde --features derive")).toEqual(["serde"]);
    expect(added("go get example.com/pkg@v1")).toEqual(["example.com/pkg@v1"]);
  });

  it("no-new-deps unless-asked: a turn naming the package or answering yes to it excuses the add", () => {
    const a = readClaude([
      cc.human("please add zod for the schema"),
      cc.bash("pnpm add zod"),
      cc.human("now fix the failing test"),
      cc.bash("pnpm add lodash"),
      cc.say("Shall I install date-fns for the formatting?"),
      cc.human("yes"),
      cc.bash("pnpm add date-fns"),
    ]);
    const spec: CheckSpec = { kind: "no-new-deps", unlessAsked: true };
    expect(evaluate(spec, a).asked).toEqual([true, false, true]);
    const key = checkKey(spec);
    const group = evaluateChecks([{ spec, key }], a, ctx);
    const rule = extractRules(
      [],
      [{ text: "no deps without asking", check: "no-new-deps unless-asked" }],
    ).rules;
    const s = summarizeAudit(rule, [group]).rules[0]!;
    expect(s).toMatchObject({ status: "broken", sessionsBroken: 1 });
    expect(s.checks[0]).toMatchObject({ breaks: 1, sessionsOnRequest: 0 });
  });
});

describe("files, rm, publish, deploy, never", () => {
  it("no-edit: edit tools and shell writes inside the repo", () => {
    const a = readClaude([
      cc.call("Write", { file_path: `${REPO}/.env`, content: "SECRET=1" }),
      cc.call("Edit", { file_path: `${REPO}/src/a.ts`, old_string: "a", new_string: "b" }),
      cc.bash("echo X=1 >> .env.local"),
      cc.bash("echo X=1 > /tmp/.env"),
      cc.call("Write", { file_path: `${REPO}/.env.example`, content: "X=" }),
    ]);
    expect(evaluate({ kind: "no-edit", paths: [".env", ".env.local"] }, a).broken).toEqual([
      "Write .env",
      "Bash .env.local",
    ]);
  });

  it("no-commit: an explicit git add of the path", () => {
    const a = readClaude([
      cc.bash("git add .env src/a.ts"),
      cc.bash("git add -A"),
      cc.bash("git add .env.example"),
    ]);
    expect(evaluate({ kind: "no-commit", paths: [".env"] }, a).broken).toEqual([
      "git add .env src/a.ts",
    ]);
  });

  it("no-rm-outside reuses hook mode's rm-outside-workspace", () => {
    const a = readClaude([
      cc.bash("rm -rf build dist"),
      cc.bash("rm -rf /tmp/scratch"),
      cc.bash("rm -rf ~/old-project"),
    ]);
    expect(evaluate({ kind: "no-rm-outside" }, a).broken).toEqual(["rm -rf /home/dev/old-project"]);
  });

  it("no-publish and no-deploy", () => {
    const a = readClaude([
      cc.bash("npm publish --access public"),
      cc.bash("npm publish --dry-run"),
      cc.bash("npx vercel --prod"),
      cc.bash("vercel env ls"),
      cc.bash("wrangler deploy"),
      cc.bash("terraform plan"),
    ]);
    expect(evaluate({ kind: "no-publish" }, a).broken).toEqual(["npm publish --access public"]);
    expect(evaluate({ kind: "no-deploy" }, a).broken).toEqual(["vercel --prod", "wrangler deploy"]);
    expect(isDeploy(parseShell("vercel")[0]!)).toBe(true);
    expect(isDeploy(parseShell("vercel curl /api/health")[0]!)).toBe(false);
  });

  it("never: a prefix, anywhere in a compound line; credentials masked in the evidence", () => {
    const a = readClaude([
      cc.bash("cd apps/web && vercel env pull .env.local --token sk_live_abcdefghijkl"),
      cc.bash("vercel env ls"),
    ]);
    expect(evaluate({ kind: "never", commands: ["vercel env pull"] }, a).broken).toEqual([
      "vercel env pull .env.local --token <redacted>",
    ]);
  });
});

describe("reading transcripts", () => {
  it("counts a subagent's calls under the session that started it, and a call seen twice once", () => {
    const main = [cc.human("ship the fix"), cc.bash("git push origin main", { session: "s9" })];
    const sub = [cc.bash("git push origin main", { session: "s9", sidechain: true })];
    const resumed = [main[1]!];
    const a = readClaude(main, sub, resumed);
    expect(a.steps.map((s) => [s.session, s.file])).toEqual([
      ["s9", 0],
      ["s9", 1],
    ]);
  });

  it("leaves out calls made in another directory, and marks calls the harness refused", () => {
    const refused = cc.bash("git push origin main");
    const a = readClaude([
      cc.bash("git push origin main", { cwd: "/work/other" }),
      refused,
      cc.result(refused.id, { toolDenialKind: "automode-blocked" }),
    ]);
    expect(a.steps).toHaveLength(1);
    expect(a.steps[0]!.refused).toBe(true);
    expect(a.sessions.map((s) => s.id)).toEqual(["s1"]);
  });

  it("reads Codex rollouts: exec_command, shell, apply_patch; JavaScript exec is counted as unread", () => {
    const reader = new CodexAuditReader({ inRepo });
    const line = (type: string, payload: Record<string, unknown>) => ({
      type,
      timestamp: tick(),
      payload,
    });
    const lines = [
      line("session_meta", { id: "child", parent_thread_id: "thread-1", cwd: REPO }),
      line("turn_context", { cwd: REPO, model: "m" }),
      line("response_item", {
        type: "function_call",
        name: "exec_command",
        call_id: "call_1",
        arguments: JSON.stringify({ cmd: "git push --force origin main", workdir: REPO }),
      }),
      line("response_item", {
        type: "local_shell_call",
        call_id: "call_2",
        action: { type: "exec", command: ["npm", "install"] },
      }),
      line("response_item", {
        type: "custom_tool_call",
        name: "apply_patch",
        call_id: "call_3",
        input: "*** Begin Patch\n*** Update File: .env\n@@\n-a\n+b\n*** End Patch",
      }),
      line("response_item", {
        type: "custom_tool_call",
        name: "exec",
        call_id: "call_4",
        input: "await tools.exec_command({})",
      }),
    ];
    lines.forEach((l, i) => reader.add(l, i + 1));
    const a = reader.result();
    expect(a.sessions).toEqual([
      expect.objectContaining({ id: "thread-1", client: "codex", turnsKnown: false }),
    ]);
    expect(a.unread).toBe(1);
    expect(evaluate({ kind: "no-force-push", branches: [] }, a).broken).toEqual([
      "git push --force origin main",
    ]);
    expect(evaluate({ kind: "package-manager", use: "pnpm", forbid: ["npm"] }, a).broken).toEqual([
      "npm install",
    ]);
    expect(evaluate({ kind: "no-edit", paths: [".env"] }, a).broken).toEqual(["apply_patch .env"]);
    expect(evaluate({ kind: "no-new-deps", unlessAsked: true }, a).asked).toEqual([]);
  });

  it("ignores a Codex rollout about another directory", () => {
    const reader = new CodexAuditReader({ inRepo });
    reader.add(
      { type: "session_meta", timestamp: tick(), payload: { id: "t", cwd: "/elsewhere" } },
      1,
    );
    expect(reader.relevant).toBe(false);
    expect(reader.result().sessions).toEqual([]);
  });
});

describe("what is kept, and the summary", () => {
  it("keeps no command, path or prompt in what is cached", () => {
    const a = readClaude([
      cc.human("CANARY-PROMPT-1 push it"),
      cc.say("CANARY-ASSISTANT-2"),
      cc.bash("git push origin main # CANARY-COMMAND-3"),
      cc.call("Write", { file_path: `${REPO}/CANARY-PATH-4/.env`, content: "CANARY-CONTENT-5" }),
    ]);
    const { rules } = extractRules([
      { path: "CLAUDE.md", text: "- Never push to main.\n- Do not edit `.env`.\n" },
    ]);
    const group = evaluateChecks(
      rules.flatMap((r) => r.checks),
      a,
      ctx,
    );
    const json = JSON.stringify(group);
    expect(json).not.toMatch(/CANARY|git push|\.env|toolu_/);
    expect(Object.values(group.checks).every((c) => c.breaks.length === 1)).toBe(true);
  });

  it("folds groups into one line per rule, within the window", () => {
    const { rules } = extractRules([
      {
        path: "CLAUDE.md",
        text: "- Never push to main.\n- Never use `--no-verify`.\n- Do not deploy.\n- Be kind.\n",
      },
    ]);
    const checks = rules.flatMap((r) => r.checks);
    const old = readClaude([cc.bash("git push origin main", { session: "old" })]);
    clock = Date.parse("2026-10-06T09:00:00Z");
    const a = readClaude([
      cc.bash("git push origin main", { session: "a" }),
      cc.bash("git commit -m fine", { session: "b" }),
      cc.bash("git push origin main", { session: "b" }),
    ]);
    const groups: GroupAudit[] = [
      evaluateChecks(checks, old, ctx),
      evaluateChecks(checks, a, ctx),
      evaluateChecks(checks, a, ctx),
    ];
    const s = summarizeAudit(rules, groups, { since: Date.parse("2026-10-05T00:00:00Z") });
    expect(s.sessions).toBe(2);
    expect(
      s.rules.map((r) => [
        r.rule.n,
        r.status,
        r.sessionsBroken,
        r.checks.map((c) => c.sessionsApplicable),
      ]),
    ).toEqual([
      [1, "broken", 2, [2]],
      [2, "kept", 0, [2]],
      [3, "kept", 0, [2]],
      [4, "not-checkable", 0, []],
    ]);
    const last = s.rules[0]!.last;
    expect(last.map((b) => b.session)).toEqual(["b", "a"]);
    expect(last[0]!.at).toBeGreaterThan(last[1]!.at);
    const all = summarizeAudit(rules, groups);
    expect(all.rules[0]!.sessionsBroken).toBe(3);
  });
});
