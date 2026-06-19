import { join } from "node:path";

import { z } from "zod/mini";

import { SKILL_FILE_NAME } from "../../constants/general.js";
import { RULESYNC_SKILLS_RELATIVE_DIR_PATH } from "../../constants/rulesync-paths.js";
import { ValidationResult } from "../../types/ai-dir.js";
import { formatError } from "../../utils/error.js";
import { RulesyncSkill, RulesyncSkillFrontmatterInput, SkillFile } from "./rulesync-skill.js";
import {
  ToolSkill,
  ToolSkillForDeletionParams,
  ToolSkillFromDirParams,
  ToolSkillFromRulesyncSkillParams,
  ToolSkillSettablePaths,
} from "./tool-skill.js";

/**
 * Frontmatter schema for Oh My Pi skills.
 *
 * OMP follows the Agent Skills standard (SKILL.md with `name` and `description`).
 * Additional fields are preserved via `looseObject` so OMP-specific metadata
 * passes through unchanged.
 */
export const OmpSkillFrontmatterSchema = z.looseObject({
  name: z.string(),
  description: z.string(),
  "allowed-tools": z.optional(z.array(z.string())),
  "disable-model-invocation": z.optional(z.boolean()),
  license: z.optional(z.string()),
  compatibility: z.optional(z.union([z.string(), z.looseObject({})])),
  metadata: z.optional(z.looseObject({})),
});

export type OmpSkillFrontmatter = z.infer<typeof OmpSkillFrontmatterSchema>;

export type OmpSkillParams = {
  outputRoot?: string;
  relativeDirPath?: string;
  dirName: string;
  frontmatter: OmpSkillFrontmatter;
  body: string;
  otherFiles?: SkillFile[];
  validate?: boolean;
  global?: boolean;
};

/**
 * Skill generator for Oh My Pi.
 *
 * - Project scope: `.omp/skills/<name>/SKILL.md`
 * - Global scope: `~/.omp/agent/skills/<name>/SKILL.md`
 */
export class OmpSkill extends ToolSkill {
  constructor({
    outputRoot = process.cwd(),
    relativeDirPath,
    dirName,
    frontmatter,
    body,
    otherFiles = [],
    validate = true,
    global = false,
  }: OmpSkillParams) {
    const resolvedDirPath =
      relativeDirPath ?? OmpSkill.getSettablePaths({ global }).relativeDirPath;

    super({
      outputRoot,
      relativeDirPath: resolvedDirPath,
      dirName,
      mainFile: {
        name: SKILL_FILE_NAME,
        body,
        frontmatter: { ...frontmatter },
      },
      otherFiles,
      global,
    });

    if (validate) {
      const result = this.validate();
      if (!result.success) {
        throw result.error;
      }
    }
  }

  static getSettablePaths({ global }: { global?: boolean } = {}): ToolSkillSettablePaths {
    if (global) {
      return {
        relativeDirPath: join(".omp", "agent", "skills"),
      };
    }
    return {
      relativeDirPath: join(".omp", "skills"),
    };
  }

  getFrontmatter(): OmpSkillFrontmatter {
    return OmpSkillFrontmatterSchema.parse(this.requireMainFileFrontmatter());
  }

  getBody(): string {
    return this.mainFile?.body ?? "";
  }

  validate(): ValidationResult {
    if (!this.mainFile) {
      return {
        success: false,
        error: new Error(`${this.getDirPath()}: ${SKILL_FILE_NAME} file does not exist`),
      };
    }

    const result = OmpSkillFrontmatterSchema.safeParse(this.mainFile.frontmatter);
    if (!result.success) {
      return {
        success: false,
        error: new Error(
          `Invalid frontmatter in ${this.getDirPath()}: ${formatError(result.error)}`,
        ),
      };
    }

    return { success: true, error: null };
  }

  toRulesyncSkill(): RulesyncSkill {
    const frontmatter = this.getFrontmatter();
    const ompBlock = {
      ...(frontmatter["allowed-tools"] !== undefined && {
        "allowed-tools": frontmatter["allowed-tools"],
      }),
      ...(frontmatter["disable-model-invocation"] !== undefined && {
        "disable-model-invocation": frontmatter["disable-model-invocation"],
      }),
      ...(frontmatter.license !== undefined && { license: frontmatter.license }),
      ...(frontmatter.compatibility !== undefined && {
        compatibility: frontmatter.compatibility,
      }),
      ...(frontmatter.metadata !== undefined && { metadata: frontmatter.metadata }),
    };
    const rulesyncFrontmatter: RulesyncSkillFrontmatterInput = {
      name: frontmatter.name,
      description: frontmatter.description,
      targets: ["*"],
      ...(Object.keys(ompBlock).length > 0 && { omp: ompBlock }),
    };

    return new RulesyncSkill({
      outputRoot: this.outputRoot,
      relativeDirPath: RULESYNC_SKILLS_RELATIVE_DIR_PATH,
      dirName: this.getDirName(),
      frontmatter: rulesyncFrontmatter,
      body: this.getBody(),
      otherFiles: this.getOtherFiles(),
      validate: true,
      global: this.global,
    });
  }

  static fromRulesyncSkill({
    outputRoot = process.cwd(),
    rulesyncSkill,
    validate = true,
    global = false,
  }: ToolSkillFromRulesyncSkillParams): OmpSkill {
    const settablePaths = OmpSkill.getSettablePaths({ global });
    const rulesyncFrontmatter = rulesyncSkill.getFrontmatter();

    const ompFrontmatter: OmpSkillFrontmatter = {
      name: rulesyncFrontmatter.name,
      description: rulesyncFrontmatter.description,
      ...rulesyncFrontmatter.omp,
    };

    return new OmpSkill({
      outputRoot,
      relativeDirPath: settablePaths.relativeDirPath,
      dirName: rulesyncSkill.getDirName(),
      frontmatter: ompFrontmatter,
      body: rulesyncSkill.getBody(),
      otherFiles: rulesyncSkill.getOtherFiles(),
      validate,
      global,
    });
  }

  static isTargetedByRulesyncSkill(rulesyncSkill: RulesyncSkill): boolean {
    const targets = rulesyncSkill.getFrontmatter().targets;
    return targets.includes("*") || targets.includes("omp");
  }

  static async fromDir(params: ToolSkillFromDirParams): Promise<OmpSkill> {
    const loaded = await this.loadSkillDirContent({
      ...params,
      getSettablePaths: OmpSkill.getSettablePaths,
    });

    const result = OmpSkillFrontmatterSchema.safeParse(loaded.frontmatter);
    if (!result.success) {
      const skillDirPath = join(loaded.outputRoot, loaded.relativeDirPath, loaded.dirName);
      throw new Error(
        `Invalid frontmatter in ${join(skillDirPath, SKILL_FILE_NAME)}: ${formatError(result.error)}`,
      );
    }

    return new OmpSkill({
      outputRoot: loaded.outputRoot,
      relativeDirPath: loaded.relativeDirPath,
      dirName: loaded.dirName,
      frontmatter: result.data,
      body: loaded.body,
      otherFiles: loaded.otherFiles,
      validate: true,
      global: loaded.global,
    });
  }

  static forDeletion({
    outputRoot = process.cwd(),
    relativeDirPath,
    dirName,
    global = false,
  }: ToolSkillForDeletionParams): OmpSkill {
    const settablePaths = OmpSkill.getSettablePaths({ global });
    return new OmpSkill({
      outputRoot,
      relativeDirPath: relativeDirPath ?? settablePaths.relativeDirPath,
      dirName,
      frontmatter: { name: "", description: "" },
      body: "",
      otherFiles: [],
      validate: false,
      global,
    });
  }
}
