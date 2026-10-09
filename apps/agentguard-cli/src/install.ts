/**
 * How to run okgate: the one constant behind every place the command is shown, printed or
 * written into someone's config: `--help` and the CLI's own hints, the hook command `hooks
 * install` writes, the MCP server entry `init` writes, the README, llms.txt, server.json and the
 * plugin files. src/distribution.test.ts fails while any of them names a form that does not run.
 *
 * agentguard was renamed okgate on 8 Oct 2026 (brief REN-1). The new npm names need the owner's
 * security key for their first publish, so until then npm serves okgate as a second bin of the
 * package it always was: `npx -p @agentwares/agentguard okgate`.
 *
 * - NEW_NPM_NAMES: flip when `@agentwares/okgate`, `-core` and `-sdk` 0.2.0 are on npm (and the
 *   old names have become shims). Hook commands and MCP entries then name `@agentwares/okgate`.
 *   The rest of the flip is listed in docs/handoff/briefs/REN-1.md's PR and in shims/README.md.
 * - FROM_GITHUB: the npm-free form REL-1 uses for the doors,
 *   `npx --allow-git=root github:agentwares/okgate` (npm 12 refuses a git spec unless
 *   `--allow-git` permits it; `root` permits only the one named; npm 10 and 11 accept the flag).
 *   It needs the public repo renamed AND a runnable package at its root, which it does not have
 *   today: scripts/sync-oss-repos.sh generates agentguard as a private pnpm workspace. Leave it
 *   off until `npx --allow-git=root github:agentwares/okgate --version` prints a version.
 */
export const NEW_NPM_NAMES: boolean = false;
export const FROM_GITHUB: boolean = false;

export const BIN = "okgate";
/** The npm package that serves the CLI. */
export const PACKAGE = NEW_NPM_NAMES ? "@agentwares/okgate" : "@agentwares/agentguard";
/** The npm package the policy engine is published as. */
export const CORE_PACKAGE = NEW_NPM_NAMES
  ? "@agentwares/okgate-core"
  : "@agentwares/agentguard-core";
/** The npm package the SDK is published as. */
export const SDK_PACKAGE = NEW_NPM_NAMES ? "@agentwares/okgate-sdk" : "@agentwares/agentguard-sdk";

const GITHUB = "--allow-git=root github:agentwares/okgate";

/** `npx` arguments that run the CLI from npm; `version` pins it. */
export function npxArgs(opts: { yes?: boolean; version?: string } = {}): string[] {
  const pkg = `${PACKAGE}${opts.version ? `@${opts.version}` : ""}`;
  return [...(opts.yes ? ["-y"] : []), ...(NEW_NPM_NAMES ? [pkg] : ["-p", pkg, BIN])];
}

/** What a person types. */
export const INSTALL = FROM_GITHUB ? `npx ${GITHUB}` : ["npx", ...npxArgs()].join(" ");

/** What an agent runs unattended: no install prompt. */
export const RUN = FROM_GITHUB ? `npx -y ${GITHUB}` : ["npx", ...npxArgs({ yes: true })].join(" ");

/**
 * The command a hook or an MCP client config runs: always from npm, pinned when `version` is
 * given, so a committed settings file keeps running the build that wrote it.
 */
export function npxCommand(version?: string): string {
  return ["npx", ...npxArgs({ yes: true, version })].join(" ");
}
