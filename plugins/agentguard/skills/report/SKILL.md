---
name: report
description: Explain agentguard's report of the last agent run - what dry-run mode faked (records it would have created, updated or deleted, messages sent, dollars spent), what actually ran, and every call agentguard halted - and whether the policy is ready for enforce mode. Use after an agent has run behind agentguard, or when the user asks what an agent did or would have done.
argument-hint: "[--run <run id> | --all]"
---

# Explain the last agentguard run

Run, from the directory that holds `agentguard.yaml`:

```sh
npx -y @agentwares/agentguard@latest report $ARGUMENTS
```

If it fails with `INVALID_POLICY` and "no policy file", agentguard is not set up here: say so
and suggest `/agentguard:init`. If the policy lives elsewhere, rerun with `--config <path>`.

Then explain the report in plain words, in this order:

1. **Scope.** How many tool calls, over which upstream servers, in which mode.
2. **What it would have done** (dry-run only). Records created, updated and deleted, messages
   sent, money spent. Nothing in this section executed. Lead with anything destructive or costly.
3. **Where agentguard stepped in.** One line per halt, with what the code means:
   - `CAP_EXCEEDED`: a per-run or per-day cap in `caps:` was reached;
   - `LOOP_DETECTED`: the same call, or an A→B→A→B cycle, repeated;
   - `APPROVAL_REQUIRED`: a tool under `approval.tools` waited for a human
     (`npx -y @agentwares/agentguard approvals`, then `approve <id>` or `deny <id>`);
   - `KILLED`: the kill switch was on;
   - `TOOL_DENIED`: the tool matched `deny:` or was outside an agent key's `allow:` list.
4. **Audit chain.** Repeat the `Audit chain` line. If it says `BROKEN`, say that the log was
   edited and the report cannot be trusted.

If the run would have deleted, sent or spent anything, run
`npx -y @agentwares/agentguard@latest diff` and show the records that would have changed.

Finish with a recommendation the user can act on: destructive tools that ran and are not yet
under `approval.tools`, caps that were hit or are far above what the run used, and tools
classified as writes that only read (move them to `classify.read`). Say whether the run looks safe
to repeat with `mode: enforce`. The user decides: do not edit `agentguard.yaml` unless asked.
