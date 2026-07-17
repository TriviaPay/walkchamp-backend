import { createHmac, timingSafeEqual } from "crypto";

function safeHexBuffer(value: string): Buffer | null {
  if (!/^[a-f0-9]+$/i.test(value) || value.length % 2 !== 0) return null;
  return Buffer.from(value, "hex");
}

export function verifyRazorpaySignature(input: {
  secret: string | null | undefined;
  payload: string | Buffer;
  signature: string | null | undefined;
}): boolean {
  const secret = input.secret?.trim();
  const signature = input.signature?.trim();
  if (!secret || !signature) return false;

  const expected = createHmac("sha256", secret).update(input.payload).digest("hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  const actualBuffer = safeHexBuffer(signature);
  if (!actualBuffer || actualBuffer.length !== expectedBuffer.length) return false;

  return timingSafeEqual(actualBuffer, expectedBuffer);
}

export function verifyRazorpayCheckoutSignature(input: {
  secret: string | null | undefined;
  orderId: string | null | undefined;
  paymentId: string | null | undefined;
  signature: string | null | undefined;
}): boolean {
  const orderId = input.orderId?.trim();
  const paymentId = input.paymentId?.trim();
  if (!orderId || !paymentId) return false;

  return verifyRazorpaySignature({
    secret: input.secret,
    payload: `${orderId}|${paymentId}`,
    signature: input.signature,
  });
}
