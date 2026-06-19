import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { RULESYNC_RELEASE_TAG, RULESYNC_VERSION } from "../src/version.js";

const expectedVersion = "8.30.1-omp.1";
const expectedTag = "v8.30.1-omp.1";
const commit = process.env.RULESYNC_RESULTING_COMMIT;

if (RULESYNC_VERSION !== expectedVersion || RULESYNC_RELEASE_TAG !== expectedTag) {
  throw new Error(`Release metadata must remain pinned to ${expectedTag}`);
}
if (process.env.RULESYNC_RELEASE_TAG !== expectedTag) {
  throw new Error(`RULESYNC_RELEASE_TAG must be exactly ${expectedTag}`);
}
if (!commit || !/^[0-9a-f]{40}$/.test(commit)) {
  throw new Error("RULESYNC_RESULTING_COMMIT must be a lowercase 40-hex Git commit");
}
const checkedOutCommit = execFileSync("git", ["rev-parse", "HEAD^{commit}"], {
  cwd: process.cwd(),
  encoding: "utf8",
}).trim();
if (commit !== checkedOutCommit) {
  throw new Error(
    `RULESYNC_RESULTING_COMMIT ${commit} does not match checked-out commit ${checkedOutCommit}`,
  );
}

const outputDir = join(process.cwd(), "dist-release");
const commitDefine = `__RULESYNC_RESULTING_COMMIT__=${JSON.stringify(commit)}`;

function compile(name: string, entrypoint: string): void {
  execFileSync(
    process.execPath,
    [
      "build",
      "--compile",
      "--minify",
      "--target=bun-darwin-arm64",
      `--define=${commitDefine}`,
      "--define=__RULESYNC_RELEASE_BUILD__=true",
      `--outfile=${join(outputDir, name)}`,
      entrypoint,
    ],
    { cwd: process.cwd(), stdio: "inherit" },
  );
  chmodSync(join(outputDir, name), 0o755);
}

async function withEmbeddedOmpNative(build: () => void): Promise<void> {
  const nativeIndex = join(
    process.cwd(),
    "node_modules/.pnpm/@oh-my-pi+pi-natives@16.0.9/node_modules/@oh-my-pi/pi-natives/native/index.js",
  );
  const nativeDir = dirname(nativeIndex);
  const embeddedModule = join(nativeDir, "embedded-addon.js");
  const originalModule = readFileSync(embeddedModule);
  const addonPath = join(
    process.cwd(),
    "node_modules/.pnpm/@oh-my-pi+pi-natives-darwin-arm64@16.0.9/node_modules/@oh-my-pi/pi-natives-darwin-arm64/pi_natives.darwin-arm64.node",
  );
  const addonFilename = basename(addonPath);
  const addon = readFileSync(addonPath);
  writeFileSync(
    embeddedModule,
    `import addonPath from ${JSON.stringify(addonPath)} with { type: "file" };\n` +
      `export const embeddedAddon = ${JSON.stringify({
        platformTag: "darwin-arm64",
        version: "16.0.9",
        files: [{ variant: "default", filename: addonFilename, size: addon.byteLength }],
      })};\n` +
      "embeddedAddon.files[0].filePath = addonPath;\n",
  );

  try {
    build();
  } finally {
    writeFileSync(embeddedModule, originalModule);
  }
}
const assets = [
  {
    name: "rulesync-darwin-arm64",
    entrypoint: "src/cli/index.ts",
  },
  {
    name: "omp-runtime-contract-darwin-arm64",
    entrypoint: "src/e2e/omp-runtime-contract.ts",
  },
] as const;

rmSync(outputDir, { recursive: true, force: true });
mkdirSync(outputDir, { recursive: true });

compile("rulesync-darwin-arm64", "src/cli/index.ts");
await withEmbeddedOmpNative(() =>
  compile("omp-runtime-contract-darwin-arm64", "src/e2e/omp-runtime-contract.ts"),
);

execFileSync(process.execPath, ["scripts/generate-json-schema.ts"], {
  cwd: process.cwd(),
  stdio: "inherit",
});

const schema = readFileSync(join(process.cwd(), "config-schema.json"));
writeFileSync(join(outputDir, "config-schema.json"), schema);

const checksumNames = [...assets.map(({ name }) => name), "config-schema.json"].sort();
const checksums = checksumNames.map((name) => {
  const digest = createHash("sha256")
    .update(readFileSync(join(outputDir, name)))
    .digest("hex");
  return `${digest}  ${name}`;
});
writeFileSync(join(outputDir, "SHA256SUMS"), `${checksums.join("\n")}\n`);
