/**
 * From measuring to enforcing: the checks `extractRules` found, as hook-mode rules
 * (`hooks.shell.deny|approval`, `hooks.paths.deny`, `hooks.irreversible`). `okgate audit
 * --enforce` writes this plan into okgate.yaml in dry-run; nothing here changes
 * `hooks.mode`. Checks that need the order of commands or the checked-out branch cannot be a
 * pre-execution rule and stay audit-only.
 *
 * Web-standard: pure.
 */
import type { BuiltinIrreversible } from "./policy.js";
import type { PackageManager, Rule, RuleCheck } from "./rules.js";

export type EnforceList = "hooks.shell.deny" | "hooks.shell.approval" | "hooks.paths.deny";

export interface EnforceItem {
  list: EnforceList;
  pattern: string;
  rule: Rule;
  check: RuleCheck;
}

export interface EnforcePlan {
  items: EnforceItem[];
  /** built-in irreversible classes the rules rely on: they must stay enabled */
  builtins: { name: BuiltinIrreversible; rule: Rule; check: RuleCheck }[];
  /** custom `hooks.irreversible.rules` */
  irreversible: {
    name: string;
    shell: string[];
    mentions: string[];
    rule: Rule;
    check: RuleCheck;
  }[];
  /** checks a pre-execution hook cannot express */
  auditOnly: { rule: Rule; check: RuleCheck; why: string }[];
  /** what the rules above do not cover, one line each */
  notes: string[];
}

const PM_DENY: Record<PackageManager, string[]> = {
  npm: [
    "npm install*",
    "npm i",
    "npm i *",
    "npm ci*",
    "npm add *",
    "npm uninstall *",
    "npm update*",
    "npm run *",
    "npm test*",
    "npm exec *",
    "npm init*",
  ],
  pnpm: ["pnpm", "pnpm *"],
  yarn: ["yarn", "yarn *"],
  bun: ["bun install*", "bun i", "bun i *", "bun add *", "bun remove *"],
};

const DEP_ADD = [
  "pnpm add *",
  "npm install *",
  "npm i *",
  "npm add *",
  "yarn add *",
  "bun add *",
  "pip install *",
  "pip3 install *",
  "uv add *",
  "poetry add *",
  "cargo add *",
  "go get *",
];

const DEPLOY = [
  "vercel",
  "vercel --prod*",
  "vercel deploy*",
  "vercel promote*",
  "wrangler deploy*",
  "wrangler publish*",
  "fly deploy*",
  "flyctl deploy*",
  "netlify deploy*",
  "firebase deploy*",
  "railway up*",
  "serverless deploy*",
  "sls deploy*",
  "cdk deploy*",
  "terraform apply*",
  "terraform destroy*",
  "pulumi up*",
  "kubectl apply*",
  "helm install*",
  "helm upgrade*",
];

/** Turn every checkable rule into the hook rules that enforce it, where a hook can. */
export function planEnforcement(rules: readonly Rule[]): EnforcePlan {
  const plan: EnforcePlan = { items: [], builtins: [], irreversible: [], auditOnly: [], notes: [] };
  const seen = new Set<string>();
  const note = (line: string): void => {
    if (!plan.notes.includes(line)) plan.notes.push(line);
  };
  const add = (list: EnforceList, patterns: string[], rule: Rule, check: RuleCheck): void => {
    for (const pattern of patterns) {
      const k = `${list}\u0000${pattern.toLowerCase()}`;
      if (seen.has(k)) continue;
      seen.add(k);
      plan.items.push({ list, pattern, rule, check });
    }
  };
  for (const rule of rules) {
    for (const check of rule.checks) {
      const spec = check.spec;
      switch (spec.kind) {
        case "no-push":
          add(
            "hooks.shell.deny",
            spec.branches.flatMap((b) => [
              `git push * ${b}`,
              `git push * ${b} *`,
              `git push *:${b}`,
              `git push *:${b} *`,
            ]),
            rule,
            check,
          );
          note(
            "a bare `git push` while a protected branch is checked out is not visible to a shell rule; the audit still counts it",
          );
          break;
        case "no-force-push":
          add(
            "hooks.shell.deny",
            spec.branches.length === 0
              ? [
                  "git push *--force*",
                  "git push * -f",
                  "git push * -f *",
                  "git push -f*",
                  "git push * +*",
                ]
              : spec.branches.flatMap((b) => [
                  `git push *--force* ${b}`,
                  `git push *--force* ${b} *`,
                  `git push * ${b} *--force*`,
                  `git push *-f * ${b}`,
                  `git push * ${b} -f`,
                  `git push * ${b} -f *`,
                  `git push * +${b}`,
                  `git push * +*:${b}`,
                ]),
            rule,
            check,
          );
          break;
        case "no-verify":
          add(
            "hooks.shell.deny",
            [
              "git *--no-verify*",
              "git commit -n*",
              "git commit * -n",
              "git commit * -n *",
              "HUSKY=0 *",
            ],
            rule,
            check,
          );
          break;
        case "package-manager":
          add(
            "hooks.shell.deny",
            spec.forbid.flatMap((pm) => PM_DENY[pm]),
            rule,
            check,
          );
          break;
        case "no-edit":
          add("hooks.paths.deny", spec.paths, rule, check);
          break;
        case "no-commit":
          add(
            "hooks.shell.deny",
            spec.paths.map((p) => `git add *${p.replace(/^\*+|\*+$/g, "")}*`),
            rule,
            check,
          );
          note(
            "`git add .` / `git add -A` stage everything, a protected file included; only an explicit `git add <path>` is matched",
          );
          break;
        case "no-new-deps":
          add(spec.unlessAsked ? "hooks.shell.approval" : "hooks.shell.deny", DEP_ADD, rule, check);
          if (spec.unlessAsked)
            note("adding a package waits for `okgate approve <id>` (hooks.shell.approval)");
          break;
        case "no-rm-outside":
          plan.builtins.push({ name: "rm-outside-workspace", rule, check });
          break;
        case "no-publish":
          plan.builtins.push({ name: "publish", rule, check });
          note(
            "package publish is a built-in irreversible class: it runs only on a turn a person typed that names it, or after `okgate approve`",
          );
          break;
        case "no-deploy":
          if (!plan.irreversible.some((r) => r.name === "deploy"))
            plan.irreversible.push({
              name: "deploy",
              shell: DEPLOY,
              mentions: ["deploy", "ship", "release", "production", "prod"],
              rule,
              check,
            });
          break;
        case "never":
          add(
            "hooks.shell.deny",
            spec.commands.map((c) => (/[*?]/.test(c) ? c : `${c}*`)),
            rule,
            check,
          );
          break;
        case "run-before":
          plan.auditOnly.push({
            rule,
            check,
            why: "needs the order of commands in the session; a pre-execution hook sees one command",
          });
          break;
        case "no-commit-to":
          plan.auditOnly.push({
            rule,
            check,
            why: "needs the checked-out branch, which the hook input does not carry",
          });
          break;
      }
    }
  }
  return plan;
}
