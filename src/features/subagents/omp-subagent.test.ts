import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RULESYNC_SUBAGENTS_RELATIVE_DIR_PATH } from "../../constants/rulesync-paths.js";
import { setupTestDirectory } from "../../test-utils/test-directories.js";
import { OmpSubagent } from "./omp-subagent.js";
import { RulesyncSubagent } from "./rulesync-subagent.js";

describe("OmpSubagent", () => {
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

  it("uses exact project and global agent paths", () => {
    expect(OmpSubagent.getSettablePaths()).toEqual({ relativeDirPath: join(".omp", "agents") });
    expect(OmpSubagent.getSettablePaths({ global: true })).toEqual({
      relativeDirPath: join(".omp", "agent", "agents"),
    });
  });

  it("maps the complete omp block to native frontmatter", () => {
    const source = new RulesyncSubagent({
      outputRoot: testDir,
      relativeDirPath: RULESYNC_SUBAGENTS_RELATIVE_DIR_PATH,
      relativeFilePath: "reviewer.md",
      frontmatter: {
        targets: ["omp"],
        name: "reviewer",
        description: "Review code",
        omp: {
          tools: ["read", "bash"],
          spawns: "*",
          model: ["fast", "smart"],
          thinkingLevel: "high",
          output: { type: "object" },
          blocking: true,
          autoloadSkills: ["ast-grep"],
          "read-summarize": true,
        },
        qwencode: { model: "ignored" },
      },
      body: "Review carefully",
    });
    const agent = OmpSubagent.fromRulesyncSubagent({
      outputRoot: testDir,
      relativeDirPath: RULESYNC_SUBAGENTS_RELATIVE_DIR_PATH,
      rulesyncSubagent: source,
      global: true,
    }) as OmpSubagent;

    expect(agent.getRelativeDirPath()).toBe(join(".omp", "agent", "agents"));
    expect(agent.getFrontmatter()).toEqual({
      name: "reviewer",
      description: "Review code",
      tools: ["read", "bash"],
      spawns: "*",
      model: ["fast", "smart"],
      thinkingLevel: "high",
      output: { type: "object" },
      blocking: true,
      autoloadSkills: ["ast-grep"],
      readSummarize: true,
    });
  });

  it("reverse-nests native readSummarize as read-summarize", () => {
    const agent = new OmpSubagent({
      outputRoot: testDir,
      relativeDirPath: join(".omp", "agents"),
      relativeFilePath: "reviewer.md",
      frontmatter: {
        name: "reviewer",
        description: "Review code",
        model: "smart",
        readSummarize: true,
      },
      body: "Review carefully",
    });

    expect(agent.toRulesyncSubagent().getFrontmatter()).toEqual({
      targets: ["*"],
      name: "reviewer",
      description: "Review code",
      omp: { model: "smart", "read-summarize": true },
    });
  });
});
