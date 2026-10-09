/**
 * The files that put agentguard where agent builders already are: the README's install buttons,
 * this package's CHANGELOG (the release notes), and the repo-root files the sync copies from
 * `distribution/root` (Claude Code plugin marketplace, Gemini CLI extension, Dockerfile, release
 * workflow). The public repo has those at its root and not under this package, so their checks
 * run in the monorepo only; `scripts/sync-oss-repos.sh` re-validates them when it copies them.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { OLD_NAMES_UNTIL, parsePolicy } from "@agentwares/agentguard-core";
import { isProxyEntry, type ServerEntry } from "./configs.js";
import {
  FROM_GITHUB,
  INSTALL,
  NEW_NPM_NAMES,
  PACKAGE,
  RUN,
  npxArgs,
  npxCommand,
} from "./install.js";

/** What a plugin skill or a Gemini command runs: the newest build, no prompt. */
const RUN_LATEST = npxCommand("latest");

const here = (rel: string): URL => new URL(`../${rel}`, import.meta.url);
const read = (rel: string): string => readFileSync(here(rel), "utf8");
const json = <T>(rel: string): T => JSON.parse(read(rel)) as T;
const pkg = json<{ name: string; version: string }>("package.json");

describe("install links in the README", () => {
  const readme = read("README.md");
  const href = (prefix: string): URL => {
    const match = readme.match(new RegExp(`\\]\\((${prefix.replace(/[.?]/g, "\\$&")}[^)\\s]+)\\)`));
    expect(match, `a link starting ${prefix}`).toBeTruthy();
    return new URL(match![1]!);
  };

  it("Add to Cursor carries the base64 server config that `init` recognises as the proxy", () => {
    const url = href("https://cursor.com/link/mcp/install?");
    expect(url.searchParams.get("name")).toBe("okgate");
    const config = JSON.parse(
      Buffer.from(url.searchParams.get("config")!, "base64").toString("utf8"),
    ) as ServerEntry;
    // the package npm serves the okgate bin from (src/install.ts)
    expect(config).toEqual({ command: "npx", args: [...npxArgs({ yes: true }), "proxy"] });
    // so a later `init` skips it instead of wrapping okgate in itself
    expect(isProxyEntry(config)).toBe(true);
  });

  it("Install in VS Code carries the same server, as vscode:mcp/install expects it", () => {
    const url = href("https://vscode.dev/redirect/mcp/install?");
    expect(url.searchParams.get("name")).toBe("okgate");
    const config = JSON.parse(url.searchParams.get("config")!) as ServerEntry;
    expect(config).toEqual({
      type: "stdio",
      command: "npx",
      args: [...npxArgs({ yes: true }), "proxy"],
    });
    expect(isProxyEntry(config)).toBe(true);
  });
});

describe("CHANGELOG", () => {
  it("has a section for this version, which the release workflow uses as the notes", () => {
    expect(read("CHANGELOG.md")).toMatch(
      new RegExp(`^## ${pkg.version.replace(/\./g, "\\.")} `, "m"),
    );
  });
});

const root = "distribution/root";
describe.skipIf(!existsSync(here(root)))("repo-root files (distribution/root)", () => {
  it("the marketplace's plugin resolves, and versions match this package", () => {
    const marketplace = json<{
      name: string;
      owner: { name: string };
      plugins: { name: string; source: string }[];
    }>(`${root}/.claude-plugin/marketplace.json`);
    expect(marketplace.owner.name).toBe("agentwares");
    for (const entry of marketplace.plugins) {
      expect(entry.source.startsWith("./")).toBe(true);
      const plugin = json<{ name: string; version: string }>(
        `${root}/${entry.source.slice(2)}/.claude-plugin/plugin.json`,
      );
      expect(plugin.name).toBe(entry.name);
      expect(plugin.version).toBe(pkg.version);
    }
    // okgate, and for the window the deprecated agentguard entry with the same skills
    expect(marketplace.plugins.map((p) => p.name)).toEqual(["okgate", "agentguard"]);
    const gemini = json<{ name: string; version: string }>(`${root}/gemini-extension.json`);
    // Gemini CLI installs an extension into a directory named after the repo: agentwares/okgate
    expect(gemini).toMatchObject({ name: "okgate", version: pkg.version });
  });

  it("the deprecated agentguard plugin and commands are okgate's, under the old names", () => {
    for (const skill of readdirSync(here(`${root}/plugins/okgate/skills`))) {
      const next = read(`${root}/plugins/okgate/skills/${skill}/SKILL.md`);
      const old = read(`${root}/plugins/agentguard/skills/${skill}/SKILL.md`);
      expect(old.replace(/\n> \*\*agentguard is now okgate\.\*\*[\s\S]*?\n\n/, "\n")).toBe(
        next.replaceAll("/okgate:", "/agentguard:"),
      );
    }
    for (const command of ["audit", "hooks", "init", "report"]) {
      const old = read(`${root}/commands/agentguard/${command}.toml`);
      expect(old).toContain(`Deprecated, use /okgate:${command}`);
      expect(old).toContain(RUN_LATEST);
    }
  });

  it("every skill and Gemini command says what it runs: the published package", () => {
    const skills = readdirSync(here(`${root}/plugins/okgate/skills`));
    expect(skills.sort()).toEqual(["audit", "hooks", "init", "report"]);
    for (const skill of skills) {
      const text = read(`${root}/plugins/okgate/skills/${skill}/SKILL.md`);
      const front = YAML.parse(text.split("---")[1]!) as Record<string, unknown>;
      expect(front.name).toBe(skill);
      expect(String(front.description).length).toBeGreaterThan(80);
      expect(text).toContain(`${RUN_LATEST} ${skill}`);
    }
    // init and hooks rewrite configs: only the user starts them
    for (const skill of ["init", "hooks"]) {
      const front = YAML.parse(
        read(`${root}/plugins/okgate/skills/${skill}/SKILL.md`).split("---")[1]!,
      ) as Record<string, unknown>;
      expect(front["disable-model-invocation"]).toBe(true);
    }
    // the audit reads counts only: it never runs --enforce on its own
    const audit = read(`${root}/plugins/okgate/skills/audit/SKILL.md`);
    expect(audit).toContain(`${RUN_LATEST} audit --json`);
    expect(audit).toContain("Do not run `--enforce` unless the user asks");

    // Claude's plugin directory holds any skill that pre-approves shell commands ("Pre-approves
    // broad shell access in allowed-tools", 8 Oct 2026), even npx-specific ones: Claude Code asks.
    for (const skill of skills) {
      const front = YAML.parse(
        read(`${root}/plugins/okgate/skills/${skill}/SKILL.md`).split("---")[1]!,
      ) as Record<string, unknown>;
      expect(front["allowed-tools"], `${skill} pre-approves tools`).toBeUndefined();
    }

    for (const command of ["audit", "hooks", "init", "report"]) {
      const toml = read(`${root}/commands/okgate/${command}.toml`);
      expect(toml).toMatch(/^description = ".+"$/m);
      expect(toml).toMatch(/^prompt = """\n[\s\S]+\n"""\n$/m);
      expect(toml).toContain(`${RUN_LATEST} ${command}`);
    }
  });

  it("the plugin has the directory's icon: a square PNG, 512-2048 px, under 2 MB", () => {
    const png = readFileSync(here(`${root}/plugins/okgate/.claude-plugin/icon.png`));
    expect(png.subarray(1, 4).toString("latin1")).toBe("PNG");
    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    expect(width).toBe(height);
    expect(width).toBeGreaterThanOrEqual(512);
    expect(width).toBeLessThanOrEqual(2048);
    expect(png.length).toBeLessThan(2 * 1024 * 1024);
  });

  it("the Docker demo policy parses and points at the CRM fixture this package builds", () => {
    const demo = parsePolicy(YAML.parse(read(`${root}/docker/demo.okgate.yaml`)));
    expect(demo.mode).toBe("dry-run");
    expect(demo.upstreams).toEqual([
      expect.objectContaining({
        name: "crm",
        command: "node",
        args: ["/app/dist/fixtures/crm-server.js"],
      }),
    ]);
    expect(read("tsup.config.ts")).toContain('"fixtures/crm-server": "src/fixtures/crm-server.ts"');
    const dockerfile = read(`${root}/Dockerfile`);
    expect(dockerfile).toContain("COPY docker/demo.okgate.yaml /app/demo/okgate.yaml");
    expect(dockerfile).toContain(`pnpm --filter ${pkg.name} deploy --prod`);
  });

  it("the release workflow fires on the tag the registry workflow uses", () => {
    const release = YAML.parse(read(`${root}/.github/workflows/release.yml`)) as {
      on: { push: { tags: string[] } };
      permissions: Record<string, string>;
    };
    const registry = YAML.parse(read("publish-mcp.workflow.yml")) as {
      on: { push: { tags: string[] } };
    };
    expect(release.on.push.tags).toEqual(registry.on.push.tags);
    expect(release.permissions).toEqual({ contents: "write" });
  });
});

describe("the install command (src/install.ts)", () => {
  const server = json<{ name: string; packages: { identifier: string }[] }>("server.json");
  const meta = pkg as unknown as { mcpName: string; bin: Record<string, string> };
  const listing = read("scripts/generate-listing.mjs");

  it(`is ${INSTALL} while NEW_NPM_NAMES is ${String(NEW_NPM_NAMES)}`, () => {
    expect(PACKAGE).toBe(NEW_NPM_NAMES ? "@agentwares/okgate" : pkg.name);
    expect(INSTALL).toBe(
      FROM_GITHUB
        ? "npx --allow-git=root github:agentwares/okgate"
        : NEW_NPM_NAMES
          ? "npx @agentwares/okgate"
          : `npx -p ${pkg.name} okgate`,
    );
    expect(RUN).toBe(INSTALL.replace(/^npx /, "npx -y "));
    expect(npxCommand("1.2.3")).toBe(
      NEW_NPM_NAMES ? "npx -y @agentwares/okgate@1.2.3" : `npx -y -p ${pkg.name}@1.2.3 okgate`,
    );
    // the package serves the bin the command names, and the old one for the window
    expect(meta.bin).toEqual({ okgate: "./dist/cli.js", agentguard: "./dist/cli.js" });
  });

  it("the listing generator mirrors it; server.json names the package and its mcpName", () => {
    expect(listing).toContain(`const INSTALL = "${INSTALL}";`);
    expect(listing).toContain(`const RUN = "${RUN}";`);
    expect(listing).toContain(`const OLD_NAMES_UNTIL = "${OLD_NAMES_UNTIL}";`);
    // the hosted app's pages print it from their own copy (monorepo only: the public okgate repo
    // does not carry the hosted app)
    if (existsSync(here("../agentguard-hosted/src/hosts.ts"))) {
      expect(read("../agentguard-hosted/src/hosts.ts")).toContain(
        `export const OKGATE_INSTALL = "${INSTALL}";`,
      );
    }
    expect(server.name).toBe(meta.mcpName);
    expect(server.packages[0]!.identifier).toBe(PACKAGE);
  });

  // What an agent or a person copies and runs: a form npm cannot serve yet must not appear.
  it.each(["llms.txt", "server.json", "README.md", "PRIVACY.md", "CHANGELOG.md"])(
    "%s names no command that does not run",
    (file) => {
      const text = read(file);
      if (!NEW_NPM_NAMES) expect(text).not.toMatch(/npx (-y )?@agentwares\/okgate\b/);
      if (!FROM_GITHUB) expect(text).not.toContain("github:agentwares/okgate");
    },
  );
});
