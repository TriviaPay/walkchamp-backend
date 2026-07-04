import { describe, expect, it } from "vitest";
import { inspectResourceBudget, type ResourceBudgetPolicy } from "../middleware/resourceBudgets";

const policy: ResourceBudgetPolicy = {
  maxJsonDepth: 2,
  maxArrayItems: 3,
  maxStringLength: 5,
  maxObjectKeys: 3,
};

describe("inspectResourceBudget", () => {
  it("allows payloads within the budget", () => {
    expect(inspectResourceBudget({ a: "abc", b: [1, 2] }, policy)).toBeNull();
  });

  it("does not inspect raw webhook buffers", () => {
    expect(inspectResourceBudget(Buffer.from("{\"event\":\"test\"}"), policy)).toBeNull();
  });

  it("rejects excessive JSON depth", () => {
    expect(inspectResourceBudget({ a: { b: { c: {} } } }, policy)).toMatchObject({
      reason: "max_depth",
    });
  });

  it("rejects oversized arrays", () => {
    expect(inspectResourceBudget({ items: [1, 2, 3, 4] }, policy)).toMatchObject({
      reason: "max_array_items",
      actual: 4,
    });
  });

  it("rejects long strings", () => {
    expect(inspectResourceBudget({ name: "toolong" }, policy)).toMatchObject({
      reason: "max_string_length",
      actual: 7,
    });
  });

  it("rejects objects with too many keys", () => {
    expect(inspectResourceBudget({ a: 1, b: 2, c: 3, d: 4 }, policy)).toMatchObject({
      reason: "max_object_keys",
      actual: 4,
    });
  });
});
