declare const __RULESYNC_RESULTING_COMMIT__: string | undefined;
declare const __RULESYNC_RELEASE_BUILD__: boolean | undefined;

export const RULESYNC_VERSION = "8.30.1-omp.1";
export const RULESYNC_RELEASE_TAG = `v${RULESYNC_VERSION}`;

const sourceCommit = "7cc1f0771fabe0c3e1f4f81bd7dea4490e6c967a";

export function resolveRulesyncForkCommit({
  injectedCommit,
  releaseBuild,
}: {
  injectedCommit: string | undefined;
  releaseBuild: boolean;
}): string {
  if (releaseBuild && injectedCommit === undefined) {
    throw new Error("Release build is missing its resulting fork commit");
  }

  const commit = injectedCommit ?? sourceCommit;
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error("Rulesync fork commit must be a lowercase 40-hex Git commit");
  }
  return commit;
}

export const RULESYNC_FORK_COMMIT = resolveRulesyncForkCommit({
  injectedCommit:
    typeof __RULESYNC_RESULTING_COMMIT__ === "string" ? __RULESYNC_RESULTING_COMMIT__ : undefined,
  releaseBuild: typeof __RULESYNC_RELEASE_BUILD__ === "boolean" && __RULESYNC_RELEASE_BUILD__,
});
