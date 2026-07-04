import type { NextFunction, Request, Response } from "express";
import { config } from "../lib/config.js";

export type ResourceBudgetPolicy = {
  maxJsonDepth: number;
  maxArrayItems: number;
  maxStringLength: number;
  maxObjectKeys: number;
};

export type ResourceBudgetViolation = {
  path: string;
  reason: "max_depth" | "max_array_items" | "max_string_length" | "max_object_keys";
  limit: number;
  actual: number;
};

function requestIdOf(req: Request): string | null {
  return (req as Request & { id?: string }).id ?? null;
}

function inspectValue(
  value: unknown,
  policy: ResourceBudgetPolicy,
  path: string,
  depth: number,
  seen: WeakSet<object>,
): ResourceBudgetViolation | null {
  if (value == null) return null;

  if (typeof value === "string") {
    return value.length > policy.maxStringLength
      ? {
          path,
          reason: "max_string_length",
          limit: policy.maxStringLength,
          actual: value.length,
        }
      : null;
  }

  if (typeof value !== "object" || Buffer.isBuffer(value)) {
    return null;
  }

  if (seen.has(value)) return null;
  seen.add(value);

  if (depth > policy.maxJsonDepth) {
    return {
      path,
      reason: "max_depth",
      limit: policy.maxJsonDepth,
      actual: depth,
    };
  }

  if (Array.isArray(value)) {
    if (value.length > policy.maxArrayItems) {
      return {
        path,
        reason: "max_array_items",
        limit: policy.maxArrayItems,
        actual: value.length,
      };
    }

    for (let i = 0; i < value.length; i += 1) {
      const violation = inspectValue(value[i], policy, `${path}[${i}]`, depth + 1, seen);
      if (violation) return violation;
    }
    return null;
  }

  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > policy.maxObjectKeys) {
    return {
      path,
      reason: "max_object_keys",
      limit: policy.maxObjectKeys,
      actual: entries.length,
    };
  }

  for (const [key, child] of entries) {
    const violation = inspectValue(child, policy, path ? `${path}.${key}` : key, depth + 1, seen);
    if (violation) return violation;
  }

  return null;
}

export function inspectResourceBudget(
  value: unknown,
  policy: ResourceBudgetPolicy,
): ResourceBudgetViolation | null {
  return inspectValue(value, policy, "$", 0, new WeakSet<object>());
}

export function resourceBudgetMiddleware(req: Request, res: Response, next: NextFunction) {
  const violation = inspectResourceBudget(req.body, {
    maxJsonDepth: config.runtime.maxJsonDepth,
    maxArrayItems: config.runtime.maxJsonArrayItems,
    maxStringLength: config.runtime.maxJsonStringLength,
    maxObjectKeys: config.runtime.maxJsonObjectKeys,
  });

  if (!violation) return next();

  req.log.warn({ violation }, "Request resource budget exceeded");
  return res.status(413).json({
    error: "Request body exceeds resource limits.",
    code: "RESOURCE_BUDGET_EXCEEDED",
    violation,
    requestId: requestIdOf(req),
  });
}
