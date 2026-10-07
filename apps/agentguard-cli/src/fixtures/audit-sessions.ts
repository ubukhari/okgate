/**
 * A synthetic history for `agentguard audit`: rule files in every format it reads, and Claude
 * Code and Codex transcripts in the shapes those clients write (verified on 7 Oct 2026, structure
 * only), with known kept and broken rules. Every prompt, command and path here is made up; the
 * CANARY strings let a test prove none of them reaches the cache or the JSON.
 *
 * Used by the tests and by `scripts/audit-recorded-run.mjs`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const AUDIT_CANARIES = [
  "CANARY-PROMPT-7d1e",
  "CANARY-ASSISTANT-3b9a",
  "CANARY-COMMIT-MESSAGE-5c2f",
  "CANARY-OUTPUT-8e4d",
  "CANARY-PATH-2a6b",
  "CANARY-CONTENT-9f0c",
] as const;

const [PROMPT, ASSISTANT, COMMIT, OUTPUT, PATH, CONTENT] = AUDIT_CANARIES;

const CLAUDE_MD = `# Working in this repo

## Git

- Never push to \`main\`.
- Never force-push.
- Never use \`--no-verify\`.
- Run \`pnpm check\` before pushing.

## Tooling

- Use pnpm, not npm.
- Write tests for new code.
`;

const AGENTS_MD = `# AGENTS.md

- Do not add dependencies without asking.
- Never rm -rf anything outside the repo.
- Keep functions small. <!-- agentguard: none -->
`;

const GEMINI_MD = `# GEMINI.md

Do not edit \`pnpm-lock.yaml\` by hand.
`;

const CURSOR_RULE = `---
description: releases
alwaysApply: true
---

- Do not deploy.
- Do not use \`vercel env pull\`.
`;

const POLICY = `version: 1
audit:
  rules:
    - id: publish
      text: Only CI publishes packages
      check: no-publish
`;

export interface SyntheticAuditOptions {
  /** the repository: rule files are written here */
  repo: string;
  /** stands in for ~/.claude/projects */
  claudeDir: string;
  /** stands in for ~/.codex/sessions */
  codexDir: string;
  now?: Date;
}

export interface SyntheticAuditHistory {
  /** sessions in the repository in the last 7 days (5 Claude Code, 1 Codex) */
  sessionsLast7d: number;
  /** and with the one 20 days old */
  sessionsAll: number;
}

type Entry = Record<string, unknown>;

/** Write the rule files and the transcripts. */
export function writeSyntheticAuditHistory(opts: SyntheticAuditOptions): SyntheticAuditHistory {
  const now = (opts.now ?? new Date()).getTime();
  const repo = opts.repo;
  mkdirSync(join(repo, ".cursor", "rules"), { recursive: true });
  writeFileSync(join(repo, "CLAUDE.md"), CLAUDE_MD);
  writeFileSync(join(repo, "AGENTS.md"), AGENTS_MD);
  writeFileSync(join(repo, "GEMINI.md"), GEMINI_MD);
  writeFileSync(join(repo, ".cursor", "rules", "release.mdc"), CURSOR_RULE);
  writeFileSync(join(repo, "agentguard.yaml"), POLICY);

  const project = join(opts.claudeDir, repo.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(project, { recursive: true });
  let n = 0;

  const session = (id: string, daysAgo: number, cwd = repo) => {
    let t = now - daysAgo * 86_400_000;
    const lines: Entry[] = [];
    let branch = "fix/work";
    const base = (type: string, sidechain = false): Entry => {
      t += 45_000;
      n += 1;
      return {
        parentUuid: null,
        isSidechain: sidechain,
        type,
        uuid: `u-${id}-${n}`,
        timestamp: new Date(t).toISOString(),
        userType: "external",
        entrypoint: "cli",
        cwd,
        sessionId: id,
        version: "2.1.286",
        gitBranch: branch,
      };
    };
    const api = {
      lines,
      branch(b: string) {
        branch = b;
        return api;
      },
      human(text: string) {
        lines.push({
          ...base("user"),
          origin: { kind: "human" },
          message: { role: "user", content: text },
        });
        return api;
      },
      say(text: string) {
        lines.push({
          ...base("assistant"),
          message: { role: "assistant", content: [{ type: "text", text }] },
        });
        return api;
      },
      tool(name: string, input: Entry, result: Entry = {}, sidechain = false) {
        const toolId = `toolu_${id}_${n + 1}`;
        lines.push({
          ...base("assistant", sidechain),
          message: { role: "assistant", content: [{ type: "tool_use", id: toolId, name, input }] },
        });
        lines.push({
          ...base("user", sidechain),
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: toolId,
                content: `done ${OUTPUT}`,
                is_error: Boolean(result.toolDenialKind),
              },
            ],
          },
          toolUseResult: { stdout: `ok ${OUTPUT}`, stderr: "" },
          ...result,
        });
        return api;
      },
      bash(command: string, result: Entry = {}, sidechain = false) {
        return api.tool("Bash", { command, description: "synthetic" }, result, sidechain);
      },
      write(dir: string, file: string) {
        writeFileSync(
          join(dir, `${id}.jsonl`),
          lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
        );
        return file;
      },
    };
    return api;
  };

  // S1: kept everything — edited, checked, pushed a branch
  session("s1-kept", 6)
    .human(`fix the login bug ${PROMPT}`)
    .say(`Looking at it. ${ASSISTANT}`)
    .tool("Edit", {
      file_path: join(repo, "src", `${PATH}.ts`),
      old_string: "a",
      new_string: CONTENT,
    })
    .bash("pnpm check 2>&1 | tail -20")
    .bash(`git commit -am "fix login ${COMMIT}"`)
    .bash("git push origin fix/login")
    .write(project, "s1");

  // S2: pushed main without the check, and skipped the hooks
  session("s2-main", 5)
    .human("update the readme")
    .tool("Write", { file_path: join(repo, "README.md"), content: CONTENT })
    .bash(`git commit --no-verify -m "${COMMIT}"`)
    .bash("git push origin main")
    .write(project, "s2");

  // S3: npm instead of pnpm; one package asked for, one not (in a subagent)
  const s3 = session("s3-deps", 4)
    .human("add zod for the form validation")
    .bash("pnpm add zod")
    .bash("npm install");
  s3.write(project, "s3");
  // a subagent of the same session, a few minutes later: its sidechain lines carry the parent's id
  const sub = session("s3-deps", 3.99).bash("pnpm add left-pad", {}, true);
  mkdirSync(join(project, "s3-deps", "subagents"), { recursive: true });
  writeFileSync(
    join(project, "s3-deps", "subagents", "agent-a1.jsonl"),
    sub.lines.map((l) => JSON.stringify({ ...l, agentId: "a1" })).join("\n") + "\n",
  );

  // S4: force-push, rm outside the repo, a hand-edited lockfile, a refused push to main
  session("s4-cleanup", 3)
    .human("clean up the branch")
    .bash("git push --force origin fix/work")
    .bash("rm -rf /srv/old-builds")
    .tool("Edit", { file_path: join(repo, "pnpm-lock.yaml"), old_string: "a", new_string: "b" })
    .bash("git push origin main", { toolDenialKind: "user-rejected" })
    .write(project, "s4");

  // S5: secrets pulled, a deploy the person asked for, a publish
  session("s5-release", 2)
    .human("deploy the release to production")
    .bash("vercel env pull .env.local --token sk_live_synthetic000000")
    .bash("vercel --prod")
    .bash("npm publish --access public")
    .write(project, "s5");

  // S6: twenty days ago — only in a 30-day audit
  session("s6-old", 20).human("ship it").bash("git push origin main").write(project, "s6");

  // another repository on the same machine: never counted
  const other = join(opts.claudeDir, `${repo.replace(/[^a-zA-Z0-9]/g, "-")}-other`);
  mkdirSync(other, { recursive: true });
  session("s7-elsewhere", 1, `${repo}-other`).bash("git push origin main").write(other, "s7");

  // Codex: one rollout in the repository, one elsewhere
  const day = new Date(now - 86_400_000);
  const codexDay = join(
    opts.codexDir,
    String(day.getUTCFullYear()),
    String(day.getUTCMonth() + 1).padStart(2, "0"),
    String(day.getUTCDate()).padStart(2, "0"),
  );
  mkdirSync(codexDay, { recursive: true });
  const rollout = (thread: string, cwd: string): string => {
    let t = now - 86_400_000;
    const line = (type: string, payload: Entry): Entry => {
      t += 30_000;
      return { timestamp: new Date(t).toISOString(), type, payload };
    };
    const call = (cmd: string, k: number): Entry =>
      line("response_item", {
        type: "function_call",
        name: "exec_command",
        call_id: `call_${thread}_${k}`,
        arguments: JSON.stringify({ cmd, workdir: cwd, yield_time_ms: 1000 }),
      });
    return (
      [
        line("session_meta", {
          id: thread,
          cwd,
          cli_version: "0.159.0",
          originator: "codex_cli_rs",
          source: "cli",
        }),
        line("turn_context", { turn_id: "t1", cwd, model: "synthetic-model" }),
        line("response_item", {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: PROMPT }],
        }),
        call("npm run build", 1),
        call("git push origin main", 2),
        line("response_item", {
          type: "custom_tool_call",
          name: "exec",
          call_id: `call_${thread}_3`,
          input: `await run(${JSON.stringify(CONTENT)})`,
        }),
      ]
        .map((l) => JSON.stringify(l))
        .join("\n") + "\n"
    );
  };
  writeFileSync(
    join(codexDay, "rollout-2026-10-06T10-00-00-thread-in-repo.jsonl"),
    rollout("thread-in-repo", repo),
  );
  writeFileSync(
    join(codexDay, "rollout-2026-10-06T11-00-00-thread-other.jsonl"),
    rollout("thread-other", "/elsewhere/project"),
  );

  return { sessionsLast7d: 6, sessionsAll: 7 };
}
