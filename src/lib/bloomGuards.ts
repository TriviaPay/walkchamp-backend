import { createHash } from "node:crypto";
import { config } from "./config.js";
import { getRedisCache } from "./redis.js";

type BloomDomain = "profile" | "group" | "race" | "theme";

type BloomDecision = {
  allowed: boolean;
  mode: "off" | "monitor" | "enforce";
  reason: "disabled" | "unavailable" | "possible_hit" | "would_block" | "blocked";
};

const DEFAULT_BITS = 1_000_000;
const DEFAULT_HASHES = 7;

function offsets(domain: BloomDomain, value: string, bits = DEFAULT_BITS, hashes = DEFAULT_HASHES): number[] {
  const digest = createHash("sha256").update(`${domain}:${value}`).digest();
  const out: number[] = [];
  for (let i = 0; i < hashes; i += 1) {
    const start = (i * 4) % digest.length;
    out.push(digest.readUInt32BE(start) % bits);
  }
  return out;
}

function activeVersionKey(domain: BloomDomain): string {
  return `bf:${domain}:active_version`;
}

function bloomKey(domain: BloomDomain, version: string): string {
  return `bf:${domain}:v${version}`;
}

export async function addBloomMember(domain: BloomDomain, version: string, value: string): Promise<void> {
  const redis = getRedisCache();
  const key = bloomKey(domain, version);
  const pipeline = redis.pipeline();
  for (const offset of offsets(domain, value)) {
    pipeline.setbit(key, offset, 1);
  }
  await pipeline.exec();
}

export async function setActiveBloomVersion(domain: BloomDomain, version: string): Promise<void> {
  await getRedisCache().set(activeVersionKey(domain), version);
}

export async function checkBloomGuard(domain: BloomDomain, value: string): Promise<BloomDecision> {
  const mode = config.features.bloomGuardsMode;
  if (mode === "off") return { allowed: true, mode, reason: "disabled" };

  try {
    const redis = getRedisCache();
    const version = await redis.get(activeVersionKey(domain));
    if (!version) return { allowed: true, mode, reason: "unavailable" };

    const key = bloomKey(domain, version);
    const pipeline = redis.pipeline();
    for (const offset of offsets(domain, value)) {
      pipeline.getbit(key, offset);
    }
    const result = await pipeline.exec();
    if (!result) return { allowed: true, mode, reason: "unavailable" };

    const allPresent = result.every(([err, bit]) => !err && bit === 1);
    if (allPresent) return { allowed: true, mode, reason: "possible_hit" };

    return mode === "enforce"
      ? { allowed: false, mode, reason: "blocked" }
      : { allowed: true, mode, reason: "would_block" };
  } catch {
    return { allowed: true, mode, reason: "unavailable" };
  }
}
