import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";

const mockAreCashFeaturesEnabled = vi.fn();

vi.mock("../lib/featureFlags", () => ({
  areCashFeaturesEnabled: () => mockAreCashFeaturesEnabled(),
}));

import { requireCashFeaturesEnabled } from "../middleware/requireCashFeaturesEnabled";

function mockContext(path = "/api/wallet/deposit/stripe/create-payment-intent") {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  const req = { method: "POST", path, ip: "127.0.0.1" } as unknown as Request;
  const res = { status, json } as unknown as Response;
  const next = vi.fn() as unknown as NextFunction;
  return { req, res, next, status, json };
}

beforeEach(() => {
  mockAreCashFeaturesEnabled.mockReset();
});

describe("requireCashFeaturesEnabled", () => {
  it("blocks cash routes when the feature is disabled", async () => {
    mockAreCashFeaturesEnabled.mockResolvedValue(false);
    const { req, res, next, status, json } = mockContext();

    await requireCashFeaturesEnabled(req, res, next);

    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith({
      error: "Cash features are disabled for this build.",
      code: "CASH_FEATURES_DISABLED",
    });
    expect(next).not.toHaveBeenCalled();
  });

  it("allows the request through when cash features are enabled", async () => {
    mockAreCashFeaturesEnabled.mockResolvedValue(true);
    const { req, res, next, status } = mockContext();

    await requireCashFeaturesEnabled(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(status).not.toHaveBeenCalled();
  });
});
