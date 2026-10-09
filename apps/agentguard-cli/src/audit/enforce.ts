/**
 * `okgate audit --enforce`: write the plan `planEnforcement` made into okgate.yaml with
 * the `yaml` document API, so every comment and setting already there stays. Each added rule
 * carries a comment naming the rule it came from. `hooks.mode` is never touched: a new policy, or
 * a new hooks block, starts in dry-run.
 */
import { existsSync, readFileSync } from "node:fs";
import YAML, { isMap, isScalar, isSeq, type Document, type Scalar, type YAMLSeq } from "yaml";
import type { EnforcePlan, Rule } from "@agentwares/agentguard-core";
import { HOOKS_POLICY_BLOCK, renderHooksStarterPolicy } from "../commands/hooks.js";

export interface EnforceEdit {
  /** the policy before (empty when there was none) and after */
  before: string;
  after: string;
  created: boolean;
  /** one line per hook rule added */
  added: string[];
  mode: "dry-run" | "enforce";
}

const origin = (rule: Rule): string => ` R${rule.n} ${rule.file}:${rule.line}`;

function seqAt(doc: Document, path: string[]): YAMLSeq {
  let node = doc.getIn(path, true);
  if (!isSeq(node)) {
    doc.setIn(path, doc.createNode([]));
    node = doc.getIn(path, true);
  }
  const seq = node as YAMLSeq;
  seq.flow = false;
  return seq;
}

const values = (seq: YAMLSeq): string[] =>
  seq.items.map((n) => (isScalar(n) ? String(n.value) : "")).map((v) => v.toLowerCase());

/** The policy text with the plan applied. Throws on a policy that is not valid YAML. */
export function applyEnforcePlan(
  policyPath: string,
  plan: EnforcePlan,
  now = new Date(),
): EnforceEdit {
  const created = !existsSync(policyPath);
  const before = created ? "" : readFileSync(policyPath, "utf8");
  let text = created ? renderHooksStarterPolicy(now) : before;
  if (!/^hooks\s*:/m.test(text)) text = `${text.replace(/\n*$/, "\n")}${HOOKS_POLICY_BLOCK}`;
  const doc = YAML.parseDocument(text);
  if (doc.errors.length > 0)
    throw new Error(`${policyPath} is not valid YAML: ${doc.errors[0]!.message}`);
  const added: string[] = [];

  for (const item of plan.items) {
    const seq = seqAt(doc, item.list.split("."));
    if (values(seq).includes(item.pattern.toLowerCase())) continue;
    const node = doc.createNode(item.pattern) as Scalar;
    node.comment = origin(item.rule);
    seq.items.push(node);
    added.push(`${item.list}: ${item.pattern}  (R${item.rule.n}, ${item.check.label})`);
  }

  if (plan.builtins.length > 0) {
    const path = ["hooks", "irreversible", "builtins"];
    const node = doc.getIn(path, true);
    const enabled = isScalar(node) ? node.value : undefined;
    if (enabled === false || isSeq(node)) {
      const seq = seqAt(doc, path);
      for (const b of plan.builtins) {
        if (values(seq).includes(b.name)) continue;
        const scalar = doc.createNode(b.name) as Scalar;
        scalar.comment = origin(b.rule);
        seq.items.push(scalar);
        added.push(`hooks.irreversible.builtins: ${b.name}  (R${b.rule.n}, ${b.check.label})`);
      }
    }
    // `true` or absent: every built-in class is already on
  }

  if (plan.irreversible.length > 0) {
    const seq = seqAt(doc, ["hooks", "irreversible", "rules"]);
    const names = new Set(
      seq.items.map((n) => (isMap(n) ? String(n.get("name") ?? "") : "")).filter(Boolean),
    );
    for (const r of plan.irreversible) {
      if (names.has(r.name)) continue;
      const node = doc.createNode({ name: r.name, shell: r.shell, mentions: r.mentions });
      if (isMap(node)) node.commentBefore = origin(r.rule);
      seq.items.push(node);
      added.push(
        `hooks.irreversible.rules: ${r.name} (${r.shell.length} commands)  (R${r.rule.n}, ${r.check.label})`,
      );
    }
  }

  const mode = doc.getIn(["hooks", "mode"]) === "enforce" ? "enforce" : "dry-run";
  return { before, after: doc.toString({ lineWidth: 0 }), created, added, mode };
}

/** A unified-style line diff, with `context` unchanged lines around each change. */
export function lineDiff(a: string, b: string, context = 2): string[] {
  const x = a === "" ? [] : a.replace(/\n$/, "").split("\n");
  const y = b.replace(/\n$/, "").split("\n");
  const n = x.length;
  const m = y.length;
  // longest common subsequence, small files only
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1)
    for (let j = m - 1; j >= 0; j -= 1)
      lcs[i]![j] =
        x[i] === y[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const ops: { op: " " | "+" | "-"; line: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) {
      ops.push({ op: " ", line: x[i]! });
      i += 1;
      j += 1;
    } else if (j < m && (i >= n || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) {
      ops.push({ op: "+", line: y[j]! });
      j += 1;
    } else {
      ops.push({ op: "-", line: x[i]! });
      i += 1;
    }
  }
  const keep = new Set<number>();
  ops.forEach((o, k) => {
    if (o.op === " ") return;
    for (let d = -context; d <= context; d += 1) keep.add(k + d);
  });
  const out: string[] = [];
  let last = -2;
  ops.forEach((o, k) => {
    if (!keep.has(k)) return;
    if (k !== last + 1 && out.length > 0) out.push("  …");
    out.push(`${o.op} ${o.line}`);
    last = k;
  });
  return out;
}
