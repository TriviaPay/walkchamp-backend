/**
 * Repo-invariant guards that prevent the 2026-07-23-style outage from recurring: every external
 * dependency's error channel must be handled at its source, and both entrypoints must install the
 * process-safety net. Failing here means a transient DB/Redis blip could crash the whole process.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

function tsFiles(root: string): string[] {
  return (readdirSync(root, { recursive: true, encoding: "utf8" }) as string[])
    .filter((f) => f.endsWith(".ts") && !f.includes("__tests__"))
    .map((f) => join(root, f));
}

describe("resilience guardrails (do NOT remove — prevents crash-on-dependency-blip outages)", () => {
  it("every `new Pool(` attaches a pool error handler in the same file", () => {
    const offenders = [...tsFiles("src"), ...tsFiles("db/src")].filter((f) => {
      const src = readFileSync(f, "utf8");
      return src.includes("new Pool(") && !src.includes('.on("error"');
    });
    expect(offenders, `Pool without an .on("error") handler: ${offenders.join(", ")}`).toEqual([]);
  });

  it("the pg pool has its error handler", () => {
    expect(readFileSync("db/src/index.ts", "utf8")).toContain('pool.on("error"');
  });

  it("BullMQ queue and worker have error handlers", () => {
    const queue = readFileSync("src/lib/queue.ts", "utf8");
    expect(queue).toContain('queue.on("error"');
    expect(queue).toContain('worker.on("error"');
  });

  it("processSafety registers uncaughtException, unhandledRejection, and signal handlers", () => {
    const ps = readFileSync("src/lib/processSafety.ts", "utf8");
    expect(ps).toContain('"uncaughtException"');
    expect(ps).toContain('"unhandledRejection"');
    expect(ps).toContain('"SIGTERM"');
  });

  it("both entrypoints install the process-safety net", () => {
    expect(readFileSync("src/index.ts", "utf8")).toContain("installProcessSafetyHandlers");
    expect(readFileSync("src/worker.ts", "utf8")).toContain("installProcessSafetyHandlers");
  });
});
