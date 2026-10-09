/**
 * `okgate audit` end to end through `main`, on the synthetic history in
 * `fixtures/audit-sessions.ts`: rule files in every format, five Claude Code sessions and a Codex
 * rollout in the repo (one older Claude session, and one session and one rollout elsewhere).
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadPolicyFromYaml } from "@agentwares/agentguard-core";
import { main } from "../cli.js";
import type { Io } from "../context.js";
import { AUDIT_CANARIES, writeSyntheticAuditHistory } from "../fixtures/audit-sessions.js";
import { TEAM_HISTORY_LINE } from "./audit.js";

let dir: string;
let repo: string;
let home: string;
let out: string[];
let io: Io;
const NOW = new Date();

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "okgate-audit-")));
  repo = join(dir, "acme");
  home = join(dir, "home");
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(home);
  writeSyntheticAuditHistory({
    repo,
    claudeDir: join(home, ".claude", "projects"),
    codexDir: join(home, ".codex", "sessions"),
    now: NOW,
  });
  out = [];
  io = {
    out: (l) => out.push(l),
    err: (l) => out.push(`ERR ${l}`),
    cwd: repo,
    env: { PATH: process.env.PATH, HOME: home, USER: "tester" },
  };
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function audit(...argv: string[]): Promise<{ code: number; text: string }> {
  out = [];
  const code = await main(["audit", ...argv], io);
  return { code, text: out.join("\n") };
}

interface JsonRule {
  n: number;
  text: string;
  status: string;
  sessions_broken: number;
  last_broken: string[];
  checks: {
    check: string;
    sessions_applicable: number;
    sessions_broken: number;
    sessions_on_request: number;
    refused: number;
    enforce: string;
  }[];
}

type JsonAudit = { rules: JsonRule[] } & Record<string, unknown>;

async function auditJson(...argv: string[]): Promise<JsonAudit> {
  const { text } = await audit("--json", ...argv);
  return JSON.parse(text) as JsonAudit;
}

const byN = (rules: JsonRule[], n: number): JsonRule => rules.find((r) => r.n === n)!;
const sources = (a: JsonAudit, client: string) =>
  (a.sources as Record<string, { read: number; cached: number }>)[client];

describe("okgate audit", () => {
  it("prints, per rule, sessions broken out of sessions checked, with the latest evidence on screen", async () => {
    const { code, text } = await audit();
    expect(code).toBe(0);
    const lines = text.split("\n");
    expect(lines[0]).toMatch(/^okgate audit — .*acme · since \d{4}-\d{2}-\d{2}$/);
    expect(text).toContain(
      "6 sessions in this repository (Claude Code 5, Codex 1). Read on this machine; nothing was sent anywhere.",
    );
    expect(text).toContain(
      "13 rules found (6 in CLAUDE.md, 3 in AGENTS.md, 1 in GEMINI.md, 2 in .cursor/rules/release.mdc, 1 in okgate.yaml); 11 checkable.",
    );
    expect(text).toContain(
      "no-push main — broken in 3 of 6 sessions (4 pushed); 1 refused by the harness",
    );
    expect(text).toContain(
      'run "pnpm check" before push — broken in 3 of 6 sessions (4 pushed or opened a PR); 4 times',
    );
    expect(text).toContain(
      "no-new-deps unless-asked — broken in 1 of 6 sessions (1 added packages)",
    );
    expect(text).toContain("no-rm-outside — broken in 1 of 6 sessions (1 removed files)");
    expect(text).toContain("no-deploy — broken in 1 of 6 sessions; 1 on a turn that asked for it");
    // evidence, on this screen only: the command, credentials masked
    expect(text).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2} {2}git push origin main {2}\[refused\]/);
    expect(text).toContain("vercel env pull .env.local --token <redacted>");
    expect(text).toContain("Edit pnpm-lock.yaml");
    expect(text).toMatch(/NOT CHECKABLE MECHANICALLY \(2\)[^\n]*\/okgate:audit/);
    expect(text).toContain("R9   Keep functions small.   (AGENTS.md:5)  [marked none]");
    expect(lines[lines.length - 1]).toBe(TEAM_HISTORY_LINE);
  });

  it("--json: counts, rule ids and dates, and the same answer from the cache", async () => {
    const first = await auditJson();
    expect(first.sessions).toEqual({ total: 6, "claude-code": 5, codex: 1 });
    expect(first.unread_tool_calls).toBe(1);
    expect(first.rules.map((r) => [r.n, r.status, r.sessions_broken])).toEqual([
      [1, "broken", 3],
      [2, "broken", 1],
      [3, "broken", 1],
      [4, "broken", 3],
      [5, "broken", 2],
      [6, "not-checkable", 0],
      [7, "broken", 1],
      [8, "broken", 1],
      [9, "not-checkable", 0],
      [10, "broken", 1],
      [11, "broken", 1],
      [12, "broken", 1],
      [13, "broken", 1],
    ]);
    expect(byN(first.rules, 1).checks[0]).toMatchObject({
      check: "no-push main",
      sessions_applicable: 4,
      sessions_broken: 3,
      refused: 1,
      enforce: "hooks.shell.deny",
    });
    expect(byN(first.rules, 4).checks[0]!.enforce).toBe("audit-only");
    expect(byN(first.rules, 1).last_broken).toHaveLength(3);
    expect(first.team_history).toEqual({
      available: false,
      url: "https://agentwares-agentguard.vercel.app/team-history",
    });
    expect(sources(first, "claude-code")).toMatchObject({ read: 8, cached: 0 });

    const second = await auditJson();
    expect(sources(second, "claude-code")).toMatchObject({ read: 0, cached: 8 });
    expect(second.rules).toEqual(first.rules);
  });

  it("never writes transcript text to the cache or to the JSON", async () => {
    const human = (await audit()).text;
    const { text: json } = await audit("--json");
    const cacheDir = join(home, ".okgate", "audit-cache-v1");
    const cached = readdirSync(cacheDir).map((f) => readFileSync(join(cacheDir, f), "utf8"));
    expect(cached.length).toBeGreaterThan(0);
    for (const canary of AUDIT_CANARIES) {
      expect(json).not.toContain(canary);
      for (const c of cached) expect(c).not.toContain(canary);
    }
    // what only the transcripts say (the rule files may name `vercel env pull` themselves)
    const transcriptOnly = [
      "git push origin",
      "npm install",
      "rm -rf /srv",
      "left-pad",
      "fix/login",
      "sk_live",
      "toolu_",
      "subagents",
      "README.md",
    ];
    for (const leak of transcriptOnly) {
      expect(json.includes(leak), `JSON holds "${leak}"`).toBe(false);
      for (const c of cached) expect(c.includes(leak), `cache holds "${leak}"`).toBe(false);
    }
    // the cache does not hold the rules either: a check is keyed by its kind and a hash
    for (const c of cached) expect(/pnpm-lock|vercel env|"main"/.test(c)).toBe(false);
    for (const c of cached) expect(c.includes(repo), "cache holds the repo path").toBe(false);
    // the screen is the one place evidence is shown
    expect(human).toContain("CANARY-COMMIT-MESSAGE-5c2f");
  });

  it("shows the same evidence when every transcript comes from the cache", async () => {
    const fresh = (await audit()).text;
    const cached = (await audit()).text;
    const evidence = (t: string) => t.split("\n").filter((l) => /^ {9}\d{4}-/.test(l));
    expect(evidence(cached)).toEqual(evidence(fresh));
    expect(evidence(fresh).length).toBeGreaterThan(10);
  });

  it("keeps the counts from a transcript the client has since deleted", async () => {
    await audit();
    const projects = join(home, ".claude", "projects");
    const project = readdirSync(projects).find((d) => !d.endsWith("-other"))!;
    rmSync(join(projects, project, "s2-main.jsonl"));
    const { text } = await audit();
    expect(text).toContain("1 kept from deleted transcripts");
    expect(text).toContain("no-verify — broken in 1 of 6 sessions");
    expect(text).toContain("(transcript no longer on disk)");
  });

  it("--since and --client choose the sessions", async () => {
    const all = await auditJson("--since", "all");
    expect(all.sessions).toEqual({ total: 7, "claude-code": 6, codex: 1 });
    expect(byN(all.rules, 1).sessions_broken).toBe(4);
    const codex = await auditJson("--client", "codex", "--since", "30d");
    expect(codex.sessions).toEqual({ total: 1, "claude-code": 0, codex: 1 });
    expect(byN(codex.rules, 5).sessions_broken).toBe(1);
    expect(byN(codex.rules, 7).status).toBe("not-applicable");
  });

  it("--no-evidence shows when, not what", async () => {
    const { text } = await audit("--no-evidence");
    expect(text).not.toContain("git push origin main");
    expect(text).not.toContain("transcript no longer on disk");
    expect(text).toMatch(/^ {9}\d{4}-\d{2}-\d{2} \d{2}:\d{2} {2}\[refused\] {2}· session /m);
  });

  it("--no-cache writes nothing", async () => {
    await audit("--no-cache");
    expect(existsSync(join(home, ".okgate", "audit-cache-v1"))).toBe(false);
  });

  it("matches sessions from every worktree when run inside one", async () => {
    const wt = join(repo, ".claude", "worktrees", "w1");
    mkdirSync(wt, { recursive: true });
    mkdirSync(join(repo, ".git", "worktrees", "w1"), { recursive: true });
    writeFileSync(join(wt, ".git"), `gitdir: ${join(repo, ".git", "worktrees", "w1")}\n`);
    writeFileSync(join(wt, "CLAUDE.md"), "- Never push to `main`.\n");
    io = { ...io, cwd: wt };
    const r = await auditJson();
    expect(r.repo).toBe(repo);
    expect(r.checkout).toBe(wt);
    expect(r.rules.map((x) => [x.text, x.sessions_broken])).toEqual([["Never push to `main`.", 3]]);
  });

  it("says so when there is nothing to audit", async () => {
    const empty = join(dir, "empty");
    mkdirSync(empty);
    io = { ...io, cwd: empty };
    const { code, text } = await audit();
    expect(code).toBe(0);
    expect(text).toContain("No rule files here");
    expect(text.trim().split("\n").pop()).toBe(TEAM_HISTORY_LINE);
  });

  it("rejects a --since it cannot read", async () => {
    const { code, text } = await audit("--since", "last tuesday");
    expect(code).toBe(1);
    expect(text).toContain("--since");
  });
});

describe("okgate audit --enforce", () => {
  it("--preview shows the diff and writes nothing", async () => {
    const before = readFileSync(join(repo, "okgate.yaml"), "utf8");
    const { code, text } = await audit("--enforce", "--preview");
    expect(code).toBe(0);
    expect(text).toContain("would update");
    expect(text).toMatch(/\+ +- git push \* main # R1 CLAUDE\.md:5/);
    expect(text).toContain("Preview only: nothing was written.");
    expect(readFileSync(join(repo, "okgate.yaml"), "utf8")).toBe(before);
    expect(existsSync(join(repo, ".claude", "settings.json"))).toBe(false);
  });

  it("writes the hook rules in dry-run, keeps the rest of the policy, and installs the hook", async () => {
    const { code, text } = await audit("--enforce", "--command", "okgate");
    expect(code).toBe(0);
    const yaml = readFileSync(join(repo, "okgate.yaml"), "utf8");
    expect(yaml).toContain("id: publish");
    expect(yaml).toMatch(/^ {2}mode: dry-run/m);
    expect(yaml).toContain("- git push * main # R1 CLAUDE.md:5");
    expect(yaml).toContain("- pnpm-lock.yaml # R10 GEMINI.md:3");
    expect(yaml).toContain("- name: deploy");
    const policy = loadPolicyFromYaml(yaml);
    expect(policy.hooks.mode).toBe("dry-run");
    expect(policy.hooks.shell.deny).toEqual(
      expect.arrayContaining(["git push * main", "vercel env pull*", "npm install*"]),
    );
    expect(policy.hooks.shell.approval).toEqual(expect.arrayContaining(["pnpm add *"]));
    expect(policy.audit.rules).toEqual([
      { id: "publish", text: "Only CI publishes packages", check: "no-publish" },
    ]);
    expect(text).toContain("Audit only (a pre-execution hook cannot check these):");
    expect(text).toContain('R4 run "pnpm check" before push');
    const settings = JSON.parse(readFileSync(join(repo, ".claude", "settings.json"), "utf8")) as {
      hooks: { PreToolUse: { hooks: { command: string }[] }[] };
    };
    expect(settings.hooks.PreToolUse[0]!.hooks[0]!.command).toBe(
      "okgate hook pre-tool-use --client claude",
    );
    expect(text).toContain("hooks.mode is dry-run");

    const again = await audit("--enforce");
    expect(again.text).toContain("already has a hook rule for every enforceable rule");
    expect(again.text).toContain("The okgate hook is already installed");
  });

  it("never adds rules that would block at once without --yes", async () => {
    const enforcing = "version: 1\nhooks:\n  mode: enforce\n";
    writeFileSync(join(repo, "okgate.yaml"), enforcing);
    const refused = await audit("--enforce");
    expect(refused.code).toBe(1);
    expect(refused.text).toContain("hooks.mode is enforce");
    expect(readFileSync(join(repo, "okgate.yaml"), "utf8")).toBe(enforcing);
    const forced = await audit("--enforce", "--yes", "--command", "okgate");
    expect(forced.code).toBe(0);
    const yaml = readFileSync(join(repo, "okgate.yaml"), "utf8");
    expect(yaml).toContain("git push * main");
    expect(yaml).toContain("mode: enforce");
  });

  it("writes a starter policy when there is none", async () => {
    rmSync(join(repo, "okgate.yaml"));
    const { text } = await audit("--enforce", "--command", "okgate");
    expect(text).toContain("wrote");
    const yaml = readFileSync(join(repo, "okgate.yaml"), "utf8");
    expect(yaml).toContain("# okgate.yaml — generated by `okgate hooks install`");
    expect(yaml).toContain("- git push *--force*");
  });
});
