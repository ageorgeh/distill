import { describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createGitContextProvider } from "../src/git-context";

async function git(root: string, args: string[], allowFailure = false): Promise<string> {
  const child = Bun.spawn(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0 && !allowFailure) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  return stdout;
}

async function repository(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "distill-git-context-"));
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.email", "distill@example.test"]);
  await git(root, ["config", "user.name", "Distill Test"]);
  await writeFile(path.join(root, "owner.ts"), "export const value = 'base';\n", "utf8");
  await git(root, ["add", "owner.ts"]);
  await git(root, ["commit", "-m", "base"]);
  return root;
}

describe("deterministic Git context", () => {
  it("grounds review retrieval in base-to-HEAD changed files and patch ranges", async () => {
    const root = await repository();
    try {
      const base = (await git(root, ["rev-parse", "HEAD"])).trim();
      await writeFile(path.join(root, "owner.ts"), "export const value = 'changed';\n", "utf8");
      await writeFile(path.join(root, "test.ts"), "export const covered = true;\n", "utf8");
      await git(root, ["add", "."]);
      await git(root, ["commit", "-m", "change"]);
      const result = await createGitContextProvider().gather({ action: "gather", workspaceRoot: root, intent: "review", objective: "Review changes.", baseRef: base });
      expect(result.references).toEqual(["owner.ts", "test.ts"]);
      expect(result.text).toContain(`base_ref: ${base}`);
      expect(result.text).toContain("mandatory_seed_files:\n- owner.ts\n- test.ts");
      expect(result.text).toContain("+export const value = 'changed';");
      expect(result.commands.some((command) => command.includes("--name-only"))).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("grounds merge retrieval in unmerged files", async () => {
    const root = await repository();
    try {
      await git(root, ["checkout", "-b", "other"]);
      await writeFile(path.join(root, "owner.ts"), "export const value = 'other';\n", "utf8");
      await git(root, ["commit", "-am", "other"]);
      await git(root, ["checkout", "main"]);
      await writeFile(path.join(root, "owner.ts"), "export const value = 'main';\n", "utf8");
      await git(root, ["commit", "-am", "main"]);
      await git(root, ["merge", "other"], true);
      const result = await createGitContextProvider().gather({ action: "gather", workspaceRoot: root, intent: "merge", objective: "Resolve merge conflicts." });
      expect(result.references).toEqual(["owner.ts"]);
      expect(result.text).toContain("source: unmerged index and working-tree entries");
      expect(result.text).toContain("mandatory_seed_files:\n- owner.ts");
      expect(result.commands.every((command) => command.includes("--diff-filter=U"))).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
