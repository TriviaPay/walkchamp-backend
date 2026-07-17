import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  verifyRazorpayCheckoutSignature,
  verifyRazorpaySignature,
} from "../lib/razorpaySecurity.js";

describe("razorpay signature verification", () => {
  it("accepts a valid webhook signature", () => {
    const secret = "rzp_secret";
    const payload = Buffer.from(JSON.stringify({ event: "payment.captured" }));
    const signature = createHmac("sha256", secret).update(payload).digest("hex");

    expect(verifyRazorpaySignature({ secret, payload, signature })).toBe(true);
  });

  it("rejects invalid, malformed, and length-mismatched signatures", () => {
    const secret = "rzp_secret";
    const payload = "order_123|pay_123";
    const signature = createHmac("sha256", secret).update(payload).digest("hex");

    expect(verifyRazorpaySignature({ secret, payload, signature: signature.replace(/^./, "0") })).toBe(false);
    expect(verifyRazorpaySignature({ secret, payload, signature: "not-hex" })).toBe(false);
    expect(verifyRazorpaySignature({ secret, payload, signature: signature.slice(2) })).toBe(false);
    expect(verifyRazorpaySignature({ secret: "", payload, signature })).toBe(false);
  });

  it("verifies checkout signatures with order and payment ids", () => {
    const secret = "rzp_secret";
    const orderId = "order_123";
    const paymentId = "pay_123";
    const signature = createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest("hex");

    expect(verifyRazorpayCheckoutSignature({ secret, orderId, paymentId, signature })).toBe(true);
    expect(verifyRazorpayCheckoutSignature({ secret, orderId, paymentId: "pay_other", signature })).toBe(false);
  });
});
