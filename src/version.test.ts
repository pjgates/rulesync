import { describe, expect, it } from "vitest";

import {
  resolveRulesyncForkCommit,
  RULESYNC_FORK_COMMIT,
  RULESYNC_RELEASE_TAG,
  RULESYNC_VERSION,
} from "./version.js";

describe("release version contract", () => {
  it("uses the pinned fork metadata in source builds", () => {
    expect(RULESYNC_VERSION).toBe("8.30.1-omp.1");
    expect(RULESYNC_RELEASE_TAG).toBe("v8.30.1-omp.1");
    expect(RULESYNC_FORK_COMMIT).toBe("7cc1f0771fabe0c3e1f4f81bd7dea4490e6c967a");
  });

  it("uses the injected resulting commit in release builds", () => {
    const resultingCommit = "0123456789abcdef0123456789abcdef01234567";
    expect(resolveRulesyncForkCommit({ injectedCommit: resultingCommit, releaseBuild: true })).toBe(
      resultingCommit,
    );
  });

  it("rejects missing and malformed release commit injection", () => {
    expect(() =>
      resolveRulesyncForkCommit({ injectedCommit: undefined, releaseBuild: true }),
    ).toThrow("missing its resulting fork commit");
    expect(() =>
      resolveRulesyncForkCommit({ injectedCommit: "not-a-commit", releaseBuild: true }),
    ).toThrow("lowercase 40-hex");
  });
});
