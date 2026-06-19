import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { runGenerate } from "./e2e-helper.js";

const execFileAsync = promisify(execFile);
const CONTRACT_PATH = join(import.meta.dirname, "omp-runtime-contract.ts");
const GLOBAL_RULE = "Global private runtime rule.";
const PROJECT_RULE = "Project private runtime rule.";
const CONTRACT_COMMAND = process.env.OMP_RUNTIME_CONTRACT_CMD ?? "bun";
const CONTRACT_ARGUMENTS = process.env.OMP_RUNTIME_CONTRACT_CMD ? [] : [CONTRACT_PATH];

interface ContractResult {
  version: string;
  agentDir: string;
  root: string[];
  nested: string[];
  moved: string[];
  agents: Array<{ name: string; scope: string; source: string }>;
  commands: Array<{ name: string; scope: string; source: string; expanded: string }>;
  skills: Array<{ name: string; scope: string; source: string; supportAssetSha256: string }>;
  diagnostics: string[];
}

const cleanups: string[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporaryDirectory(name: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `rulesync-${name}-`));
  cleanups.push(path);
  return path;
}

async function writeSource(root: string, scope: "global" | "project"): Promise<void> {
  const source = join(root, ".rulesync");
  await Promise.all([
    mkdir(join(source, "rules"), { recursive: true }),
    mkdir(join(source, "commands"), { recursive: true }),
    mkdir(join(source, "skills", "contract-skill"), { recursive: true }),
    mkdir(join(source, "subagents"), { recursive: true }),
  ]);
  const prefix = scope === "global" ? "Global" : "Project";
  await writeFile(
    join(source, "rules", `${scope}.md`),
    `---\nroot: ${scope === "global"}\ntargets: [omp]\ndescription: ${prefix} rule\n---\n${prefix} private runtime rule.\n`,
  );
  await writeFile(
    join(source, "commands", "contract-command.md"),
    `---\nroot: ${scope === "global"}\ntargets: [omp]\ndescription: ${prefix} command\n---\n${prefix} command $ARGUMENTS\n`,
  );
  await writeFile(
    join(source, "skills", "contract-skill", "SKILL.md"),
    `---\nname: contract-skill\ndescription: ${prefix} skill\nroot: ${scope === "global"}\ntargets: [omp]\n---\n${prefix} skill body.\n`,
  );
  await writeFile(
    join(source, "skills", "contract-skill", "support.txt"),
    `${prefix} support asset\n`,
  );
  await writeFile(
    join(source, "subagents", "contract-agent.md"),
    `---\nname: contract-agent\ndescription: ${prefix} agent\nroot: ${scope === "global"}\ntargets: [omp]\n---\n${prefix} agent body.\n`,
  );
}

async function initializeCheckout(path: string): Promise<void> {
  await mkdir(join(path, "src", "nested"), { recursive: true });
  await mkdir(join(path, ".git"));
}

async function runOmpGenerate(options: Parameters<typeof runGenerate>[0]): Promise<void> {
  try {
    await runGenerate({ ...options, env: { NODE_ENV: "production", ...options.env } });
  } catch (error) {
    throw new Error(String(error), { cause: error });
  }
}

async function runContract(paths: {
  home: string;
  checkout: string;
  nested: string;
  otherCheckout: string;
}): Promise<ContractResult> {
  const { stdout, stderr } = await execFileAsync(
    CONTRACT_COMMAND,
    [
      ...CONTRACT_ARGUMENTS,
      "--home",
      paths.home,
      "--checkout",
      paths.checkout,
      "--nested",
      paths.nested,
      "--other-checkout",
      paths.otherCheckout,
      "--agent",
      "contract-agent",
      "--command",
      "contract-command",
      "--skill",
      "contract-skill",
      "--json",
    ],
    {
      env: {
        ...process.env,
        HOME: paths.home,
        XDG_CACHE_HOME: join(paths.home, ".cache"),
        XDG_CONFIG_HOME: join(paths.home, ".config"),
        XDG_DATA_HOME: join(paths.home, ".local", "share"),
        XDG_STATE_HOME: join(paths.home, ".local", "state"),
        XDG_RUNTIME_DIR: join(paths.home, ".runtime"),
        OMP_PROFILE: "must-be-cleared",
        PI_PROFILE: "must-be-cleared",
        PI_CONFIG_DIR: "/must/be/cleared",
        PI_CODING_AGENT_DIR: "/must/be/cleared",
      },
    },
  );
  expect(stderr).toBe("");
  return JSON.parse(stdout) as ContractResult;
}

function occurrenceCount(entries: string[], body: string): number {
  return entries.reduce((count, entry) => count + entry.split(body).length - 1, 0);
}

describe("OMP runtime contract", () => {
  it("uses real OMP APIs for rules, moves, agents, commands, and skills", async () => {
    const home = await temporaryDirectory("omp-home");
    const globalSource = await temporaryDirectory("omp-global-source");
    const projectSource = await temporaryDirectory("omp-project-source");
    const checkout = await temporaryDirectory("omp-checkout");
    const otherCheckout = await temporaryDirectory("omp-other-checkout");
    await Promise.all([
      writeSource(globalSource, "global"),
      writeSource(projectSource, "project"),
      initializeCheckout(checkout),
      initializeCheckout(otherCheckout),
    ]);

    await runOmpGenerate({
      target: "omp",
      features: "rules,commands,skills,subagents",
      global: true,
      inputRoot: globalSource,
      env: { HOME: home },
    });
    const previousCwd = process.cwd();
    process.chdir(checkout);
    try {
      await runOmpGenerate({
        target: "omp",
        features: "rules,commands,skills,subagents",
        inputRoot: projectSource,
        env: { HOME: home },
      });
    } finally {
      process.chdir(previousCwd);
    }

    await mkdir(join(checkout, ".cursor", "rules"), { recursive: true });
    await writeFile(
      join(checkout, ".cursor", "rules", "project-twin.mdc"),
      `---\ndescription: Native Cursor twin\nglobs: []\nalwaysApply: true\n---\n${PROJECT_RULE}\n`,
    );
    const result = await runContract({
      home,
      checkout,
      nested: join(checkout, "src", "nested"),
      otherCheckout,
    });

    expect(result.version).toBe("16.0.9");
    expect(result.agentDir).toBe(await realpath(join(home, ".omp", "agent")));
    expect(occurrenceCount(result.root, GLOBAL_RULE), JSON.stringify(result)).toBe(1);
    expect(occurrenceCount(result.root, PROJECT_RULE), JSON.stringify(result.root)).toBe(1);
    expect(occurrenceCount(result.nested, GLOBAL_RULE)).toBe(1);
    expect(occurrenceCount(result.nested, PROJECT_RULE)).toBe(1);
    expect(occurrenceCount(result.moved, GLOBAL_RULE)).toBe(1);
    expect(occurrenceCount(result.moved, PROJECT_RULE)).toBe(0);

    expect(result.agents).toEqual([
      expect.objectContaining({ name: "contract-agent", scope: "project" }),
    ]);
    expect(result.agents[0]?.source).toBe(
      await realpath(join(checkout, ".omp", "agents", "contract-agent.md")),
    );
    expect(result.commands).toEqual([
      expect.objectContaining({
        name: "contract-command",
        scope: "project",
        expanded: expect.stringContaining("Project command contract-value"),
      }),
    ]);
    expect(result.commands[0]?.source).toBe(
      await realpath(join(checkout, ".omp", "commands", "contract-command.md")),
    );
    const projectSupport = join(checkout, ".omp", "skills", "contract-skill", "support.txt");
    expect(result.skills).toEqual([
      {
        name: "contract-skill",
        scope: "project",
        source: await realpath(join(checkout, ".omp", "skills", "contract-skill", "SKILL.md")),
        supportAssetSha256: createHash("sha256")
          .update(await readFile(projectSupport))
          .digest("hex"),
      },
    ]);
    expect(result.diagnostics).toEqual([]);
  });

  it("ignores unlisted stale Markdown outside marker authority", async () => {
    const home = await temporaryDirectory("omp-invalid-home");
    const source = await temporaryDirectory("omp-invalid-source");
    const globalSource = await temporaryDirectory("omp-invalid-global-source");
    const checkout = await temporaryDirectory("omp-invalid-checkout");
    const otherCheckout = await temporaryDirectory("omp-invalid-other");
    await Promise.all([
      writeSource(source, "project"),
      writeSource(globalSource, "global"),
      initializeCheckout(checkout),
      initializeCheckout(otherCheckout),
    ]);
    await runOmpGenerate({
      target: "omp",
      features: "rules,commands,skills,subagents",
      global: true,
      inputRoot: globalSource,
      env: { HOME: home },
    });

    const previousCwd = process.cwd();
    process.chdir(checkout);
    try {
      await runOmpGenerate({
        target: "omp",
        features: "rules,commands,skills,subagents",
        inputRoot: source,
        env: { HOME: home },
      });
    } finally {
      process.chdir(previousCwd);
    }
    await writeFile(
      join(checkout, ".omp", "rulesync-rules", "stale-disabled.md"),
      "Stale unlisted rule is outside marker authority.\n",
    );

    const result = await runContract({
      home,
      checkout,
      nested: join(checkout, "src", "nested"),
      otherCheckout,
    });
    expect(occurrenceCount(result.root, PROJECT_RULE)).toBe(1);
    expect(result.diagnostics).toEqual([]);
  });

  it("reports one diagnostic and injects nothing from a malformed project store", async () => {
    const home = await temporaryDirectory("omp-malformed-home");
    const source = await temporaryDirectory("omp-malformed-source");
    const globalSource = await temporaryDirectory("omp-malformed-global-source");
    const checkout = await temporaryDirectory("omp-malformed-checkout");
    const otherCheckout = await temporaryDirectory("omp-malformed-other");
    await Promise.all([
      writeSource(source, "project"),
      writeSource(globalSource, "global"),
      initializeCheckout(checkout),
      initializeCheckout(otherCheckout),
    ]);
    await runOmpGenerate({
      target: "omp",
      features: "rules,commands,skills,subagents",
      global: true,
      inputRoot: globalSource,
      env: { HOME: home },
    });
    const previousCwd = process.cwd();
    process.chdir(checkout);
    try {
      await runOmpGenerate({
        target: "omp",
        features: "rules,commands,skills,subagents",
        inputRoot: source,
        env: { HOME: home },
      });
    } finally {
      process.chdir(previousCwd);
    }
    const markerPath = join(checkout, ".omp", "rulesync-rules", ".rulesync-store-v1.json");
    const marker = JSON.parse(await readFile(markerPath, "utf8")) as {
      rules: Array<{ sha256: string }>;
    };
    marker.rules[0]!.sha256 = "0".repeat(64);
    await writeFile(markerPath, `${JSON.stringify(marker)}\n`);

    const result = await runContract({
      home,
      checkout,
      nested: join(checkout, "src", "nested"),
      otherCheckout,
    });
    expect(occurrenceCount(result.root, PROJECT_RULE)).toBe(0);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toContain("Rulesync OMP project rule store rejected");
  });
});
