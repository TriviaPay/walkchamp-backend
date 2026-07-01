import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Readable } from "node:stream";
import { config } from "./config.js";

type ObjectStorageConfig = {
  accessKeyId: string,
  bucket: string,
  endpoint: string,
  publicBaseUrl: string,
  region: string,
  secretAccessKey: string,
};

export type StoredObjectMetadata = {
  cacheControl: string | null,
  contentLength: number | null,
  contentType: string,
  etag: string | null,
  lastModified: Date | null,
};

export type StoredObject = StoredObjectMetadata & {
  body: Readable,
};

class ObjectStorageConfigError extends Error {
  constructor() {
    super("Object storage is not fully configured.");
    this.name = "ObjectStorageConfigError";
  }
}

let s3Client: S3Client | null = null;

function getObjectStorageConfig(): ObjectStorageConfig | null {
  const endpoint = config.objectStorage.endpoint;
  const region = config.objectStorage.region;
  const bucket = config.objectStorage.bucket;
  const accessKeyId = config.objectStorage.accessKeyId;
  const secretAccessKey = config.objectStorage.secretAccessKey;
  const publicBaseUrl = config.objectStorage.publicBaseUrl;

  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey || !publicBaseUrl) {
    return null;
  }

  return {
    accessKeyId,
    bucket,
    endpoint,
    publicBaseUrl,
    region,
    secretAccessKey,
  };
}

function requireObjectStorageConfig(): ObjectStorageConfig {
  const storageConfig = getObjectStorageConfig();
  if (!storageConfig) throw new ObjectStorageConfigError();
  return storageConfig;
}

function getObjectStorageClient(): S3Client {
  if (s3Client) return s3Client;

  const storageConfig = requireObjectStorageConfig();

  s3Client = new S3Client({
    region: storageConfig.region,
    endpoint: storageConfig.endpoint,
    credentials: {
      accessKeyId: storageConfig.accessKeyId,
      secretAccessKey: storageConfig.secretAccessKey,
    },
    forcePathStyle: true,
    // Keep SDK checksum behavior explicit so S3-compatible backends do not
    // receive unsupported auto-generated checksum headers.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });

  return s3Client;
}

function toStoredObjectMetadata(input: {
  CacheControl?: string,
  ContentLength?: number,
  ContentType?: string,
  ETag?: string,
  LastModified?: Date,
}): StoredObjectMetadata {
  return {
    cacheControl: input.CacheControl ?? null,
    contentLength: typeof input.ContentLength === "number" ? input.ContentLength : null,
    contentType: input.ContentType ?? "application/octet-stream",
    etag: input.ETag ?? null,
    lastModified: input.LastModified ?? null,
  };
}

function encodeObjectKey(key: string): string {
  return key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

export function isObjectStorageConfigured(): boolean {
  return getObjectStorageConfig() !== null;
}

export function isObjectStorageConfigError(err: unknown): boolean {
  return err instanceof ObjectStorageConfigError;
}

export function objectUrl(key: string): string {
  const storageConfig = requireObjectStorageConfig();
  const publicBaseUrl = `${storageConfig.publicBaseUrl.replace(/\/$/, "")}/`;
  return new URL(encodeObjectKey(key), publicBaseUrl).toString();
}

export function objectKeyFromUrl(url: string | null | undefined): string | null {
  const storageConfig = getObjectStorageConfig();
  if (!url || !storageConfig) return null;

  try {
    const baseUrl = new URL(`${storageConfig.publicBaseUrl.replace(/\/$/, "")}/`);
    const parsedUrl = new URL(url);

    if (parsedUrl.origin !== baseUrl.origin) {
      return null;
    }

    if (!parsedUrl.pathname.startsWith(baseUrl.pathname)) {
      return null;
    }

    const relativePath = parsedUrl.pathname.slice(baseUrl.pathname.length);
    if (!relativePath) return null;

    return relativePath
      .split("/")
      .map((segment) => decodeURIComponent(segment))
      .join("/");
  } catch {
    return null;
  }
}

export async function putStoredObject(
  key: string,
  body: Buffer,
  contentType: string,
  options?: { cacheControl?: string | null },
): Promise<void> {
  const storageConfig = requireObjectStorageConfig();

  await getObjectStorageClient().send(new PutObjectCommand({
    Bucket: storageConfig.bucket,
    Key: key,
    Body: body,
    ContentType: contentType,
    CacheControl: options?.cacheControl ?? undefined,
  }));
}

export async function getStoredObject(
  key: string,
  options?: { abortSignal?: AbortSignal },
): Promise<StoredObject | null> {
  const storageConfig = requireObjectStorageConfig();

  try {
    const result = await getObjectStorageClient().send(
      new GetObjectCommand({
        Bucket: storageConfig.bucket,
        Key: key,
      }),
      { abortSignal: options?.abortSignal },
    );

    if (!result.Body) return null;

    return {
      ...toStoredObjectMetadata(result),
      body: result.Body as Readable,
    };
  } catch (err: any) {
    if (err?.name === "NoSuchKey" || err?.$metadata?.httpStatusCode === 404) {
      return null;
    }
    throw err;
  }
}

export async function headStoredObject(
  key: string,
  options?: { abortSignal?: AbortSignal },
): Promise<StoredObjectMetadata | null> {
  const storageConfig = requireObjectStorageConfig();

  try {
    const result = await getObjectStorageClient().send(
      new HeadObjectCommand({
        Bucket: storageConfig.bucket,
        Key: key,
      }),
      { abortSignal: options?.abortSignal },
    );

    return toStoredObjectMetadata(result);
  } catch (err: any) {
    if (err?.name === "NotFound" || err?.name === "NoSuchKey" || err?.$metadata?.httpStatusCode === 404) {
      return null;
    }
    throw err;
  }
}

export async function storedObjectExists(key: string): Promise<boolean> {
  return (await headStoredObject(key)) !== null;
}

export async function deleteStoredObject(key: string): Promise<void> {
  const storageConfig = requireObjectStorageConfig();

  await getObjectStorageClient().send(new DeleteObjectCommand({
    Bucket: storageConfig.bucket,
    Key: key,
  }));
}
