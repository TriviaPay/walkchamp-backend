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

  it("requires provider refund webhook binding checks before status mutation", () => {
    const refundService = readFileSync("src/lib/refundService.ts", "utf8");

    expect(refundService).toContain("provider_refund_binding_mismatch");
    // Amount binding now coerces the event amount so a string/non-numeric value
    // cannot silently skip the check (see L-1 audit fix).
    expect(refundService).toContain("const eventAmountNum = eventAmountRaw === null ? null : Number(eventAmountRaw)");
    expect(refundService).toContain("!Number.isInteger(eventAmountNum) || eventAmountNum !== item.approvedAmount");
    expect(refundService).toContain("eventCurrency === \"string\"");
    expect(refundService).toContain("eventPaymentId === \"string\"");
    expect(refundService).toContain("[RefundService] provider refund webhook binding mismatch");
  });
});
