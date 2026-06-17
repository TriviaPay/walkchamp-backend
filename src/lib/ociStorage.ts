import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { Readable } from "stream";

const namespace = process.env.OCI_NAMESPACE ?? "";
const region    = process.env.OCI_REGION    ?? "us-ashburn-1";
const bucket    = process.env.OCI_BUCKET_NAME ?? "";

// OCI S3-compatible endpoint format
const endpoint = `https://${namespace}.compat.objectstorage.${region}.oraclecloud.com`;

export const ociS3 = new S3Client({
  region,
  endpoint,
  credentials: {
    accessKeyId:     process.env.OCI_ACCESS_KEY_ID     ?? "",
    secretAccessKey: process.env.OCI_SECRET_ACCESS_KEY ?? "",
  },
  forcePathStyle: true,
  // AWS SDK v3 (≥3.500) adds x-amz-checksum-* headers automatically.
  // OCI's S3-compatible layer rejects them — disable automatic checksumming.
  requestChecksumCalculation: "WHEN_REQUIRED",
  responseChecksumValidation: "WHEN_REQUIRED",
});

export const OCI_BUCKET = bucket;

/** Returns the canonical HTTPS URL for an object stored in the OCI bucket. */
export function ociObjectUrl(key: string): string {
  return `${endpoint}/${bucket}/${key}`;
}

/**
 * Upload a buffer to OCI Object Storage.
 * NOTE: OCI's S3-compatible API does NOT support per-object ACLs.
 * Images are served through our own proxy route (/api/profile/avatar/:id)
 * so they never need to be publicly readable from OCI directly.
 */
export async function ociPutObject(key: string, body: Buffer, contentType: string): Promise<void> {
  await ociS3.send(new PutObjectCommand({
    Bucket:      OCI_BUCKET,
    Key:         key,
    Body:        body,
    ContentType: contentType,
    // Intentionally omit ACL — OCI rejects the x-amz-acl header.
  }));
}

export async function ociGetObject(key: string): Promise<{ body: Readable; contentType: string } | null> {
  try {
    const res = await ociS3.send(new GetObjectCommand({ Bucket: OCI_BUCKET, Key: key }));
    if (!res.Body) return null;
    return {
      body:        res.Body as Readable,
      contentType: res.ContentType ?? "application/octet-stream",
    };
  } catch (err: any) {
    if (err?.name === "NoSuchKey" || err?.$metadata?.httpStatusCode === 404) return null;
    throw err;
  }
}

export async function ociObjectExists(key: string): Promise<boolean> {
  try {
    await ociS3.send(new HeadObjectCommand({ Bucket: OCI_BUCKET, Key: key }));
    return true;
  } catch {
    return false;
  }
}

export async function ociDeleteObject(key: string): Promise<void> {
  await ociS3.send(new DeleteObjectCommand({ Bucket: OCI_BUCKET, Key: key }));
}
