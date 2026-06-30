import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";

type RewriteCandidate = {
  currentUrl: string,
  id: string,
  key: string,
  nextUrl: string,
};

type RewriteSummary = {
  alreadyOnR2: number,
  rewrites: RewriteCandidate[],
  skipped: Array<{ id: string; url: string }>,
};

function loadDotEnvFile(filePath: string) {
  if (!fs.existsSync(filePath)) return;

  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const idx = line.indexOf("=");
    if (idx < 0) continue;

    const key = line.slice(0, idx).trim();
    if (!key || process.env[key]) continue;

    let value = line.slice(idx + 1);
    if (
      (value.startsWith("\"") && value.endsWith("\""))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}

function encodeObjectKey(key: string): string {
  return key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function buildPublicObjectUrl(publicBaseUrl: string, key: string): string {
  return new URL(
    encodeObjectKey(key),
    `${publicBaseUrl.replace(/\/$/, "")}/`,
  ).toString();
}

function extractLegacyObjectKey(url: string): string | null {
  try {
    const parsedUrl = new URL(url);
    const segments = parsedUrl.pathname
      .split("/")
      .filter(Boolean)
      .map((segment) => decodeURIComponent(segment));

    if (segments.length < 2) return null;

    const key = segments.slice(1).join("/");
    if (
      key.startsWith("avatars/")
      || key.startsWith("group-images/")
      || key.startsWith("race-themes/")
    ) {
      return key;
    }

    return null;
  } catch {
    return null;
  }
}

function summarizeRows(
  rows: Array<{ id: string; url: string }>,
  publicBaseUrl: string,
): RewriteSummary {
  const normalizedBaseUrl = `${publicBaseUrl.replace(/\/$/, "")}/`;
  const summary: RewriteSummary = {
    alreadyOnR2: 0,
    rewrites: [],
    skipped: [],
  };

  for (const row of rows) {
    if (row.url.startsWith(normalizedBaseUrl)) {
      summary.alreadyOnR2 += 1;
      continue;
    }

    const key = extractLegacyObjectKey(row.url);
    if (!key) {
      summary.skipped.push({ id: row.id, url: row.url });
      continue;
    }

    summary.rewrites.push({
      id: row.id,
      key,
      currentUrl: row.url,
      nextUrl: buildPublicObjectUrl(publicBaseUrl, key),
    });
  }

  return summary;
}

async function fetchRows(
  client: Client,
  tableName: "profiles" | "walking_groups",
  columnName: "avatar_url" | "group_image_url",
): Promise<Array<{ id: string; url: string }>> {
  const result = await client.query<{ id: string; url: string }>(
    `select id::text as id, ${columnName} as url
       from ${tableName}
      where ${columnName} is not null`,
  );

  return result.rows.filter((row) => typeof row.url === "string" && row.url.length > 0);
}

async function applyRewrites(
  client: Client,
  tableName: "profiles" | "walking_groups",
  columnName: "avatar_url" | "group_image_url",
  rewrites: RewriteCandidate[],
): Promise<number> {
  let updatedCount = 0;

  for (const rewrite of rewrites) {
    const result = await client.query(
      `update ${tableName}
          set ${columnName} = $1
        where id = $2
          and ${columnName} = $3`,
      [rewrite.nextUrl, rewrite.id, rewrite.currentUrl],
    );
    updatedCount += result.rowCount ?? 0;
  }

  return updatedCount;
}

async function main() {
  loadDotEnvFile(path.resolve(process.cwd(), ".env"));

  const publicBaseUrl = process.env.OBJECT_STORAGE_PUBLIC_BASE_URL?.trim();
  if (!publicBaseUrl) {
    throw new Error("OBJECT_STORAGE_PUBLIC_BASE_URL must be set.");
  }

  const databaseUrl =
    process.env.DATABASE_ADMIN_URL
    ?? process.env.NEON_DATABASE_ADMIN_URL
    ?? process.env.DATABASE_RUNTIME_URL
    ?? process.env.NEON_DATABASE_URL
    ?? process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error("DATABASE_ADMIN_URL or NEON_DATABASE_ADMIN_URL or DATABASE_RUNTIME_URL or NEON_DATABASE_URL or DATABASE_URL must be set.");
  }

  const applyChanges = process.argv.includes("--apply");

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    const [profileRows, groupRows] = await Promise.all([
      fetchRows(client, "profiles", "avatar_url"),
      fetchRows(client, "walking_groups", "group_image_url"),
    ]);

    const profileSummary = summarizeRows(profileRows, publicBaseUrl);
    const groupSummary = summarizeRows(groupRows, publicBaseUrl);

    console.log("Object storage URL rewrite summary");
    console.log(JSON.stringify({
      mode: applyChanges ? "apply" : "dry-run",
      profiles: {
        totalRows: profileRows.length,
        rewrites: profileSummary.rewrites.length,
        alreadyOnR2: profileSummary.alreadyOnR2,
        skipped: profileSummary.skipped.length,
      },
      walkingGroups: {
        totalRows: groupRows.length,
        rewrites: groupSummary.rewrites.length,
        alreadyOnR2: groupSummary.alreadyOnR2,
        skipped: groupSummary.skipped.length,
      },
    }, null, 2));

    if (profileSummary.skipped.length > 0 || groupSummary.skipped.length > 0) {
      console.log("Skipped rows");
      console.log(JSON.stringify({
        profiles: profileSummary.skipped.slice(0, 25),
        walkingGroups: groupSummary.skipped.slice(0, 25),
      }, null, 2));
    }

    if (!applyChanges) {
      console.log("Dry-run sample rewrites");
      console.log(JSON.stringify({
        profiles: profileSummary.rewrites.slice(0, 10),
        walkingGroups: groupSummary.rewrites.slice(0, 10),
      }, null, 2));
      console.log("Re-run with --apply once object-copy verification is complete.");
      return;
    }

    await client.query("begin");
    const updatedProfiles = await applyRewrites(client, "profiles", "avatar_url", profileSummary.rewrites);
    const updatedWalkingGroups = await applyRewrites(client, "walking_groups", "group_image_url", groupSummary.rewrites);
    await client.query("commit");

    console.log(JSON.stringify({
      updatedProfiles,
      updatedWalkingGroups,
    }, null, 2));
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
