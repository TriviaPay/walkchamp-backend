import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { deriveRefundStatus, isAmountReservedByRefundItem } from "../lib/refundService.js";

describe("refundService state helpers", () => {
  it("derives parent status deterministically from item statuses", () => {
    expect(deriveRefundStatus([{ status: "succeeded" }, { status: "accounting_only_completed" }])).toBe("succeeded");
    expect(deriveRefundStatus([{ status: "succeeded" }, { status: "failed_terminal" }])).toBe("partially_succeeded");
    expect(deriveRefundStatus([{ status: "succeeded" }, { status: "provider_pending" }])).toBe("provider_pending");
    expect(deriveRefundStatus([{ status: "processing" }, { status: "requested" }])).toBe("processing");
    expect(deriveRefundStatus([{ status: "queued" }, { status: "approved" }])).toBe("queued");
    expect(deriveRefundStatus([{ status: "failed_retryable" }, { status: "rejected" }])).toBe("failed_retryable");
    expect(deriveRefundStatus([{ status: "failed_terminal" }, { status: "failed_terminal" }])).toBe("failed_terminal");
    expect(deriveRefundStatus([{ status: "rejected" }, { status: "rejected" }])).toBe("rejected");
  });

  it("reserves amount for pending or retryable refund items only", () => {
    for (const status of ["requested", "approved", "queued", "processing", "provider_pending", "succeeded", "failed_retryable"]) {
      expect(isAmountReservedByRefundItem(status), status).toBe(true);
    }
    for (const status of ["rejected", "failed_terminal", "canceled", "accounting_only_completed"]) {
      expect(isAmountReservedByRefundItem(status), status).toBe(false);
    }
  });

  it("does not reintroduce old refund metadata writes or standalone race refund route", () => {
    const paymentsRoute = readFileSync("src/routes/payments.ts", "utf8");
    const racesRoute = readFileSync("src/routes/races.ts", "utf8");
    expect(paymentsRoute).not.toContain("refundRequestedAt");
    expect(paymentsRoute).not.toContain("refundReason");
    expect(racesRoute).not.toContain("/races/:id/refund-entry");
  });
});
