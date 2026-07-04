export function shouldExposeReadinessDetails(input: {
  nodeEnv: string;
  configuredToken: string | null;
  requestToken: string | null;
}): boolean {
  if (input.nodeEnv !== "production") return true;
  if (!input.configuredToken) return false;
  return input.requestToken === input.configuredToken;
}

export function readinessStatusCode(status: "ready" | "degraded" | "not_ready"): number {
  return status === "not_ready" ? 503 : 200;
}
