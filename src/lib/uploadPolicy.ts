import { randomUUID } from "node:crypto";
import { config } from "./config";

const SIGNATURES = {
  jpeg: Buffer.from([0xff, 0xd8, 0xff]),
  png: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  gif87a: Buffer.from("474946383761", "hex"),
  gif89a: Buffer.from("474946383961", "hex"),
  webpRiff: Buffer.from("52494646", "hex"),
  webpTag: Buffer.from("57454250", "hex"),
} as const;

export const allowedRasterMimeTypes = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
] as const;

type AllowedRasterMimeType = (typeof allowedRasterMimeTypes)[number];

function startsWith(buffer: Buffer, prefix: Buffer): boolean {
  return buffer.subarray(0, prefix.length).equals(prefix);
}

export function sniffRasterMimeType(buffer: Buffer): AllowedRasterMimeType | null {
  if (buffer.length < 12) return null;
  if (startsWith(buffer, SIGNATURES.jpeg)) return "image/jpeg";
  if (startsWith(buffer, SIGNATURES.png)) return "image/png";
  if (startsWith(buffer, SIGNATURES.gif87a) || startsWith(buffer, SIGNATURES.gif89a)) return "image/gif";
  if (startsWith(buffer, SIGNATURES.webpRiff) && buffer.subarray(8, 12).equals(SIGNATURES.webpTag)) {
    return "image/webp";
  }
  return null;
}

export function validateRasterUpload(file: Express.Multer.File): AllowedRasterMimeType {
  if (file.size > config.runtime.uploadBodyLimitBytes) {
    throw new Error("Upload exceeds the 5 MB limit.");
  }

  if (file.mimetype === "image/svg+xml") {
    throw new Error("SVG uploads are not allowed.");
  }

  const sniffedType = sniffRasterMimeType(file.buffer);
  if (!sniffedType) {
    throw new Error("Only JPEG, PNG, GIF, and WebP images are allowed.");
  }

  return sniffedType;
}

export function buildGeneratedObjectKey(prefix: string, ownerId: string, contentType: AllowedRasterMimeType): string {
  const ext =
    contentType === "image/jpeg"
      ? "jpg"
      : contentType === "image/png"
        ? "png"
        : contentType === "image/gif"
          ? "gif"
          : "webp";
  return `${prefix}/${ownerId}/${Date.now()}-${randomUUID()}.${ext}`;
}
