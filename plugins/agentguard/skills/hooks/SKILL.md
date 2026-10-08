---
name: hooks
description: Install, check or remove agentguard hook mode, which checks this coding agent's own shell commands and file edits against agentguard.yaml before they run and lets irreversible commands (push, merge, publish, send, rm outside the repo) run only on a turn a person typed. Runs `npx @agentwares/agentguard hooks status|install|uninstall`; dry-run first, nothing blocked until the user switches to enforce.
argument-hint: "[status | install [--client claude|codex|gemini|all] [--user] | uninstall]"
disable-model-invocation: true
---

# agentguard hook mode

Hook mode puts one rulebook, `agentguard.yaml`, in front of the coding agent's own shell
commands, file edits and MCP calls (Claude Code `PreToolUse`, Codex `PreToolUse`, Gemini CLI
`BeforeTool`). It runs on this machine, needs no account and makes no LLM calls.

## 1. Where things stand

Always start with:

```sh
npx -y @agentwares/agentguard@latest hooks status
```

It lists, for the project and the user level, whether each client has the agentguard hook.
Tell the user in one or two lines.

## 2. Do what was asked

- **status** (or no argument): stop after step 1, and mention `agentguard report` for what the
  hook decided so far.
- **install**: say what it changes before running it — it writes the client's hook settings
  (`.claude/settings.json`, `.codex/hooks.json` or `.gemini/settings.json`; a backup is kept), a
  `hooks:` block in agentguard.yaml in **dry-run**, and `.agentguard/` to `.gitignore`. Then run
  `npx -y @agentwares/agentguard@latest hooks $ARGUMENTS`. `--user` installs it for every project
  on this machine: only when the user asked for that.
- **uninstall**: run `npx -y @agentwares/agentguard@latest hooks uninstall` (add `--user` for the
  user level). It removes only agentguard's entries and keeps agentguard.yaml.

## 3. After an install

1. The hook is read when a session starts: the user starts a new session.
2. Work as usual. In dry-run every decision is logged and nothing is blocked.
3. `npx -y @agentwares/agentguard@latest report` shows what enforce mode would have stopped.
4. When that list looks right, the user sets `hooks.mode: enforce` in agentguard.yaml.

Codex runs a new hook only after it is trusted in `/hooks`; Gemini CLI asks to confirm a project
hook once. To turn the repo's CLAUDE.md rules into hook rules, see `/agentguard:audit`.

Never set `hooks.mode: enforce`, and never run `agentguard approve`, yourself: agentguard refuses
an approval that comes from the agent.
