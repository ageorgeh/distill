import { describe, expect, it } from "bun:test";

import { fitInput } from "../src/prompt";

describe("fitInput", () => {
  it("returns input unchanged when within limit", () => {
    const input = "ok\nline2";
    expect(fitInput(input, 100)).toBe(input);
  });

  it("keeps salient risk/error lines when compaction is required", () => {
    const input = [
      "header line", 
      ...Array.from({ length: 120 }, (_, i) => `noise ${i}`),
      "ERROR build failed on package api",
      "DROP TABLE users;",
      ...Array.from({ length: 120 }, (_, i) => `tail-noise ${i}`),
      "final line"
    ].join("\n");

    const compacted = fitInput(input, 1200);

    expect(compacted.length).toBeLessThanOrEqual(1200);
    expect(compacted).toContain("[salient lines]");
    expect(compacted).toContain("ERROR build failed on package api");
    expect(compacted).toContain("DROP TABLE users;");
  });

  it("falls back to head-tail truncation when no salient lines exist", () => {
    const input = Array.from({ length: 300 }, (_, i) => `plain text line ${i}`).join("\n");
    const compacted = fitInput(input, 500);

    expect(compacted.length).toBeLessThanOrEqual(500);
    expect(compacted).toContain("chars not shown");
    expect(compacted).not.toContain("[salient lines]");
  });
});
