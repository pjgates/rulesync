import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RULESYNC_COMMANDS_RELATIVE_DIR_PATH } from "../../constants/rulesync-paths.js";
import { setupTestDirectory } from "../../test-utils/test-directories.js";
import { ensureDir, writeFileContent } from "../../utils/file.js";
import { OmpCommand } from "./omp-command.js";
import { RulesyncCommand } from "./rulesync-command.js";

describe("OmpCommand", () => {
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

  it("uses exact project and global command paths", () => {
    expect(OmpCommand.getSettablePaths()).toEqual({ relativeDirPath: join(".omp", "commands") });
    expect(OmpCommand.getSettablePaths({ global: true })).toEqual({
      relativeDirPath: join(".omp", "agent", "commands"),
    });
  });

  it("lifts only native OMP metadata into the omp block", () => {
    const command = new OmpCommand({
      outputRoot: testDir,
      relativeDirPath: join(".omp", "commands"),
      relativeFilePath: "review.md",
      frontmatter: { description: "Review", "argument-hint": "[ref]" },
      body: "Review it",
    });

    expect(command.toRulesyncCommand().getFrontmatter()).toEqual({
      targets: ["*"],
      description: "Review",
      omp: { "argument-hint": "[ref]" },
    });
  });

  it("emits only the omp block and maps global scope", () => {
    const source = new RulesyncCommand({
      outputRoot: testDir,
      relativeDirPath: RULESYNC_COMMANDS_RELATIVE_DIR_PATH,
      relativeFilePath: "review.md",
      frontmatter: {
        targets: ["omp"],
        description: "Review",
        omp: { "argument-hint": "[ref]" },
        pi: { "argument-hint": "ignored" },
      },
      body: "Review it",
      fileContent: "",
    });
    const command = OmpCommand.fromRulesyncCommand({
      outputRoot: testDir,
      rulesyncCommand: source,
      global: true,
    });

    expect(command.getRelativeDirPath()).toBe(join(".omp", "agent", "commands"));
    expect(command.getFrontmatter()).toEqual({ description: "Review", "argument-hint": "[ref]" });
  });

  it("imports native commands", async () => {
    await ensureDir(join(testDir, ".omp", "commands"));
    await writeFileContent(
      join(testDir, ".omp", "commands", "review.md"),
      "---\nargument-hint: '[ref]'\n---\nReview it",
    );
    const command = await OmpCommand.fromFile({
      outputRoot: testDir,
      relativeFilePath: "review.md",
    });
    expect(command.getFrontmatter()).toEqual({ "argument-hint": "[ref]" });
    expect(command.getBody()).toBe("Review it");
  });
});
