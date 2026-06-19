import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RULESYNC_SKILLS_RELATIVE_DIR_PATH } from "../../constants/rulesync-paths.js";
import { setupTestDirectory } from "../../test-utils/test-directories.js";
import { OmpSkill } from "./omp-skill.js";
import { RulesyncSkill } from "./rulesync-skill.js";

describe("OmpSkill", () => {
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

  it("uses exact project and global skill paths", () => {
    expect(OmpSkill.getSettablePaths()).toEqual({ relativeDirPath: join(".omp", "skills") });
    expect(OmpSkill.getSettablePaths({ global: true })).toEqual({
      relativeDirPath: join(".omp", "agent", "skills"),
    });
  });

  it("round-trips OMP provider metadata and support assets", () => {
    const support = {
      relativeFilePathToDirPath: "references/api.md",
      fileBuffer: Buffer.from("API"),
    };
    const skill = new OmpSkill({
      outputRoot: testDir,
      dirName: "review",
      frontmatter: {
        name: "review",
        description: "Review code",
        "allowed-tools": ["read", "bash"],
        "disable-model-invocation": true,
        license: "MIT",
        compatibility: "OMP 16+",
        metadata: { author: "rulesync" },
      },
      body: "Review carefully",
      otherFiles: [support],
    });

    const rulesync = skill.toRulesyncSkill();
    expect(rulesync.getFrontmatter()).toEqual({
      name: "review",
      description: "Review code",
      targets: ["*"],
      omp: {
        "allowed-tools": ["read", "bash"],
        "disable-model-invocation": true,
        license: "MIT",
        compatibility: "OMP 16+",
        metadata: { author: "rulesync" },
      },
    });
    expect(rulesync.getOtherFiles()).toEqual([support]);

    const restored = OmpSkill.fromRulesyncSkill({ outputRoot: testDir, rulesyncSkill: rulesync });
    expect(restored.getFrontmatter()).toEqual(skill.getFrontmatter());
    expect(restored.getOtherFiles()).toEqual([support]);
  });

  it("reads only the omp provider block and maps global scope", () => {
    const source = new RulesyncSkill({
      outputRoot: testDir,
      relativeDirPath: RULESYNC_SKILLS_RELATIVE_DIR_PATH,
      dirName: "review",
      frontmatter: {
        name: "review",
        description: "Review code",
        targets: ["omp"],
        omp: { metadata: { scope: "omp" } },
        pi: { metadata: { scope: "pi" } },
      },
      body: "Review carefully",
    });
    const skill = OmpSkill.fromRulesyncSkill({
      outputRoot: testDir,
      rulesyncSkill: source,
      global: true,
    });

    expect(skill.getRelativeDirPath()).toBe(join(".omp", "agent", "skills"));
    expect(skill.getFrontmatter().metadata).toEqual({ scope: "omp" });
  });
});
