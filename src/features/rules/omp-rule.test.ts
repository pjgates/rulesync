import { createHash } from "node:crypto";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setupTestDirectory } from "../../test-utils/test-directories.js";
import { parseFrontmatter } from "../../utils/frontmatter.js";
import { RULESYNC_FORK_COMMIT } from "../../version.js";
import {
  OMP_GLOBAL_RULES_DIR,
  OMP_RULES_DIR,
  OMP_RULES_MARKER,
  OMP_TTSR_MANAGED,
  OMP_TTSR_RULES_DIR,
  OmpRule,
  buildOmpRuleStoreFiles,
  extractOmpRuleCandidates,
  ompRuleGlobMatches,
  ompRulesExtensionSource,
  isManagedOmpTtsrContent,
  validateOmpRuleGlob,
} from "./omp-rule.js";
import { RulesyncRule } from "./rulesync-rule.js";
describe("OmpRule", () => {
  let testDir: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ testDir, cleanup } = await setupTestDirectory());
    vi.spyOn(process, "cwd").mockReturnValue(testDir);
  });

  afterEach(async () => {
    await cleanup();
    vi.restoreAllMocks();
  });

  it("uses private project and global stores", () => {
    expect(OmpRule.getSettablePaths().nonRoot.relativeDirPath).toBe(OMP_RULES_DIR);
    expect(OmpRule.getSettablePaths({ global: true }).nonRoot.relativeDirPath).toBe(
      OMP_GLOBAL_RULES_DIR,
    );
  });

  it("emits private rules, native TTSR rules, and a canonical marker", () => {
    const root = new RulesyncRule({
      outputRoot: testDir,
      relativeDirPath: ".rulesync/rules",
      relativeFilePath: "z-root.md",
      frontmatter: { root: true, targets: ["omp"], description: "Root", globs: ["**/*"] },
      body: "Root body\n\n",
    });
    const conditional = new RulesyncRule({
      outputRoot: testDir,
      relativeDirPath: ".rulesync/rules",
      relativeFilePath: "a-typescript.md",
      frontmatter: { targets: ["omp"], description: "TS", globs: ["src/**/*.ts"] },
      body: "TypeScript body",
    });
    const triggered = new RulesyncRule({
      outputRoot: testDir,
      relativeDirPath: ".rulesync/rules",
      relativeFilePath: "b-triggered.md",
      frontmatter: {
        targets: ["omp"],
        description: "Triggered",
        globs: ["src/**/*.ts"],
        condition: ["dangerous\\("],
        astCondition: ["console.log($$$ARGS)"],
        scope: ["text", "tool:edit(src/**/*.ts)"],
        interruptMode: "always",
      },
      body: "Triggered body",
    });
    const files = buildOmpRuleStoreFiles({
      outputRoot: testDir,
      global: false,
      rules: [root, conditional, triggered].map((rulesyncRule) =>
        OmpRule.fromRulesyncRule({ outputRoot: testDir, rulesyncRule }),
      ),
    });
    const byName = new Map(files.map((file) => [file.getRelativeFilePath(), file]));

    expect(byName.get("z-root.md")?.getFileContent()).toBe("Root body\n");
    expect(byName.get("a-typescript.md")?.getFileContent()).toBe("TypeScript body\n");
    const triggeredFile = byName.get("rulesync-b-triggered.md");
    expect(triggeredFile?.getRelativeDirPath()).toBe(OMP_TTSR_RULES_DIR);
    expect(isManagedOmpTtsrContent(triggeredFile!.getFileContent())).toBe(true);
    const parsedTriggered = parseFrontmatter(triggeredFile!.getFileContent());
    expect(parsedTriggered.body).toBe("Triggered body\n");
    expect(parsedTriggered.frontmatter).toMatchObject({
      condition: ["dangerous\\("],
      astCondition: ["console.log($$$ARGS)"],
      scope: ["text", "tool:edit(src/**/*.ts)"],
      interruptMode: "always",
      globs: ["src/**/*.ts"],
      rulesyncManaged: OMP_TTSR_MANAGED,
    });
    const markerText = byName.get(OMP_RULES_MARKER)?.getFileContent();
    expect(markerText?.endsWith("\n")).toBe(true);
    const marker = JSON.parse(markerText!);
    expect(Object.keys(marker)).toEqual([
      "version",
      "contract",
      "forkCommit",
      "scope",
      "outputRoot",
      "rules",
    ]);
    expect(marker.forkCommit).toBe(RULESYNC_FORK_COMMIT);
    expect(marker.rules.map((rule: { path: string }) => rule.path)).toEqual([
      "a-typescript.md",
      "z-root.md",
    ]);
    expect(marker.rules.map((rule: { path: string }) => rule.path)).not.toContain("b-triggered.md");
    expect(marker.rules[0]).toEqual({
      path: "a-typescript.md",
      sha256: createHash("sha256").update("TypeScript body\n").digest("hex"),
      description: "TS",
      globs: ["src/**/*.ts"],
    });
    expect(marker.rules[1].globs).toEqual([]);
    expect(markerText).toBe(`${JSON.stringify(marker)}\n`);
  });

  it("emits one global extension even when no rules are authored", () => {
    const files = buildOmpRuleStoreFiles({ outputRoot: testDir, global: true, rules: [] });
    expect(files.map((file) => file.getRelativeFilePath())).toEqual([
      OMP_RULES_MARKER,
      "rulesync-project-rules.ts",
    ]);
    expect(files[1]?.getRelativeDirPath()).toBe(join(".omp", "agent", "extensions"));
  });

  it("rejects basename collisions before store generation", () => {
    const makeRule = (relativeFilePath: string) =>
      OmpRule.fromRulesyncRule({
        outputRoot: testDir,
        rulesyncRule: new RulesyncRule({
          outputRoot: testDir,
          relativeDirPath: ".rulesync/rules",
          relativeFilePath,
          frontmatter: { targets: ["omp"] },
          body: relativeFilePath,
        }),
      });
    expect(() =>
      buildOmpRuleStoreFiles({
        outputRoot: testDir,
        global: false,
        rules: [makeRule("one/shared.md"), makeRule("two/shared.md")],
      }),
    ).toThrow("basename collision");
  });

  it("ports the complete restricted glob grammar", () => {
    for (const pattern of ["src/*.ts", "src/**/test?.ts", "README.?", "folder name/*.md"]) {
      expect(() => validateOmpRuleGlob(pattern)).not.toThrow();
    }
    for (const pattern of [
      "",
      "/src/*.ts",
      "./src",
      "src/../x",
      "src//x",
      "src/**x",
      "src/[ab]",
      "!src",
      "src\\x",
      "src/\ntest",
    ]) {
      expect(() => validateOmpRuleGlob(pattern), pattern).toThrow("Invalid OMP rule glob");
    }
  });
  it("matches the complete path and basename vector", () => {
    const cases: Array<[string, string, boolean]> = [
      ["src/*.ts", "src/a.ts", true],
      ["src/*.ts", "src/nested/a.ts", false],
      ["src/**/*.ts", "src/a.ts", true],
      ["src/**/*.ts", "src/nested/a.ts", true],
      ["README.?", "docs/README.md", false],
      ["*.ts", "src/nested/a.ts", true],
      ["*.TS", "src/a.ts", false],
      ["**/*.md", "README.md", true],
      ["**/*.md", "docs/guide.md", true],
      ["src/**", "src/nested/a.ts", true],
      ["src/test?.ts", "src/test.ts", false],
      ["src/test?.ts", "src/test1.ts", true],
    ];
    for (const [pattern, candidate, expected] of cases) {
      expect(ompRuleGlobMatches(pattern, candidate), `${pattern} ${candidate}`).toBe(expected);
    }
  });

  it("normalizes and rejects the complete prompt candidate vector", () => {
    const candidates = extractOmpRuleCandidates(
      "open `src\\nested\\a.ts`, `path with space.md`, then './README.md'; docs/file.ts, docs/x.ts: " +
        "docs/y.ts; docs/z.ts() docs/q.ts[] '' C:\\secret.txt /etc/passwd //server/x " +
        "\\\\server\\share src//bad src/../bad ././kept.md \"quoted/inside.ts,\" 'single/inside.md;'",
    );
    for (const expected of [
      "src/nested/a.ts",
      "path with space.md",
      "README.md",
      "docs/file.ts",
      "docs/x.ts",
      "docs/y.ts",
      "docs/z.ts",
      "docs/q.ts",
      "./kept.md",
      "quoted/inside.ts",
      "single/inside.md",
    ]) {
      expect(candidates).toContain(expected);
    }
    for (const rejected of [
      "",
      "C:/secret.txt",
      "/etc/passwd",
      "//server/x",
      "//server/share",
      "src//bad",
      "src/../bad",
    ]) {
      expect(candidates).not.toContain(rejected);
    }
  });

  it("pins strict validation, selector normalization, cwd cache, and block dedup in the extension", () => {
    const extension = ompRulesExtensionSource();
    expect(extension).not.toContain("@oh-my-pi/pi-utils");
    expect(extension).toContain("function postRenderFormat(content: string)");
    expect(extension).toContain('.split("\\n").map((line) => line.trim())');
    expect(extension).toContain("const cwd = canonical(process.cwd())");
    expect(extension).toContain("const cache = new Map<string, LoadedRule[]>()");
    expect(extension).toContain(
      'const projectRules = root ? loadStore(path.join(root, ".omp", "rulesync-rules")',
    );
    expect(extension).toContain('const selected = (["global", "project"] as const).flatMap');
    expect(extension).toContain('path.join(agentDir, "rulesync-rules")');
    expect(extension).toContain("if (count === 0) systemPrompt.push(rule.body)");
    expect(extension).toContain("else if (count > 1) api.logger.error");
    expect(extension).toContain("const result = [...globalRules, ...projectRules]");
  });
});
