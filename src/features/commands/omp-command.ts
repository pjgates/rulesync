import { join } from "node:path";

import { z } from "zod/mini";

import { AiFileParams, ValidationResult } from "../../types/ai-file.js";
import { formatError } from "../../utils/error.js";
import { readFileContent } from "../../utils/file.js";
import { parseFrontmatter, stringifyFrontmatter } from "../../utils/frontmatter.js";
import { RulesyncCommand, RulesyncCommandFrontmatter } from "./rulesync-command.js";
import {
  ToolCommand,
  ToolCommandForDeletionParams,
  ToolCommandFromFileParams,
  ToolCommandFromRulesyncCommandParams,
  ToolCommandSettablePaths,
} from "./tool-command.js";

/**
 * Frontmatter schema for Oh My Pi commands.
 *
 * OMP reads Markdown commands from `.omp/commands/` with an optional minimal
 * frontmatter. Unknown keys are preserved via `looseObject` so the schema
 * stays tolerant to OMP's evolving command metadata.
 */
export const OmpCommandFrontmatterSchema = z.looseObject({
  description: z.optional(z.string()),
  "argument-hint": z.optional(z.string()),
});

export type OmpCommandFrontmatter = z.infer<typeof OmpCommandFrontmatterSchema>;

export type OmpCommandParams = {
  frontmatter: OmpCommandFrontmatter;
  body: string;
} & Omit<AiFileParams, "fileContent">;

/**
 * Command generator for Oh My Pi.
 *
 * - Project scope: `.omp/commands/<name>.md`
 * - Global scope: `~/.omp/agent/commands/<name>.md`
 *
 * OMP's argument placeholders (`$1`, `$2`, `$@`, `$ARGUMENTS`) are compatible
 * with rulesync command bodies, so the body is passed through verbatim.
 */
export class OmpCommand extends ToolCommand {
  private readonly frontmatter: OmpCommandFrontmatter;
  private readonly body: string;

  constructor({ frontmatter, body, ...rest }: OmpCommandParams) {
    if (rest.validate) {
      const result = OmpCommandFrontmatterSchema.safeParse(frontmatter);
      if (!result.success) {
        throw new Error(
          `Invalid frontmatter in ${join(rest.relativeDirPath, rest.relativeFilePath)}: ${formatError(result.error)}`,
        );
      }
    }

    super({
      ...rest,
      fileContent: OmpCommand.generateFileContent(body, frontmatter),
    });

    this.frontmatter = frontmatter;
    this.body = body;
  }

  private static generateFileContent(body: string, frontmatter: OmpCommandFrontmatter): string {
    // Emit frontmatter only when there is at least one defined field.
    const hasContent = Object.values(frontmatter).some((value) => value !== undefined);
    if (!hasContent) {
      return body;
    }
    return stringifyFrontmatter(body, frontmatter);
  }

  static getSettablePaths({ global }: { global?: boolean } = {}): ToolCommandSettablePaths {
    if (global) {
      return {
        relativeDirPath: join(".omp", "agent", "commands"),
      };
    }
    return {
      relativeDirPath: join(".omp", "commands"),
    };
  }

  getBody(): string {
    return this.body;
  }

  getFrontmatter(): Record<string, unknown> {
    return this.frontmatter;
  }

  toRulesyncCommand(): RulesyncCommand {
    const { description, ...restFields } = this.frontmatter;

    const rulesyncFrontmatter: RulesyncCommandFrontmatter = {
      targets: ["*"],
      description,
      // Preserve OMP-specific fields (e.g. `argument-hint`) under a `omp:`
      // section so round-trips retain tool-specific metadata.
      ...(Object.keys(restFields).length > 0 && { omp: restFields }),
    };

    const fileContent = stringifyFrontmatter(this.body, rulesyncFrontmatter);

    return new RulesyncCommand({
      outputRoot: ".",
      frontmatter: rulesyncFrontmatter,
      body: this.body,
      relativeDirPath: RulesyncCommand.getSettablePaths().relativeDirPath,
      relativeFilePath: this.relativeFilePath,
      fileContent,
      validate: true,
    });
  }

  static fromRulesyncCommand({
    outputRoot = process.cwd(),
    rulesyncCommand,
    validate = true,
    global = false,
  }: ToolCommandFromRulesyncCommandParams): OmpCommand {
    const rulesyncFrontmatter = rulesyncCommand.getFrontmatter();
    const ompFields = rulesyncFrontmatter.omp ?? {};

    const ompFrontmatter: OmpCommandFrontmatter = {
      ...(rulesyncFrontmatter.description !== undefined && {
        description: rulesyncFrontmatter.description,
      }),
      ...ompFields,
    };

    const paths = this.getSettablePaths({ global });

    return new OmpCommand({
      outputRoot,
      frontmatter: ompFrontmatter,
      body: rulesyncCommand.getBody(),
      relativeDirPath: paths.relativeDirPath,
      relativeFilePath: rulesyncCommand.getRelativeFilePath(),
      validate,
    });
  }

  validate(): ValidationResult {
    if (!this.frontmatter) {
      return { success: true, error: null };
    }
    const result = OmpCommandFrontmatterSchema.safeParse(this.frontmatter);
    if (result.success) {
      return { success: true, error: null };
    }
    return {
      success: false,
      error: new Error(
        `Invalid frontmatter in ${join(this.relativeDirPath, this.relativeFilePath)}: ${formatError(result.error)}`,
      ),
    };
  }

  static isTargetedByRulesyncCommand(rulesyncCommand: RulesyncCommand): boolean {
    return this.isTargetedByRulesyncCommandDefault({
      rulesyncCommand,
      toolTarget: "omp",
    });
  }

  static async fromFile({
    outputRoot = process.cwd(),
    relativeFilePath,
    validate = true,
    global = false,
  }: ToolCommandFromFileParams): Promise<OmpCommand> {
    const paths = this.getSettablePaths({ global });
    const filePath = join(outputRoot, paths.relativeDirPath, relativeFilePath);
    const fileContent = await readFileContent(filePath);
    const { frontmatter, body: content } = parseFrontmatter(fileContent, filePath);

    const result = OmpCommandFrontmatterSchema.safeParse(frontmatter);
    if (!result.success) {
      throw new Error(`Invalid frontmatter in ${filePath}: ${formatError(result.error)}`);
    }

    return new OmpCommand({
      outputRoot,
      relativeDirPath: paths.relativeDirPath,
      relativeFilePath,
      frontmatter: result.data,
      body: content.trim(),
      validate,
    });
  }

  static forDeletion({
    outputRoot = process.cwd(),
    relativeDirPath,
    relativeFilePath,
  }: ToolCommandForDeletionParams): OmpCommand {
    return new OmpCommand({
      outputRoot,
      relativeDirPath,
      relativeFilePath,
      frontmatter: {},
      body: "",
      validate: false,
    });
  }
}
