---
name: audit
description: Check which rules in this repo's CLAUDE.md, AGENTS.md, GEMINI.md and .cursor/rules the coding agents actually broke, from this machine's own Claude Code and Codex sessions - per rule, sessions broken out of sessions checked and when - then judge the rules no script can check. Runs `npx @agentwares/agentguard audit --json` locally; nothing is sent anywhere. Use when the user asks whether agents follow CLAUDE.md, which rules get ignored, or before tightening the rules.
argument-hint: "[--since 7d|30d|all] [--client claude|codex|all]"
---

# Which written rules did the agents break?

Run, from the repository root:

```sh
npx -y @agentwares/agentguard@latest audit --json $ARGUMENTS
```

It reads the repo's rule files (CLAUDE.md, AGENTS.md, GEMINI.md, `.cursor/rules`, and
`audit.rules` in agentguard.yaml) and this machine's Claude Code and Codex transcripts for this
repository, and returns, per rule: `status` (`broken`, `kept`, `not-applicable`,
`not-checkable`), `sessions_broken`, each check's `sessions_applicable`, and `last_broken` dates.
The JSON holds counts, rule ids and dates only: no command, path or prompt from a transcript. Do
not go looking for the transcripts yourself; the counts are the point.

## 1. Report the mechanical results

In plain words, most broken first:

- "R4 (CLAUDE.md:12) `Run pnpm check before pushing` — broken in 9 of 31 sessions, last on …".
- Say how many sessions the window held, and the window (`since`).
- For a rule broken in most sessions, say that either the agents ignore it or the rule does not
  match how the team works, and ask which. Do not decide for the user.
- Name the rules kept, briefly.

The user can see which command or path broke each rule by running
`npx -y @agentwares/agentguard@latest audit` in their own terminal: that view is meant for
their screen only, so suggest it rather than running it here.

## 2. Judge the rules marked `not-checkable` — with what you can see, not with transcripts

For each rule whose `status` is `not-checkable` (skip those with `marked_not_checkable: true`:
the author said no check applies), decide one of **kept**, **broken** or **can't tell**, using
only:

- the repository as it is now (read the files the rule is about);
- recent history: `git log --since=<since> --stat` and `git show <commit>` for the commits in the
  window;
- what you did in this session.

One line each, with the evidence you used ("R7 Write tests for new code — broken: 3 of the 5
commits since Oct 1 add files under src/ with no test file"). Say "can't tell" when the history
cannot show it; never guess. Spend at most a few commands per rule.

Where a rule could be checked mechanically after all, suggest the inline comment that would make
it so, from this list, on the rule's line in its file:

```
<!-- agentguard: no-push main -->            <!-- agentguard: run "pnpm test" before push -->
<!-- agentguard: no-force-push -->           <!-- agentguard: use pnpm -->
<!-- agentguard: no-edit ".env" -->          <!-- agentguard: no-commit "*.pem" -->
<!-- agentguard: never "rm -rf /*" -->       <!-- agentguard: no-new-deps unless-asked -->
<!-- agentguard: none -->   (no mechanical check applies; stop listing it)
```

## 3. Next steps to offer

- `npx -y @agentwares/agentguard@latest audit --enforce --preview` shows the hook rules that
  would enforce the checkable rules; without `--preview` it writes them to agentguard.yaml in
  **dry-run** and installs the hook. Do not run `--enforce` unless the user asks: it edits
  agentguard.yaml and `.claude/settings.json`.
- Repeat the audit after a CLAUDE.md change to see whether adherence moved.

Do not edit CLAUDE.md or any rule file unless the user asks.
