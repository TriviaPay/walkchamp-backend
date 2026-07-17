import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

type CliOptions = {
  allowOversize: boolean;
  apply: boolean;
  reportPath: string | null;
  sourceDir: string;
};

type VariantReport = {
  bytes: number;
  cacheControl: string;
  contentType: string;
  height: number;
  key: string;
  publicHeadStatus: number | null;
  publicUrl: string | null;
  sha256: string;
  uploaded: boolean;
  variant: string;
  width: number;
};

const SOURCE_FILE_BY_CODE: Record<string, string> = {
  bg: "bg.png",
  daylightStadium: "daylightStadium.jpeg",
  bg1: "bg1.png",
  galaxy: "galaxy.jpeg",
  forest: "forest.jpeg",
  city: "city.jpeg",
  lava: "lava.jpeg",
  ice: "ice.jpeg",
  candy: "candy.jpeg",
  farm: "farm.jpeg",
  underwater: "underwater.jpeg",
  musicfest: "musicfest.jpeg",
  barbie: "track_barbie.png",
  desert: "track_desert.png",
  gold: "track_gold.png",
  nightforest: "track_nightforest.png",
  skykingdom: "track_skykingdom.png",
  rain: "track_rain.png",
  storm: "track_storm.png",
  mountain: "track_mountain.png",
  waterfall: "track_waterfall.png",
  webcity: "track_webcity.png",
  bridge: "track_bridge.png",
  newyork: "track_newyork.png",
  pirateisland: "track_pirateisland.png",
  paradise: "track_paradise.png",
  musicfest2: "track_musicfest2.png",
  chocolate: "track_chocolate.png",
  fireworks: "track_fireworks.png",
  moon: "track_moon.png",
  rainbow_road: "track_rainbow_road.png",
  runway: "track_runway.png",
  toy_race: "track_toy_race.png",
  water_park: "track_water_park.png",
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

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    allowOversize: false,
    apply: false,
    reportPath: null,
    sourceDir: path.resolve(process.cwd(), "../walkchamp-frontend/assets/images"),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") options.apply = true;
    else if (arg === "--allow-oversize") options.allowOversize = true;
    else if (arg === "--source-dir") options.sourceDir = path.resolve(argv[++i] ?? "");
    else if (arg === "--report") options.reportPath = path.resolve(argv[++i] ?? "");
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function sha256(buffer: Buffer): string {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  loadDotEnvFile(path.resolve(process.cwd(), ".env"));
  loadDotEnvFile(path.resolve(process.cwd(), ".env.local"));

  const sharp = (await import("sharp")).default;
  const {
    TRACK_THEME_ASSET_CACHE_CONTROL,
    TRACK_THEME_CODES,
    TRACK_THEME_VARIANTS,
    objectUrl,
    putStoredObject,
    headStoredObject,
    trackThemeObjectKey,
  } = {
    ...(await import("../../src/lib/trackThemeMedia.js")),
    ...(await import("../../src/lib/objectStorage.js")),
  };

  const missingCodes = TRACK_THEME_CODES.filter((code) => {
    const sourceFile = SOURCE_FILE_BY_CODE[code];
    return !sourceFile || !fs.existsSync(path.join(options.sourceDir, sourceFile));
  });

  if (missingCodes.length > 0) {
    throw new Error(`Missing source assets for track themes: ${missingCodes.join(", ")}`);
  }

  const reports: Array<{ code: string; sourcePath: string; variants: VariantReport[] }> = [];
  const oversize: Array<{ code: string; variant: string; bytes: number; maxBytes: number }> = [];

  for (const code of TRACK_THEME_CODES) {
    const sourcePath = path.join(options.sourceDir, SOURCE_FILE_BY_CODE[code]);
    const variants: VariantReport[] = [];

    for (const [variant, spec] of Object.entries(TRACK_THEME_VARIANTS)) {
      const pipeline = sharp(sourcePath).rotate();
      if (variant === "full") {
        pipeline.resize({ width: spec.width, height: spec.height, fit: "inside", withoutEnlargement: true });
      } else {
        pipeline.resize({ width: spec.width, fit: "inside", withoutEnlargement: true });
      }

      const { data, info } = await pipeline.webp({ quality: spec.quality, effort: 6 }).toBuffer({ resolveWithObject: true });
      if (data.length > spec.maxBytes) {
        oversize.push({ code, variant, bytes: data.length, maxBytes: spec.maxBytes });
      }

      const key = trackThemeObjectKey(code, variant as never, 1);
      let publicUrl: string | null = null;
      try {
        publicUrl = objectUrl(key);
      } catch {
        publicUrl = null;
      }

      if (options.apply) {
        await putStoredObject(key, data, "image/webp", { cacheControl: TRACK_THEME_ASSET_CACHE_CONTROL });
        const metadata = await headStoredObject(key);
        if (!metadata) throw new Error(`Upload verification failed for ${key}: object missing`);
        if (metadata.contentType !== "image/webp") {
          throw new Error(`Upload verification failed for ${key}: content type ${metadata.contentType}`);
        }
        if (metadata.cacheControl !== TRACK_THEME_ASSET_CACHE_CONTROL) {
          throw new Error(`Upload verification failed for ${key}: cache control ${metadata.cacheControl}`);
        }
      }

      let publicHeadStatus: number | null = null;
      if (options.apply && publicUrl) {
        const publicHead = await fetch(publicUrl, { method: "HEAD" });
        publicHeadStatus = publicHead.status;
        if (!publicHead.ok) {
          throw new Error(`Public URL verification failed for ${key}: HEAD ${publicHead.status}`);
        }
      }

      variants.push({
        variant,
        key,
        publicUrl,
        publicHeadStatus,
        bytes: data.length,
        width: info.width,
        height: info.height,
        contentType: "image/webp",
        cacheControl: TRACK_THEME_ASSET_CACHE_CONTROL,
        sha256: sha256(data),
        uploaded: options.apply,
      });
    }

    reports.push({ code, sourcePath, variants });
  }

  if (oversize.length > 0 && !options.allowOversize) {
    throw new Error(`Generated assets exceed byte targets: ${JSON.stringify(oversize, null, 2)}`);
  }

  const report = {
    applied: options.apply,
    sourceDir: options.sourceDir,
    generatedAt: new Date().toISOString(),
    themeCount: reports.length,
    reports,
    oversize,
  };

  const reportJson = `${JSON.stringify(report, null, 2)}\n`;
  if (options.reportPath) fs.writeFileSync(options.reportPath, reportJson);
  process.stdout.write(reportJson);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
