import { describe, expect, it } from "bun:test";

import { DistillSession } from "../src/stream-distiller";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function createWriter() {
  let value = "";

  return {
    write(chunk: string | Uint8Array) {
      value += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    },
    read() {
      return value;
    },
  };
}

describe("DistillSession", () => {
  it("renders a batch summary", async () => {
    const writer = createWriter();
    const session = new DistillSession({
      stdout: writer,
      isTTY: false,
      summarizer: {
        summarizeBatch: async () => "All tests passed",
        summarizeWatch: async () => "unused",
      },
    });

    session.push(Buffer.from("test output\n"));
    await session.end();

    expect(writer.read()).toBe("All tests passed\n");
  });

  it("falls back to raw input when the summary is empty or invalid", async () => {
    const writer = createWriter();
    const session = new DistillSession({
      stdout: writer,
      isTTY: false,
      summarizer: {
        summarizeBatch: async () => "",
        summarizeWatch: async () => "unused",
      },
    });

    session.push(Buffer.from("raw payload\n"));
    await session.end();

    expect(writer.read()).toBe("raw payload\n");
  });

  it("prints fallback reason when debug mode is enabled", async () => {
    const stdout = createWriter();
    const stderr = createWriter();
    const session = new DistillSession({
      stdout,
      stderr,
      isTTY: false,
      debug: true,
      summarizer: {
        summarizeBatch: async () => "",
        summarizeWatch: async () => "unused",
      },
    });

    session.push(Buffer.from("raw payload\n"));
    await session.end();

    expect(stdout.read()).toBe("raw payload\n");
    expect(stderr.read()).toContain("distill: debug: fallback=batch_bad_distillation");
  });

  it("renders spinner progress and clears it before the final summary", async () => {
    const writer = createWriter();
    const progress = createWriter();
    const session = new DistillSession({
      stdout: writer,
      progress,
      isTTY: false,
      progressFrameMs: 10,
      summarizer: {
        summarizeBatch: async () => {
          await sleep(30);
          return "All tests passed";
        },
        summarizeWatch: async () => "unused",
      },
    });

    await sleep(15);
    session.push(Buffer.from("test output\n"));
    await session.end();

    expect(writer.read()).toContain("All tests passed\n");
    expect(progress.read()).toContain("distill: waiting");
    expect(progress.read()).toContain("distill: summarizing");
    expect(progress.read().endsWith("\r\u001b[2K")).toBe(true);
  });

  it("switches to passthrough for interactive prompts", async () => {
    const writer = createWriter();
    let summarizeCalls = 0;
    const session = new DistillSession({
      stdout: writer,
      isTTY: false,
      interactiveGapMs: 10,
      summarizer: {
        summarizeBatch: async () => {
          summarizeCalls += 1;
          return "never";
        },
        summarizeWatch: async () => {
          summarizeCalls += 1;
          return "never";
        },
      },
    });

    session.push(Buffer.from("Continue? [y/N]"));
    await sleep(20);
    session.push(Buffer.from("\nyes\n"));
    await session.end();

    expect(writer.read()).toBe("Continue? [y/N]\nyes\n");
    expect(summarizeCalls).toBe(0);
  });

  it("promotes recurring bursts to watch mode when enabled", async () => {
    const writer = createWriter();
    let watchCalls = 0;
    const session = new DistillSession({
      stdout: writer,
      isTTY: false,
      idleMs: 15,
      interactiveGapMs: 5,
      watchMode: true,
      summarizer: {
        summarizeBatch: async () => "unused",
        summarizeWatch: async () => {
          watchCalls += 1;
          return "failure count changed";
        },
      },
    });

    session.push(Buffer.from("watch run\nfailed: 0\n"));
    await sleep(25);
    session.push(Buffer.from("watch run\nfailed: 1\n"));
    await sleep(25);
    await session.end();

    expect(writer.read()).toBe("failure count changed\n");
    expect(watchCalls).toBe(1);
  });

  it("keeps ambiguous multi-burst output in batch mode", async () => {
    const writer = createWriter();
    let batchCalls = 0;
    const session = new DistillSession({
      stdout: writer,
      isTTY: false,
      idleMs: 10,
      interactiveGapMs: 5,
      summarizer: {
        summarizeBatch: async () => {
          batchCalls += 1;
          return "batch summary";
        },
        summarizeWatch: async () => "watch summary",
      },
    });

    session.push(Buffer.from("phase one\n"));
    await sleep(20);
    session.push(Buffer.from("totally different phase two\n"));
    await session.end();

    expect(writer.read()).toBe("batch summary\n");
    expect(batchCalls).toBe(1);
  });
});
