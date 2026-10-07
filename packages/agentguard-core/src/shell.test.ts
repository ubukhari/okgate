import { describe, expect, it } from "vitest";
import {
  commandText,
  isWithin,
  normalizePath,
  parseShell,
  redactCommandLine,
  resolvePath,
} from "./shell.js";

const lines = (cmd: string, cwd = "/ws"): string[] =>
  parseShell(cmd, { cwd, home: "/home/me" }).map(commandText);

describe("parseShell", () => {
  it("splits compound commands on && || ; | & and newlines", () => {
    expect(lines("npm test && git push || echo fail; ls | wc -l & sleep 1\ngit status")).toEqual([
      "npm test",
      "git push",
      "echo fail",
      "ls",
      "wc -l",
      "sleep 1",
      "git status",
    ]);
  });

  it("keeps quoted separators inside one word", () => {
    expect(lines(`git commit -m "fix; then git push" && echo 'a && b'`)).toEqual([
      "git commit -m fix; then git push",
      "echo a && b",
    ]);
  });

  it("reaches commands inside $(…), backticks, bash -c, sh -lc and eval", () => {
    expect(lines("echo $(git push origin main)")).toContain("git push origin main");
    expect(lines("echo `rm -rf /`")).toContain("rm -rf /");
    expect(lines(`bash -c "git push --force"`)).toEqual(["git push --force"]);
    expect(lines(`sh -lc 'cd sub && npm publish'`)).toEqual(["npm publish"]);
    expect(lines(`eval "git push"`)).toEqual(["git push"]);
    expect(lines(`diff <(git show HEAD:a) a`)).toContain("git show HEAD:a");
  });

  it("drops assignments, reserved words and wrappers", () => {
    expect(lines("FOO=1 BAR=2 git push")).toEqual(["git push"]);
    expect(lines("sudo -u root rm -rf /var/x")).toEqual(["rm -rf /var/x"]);
    expect(lines("env -i A=1 nohup timeout 30 git push")).toEqual(["git push"]);
    expect(lines("if true; then git push; fi")).toEqual(["true", "git push"]);
    expect(lines("! git push")).toEqual(["git push"]);
    expect(lines("npx -y @agentwares/agentguard@0.1.8 approve apr_1")).toEqual([
      "@agentwares/agentguard approve apr_1",
    ]);
    expect(lines("pnpm dlx semantic-release@24 --no-ci")).toEqual(["semantic-release --no-ci"]);
    expect(lines("command -v git")).toEqual([]);
  });

  it("removes git's global options and follows -C", () => {
    const [cmd] = parseShell("git -C ../other -c core.pager=cat --no-pager push origin", {
      cwd: "/ws/app",
    });
    expect(cmd!.argv).toEqual(["git", "push", "origin"]);
    expect(cmd!.cwd).toBe("/ws/other");
  });

  it("skips heredoc bodies and comments", () => {
    const cmds = parseShell(
      "cat <<'EOF' > notes.md\ngit push origin main\nrm -rf /\nEOF\necho done # git push",
      { cwd: "/ws" },
    );
    expect(cmds.map(commandText)).toEqual(["cat", "echo done"]);
    expect(cmds[0]!.redirects.map((r) => [r.op, r.target.text])).toEqual([
      ["<<", "EOF"],
      [">", "notes.md"],
    ]);
    expect(lines("cat <<-END\n\tgit push\n\tEND\nls")).toEqual(["cat", "ls"]);
  });

  it("follows cd so relative paths resolve where they run", () => {
    const cmds = parseShell("cd /tmp && rm -rf build; cd ~ && ls", {
      cwd: "/ws",
      home: "/home/me",
    });
    expect(cmds.map((c) => [commandText(c), c.cwd])).toEqual([
      ["rm -rf build", "/tmp"],
      ["ls", "/home/me"],
    ]);
    const unknown = parseShell(`cd "$DIR" && rm -rf x`, { cwd: "/ws" });
    expect(unknown[0]!.cwd).toBe("");
  });

  it("marks words that depend on variables and expands ~", () => {
    const [cmd] = parseShell(`rm -rf "$TARGET" ~/notes ~bob`, { cwd: "/ws", home: "/home/me" });
    expect(cmd!.words.map((w) => [w.text, w.dynamic])).toEqual([
      ["rm", false],
      ["-rf", false],
      ["$TARGET", true],
      ["/home/me/notes", false],
      ["~bob", true],
    ]);
  });

  it("turns find -delete into a recursive rm of its roots and reads find -exec", () => {
    const cmds = parseShell("find /etc ~/x -name '*.bak' -delete; find . -exec rm {} \\;", {
      cwd: "/ws",
      home: "/home/me",
    });
    expect(cmds.map((c) => [commandText(c), c.via ?? ""])).toEqual([
      ["find /etc /home/me/x -name *.bak -delete", ""],
      ["rm -r /etc /home/me/x", "find -delete"],
      ["find . -exec rm {} ;", ""],
      ["rm {}", "find -exec"],
    ]);
  });

  it("records redirections and drops file-descriptor numbers", () => {
    const [cmd] = parseShell("npm test 2>&1 >> log.txt &> all.txt", { cwd: "/ws" });
    expect(cmd!.argv).toEqual(["npm", "test"]);
    expect(cmd!.redirects.map((r) => [r.op, r.target.text])).toEqual([
      [">&", "1"],
      [">>", "log.txt"],
      ["&>", "all.txt"],
    ]);
  });

  it("never throws on malformed input", () => {
    for (const bad of [`echo "unterminated`, "echo $(", "`", "cat <<EOF", "((", "a |", "\\"])
      expect(() => parseShell(bad)).not.toThrow();
  });
});

describe("paths", () => {
  it("normalizes and resolves POSIX and Windows spellings", () => {
    expect(normalizePath("/a/./b/../c/")).toBe("/a/c");
    expect(resolvePath("/ws/app", "../x")).toBe("/ws/x");
    expect(resolvePath("/ws", "/etc/passwd")).toBe("/etc/passwd");
    expect(normalizePath("C:\\proj\\src\\..\\a.ts")).toBe("C:/proj/a.ts");
    expect(isWithin("/ws/a", "/ws")).toBe(true);
    expect(isWithin("/ws", "/ws")).toBe(true);
    expect(isWithin("/wsx", "/ws")).toBe(false);
  });
});

describe("redactCommandLine", () => {
  it("masks tokens, passwords, credentials in URLs and well-known key shapes", () => {
    const out = redactCommandLine(
      `curl -H "Authorization: Bearer abcdefghijkl123" --token=s3cr3tvalue https://u:p@x.io GITHUB_TOKEN=ghp_abcdefghijklmnop gh auth`,
    );
    expect(out).not.toContain("abcdefghijkl123");
    expect(out).not.toContain("s3cr3tvalue");
    expect(out).not.toContain("u:p@");
    expect(out).not.toContain("ghp_abcdefghijklmnop");
    expect(redactCommandLine("git push origin main")).toBe("git push origin main");
  });
});
