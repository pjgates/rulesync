#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";

import "../version.js";

import type { Rule } from "@oh-my-pi/pi-coding-agent/capability/rule";
import type { SlashCommand } from "@oh-my-pi/pi-coding-agent/capability/slash-command";
import type { ExtensionError } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { FileSlashCommand } from "@oh-my-pi/pi-coding-agent/extensibility/slash-commands";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";

const REQUIRED_ARGUMENTS = [
  "home",
  "checkout",
  "nested",
  "other-checkout",
  "agent",
  "command",
  "skill",
] as const;

type ArgumentName = (typeof REQUIRED_ARGUMENTS)[number];

interface ContractArguments extends Record<ArgumentName, string> {
  json: boolean;
}

interface LocatedEntry {
  name: string;
  scope: "global" | "project";
  source: string;
}

interface CommandEntry extends LocatedEntry {
  expanded: string;
}

interface SkillEntry extends LocatedEntry {
  supportAssetSha256: string;
}

interface ContractResult {
  version: string;
  agentDir: string;
  root: string[];
  nested: string[];
  moved: string[];
  agents: LocatedEntry[];
  commands: CommandEntry[];
  skills: SkillEntry[];
  diagnostics: string[];
}

function usage(): never {
  throw new Error(
    `usage: omp-runtime-contract ${REQUIRED_ARGUMENTS.map((name) => `--${name} <path>`).join(" ")} --json`,
  );
}

function parseArguments(argv: string[]): ContractArguments {
  const values = new Map<string, string>();
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token) usage();
    if (token === "--json") {
      json = true;
      continue;
    }
    if (!token.startsWith("--") || !REQUIRED_ARGUMENTS.includes(token.slice(2) as ArgumentName))
      usage();
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) usage();
    if (values.has(token)) throw new Error(`duplicate argument: ${token}`);
    values.set(token, value);
    index += 1;
  }
  if (!json) usage();
  for (const name of REQUIRED_ARGUMENTS) {
    if (!values.has(`--${name}`)) usage();
  }
  return {
    home: values.get("--home")!,
    checkout: values.get("--checkout")!,
    nested: values.get("--nested")!,
    "other-checkout": values.get("--other-checkout")!,
    agent: values.get("--agent")!,
    command: values.get("--command")!,
    skill: values.get("--skill")!,
    json,
  };
}

async function canonicalizeArguments(args: ContractArguments): Promise<ContractArguments> {
  const result = { ...args };
  for (const name of ["home", "checkout", "nested", "other-checkout"] as const) {
    result[name] = await realpath(args[name]);
  }
  return result;
}

async function configureEnvironment(home: string): Promise<void> {
  const xdg = {
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_RUNTIME_DIR: join(home, ".runtime"),
  };
  await Promise.all(
    Object.values(xdg).map((path) => mkdir(path, { recursive: true, mode: 0o700 })),
  );
  process.env.HOME = home;
  Object.assign(process.env, xdg);
  for (const name of ["OMP_PROFILE", "PI_PROFILE", "PI_CONFIG_DIR", "PI_CODING_AGENT_DIR"]) {
    delete process.env[name];
  }
}

function rejectPreloadedOmp(): void {
  const require = createRequire(import.meta.url);
  const cachedPaths = Object.keys(require.cache);
  const preloaded = cachedPaths.find((path) => path.includes("@oh-my-pi/pi-coding-agent"));
  if (preloaded) throw new Error(`OMP was loaded before runtime isolation: ${preloaded}`);
}

function scopeOf(level: string | undefined): "global" | "project" {
  return level === "project" ? "project" : "global";
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}
async function rulesyncLogDiagnostics(agentDir: string): Promise<string[]> {
  await new Promise((resolve) => setTimeout(resolve, 50));
  const logsDir = join(agentDir, "..", "logs");
  const paths = await readdir(logsDir)
    .then((entries) =>
      entries.filter((path) => /^omp\..*\.log$/.test(path)).map((path) => join(logsDir, path)),
    )
    .catch(() => [] as string[]);
  const diagnostics: string[] = [];
  for (const path of paths.sort()) {
    const content = await readFile(path, "utf8").catch(() => "");
    for (const line of content.split("\n")) {
      if (!line) continue;
      try {
        const entry = JSON.parse(line) as { pid?: number; level?: string; message?: string };
        if (
          entry.pid === process.pid &&
          entry.level === "error" &&
          entry.message?.startsWith("Rulesync OMP")
        ) {
          diagnostics.push(entry.message);
        }
      } catch {
        // OMP writes JSON lines; ignore a partial trailing line while the logger flushes.
      }
    }
  }
  return diagnostics;
}

async function main(): Promise<void> {
  rejectPreloadedOmp();
  const args = await canonicalizeArguments(parseArguments(process.argv.slice(2)));
  await configureEnvironment(args.home);
  process.chdir(args.checkout);

  // OMP reads HOME and profile variables during module initialization, so these known
  // modules must cross this intentional dynamic-loading boundary after isolation.
  const { getAgentDir, logger, VERSION } = await import("@oh-my-pi/pi-coding-agent");
  const { discoverAuthStorage, discoverContextFiles } =
    await import("@oh-my-pi/pi-coding-agent/sdk");
  const { buildSystemPrompt } = await import("@oh-my-pi/pi-coding-agent/system-prompt");
  const { discoverAndLoadExtensions } =
    await import("@oh-my-pi/pi-coding-agent/extensibility/extensions");
  const { ExtensionRunner } =
    await import("@oh-my-pi/pi-coding-agent/extensibility/extensions/runner");
  const { SessionManager } = await import("@oh-my-pi/pi-coding-agent/session/session-manager");
  const { ModelRegistry } = await import("@oh-my-pi/pi-coding-agent/config/model-registry");
  const { loadCapability } = await import("@oh-my-pi/pi-coding-agent/capability");
  const { discoverAgents } = await import("@oh-my-pi/pi-coding-agent/task/discovery");
  const { expandSlashCommand, loadSlashCommands } =
    await import("@oh-my-pi/pi-coding-agent/extensibility/slash-commands");
  const { loadSkills } = await import("@oh-my-pi/pi-coding-agent/extensibility/skills");
  logger.setTransports({ file: true, console: false });
  const extensionDiagnostics: string[] = [];

  const loaded = await discoverAndLoadExtensions([], args.checkout);
  extensionDiagnostics.push(...loaded.errors.map((error: ExtensionError) => error.error));
  const authStorage = await discoverAuthStorage();
  const runner = new ExtensionRunner(
    loaded.extensions,
    loaded.runtime,
    args.checkout,
    SessionManager.inMemory(args.checkout),
    new ModelRegistry(authStorage),
  );
  runner.onError((error: ExtensionError) => extensionDiagnostics.push(error.error));

  const runRules = async (cwd: string): Promise<string[]> => {
    process.chdir(cwd);
    const contextFiles = await discoverContextFiles(cwd);
    const loadedRules = await loadCapability<Rule>("rules", { cwd, providers: ["cursor"] });
    const alwaysApplyRules = loadedRules.items.filter((rule: Rule) => rule.alwaysApply);
    const incoming = (await buildSystemPrompt({ cwd, contextFiles, alwaysApplyRules }))
      .systemPrompt;
    const result = await runner.emitBeforeAgentStart(
      "src/runtime-contract.ts",
      undefined,
      incoming,
    );
    return result?.systemPrompt ?? incoming;
  };

  const root = await runRules(args.checkout);
  const nested = await runRules(args.nested);
  const moved = await runRules(args["other-checkout"]);

  process.chdir(args.checkout);
  const { agents: discoveredAgents } = await discoverAgents(args.checkout, args.home);
  const agent = discoveredAgents.find((entry: AgentDefinition) => entry.name === args.agent);
  if (!agent?.filePath) throw new Error(`agent not discovered: ${args.agent}`);

  const discoveredCommands = await loadSlashCommands({ cwd: args.checkout });
  const command = discoveredCommands.find((entry: FileSlashCommand) => entry.name === args.command);
  if (!command) throw new Error(`command not discovered: ${args.command}`);
  const commandSources = await loadCapability<SlashCommand>("slash-commands", {
    cwd: args.checkout,
    providers: ["native"],
  });
  const commandSource = commandSources.items.find(
    (entry: SlashCommand) => entry.name === args.command,
  );
  if (!commandSource?.path) throw new Error(`command source not discovered: ${args.command}`);

  const skillResult = await loadSkills({ cwd: args.checkout });
  const skill = skillResult.skills.find((entry) => entry.name === args.skill);
  if (!skill) throw new Error(`skill not discovered: ${args.skill}`);
  const supportAsset = join(skill.baseDir, "support.txt");

  const result: ContractResult = {
    version: VERSION,
    agentDir: await realpath(getAgentDir()),
    root,
    nested,
    moved,
    agents: [
      {
        name: agent.name,
        scope: scopeOf(agent.source),
        source: await realpath(agent.filePath),
      },
    ],
    commands: [
      {
        name: command.name,
        scope: scopeOf(commandSource._source?.level),
        source: await realpath(commandSource.path),
        expanded: expandSlashCommand(`/${args.command} contract-value`, discoveredCommands),
      },
    ],
    skills: [
      {
        name: skill.name,
        scope: scopeOf(skill._source?.level),
        source: await realpath(skill.filePath),
        supportAssetSha256: await sha256(supportAsset),
      },
    ],
    diagnostics: Array.from(
      new Set([
        ...extensionDiagnostics,
        ...skillResult.warnings.map((warning) => warning.message),
        ...(await rulesyncLogDiagnostics(getAgentDir())),
      ]),
    ),
  };

  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(0);
}

await main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
