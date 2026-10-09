/**
 * The product's names. agentguard was renamed okgate on 8 October 2026 (brief REN-1), and
 * `init` and `hooks install` had already written the old names into other people's committed
 * files, so every old name keeps working, not just pointing:
 *
 * - the policy file: `okgate.yaml`, else `agentguard.yaml`;
 * - the state directory: `.okgate/`, else an existing `.agentguard/` (its hash chain continues);
 * - environment variables: `OKGATE_<X>`, else `AGENTGUARD_<X>`. Both kill variables always halt;
 * - MCP tool names: `okgate_*` are listed, and an `agentguard_*` call is mapped to its new name
 *   until {@link OLD_NAMES_UNTIL}, then answered with `TOOL_RENAMED`.
 *
 * Web-standard: no `node:` imports, so the hosted proxy can use it too.
 */
import type { GuardErrorBody } from "./errors.js";

export const PRODUCT = "okgate";
export const LEGACY_PRODUCT = "agentguard";

export const POLICY_FILE = "okgate.yaml";
export const LEGACY_POLICY_FILE = "agentguard.yaml";
/** Looked for in this order. */
export const POLICY_FILES = [POLICY_FILE, LEGACY_POLICY_FILE] as const;

export const STATE_DIR = ".okgate";
export const LEGACY_STATE_DIR = ".agentguard";

export const ENV_PREFIX = "OKGATE_";
export const LEGACY_ENV_PREFIX = "AGENTGUARD_";
export const KILL_ENV = "OKGATE_KILL";
export const LEGACY_KILL_ENV = "AGENTGUARD_KILL";

export const TOOL_PREFIX = "okgate_";
export const LEGACY_TOOL_PREFIX = "agentguard_";

/**
 * The last day an old tool name is accepted: at least 90 days after the release that ships the
 * rename (the release was due 8–17 Oct 2026, so this errs late). Old names stop being mapped
 * only after the end of this day, UTC.
 */
export const OLD_NAMES_UNTIL = "2027-01-15";

/** True until the end of {@link OLD_NAMES_UNTIL} (UTC). */
export function oldNamesAccepted(now: Date = new Date()): boolean {
  return now.getTime() < Date.parse(`${OLD_NAMES_UNTIL}T00:00:00Z`) + 24 * 60 * 60 * 1000;
}

/**
 * `OKGATE_<name>`, or `AGENTGUARD_<name>` when the new one is unset or empty.
 * `envTwin(env, "CONFIG")` reads `OKGATE_CONFIG`, then `AGENTGUARD_CONFIG`.
 */
export function envTwin(env: Record<string, string | undefined>, name: string): string | undefined {
  const next = env[`${ENV_PREFIX}${name}`];
  if (next !== undefined && next !== "") return next;
  const old = env[`${LEGACY_ENV_PREFIX}${name}`];
  return old !== undefined && old !== "" ? old : undefined;
}

/** Which of the twins supplied the value, for messages: `OKGATE_CONFIG` or `AGENTGUARD_CONFIG`. */
export function envTwinName(
  env: Record<string, string | undefined>,
  name: string,
): string | undefined {
  const next = env[`${ENV_PREFIX}${name}`];
  if (next !== undefined && next !== "") return `${ENV_PREFIX}${name}`;
  const old = env[`${LEGACY_ENV_PREFIX}${name}`];
  return old !== undefined && old !== "" ? `${LEGACY_ENV_PREFIX}${name}` : undefined;
}

/** `agentguard_get_status` → `okgate_get_status`; any other name → undefined. */
export function renamedToolName(name: string): string | undefined {
  return name.startsWith(LEGACY_TOOL_PREFIX)
    ? `${TOOL_PREFIX}${name.slice(LEGACY_TOOL_PREFIX.length)}`
    : undefined;
}

export type ToolNameResolution =
  /** not an old name: call it as it is */
  | { kind: "current"; name: string }
  /** an old name inside the window: call `name`, and add `meta` to the result's `_meta` */
  | { kind: "renamed"; name: string; from: string; meta: Record<string, unknown> }
  /** an old name after the window: answer `error` */
  | { kind: "expired"; name: string; from: string; error: GuardErrorBody };

/**
 * What a `tools/call` for `name` should run. `exists` says whether a tool is served under the new
 * name; an old name with no new twin is left alone, so it fails as any unknown tool does.
 */
export function resolveToolName(
  name: string,
  exists: (name: string) => boolean,
  now: Date = new Date(),
): ToolNameResolution {
  const next = renamedToolName(name);
  if (next === undefined || !exists(next)) return { kind: "current", name };
  if (!oldNamesAccepted(now))
    return {
      kind: "expired",
      name: next,
      from: name,
      error: {
        code: "TOOL_RENAMED",
        cause: `${name} was renamed ${next} when agentguard became okgate; the old name was accepted until ${OLD_NAMES_UNTIL}`,
        fix: `call ${next} with the same arguments; tools/list shows the current names`,
        retryable: false,
        details: { tool: name, renamed_to: next },
      },
    };
  return {
    kind: "renamed",
    name: next,
    from: name,
    meta: {
      "okgate/deprecation": {
        tool: name,
        renamed_to: next,
        accepted_until: OLD_NAMES_UNTIL,
        note: `${name} is a deprecated name for ${next} (agentguard is now okgate). Call ${next}; the old name stops working after ${OLD_NAMES_UNTIL}.`,
      },
    },
  };
}
