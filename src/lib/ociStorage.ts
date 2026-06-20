import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { Readable } from "stream";
import { config } from "./config";

type OciConfig = {
  accessKeyId: string,
  bucket: string,
  namespace: string,
  region: string,
  secretAccessKey: string,
};

class OciConfigError extends Error {
  constructor() {
    super("OCI object storage is not fully configured.");
    this.name = "OciConfigError";
  }
}

let ociS3: S3Client | null = null;

function getOciConfig(): OciConfig | null {
  const namespace = config.objectStorage.namespace;
  const region = config.objectStorage.region;
  const bucket = config.objectStorage.bucket;
  const accessKeyId = config.objectStorage.accessKeyId;
  const secretAccessKey = config.objectStorage.secretAccessKey;

  if (!namespace || !bucket || !accessKeyId || !secretAccessKey) {
    return null;
  }

  return {
    accessKeyId,
    bucket,
    namespace,
    region,
    secretAccessKey,
  };
}

function requireOciConfig(): OciConfig {
  const config = getOciConfig();
  if (!config) throw new OciConfigError();
  return config;
}

function getOciClient(): S3Client {
  if (ociS3) return ociS3;

  const config = requireOciConfig();
  const endpoint = `https://${config.namespace}.compat.objectstorage.${config.region}.oraclecloud.com`;

  ociS3 = new S3Client({
    region: config.region,
    endpoint,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    forcePathStyle: true,
    // AWS SDK v3 (≥3.500) adds x-amz-checksum-* headers automatically.
    // OCI's S3-compatible layer rejects them — disable automatic checksumming.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });

  return ociS3;
}

export function isOciConfigured(): boolean {
  return getOciConfig() !== null;
}

export function isOciConfigError(err: unknown): boolean {
  return err instanceof OciConfigError;
}

/** Returns the canonical HTTPS URL for an object stored in the OCI bucket. */
export function ociObjectUrl(key: string): string {
  const config = requireOciConfig();
  const endpoint = `https://${config.namespace}.compat.objectstorage.${config.region}.oraclecloud.com`;
  return `${endpoint}/${config.bucket}/${key}`;
}

export function ociObjectKeyFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;

  try {
    const parsed = new URL(url);
    const config = requireOciConfig();
    const prefix = `/${config.bucket}/`;
    if (!parsed.pathname.startsWith(prefix)) return null;
    return decodeURIComponent(parsed.pathname.slice(prefix.length));
  } catch {
    return null;
  }
}

/**
 * Upload a buffer to OCI Object Storage.
 * NOTE: OCI's S3-compatible API does NOT support per-object ACLs.
 * Images are served through our own proxy route (/api/profile/avatar/:id)
 * so they never need to be publicly readable from OCI directly.
 */
export async function ociPutObject(key: string, body: Buffer, contentType: string): Promise<void> {
  const config = requireOciConfig();
  await getOciClient().send(new PutObjectCommand({
    Bucket:      config.bucket,
    Key:         key,
    Body:        body,
    ContentType: contentType,
    // Intentionally omit ACL — OCI rejects the x-amz-acl header.
  }));
}

export async function ociGetObject(key: string): Promise<{ body: Readable; contentType: string } | null> {
  const config = requireOciConfig();
  try {
    const res = await getOciClient().send(new GetObjectCommand({ Bucket: config.bucket, Key: key }));
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
  const config = requireOciConfig();
  try {
    await getOciClient().send(new HeadObjectCommand({ Bucket: config.bucket, Key: key }));
    return true;
  } catch {
    return false;
  }
}

export async function ociDeleteObject(key: string): Promise<void> {
  const config = requireOciConfig();
  await getOciClient().send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }));
}
