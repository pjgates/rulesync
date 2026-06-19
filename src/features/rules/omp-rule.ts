import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename, join } from "node:path";

import { ValidationResult } from "../../types/ai-file.js";
import { ToolFile } from "../../types/tool-file.js";
import { readFileContent } from "../../utils/file.js";
import { RULESYNC_FORK_COMMIT } from "../../version.js";
import { RulesyncRule } from "./rulesync-rule.js";
import {
  ToolRule,
  ToolRuleForDeletionParams,
  ToolRuleFromFileParams,
  ToolRuleFromRulesyncRuleParams,
} from "./tool-rule.js";

export const OMP_RULES_DIR = join(".omp", "rulesync-rules");
export const OMP_GLOBAL_RULES_DIR = join(".omp", "agent", "rulesync-rules");
export const OMP_RULES_MARKER = ".rulesync-store-v1.json";
export const OMP_RULES_EXTENSION = join(".omp", "agent", "extensions", "rulesync-project-rules.ts");

export type OmpRuleSettablePaths = {
  root?: undefined;
  nonRoot: { relativeDirPath: string };
};

/** OMP rules are body-only files in a private Rulesync-owned store. */
export class OmpRule extends ToolRule {
  static getSettablePaths({
    global = false,
    excludeToolDir,
  }: {
    global?: boolean;
    excludeToolDir?: boolean;
  } = {}): OmpRuleSettablePaths {
    const relativeDirPath = global ? OMP_GLOBAL_RULES_DIR : OMP_RULES_DIR;
    return {
      nonRoot: {
        relativeDirPath: excludeToolDir
          ? global
            ? join("agent", "rulesync-rules")
            : "rulesync-rules"
          : relativeDirPath,
      },
    };
  }

  static async fromFile({
    outputRoot = process.cwd(),
    relativeFilePath,
    relativeDirPath,
    validate = true,
    global = false,
  }: ToolRuleFromFileParams): Promise<OmpRule> {
    const store = relativeDirPath ?? this.getSettablePaths({ global }).nonRoot.relativeDirPath;
    const fileContent = await readFileContent(join(outputRoot, store, relativeFilePath));
    return new OmpRule({
      outputRoot,
      relativeDirPath: store,
      relativeFilePath,
      fileContent,
      validate,
      global,
      root: false,
    });
  }

  static fromRulesyncRule({
    outputRoot = process.cwd(),
    rulesyncRule,
    validate = true,
    global = false,
  }: ToolRuleFromRulesyncRuleParams): OmpRule {
    const relativeFilePath = basename(rulesyncRule.getRelativeFilePath());
    return new OmpRule({
      outputRoot,
      relativeDirPath: this.getSettablePaths({ global }).nonRoot.relativeDirPath,
      relativeFilePath,
      fileContent: emittedContent(rulesyncRule.getBody()),
      validate,
      global,
      root: rulesyncRule.getFrontmatter().root ?? false,
      description: rulesyncRule.getFrontmatter().description,
      globs: rulesyncRule.getFrontmatter().globs,
    });
  }

  static forDeletion({
    outputRoot = process.cwd(),
    relativeDirPath,
    relativeFilePath,
    global = false,
  }: ToolRuleForDeletionParams): OmpRule {
    return new OmpRule({
      outputRoot,
      relativeDirPath,
      relativeFilePath,
      fileContent: "",
      validate: false,
      global,
      root: false,
    });
  }

  toRulesyncRule(): RulesyncRule {
    return this.toRulesyncRuleDefault();
  }

  validate(): ValidationResult {
    return { success: true, error: null };
  }

  static isTargetedByRulesyncRule(rulesyncRule: RulesyncRule): boolean {
    return this.isTargetedByRulesyncRuleDefault({ rulesyncRule, toolTarget: "omp" });
  }
}

export type OmpStoreRule = {
  path: string;
  sha256: string;
  description: string | null;
  globs: string[];
};

class OmpGeneratedFile extends ToolFile {
  validate(): ValidationResult {
    return { success: true, error: null };
  }
}

export function emittedContent(content: string): string {
  return `${content.trimEnd()}\n`;
}

function utf8Compare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

export function validateOmpRuleGlob(pattern: string): void {
  if (
    !pattern ||
    pattern.startsWith("/") ||
    pattern.includes("\\") ||
    /[!\[\]\x00-\x1f\x7f]/.test(pattern)
  ) {
    throw new Error(`Invalid OMP rule glob: '${pattern}'`);
  }
  const parts = pattern.split("/");
  if (
    parts.some(
      (part) => !part || part === "." || part === ".." || (part !== "**" && part.includes("**")),
    )
  ) {
    throw new Error(`Invalid OMP rule glob: '${pattern}'`);
  }
}

const OMP_CANDIDATE_TRAILING = /[,.:;()\[\]]+$/;
const OMP_DRIVE = /^[A-Za-z]:/;

export function extractOmpRuleCandidates(text: string): string[] {
  const raw = [...text.matchAll(/`([^`]+)`/g)].map((match) => match[1]!);
  raw.push(...(text.replace(/`[^`]+`/g, " ").match(/\S+/g) ?? []));
  const result: string[] = [];
  for (let value of raw) {
    value = value.replace(OMP_CANDIDATE_TRAILING, "");
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
      value = value.slice(1, -1);
    }
    value = value.replace(OMP_CANDIDATE_TRAILING, "").replaceAll("\\", "/");
    if (value.startsWith("./")) value = value.slice(2);
    const parts = value.split("/");
    if (
      !value ||
      value.startsWith("/") ||
      value.startsWith("//") ||
      OMP_DRIVE.test(value) ||
      parts.some((part) => !part || part === "..")
    ) {
      continue;
    }
    if (!result.includes(value)) result.push(value);
  }
  return result;
}

export function ompRuleGlobMatches(pattern: string, candidate: string): boolean {
  validateOmpRuleGlob(pattern);
  let expression = "";
  const parts = pattern.split("/");
  for (const [index, part] of parts.entries()) {
    const last = index === parts.length - 1;
    if (part === "**") {
      expression += last ? ".*" : "(?:[^/]+/)*";
    } else {
      for (const character of part) {
        expression +=
          character === "*"
            ? "[^/]*"
            : character === "?"
              ? "[^/]"
              : character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      }
      if (!last) expression += "/";
    }
  }
  return new RegExp((pattern.includes("/") ? "^" : "(?:^|.*/)") + expression + "$").test(candidate);
}

export function buildOmpRuleStoreFiles({
  outputRoot,
  global,
  rules,
}: {
  outputRoot: string;
  global: boolean;
  rules: OmpRule[];
}): ToolFile[] {
  const byBasename = new Map<string, OmpRule>();
  for (const rule of rules) {
    const name = basename(rule.getRelativeFilePath());
    if (byBasename.has(name)) {
      throw new Error(`OMP rule basename collision: '${name}'`);
    }
    byBasename.set(name, rule);
  }

  const sortedRules = [...rules].sort((left, right) =>
    utf8Compare(left.getRelativeFilePath(), right.getRelativeFilePath()),
  );
  for (const rule of sortedRules) {
    for (const glob of rule.isRoot() ? [] : (rule.getGlobs() ?? [])) {
      validateOmpRuleGlob(glob);
    }
  }
  const markerRules: OmpStoreRule[] = sortedRules.map((rule) => {
    const body = emittedContent(rule.getFileContent());
    rule.setFileContent(body);
    return {
      path: rule.getRelativeFilePath(),
      sha256: createHash("sha256").update(body, "utf8").digest("hex"),
      description: rule.getDescription() ?? null,
      globs: rule.isRoot() ? [] : (rule.getGlobs() ?? []),
    };
  });
  const storeDir = OmpRule.getSettablePaths({ global }).nonRoot.relativeDirPath;
  const marker = {
    version: 1,
    contract: "rulesync-project-rules-v1",
    forkCommit: RULESYNC_FORK_COMMIT,
    scope: global ? "global" : "project",
    outputRoot: realpathSync(outputRoot),
    rules: markerRules,
  };
  const generated: ToolFile[] = [
    new OmpGeneratedFile({
      outputRoot,
      relativeDirPath: storeDir,
      relativeFilePath: OMP_RULES_MARKER,
      fileContent: `${JSON.stringify(marker)}\n`,
      global,
    }),
    ...sortedRules,
  ];

  if (global) {
    generated.push(
      new OmpGeneratedFile({
        outputRoot,
        relativeDirPath: join(".omp", "agent", "extensions"),
        relativeFilePath: "rulesync-project-rules.ts",
        fileContent: ompRulesExtensionSource(),
        global: true,
      }),
    );
  }
  return generated;
}

export function ompRulesExtensionSource(): string {
  return `import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

const FORK_COMMIT = ${JSON.stringify(RULESYNC_FORK_COMMIT)};
const MARKER = ".rulesync-store-v1.json";
const CONTRACT = "rulesync-project-rules-v1";
const trailing = /[,.:;()\\[\\]]+$/;
const drive = /^[A-Za-z]:/;
const cache = new Map<string, LoadedRule[]>();
let firstCall = true;
type LoadedRule = { path: string; body: string; globs: string[]; scope: "global" | "project" };
type MarkerRule = { path: string; sha256: string; description: string | null; globs: string[] };
type Marker = { version: 1; contract: string; forkCommit: string; scope: "global" | "project"; outputRoot: string; rules: MarkerRule[] };
type Api = { on: (name: "before_agent_start", handler: (event: { prompt: string; systemPrompt: string[] }, ctx: { cwd: string }) => { systemPrompt: string[] }) => void; logger: { error: (message: string) => void }; pi: { getAgentDir: () => string } };

function canonical(value: string): string { return fs.realpathSync(value); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function exactKeys(value: Record<string, unknown>, keys: string[]): boolean { return Object.keys(value).length === keys.length && keys.every((key, index) => Object.keys(value)[index] === key); }
const OPENING_XML = /^<([a-z_-]+)(?:\\s+[^>]*)?>$/;
const TABLE_ROW = /^\\|.*\\|$/;
const TABLE_SEP = /^\\|[-:\\s|]+\\|$/;
const NON_BLANK = /\\S/;
function closingTagName(value: string): string | null {
  const length = value.length;
  if (length < 4 || value.charCodeAt(length - 1) !== 62) return null;
  for (let index = 2; index < length - 1; index += 1) {
    const code = value.charCodeAt(index);
    if (!((code >= 97 && code <= 122) || code === 45 || code === 95)) return null;
  }
  return value.slice(2, length - 1);
}
function openingTagName(value: string): string | null {
  const length = value.length;
  if (length < 3 || value.charCodeAt(length - 1) !== 62) return null;
  let index = 1;
  while (index < length - 1) {
    const code = value.charCodeAt(index);
    if ((code >= 97 && code <= 122) || code === 45 || code === 95) index += 1;
    else break;
  }
  if (index === 1) return null;
  if (index === length - 1) return value.slice(1, index);
  const code = value.charCodeAt(index);
  if (code !== 32 && code !== 9) {
    if (code < 128) return null;
    return OPENING_XML.exec(value)?.[1] ?? null;
  }
  return value.indexOf(">", index + 1) === length - 1 ? value.slice(1, index) : null;
}
function compactTableRow(line: string): string { return line.split("|").map((cell) => cell.trim()).join("|"); }
function compactTableSep(line: string): string {
  const cells = line.split("|").filter((cell) => cell.trim()).map((cell) => {
    const trimmed = cell.trim();
    const left = trimmed.startsWith(":");
    const right = trimmed.endsWith(":");
    if (left && right) return ":---:";
    if (left) return ":---";
    if (right) return "---:";
    return "---";
  });
  return "|" + cells.join("|") + "|";
}
function postRenderFormat(content: string): string {
  const lines = content.split("\\n");
  const result: string[] = new Array(lines.length);
  let count = 0;
  let inCodeBlock = false;
  const topLevelTags: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]!;
    const last = raw.charCodeAt(raw.length - 1);
    let line = last <= 32 || last >= 128 ? raw.trimEnd() : raw;
    let indent = 0;
    let first = line.charCodeAt(0);
    while (first === 32 || first === 9) first = line.charCodeAt(++indent);
    if (first >= 128) {
      indent = line.length - line.trimStart().length;
      first = line.charCodeAt(indent);
    }
    if ((first === 96 || first === 126) && (line.startsWith("\\x60\\x60\\x60", indent) || line.startsWith("~~~", indent))) {
      inCodeBlock = !inCodeBlock;
      result[count++] = line;
      continue;
    }
    if (inCodeBlock) {
      result[count++] = line;
      continue;
    }
    let isClosingLine = false;
    if (first === 60) {
      const trimmedStart = indent === 0 ? line : line.slice(indent);
      if (trimmedStart.charCodeAt(1) === 47) {
        const tagName = closingTagName(trimmedStart);
        if (tagName !== null) {
          isClosingLine = true;
          if (topLevelTags.at(-1) === tagName) topLevelTags.pop();
        }
      } else if (indent === 0 && !trimmedStart.endsWith("/>")) {
        const tagName = openingTagName(trimmedStart);
        if (tagName !== null) topLevelTags.push(tagName);
      }
    } else if (first === 124) {
      const trimmedStart = indent === 0 ? line : line.slice(indent);
      if (TABLE_SEP.test(trimmedStart)) line = line.slice(0, indent) + compactTableSep(trimmedStart);
      else if (TABLE_ROW.test(trimmedStart)) line = line.slice(0, indent) + compactTableRow(trimmedStart);
    }
    if (indent >= line.length) {
      const next = lines[index + 1];
      if (next === undefined || next.length === 0 || !NON_BLANK.test(next)) {
        while (count > 0 && result[count - 1]!.length === 0) count -= 1;
        let cursor = index + 1;
        while (cursor < lines.length && (lines[cursor]!.length === 0 || !NON_BLANK.test(lines[cursor]!))) cursor += 1;
        index = cursor - 1;
        continue;
      }
      if (count === 0 || result[count - 1]!.length === 0) continue;
    }
    if (isClosingLine) while (count > 0 && result[count - 1]!.length === 0) count -= 1;
    result[count++] = line;
  }
  while (count > 0 && result[count - 1]!.length === 0) count -= 1;
  result.length = count;
  return result.join("\\n");
}
function validGlob(pattern: string): boolean {
  if (!pattern || pattern.startsWith("/") || pattern.includes("\\\\") || /[!\\[\\]\\x00-\\x1f\\x7f]/.test(pattern)) return false;
  const parts = pattern.split("/");
  return !parts.some((part) => !part || part === "." || part === ".." || (part !== "**" && part.includes("**")));
}
function candidates(text: string): string[] {
  const raw = [...text.matchAll(/\x60([^\x60]+)\x60/g)].map((match) => match[1]!);
  raw.push(...(text.replace(/\x60[^\x60]+\x60/g, " ").match(/\\S+/g) ?? []));
  const result: string[] = [];
  for (let value of raw) {
    value = value.replace(trailing, "");
    if (value.length >= 2 && (value.charCodeAt(0) === 34 || value[0] === "'") && value.at(-1) === value[0]) value = value.slice(1, -1);
    value = value.replace(trailing, "").replaceAll("\\\\", "/");
    if (value.startsWith("./")) value = value.slice(2);
    const parts = value.split("/");
    if (!value || value.startsWith("/") || value.startsWith("//") || drive.test(value) || parts.some((part) => !part || part === "..")) continue;
    if (!result.includes(value)) result.push(value);
  }
  return result;
}
function globMatches(pattern: string, candidate: string): boolean {
  let expression = "";
  const parts = pattern.split("/");
  for (const [index, part] of parts.entries()) {
    const last = index === parts.length - 1;
    if (part === "**") expression += last ? ".*" : "(?:[^/]+/)*";
    else {
      for (const character of part) expression += character === "*" ? "[^/]*" : character === "?" ? "[^/]" : character.replace(/[.*+?^\\x24{}()|[\\]\\\\]/g, "\\\\$&");
      if (!last) expression += "/";
    }
  }
  return new RegExp((pattern.includes("/") ? "^" : "(?:^|.*/)") + expression + "$").test(candidate);
}
function comparableLines(content: string): string[] {
  const value = content.trim();
  if (!value) return [];
  return postRenderFormat(value).trim().split("\\n").map((line) => line.trim());
}
function occurrenceCount(sources: string[], body: string): number {
  const wanted = comparableLines(body);
  if (!wanted.length) return 0;
  let count = 0;
  for (const source of sources) {
    const lines = comparableLines(source);
    for (let start = 0; start <= lines.length - wanted.length; start += 1) {
      if (wanted.every((line, offset) => lines[start + offset] === line)) count += 1;
    }
  }
  return count;
}
function regular(pathname: string, directory: boolean): boolean {
  const stat = fs.lstatSync(pathname);
  return !stat.isSymbolicLink() && (directory ? stat.isDirectory() : stat.isFile());
}
function parseRule(value: unknown): MarkerRule | null {
  if (!isRecord(value) || !exactKeys(value, ["path", "sha256", "description", "globs"])) return null;
  if (typeof value.path !== "string" || !/^[^/]+\\.md$/.test(value.path) || value.path === MARKER) return null;
  if (typeof value.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.sha256)) return null;
  if (value.description !== null && typeof value.description !== "string") return null;
  if (!Array.isArray(value.globs) || !value.globs.every((item) => typeof item === "string" && validGlob(item))) return null;
  return value as MarkerRule;
}
function loadStore(store: string, scope: "global" | "project", outputRoot: string, api: Api): LoadedRule[] {
  if (!fs.existsSync(store)) return [];
  try {
    if (!regular(store, true)) throw new Error("store is not a regular directory");
    const markerPath = path.join(store, MARKER);
    if (!regular(markerPath, false)) throw new Error("marker is not a regular file");
    const text = fs.readFileSync(markerPath, "utf8");
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed) || !exactKeys(parsed, ["version", "contract", "forkCommit", "scope", "outputRoot", "rules"])) throw new Error("invalid marker fields");
    if (parsed.version !== 1 || parsed.contract !== CONTRACT || parsed.forkCommit !== FORK_COMMIT || parsed.scope !== scope || parsed.outputRoot !== outputRoot || !Array.isArray(parsed.rules)) throw new Error("marker identity mismatch");
    const marker = parsed as Marker;
    if (JSON.stringify(marker) + "\\n" !== text) throw new Error("marker is not canonical JSON");
    const rules = marker.rules.map(parseRule);
    if (rules.some((rule) => rule === null)) throw new Error("invalid marker rule");
    const names = (rules as MarkerRule[]).map((rule) => rule.path);
    const sorted = [...names].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
    if (new Set(names).size !== names.length || names.some((name, index) => name !== sorted[index])) throw new Error("marker rules are not unique UTF-8 path order");
    return (rules as MarkerRule[]).map((rule) => {
      const pathname = path.join(store, rule.path);
      if (!regular(pathname, false)) throw new Error("rule is not a regular file");
      const body = fs.readFileSync(pathname, "utf8");
      if (createHash("sha256").update(body, "utf8").digest("hex") !== rule.sha256) throw new Error("rule digest mismatch");
      return { path: rule.path, body, globs: rule.globs, scope };
    });
  } catch (error) {
    api.logger.error(\`Rulesync OMP \${scope} rule store rejected: \${error instanceof Error ? error.message : String(error)}\`);
    return [];
  }
}
function projectRoot(cwd: string): string | null {
  const home = canonical(os.homedir());
  let current = cwd;
  while (true) {
    const git = path.join(current, ".git");
    try {
      const stat = fs.lstatSync(git);
      if (!stat.isSymbolicLink() && (stat.isFile() || stat.isDirectory())) return current;
    } catch {}
    if (current === home || current === path.parse(current).root) return null;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}
function rulesFor(cwd: string, api: Api): LoadedRule[] {
  const cached = cache.get(cwd);
  if (cached) return cached;
  const agentDir = canonical(api.pi.getAgentDir());
  const globalOutputRoot = canonical(path.resolve(agentDir, "..", ".."));
  const globalRules = loadStore(path.join(agentDir, "rulesync-rules"), "global", globalOutputRoot, api);
  const root = projectRoot(cwd);
  const projectRules = root ? loadStore(path.join(root, ".omp", "rulesync-rules"), "project", root, api) : [];
  const result = [...globalRules, ...projectRules];
  cache.set(cwd, result);
  return result;
}
export default function rulesyncProjectRules(api: Api): void {
  api.on("before_agent_start", (event, ctx) => {
    const cwd = canonical(process.cwd());
    if (firstCall) {
      firstCall = false;
      if (canonical(ctx.cwd) !== cwd) {
        api.logger.error("Rulesync OMP rule extension rejected mismatched initial cwd");
        return { systemPrompt: event.systemPrompt };
      }
    }
    const mentioned = candidates(event.prompt);
    const rules = rulesFor(cwd, api);
    const selected = (["global", "project"] as const).flatMap((scope) => {
      const scoped = rules.filter((rule) => rule.scope === scope);
      return [
        ...scoped.filter((rule) => rule.globs.length === 0),
        ...scoped.filter((rule) => rule.globs.length > 0 && rule.globs.some((pattern) => mentioned.some((candidate) => globMatches(pattern, candidate)))),
      ];
    });
    const systemPrompt = [...event.systemPrompt];
    for (const rule of selected) {
      const count = occurrenceCount(systemPrompt, rule.body);
      if (count === 0) systemPrompt.push(rule.body);
      else if (count > 1) api.logger.error(\`Rulesync OMP rule body appears \${count} times; refusing another copy: \${rule.path}\`);
    }
    return { systemPrompt };
  });
}
`;
}
