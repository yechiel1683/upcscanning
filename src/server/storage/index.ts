import { createReadStream, type ReadStream } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';

import { env } from '@/lib/env';

/**
 * Storage abstraction.
 *
 * Generated images and export ZIPs are the only large objects the platform
 * keeps. Local disk is the default so the app runs with no cloud account; S3
 * (or any S3-compatible bucket) is a drop-in swap for production.
 */
export interface StorageDriver {
  readonly name: string;
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  /** Streaming read, used when serving large ZIPs. */
  stream(key: string): Promise<NodeJS.ReadableStream>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  size(key: string): Promise<number>;
}

/**
 * Storage keys are built from user input (batch names, product names), so they
 * are sanitised before they ever touch a filesystem path.
 */
export function sanitizeKey(key: string): string {
  const cleaned = key
    .split('/')
    .map((segment) => segment.replace(/[^A-Za-z0-9._-]/g, '_'))
    .filter((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
    .join('/');
  if (!cleaned) throw new Error('Refusing to use an empty storage key');
  return cleaned;
}

class LocalStorage implements StorageDriver {
  readonly name = 'local';

  constructor(private readonly root: string) {}

  private resolve(key: string): string {
    const safe = sanitizeKey(key);
    const full = path.resolve(this.root, safe);
    const root = path.resolve(this.root);
    // Defence in depth: sanitizeKey already removes traversal segments.
    if (full !== root && !full.startsWith(root + path.sep)) {
      throw new Error('Storage key escapes the storage root');
    }
    return full;
  }

  async put(key: string, body: Buffer): Promise<void> {
    const target = this.resolve(key);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, body);
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.resolve(key));
  }

  async stream(key: string): Promise<ReadStream> {
    return createReadStream(this.resolve(key));
  }

  async delete(key: string): Promise<void> {
    await rm(this.resolve(key), { force: true });
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.resolve(key));
      return true;
    } catch {
      return false;
    }
  }

  async size(key: string): Promise<number> {
    const info = await stat(this.resolve(key));
    return info.size;
  }
}

class S3Storage implements StorageDriver {
  readonly name = 's3';

  // Imported lazily so the AWS SDK is not loaded when the local driver is used.
  private clientPromise: Promise<import('@aws-sdk/client-s3').S3Client> | null = null;

  constructor(private readonly bucket: string) {}

  private client() {
    if (!this.clientPromise) {
      this.clientPromise = (async () => {
        const { S3Client } = await import('@aws-sdk/client-s3');
        const config = env();
        return new S3Client({
          region: config.S3_REGION,
          endpoint: config.S3_ENDPOINT,
          forcePathStyle: config.S3_FORCE_PATH_STYLE,
          credentials:
            config.S3_ACCESS_KEY_ID && config.S3_SECRET_ACCESS_KEY
              ? {
                  accessKeyId: config.S3_ACCESS_KEY_ID,
                  secretAccessKey: config.S3_SECRET_ACCESS_KEY,
                }
              : undefined,
        });
      })();
    }
    return this.clientPromise;
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    const client = await this.client();
    await client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: sanitizeKey(key),
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async get(key: string): Promise<Buffer> {
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    const client = await this.client();
    const result = await client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: sanitizeKey(key) }),
    );
    const bytes = await result.Body?.transformToByteArray();
    if (!bytes) throw new Error(`Object not found: ${key}`);
    return Buffer.from(bytes);
  }

  async stream(key: string): Promise<NodeJS.ReadableStream> {
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    const client = await this.client();
    const result = await client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: sanitizeKey(key) }),
    );
    const body = result.Body;
    if (!body) throw new Error(`Object not found: ${key}`);
    if (body instanceof Readable) return body;
    return Readable.fromWeb(body as unknown as import('node:stream/web').ReadableStream);
  }

  async delete(key: string): Promise<void> {
    const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
    const client = await this.client();
    await client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: sanitizeKey(key) }));
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.size(key);
      return true;
    } catch {
      return false;
    }
  }

  async size(key: string): Promise<number> {
    const { HeadObjectCommand } = await import('@aws-sdk/client-s3');
    const client = await this.client();
    const result = await client.send(
      new HeadObjectCommand({ Bucket: this.bucket, Key: sanitizeKey(key) }),
    );
    return result.ContentLength ?? 0;
  }
}

let driver: StorageDriver | null = null;

export function storage(): StorageDriver {
  if (driver) return driver;
  const config = env();
  if (config.STORAGE_DRIVER === 's3') {
    if (!config.S3_BUCKET) {
      throw new Error('STORAGE_DRIVER is "s3" but S3_BUCKET is not set.');
    }
    driver = new S3Storage(config.S3_BUCKET);
  } else {
    driver = new LocalStorage(path.resolve(process.cwd(), config.STORAGE_LOCAL_DIR));
  }
  return driver;
}

/** Test hook. */
export function setStorageDriver(next: StorageDriver | null): void {
  driver = next;
}

export const keys = {
  productImage: (batchId: string, productId: string, fileName: string) =>
    `batches/${batchId}/images/${productId}_${fileName}`,
  export: (batchId: string, exportId: string, fileName: string) =>
    `batches/${batchId}/exports/${exportId}_${fileName}`,
  upload: (batchId: string, fileName: string) => `batches/${batchId}/source/${fileName}`,
};
