import { describe, expect, it } from "vitest";
import { planEnforcement } from "./audit-enforce.js";
import { assessHookAction, hookActionFromInput } from "./hook.js";
import { parsePolicy } from "./policy.js";
import { extractRules } from "./rules.js";

const CLAUDE_MD = `
- Never push to \`main\`.
- Never force-push.
- Never use \`--no-verify\`.
- Use pnpm, not npm.
- Do not edit \`.env\`.
- Never commit \`.env.local\`.
- Do not add dependencies without asking.
- Never rm -rf outside the repo.
- Never publish to npm.
- Do not deploy.
- Do not use \`vercel env pull\`.
- Run \`pnpm check\` before pushing.
- Don't commit directly to main.
- Write good tests.
`;

describe("--enforce: checks as hook-mode rules", () => {
  const { rules } = extractRules([{ path: "CLAUDE.md", text: CLAUDE_MD }]);
  const plan = planEnforcement(rules);

  it("maps each checkable rule to the hook rule that enforces it, or says why it cannot", () => {
    const byList = (list: string) =>
      plan.items.filter((i) => i.list === list).map((i) => i.pattern);
    expect(byList("hooks.shell.deny")).toEqual(
      expect.arrayContaining([
        "git push * main",
        "git push *--force*",
        "git *--no-verify*",
        "npm install*",
        "git add *.env.local*",
        "vercel env pull*",
      ]),
    );
    expect(byList("hooks.shell.approval")).toEqual(
      expect.arrayContaining(["pnpm add *", "npm install *"]),
    );
    expect(byList("hooks.paths.deny")).toEqual([".env"]);
    expect(plan.builtins.map((b) => b.name)).toEqual(["rm-outside-workspace", "publish"]);
    expect(plan.irreversible.map((r) => r.name)).toEqual(["deploy"]);
    expect(plan.auditOnly.map((a) => a.check.label)).toEqual([
      'run "pnpm check" before push',
      "no-commit-to main",
    ]);
    // every item names the rule it came from
    for (const item of plan.items) expect(rules).toContain(item.rule);
  });

  it("the written rules stop what the audit counted (enforce mode)", () => {
    const policy = parsePolicy({
      hooks: {
        mode: "enforce",
        shell: {
          deny: plan.items.filter((i) => i.list === "hooks.shell.deny").map((i) => i.pattern),
          approval: plan.items
            .filter((i) => i.list === "hooks.shell.approval")
            .map((i) => i.pattern),
        },
        paths: {
          deny: plan.items.filter((i) => i.list === "hooks.paths.deny").map((i) => i.pattern),
        },
        irreversible: {
          rules: plan.irreversible.map(({ name, shell, mentions }) => ({ name, shell, mentions })),
        },
      },
    });
    const ctx = { workspace: "/w", tmpDirs: ["/tmp"], stateDir: "/w/.agentguard", guardFiles: [] };
    const check = (command: string) =>
      assessHookAction(
        policy,
        hookActionFromInput("claude-code", {
          tool_name: "Bash",
          tool_input: { command },
          cwd: "/w",
        })!,
        ctx,
      );
    expect(check("git push origin main").denied?.code).toBe("TOOL_DENIED");
    expect(check("git push --force origin feature").denied?.code).toBe("TOOL_DENIED");
    expect(check("npm install").denied?.code).toBe("TOOL_DENIED");
    expect(check("pnpm add zod").approval?.rule).toBe("hooks.shell.approval");
    expect(check("vercel --prod").irreversible.map((m) => m.rule)).toContain("deploy");
    expect(check("git push origin feature").denied).toBeUndefined();
    expect(check("pnpm install").denied).toBeUndefined();
  });
});
