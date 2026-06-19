import { join } from "node:path";

import { z } from "zod/mini";

import { RULESYNC_SUBAGENTS_RELATIVE_DIR_PATH } from "../../constants/rulesync-paths.js";
import { AiFileParams, ValidationResult } from "../../types/ai-file.js";
import { formatError } from "../../utils/error.js";
import { readFileContent } from "../../utils/file.js";
import { parseFrontmatter, stringifyFrontmatter } from "../../utils/frontmatter.js";
import { RulesyncSubagent, RulesyncSubagentFrontmatter } from "./rulesync-subagent.js";
import {
  ToolSubagent,
  ToolSubagentForDeletionParams,
  ToolSubagentFromFileParams,
  ToolSubagentFromRulesyncSubagentParams,
  ToolSubagentSettablePaths,
} from "./tool-subagent.js";

export const OmpSubagentFrontmatterSchema = z.looseObject({
  name: z.string(),
  description: z.optional(z.string()),
  tools: z.optional(z.array(z.string())),
  spawns: z.optional(z.union([z.array(z.string()), z.literal("*")])),
  model: z.optional(z.union([z.string(), z.array(z.string())])),
  thinkingLevel: z.optional(z.string()),
  output: z.optional(z.unknown()),
  blocking: z.optional(z.boolean()),
  autoloadSkills: z.optional(z.array(z.string())),
  readSummarize: z.optional(z.boolean()),
});

type OmpSubagentFrontmatter = z.infer<typeof OmpSubagentFrontmatterSchema>;

type OmpSubagentParams = {
  frontmatter: OmpSubagentFrontmatter;
  body: string;
} & Omit<AiFileParams, "fileContent"> & { fileContent?: string };

export class OmpSubagent extends ToolSubagent {
  private readonly frontmatter: OmpSubagentFrontmatter;
  private readonly body: string;

  constructor({ frontmatter, body, fileContent, ...rest }: OmpSubagentParams) {
    if (rest.validate !== false) {
      const result = OmpSubagentFrontmatterSchema.safeParse(frontmatter);
      if (!result.success) {
        throw new Error(
          `Invalid frontmatter in ${join(rest.relativeDirPath, rest.relativeFilePath)}: ${formatError(result.error)}`,
        );
      }
    }

    super({
      ...rest,
      fileContent: fileContent ?? stringifyFrontmatter(body, frontmatter),
    });

    this.frontmatter = frontmatter;
    this.body = body;
  }

  static getSettablePaths({ global }: { global?: boolean } = {}): ToolSubagentSettablePaths {
    return {
      relativeDirPath: global ? join(".omp", "agent", "agents") : join(".omp", "agents"),
    };
  }

  getFrontmatter(): OmpSubagentFrontmatter {
    return this.frontmatter;
  }

  getBody(): string {
    return this.body;
  }

  toRulesyncSubagent(): RulesyncSubagent {
    const { name, description, readSummarize, ...ompFields } = this.frontmatter;

    const rulesyncFrontmatter: RulesyncSubagentFrontmatter = {
      targets: ["*"] as const,
      name,
      description,
      ...(Object.keys(ompFields).length > 0 || readSummarize !== undefined
        ? {
            omp: {
              ...ompFields,
              ...(readSummarize !== undefined && { "read-summarize": readSummarize }),
            },
          }
        : {}),
    };

    return new RulesyncSubagent({
      outputRoot: ".",
      frontmatter: rulesyncFrontmatter,
      body: this.body,
      relativeDirPath: RULESYNC_SUBAGENTS_RELATIVE_DIR_PATH,
      relativeFilePath: this.getRelativeFilePath(),
      validate: true,
    });
  }

  static fromRulesyncSubagent({
    outputRoot = process.cwd(),
    rulesyncSubagent,
    validate = true,
    global = false,
  }: ToolSubagentFromRulesyncSubagentParams): ToolSubagent {
    const rulesyncFrontmatter = rulesyncSubagent.getFrontmatter();
    const ompSection = rulesyncFrontmatter.omp ?? {};
    const { "read-summarize": readSummarize, ...ompFields } = ompSection;

    const ompSubagentFrontmatter: OmpSubagentFrontmatter = {
      name: rulesyncFrontmatter.name,
      description: rulesyncFrontmatter.description,
      ...ompFields,
      ...(readSummarize !== undefined && { readSummarize }),
    };

    const body = rulesyncSubagent.getBody();
    const fileContent = stringifyFrontmatter(body, ompSubagentFrontmatter, {
      avoidBlockScalars: true,
    });
    const paths = this.getSettablePaths({ global });

    return new OmpSubagent({
      outputRoot,
      frontmatter: ompSubagentFrontmatter,
      body,
      relativeDirPath: paths.relativeDirPath,
      relativeFilePath: rulesyncSubagent.getRelativeFilePath(),
      fileContent,
      validate,
      global,
    });
  }

  validate(): ValidationResult {
    if (!this.frontmatter) {
      return { success: true, error: null };
    }

    const result = OmpSubagentFrontmatterSchema.safeParse(this.frontmatter);
    if (result.success) {
      return { success: true, error: null };
    } else {
      return {
        success: false,
        error: new Error(
          `Invalid frontmatter in ${join(this.relativeDirPath, this.relativeFilePath)}: ${formatError(result.error)}`,
        ),
      };
    }
  }

  static isTargetedByRulesyncSubagent(rulesyncSubagent: RulesyncSubagent): boolean {
    return this.isTargetedByRulesyncSubagentDefault({
      rulesyncSubagent,
      toolTarget: "omp",
    });
  }

  static async fromFile({
    outputRoot = process.cwd(),
    relativeFilePath,
    validate = true,
    global = false,
  }: ToolSubagentFromFileParams): Promise<OmpSubagent> {
    const paths = this.getSettablePaths({ global });
    const filePath = join(outputRoot, paths.relativeDirPath, relativeFilePath);
    const fileContent = await readFileContent(filePath);
    const { frontmatter, body: content } = parseFrontmatter(fileContent, filePath);

    const result = OmpSubagentFrontmatterSchema.safeParse(frontmatter);
    if (!result.success) {
      throw new Error(`Invalid frontmatter in ${filePath}: ${formatError(result.error)}`);
    }

    return new OmpSubagent({
      outputRoot,
      relativeDirPath: paths.relativeDirPath,
      relativeFilePath,
      frontmatter: result.data,
      body: content.trim(),
      fileContent,
      validate,
      global,
    });
  }

  static forDeletion({
    outputRoot = process.cwd(),
    relativeDirPath,
    relativeFilePath,
  }: ToolSubagentForDeletionParams): OmpSubagent {
    return new OmpSubagent({
      outputRoot,
      relativeDirPath,
      relativeFilePath,
      frontmatter: { name: "", description: "" },
      body: "",
      fileContent: "",
      validate: false,
    });
  }
}
