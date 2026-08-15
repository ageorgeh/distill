import { describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { readPersistedConfig, resolveConfigPath } from "../src/user-config";

describe("user config", () => {
  it("loads distill.config.ts from the requested working directory", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "distill-config-"));

    try {
      await writeFile(
        path.join(dir, "distill.config.ts"),
        'export default { provider: "codex", timeoutMs: 123 };\n',
      );

      await expect(readPersistedConfig(dir)).resolves.toEqual({
        provider: "codex",
        timeoutMs: 123,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("uses distill.config.ts in the current working directory", () => {
    expect(resolveConfigPath("/tmp/distill-project"))
      .toBe(path.join("/tmp/distill-project", "distill.config.ts"));
  });
});
