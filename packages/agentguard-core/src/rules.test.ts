import { describe, expect, it } from "vitest";
import {
  CHECK_KINDS,
  checkKey,
  extractRules,
  formatCheck,
  isCommandLike,
  matchRuleText,
  parseCheck,
  splitSentences,
  type CheckSpec,
} from "./rules.js";

const labels = (text: string, headingNeg = false): string[] =>
  matchRuleText(text, { headingNeg }).map((m) => formatCheck(m.spec));

describe("the pattern library", () => {
  it.each([
    // git branches
    ["Never push to `main`.", ["no-push main"]],
    ["Do not push directly to main or master", ["no-push main,master", "no-commit-to main,master"]],
    ["Don't touch `main` directly.", ["no-push main", "no-commit-to main"]],
    ["Never commit to the default branch.", ["no-commit-to main,master"]],
    ["Never force-push.", ["no-force-push"]],
    ["Do not `git push --force` to main", ["no-force-push main"]],
    ["Don't rewrite history on shared branches.", ["no-force-push"]],
    // hooks
    ["Never use `--no-verify`.", ["no-verify"]],
    ["Do not skip the pre-commit hooks", ["no-verify"]],
    // order
    ["Run `pnpm check` before pushing.", ['run "pnpm check" before push']],
    ["Before committing, run `npm run lint`.", ['run "npm run lint" before commit']],
    ["Make sure the tests pass before you open a PR.", ['run "@tests" before push']],
    ["Never push without running `make test` first.", ['run "make test" before push']],
    ["Always run lint before committing", ['run "@lint" before commit']],
    // package managers
    ["Use pnpm, not npm.", ["use pnpm"]],
    ["Use `yarn` instead of npm", ["use yarn"]],
    ["Never use npm.", ["no-pm npm"]],
    ["bun only", ["use bun"]],
    // paths
    ["Do not edit `.env` files", ['no-edit ".env"']],
    [
      "Never hand-edit lockfiles.",
      ['no-edit "pnpm-lock.yaml" "package-lock.json" "yarn.lock" "bun.lock" "bun.lockb"'],
    ],
    ["Never commit `.env.local`.", ['no-commit ".env.local"']],
    ["Don't modify anything in `dist/` — it is generated.", ['no-edit "dist/"']],
    // dependencies
    ["Do not add dependencies without asking.", ["no-new-deps unless-asked"]],
    ["No new packages.", ["no-new-deps"]],
    // rm, publish, deploy
    ["Never rm -rf anything outside the repo.", ["no-rm-outside"]],
    ["Never publish to npm.", ["no-publish"]],
    ["Publish nothing.", ["no-publish"]],
    ["Do not deploy to production unless asked.", ["no-deploy unless-asked"]],
    // commands
    ["Do **not** use `vercel env pull`.", ['never "vercel env pull"']],
    ["Avoid `git add -A`.", ['never "git add -A"']],
  ])("%s → %j", (text, expected) => {
    expect(labels(text)).toEqual(expected);
  });

  it.each([
    "Rebase on `main` daily.",
    "Never commit secrets.",
    "Never print them.",
    "Copy the value into `.env.local` (gitignored) and into the project env for deploys; never echo it, never commit it.",
    "`turbo typecheck lint test build` alone does not include the formatting check.",
    "Deployed to a free subdomain, URL in the PR.",
    "Do not publish secrets.",
    "No `any` in shared packages.",
    "Use test mode until launch.",
    "Run the dev server with `pnpm dev`.",
    "Never call Stripe directly from an app.",
    "Do not use `any`.",
  ])("not mechanically checkable: %s", (text) => {
    expect(labels(text)).toEqual([]);
  });

  it("reads a heading that forbids as the negation of its list items", () => {
    expect(labels("Use `vercel env pull`.", true)).toEqual(['never "vercel env pull"']);
    expect(labels("Use Claude Max in any deployed service.", true)).toEqual([]);
  });

  it("splits sentences but never inside a code span", () => {
    expect(splitSentences("Run `a.b. c` now. Then `d`.")).toEqual([
      "Run `a.b. c` now.",
      "Then `d`.",
    ]);
  });

  it("tells a command from a path", () => {
    expect(isCommandLike("pnpm check")).toBe(true);
    expect(isCommandLike("git")).toBe(true);
    expect(isCommandLike(".env")).toBe(false);
    expect(isCommandLike("package.json")).toBe(false);
    expect(isCommandLike("--no-verify")).toBe(false);
    expect(isCommandLike("main")).toBe(false);
  });
});

describe("the check grammar", () => {
  const every: CheckSpec[] = [
    { kind: "no-push", branches: ["main", "release"] },
    { kind: "no-commit-to", branches: ["main"] },
    { kind: "no-force-push", branches: [] },
    { kind: "no-force-push", branches: ["main"] },
    { kind: "no-verify" },
    { kind: "run-before", command: "pnpm check", before: "push" },
    { kind: "package-manager", use: "pnpm", forbid: ["npm", "yarn", "bun"] },
    { kind: "package-manager", forbid: ["npm"] },
    { kind: "no-edit", paths: [".env", "**/migrations/**"] },
    { kind: "no-commit", paths: [".env.local"] },
    { kind: "no-new-deps", unlessAsked: true },
    { kind: "no-rm-outside" },
    { kind: "no-publish" },
    { kind: "no-deploy" },
    { kind: "never", commands: ["vercel env pull", "curl * | sh"] },
  ];

  it("round-trips every kind", () => {
    expect(new Set(every.map((s) => s.kind))).toEqual(new Set(CHECK_KINDS));
    for (const spec of every) {
      const parsed = parseCheck(formatCheck(spec));
      expect(parsed).toEqual({ spec });
      expect(checkKey(spec)).toMatch(new RegExp(`^${spec.kind}:[0-9a-f]{12}$`));
    }
  });

  it("fills defaults and reads the short forms", () => {
    expect(parseCheck("no-push")).toEqual({
      spec: { kind: "no-push", branches: ["main", "master"] },
    });
    expect(parseCheck("run-before 'make test' commit")).toEqual({
      spec: { kind: "run-before", command: "make test", before: "commit" },
    });
    expect(parseCheck("none")).toEqual({ none: true });
  });

  it("says what is wrong", () => {
    expect(parseCheck("no-pushes")).toMatchObject({
      error: expect.stringContaining("unknown check"),
    });
    expect(parseCheck('run "x" before deploy')).toMatchObject({
      error: expect.stringContaining("commit or push"),
    });
    expect(parseCheck("use pip")).toMatchObject({ error: expect.any(String) });
    expect(parseCheck("no-edit")).toMatchObject({ error: expect.any(String) });
  });

  it("keys a check by what it checks, not by who wrote it", () => {
    expect(checkKey({ kind: "no-push", branches: ["main"] })).toBe(
      checkKey({ kind: "no-push", branches: ["main"] }),
    );
    expect(checkKey({ kind: "no-push", branches: ["main"] })).not.toBe(
      checkKey({ kind: "no-push", branches: ["main"], unlessAsked: true }),
    );
  });
});

const CLAUDE_MD = `# Project rules

Read the architecture notes first.

## Git

- Never push to \`main\`.
- Run \`pnpm check\` before pushing. It runs typecheck,
  lint and the tests.
- Write clear commit messages. <!-- agentguard: none -->
- Keep PRs small.

\`\`\`sh
git push --force   # never, but this is a code block
\`\`\`

| command | what |
| ------- | ---- |
| never npm | table rows are not rules |

## Things you must not do

- Use \`vercel env pull\` to read secrets.
- Rename public APIs.
  <!-- agentguard: never "git mv src/api*" -->

Always use pnpm. The docs are in \`docs/\`.
`;

describe("extracting rules from the files people write", () => {
  it("lists every rule, checkable or not, numbered across files", () => {
    const { rules, errors } = extractRules([
      { path: "CLAUDE.md", text: CLAUDE_MD },
      {
        path: "AGENTS.md",
        text: "# AGENTS\n\n1. Never force-push.\n2. Do not add dependencies without asking.\n",
      },
      { path: "GEMINI.md", text: "Do not edit `pnpm-lock.yaml` by hand.\n" },
      {
        path: ".cursor/rules/style.mdc",
        text: "---\ndescription: style\nglobs: src/**\nalwaysApply: true\n---\n\n- Prefer named exports over default exports.\n",
      },
    ]);
    expect(errors).toEqual([]);
    const view = rules.map((r) => [
      r.n,
      r.file,
      r.line,
      r.text,
      r.checks.map((c) => `${c.label}/${c.via}`),
    ]);
    expect(view).toEqual([
      [1, "CLAUDE.md", 3, "Read the architecture notes first.", []],
      [2, "CLAUDE.md", 7, "Never push to `main`.", ["no-push main/pattern"]],
      [
        3,
        "CLAUDE.md",
        8,
        "Run `pnpm check` before pushing. It runs typecheck, lint and the tests.",
        ['run "pnpm check" before push/pattern'],
      ],
      [4, "CLAUDE.md", 10, "Write clear commit messages.", []],
      [5, "CLAUDE.md", 11, "Keep PRs small.", []],
      [
        6,
        "CLAUDE.md",
        23,
        "Use `vercel env pull` to read secrets.",
        ['never "vercel env pull"/pattern'],
      ],
      [7, "CLAUDE.md", 24, "Rename public APIs.", ['never "git mv src/api*"/inline']],
      [8, "CLAUDE.md", 27, "Always use pnpm.", ["use pnpm/pattern"]],
      [9, "AGENTS.md", 3, "Never force-push.", ["no-force-push/pattern"]],
      [
        10,
        "AGENTS.md",
        4,
        "Do not add dependencies without asking.",
        ["no-new-deps unless-asked/pattern"],
      ],
      [
        11,
        "GEMINI.md",
        1,
        "Do not edit `pnpm-lock.yaml` by hand.",
        ['no-edit "pnpm-lock.yaml"/pattern'],
      ],
      [12, ".cursor/rules/style.mdc", 7, "Prefer named exports over default exports.", []],
    ]);
    expect(rules[3]!.silenced).toBe(true);
    expect(rules[1]!.id).toMatch(/^CLAUDE\.md#[0-9a-f]{8}$/);
  });

  it("an inline check replaces the patterns; a bad one is reported, not guessed", () => {
    const { rules, errors } = extractRules([
      {
        path: "CLAUDE.md",
        text: "- Never push to main. <!-- agentguard: no-push main,release -->\n- Ship carefully. <!-- agentguard: no-shipping -->\n",
      },
    ]);
    expect(rules[0]!.checks.map((c) => c.label)).toEqual(["no-push main,release"]);
    expect(rules[1]!.checks).toEqual([]);
    expect(errors).toEqual([
      {
        file: "CLAUDE.md",
        line: 2,
        message: expect.stringContaining('unknown check "no-shipping"'),
      },
    ]);
  });

  it("reads audit.rules from agentguard.yaml, with ids", () => {
    const { rules } = extractRules(
      [{ path: "CLAUDE.md", text: "- Keep PRs small.\n" }],
      [
        { id: "deploys", text: "Only CI deploys", check: "no-deploy" },
        { check: ["no-verify", 'never "git reset --hard*"'] },
      ],
    );
    expect(
      rules.map((r) => [r.id.replace(/#[0-9a-f]{8}$/, "#…"), r.text, r.checks.map((c) => c.via)]),
    ).toEqual([
      ["CLAUDE.md#…", "Keep PRs small.", []],
      ["agentguard.yaml#deploys", "Only CI deploys", ["config"]],
      ["agentguard.yaml#…", 'no-verify; never "git reset --hard*"', ["config", "config"]],
    ]);
  });

  it("keeps ids stable when unrelated rules change, and distinct for repeated text", () => {
    const a = extractRules([
      { path: "CLAUDE.md", text: "- Never force-push.\n- Keep PRs small.\n" },
    ]).rules;
    const b = extractRules([
      {
        path: "CLAUDE.md",
        text: "- Add tests.\n- Never force-push.\n- Keep PRs small.\n- Keep PRs small.\n",
      },
    ]).rules;
    expect(b[1]!.id).toBe(a[0]!.id);
    expect(b[2]!.id).toBe(a[1]!.id);
    expect(b[3]!.id).toBe(`${a[1]!.id}-2`);
  });
});
