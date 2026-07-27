import { z } from 'zod';

import { env } from '@/lib/env';
import {
  columnMappingSchema,
  renderOptionsSchema,
  type ColumnMapping,
  type RenderOptions,
} from '@/lib/types';

/** Shared parsing of the multipart upload form, used by preview and create. */

export const uploadFormSchema = z.object({
  mapping: columnMappingSchema.partial().optional(),
  options: renderOptionsSchema.partial().optional(),
  name: z.string().trim().min(1).max(200).optional(),
});

export interface UploadForm {
  file: File;
  fileName: string;
  buffer: Buffer;
  mapping?: ColumnMapping;
  options?: Partial<RenderOptions>;
  name?: string;
}

export class UploadError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'UploadError';
  }
}

const ALLOWED_EXTENSIONS = new Set(['csv', 'tsv', 'txt', 'xlsx', 'xlsm', 'xls']);

export async function readUploadForm(request: Request): Promise<UploadForm> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw new UploadError('Could not read the upload. Send it as multipart/form-data.');
  }

  const file = form.get('file');
  if (!(file instanceof File)) {
    throw new UploadError('No file was attached. Choose a .csv or .xlsx file and try again.');
  }

  const maxBytes = env().MAX_UPLOAD_BYTES;
  if (file.size === 0) throw new UploadError('That file is empty.');
  if (file.size > maxBytes) {
    throw new UploadError(
      `That file is ${formatBytes(file.size)}. The limit is ${formatBytes(maxBytes)}.`,
      413,
    );
  }

  const fileName = sanitizeFileName(file.name || 'upload.csv');
  const extension = fileName.toLowerCase().split('.').pop() ?? '';
  if (!ALLOWED_EXTENSIONS.has(extension)) {
    throw new UploadError(
      `".${extension}" files are not supported. Upload a .csv, .xlsx, or .xlsm file.`,
    );
  }

  const parsedJson = uploadFormSchema.parse({
    mapping: parseJsonField(form.get('mapping')),
    options: parseJsonField(form.get('options')),
    name: typeof form.get('name') === 'string' ? (form.get('name') as string) : undefined,
  });

  return {
    file,
    fileName,
    buffer: Buffer.from(await file.arrayBuffer()),
    mapping: parsedJson.mapping as ColumnMapping | undefined,
    options: parsedJson.options,
    name: parsedJson.name,
  };
}

function parseJsonField(value: FormDataEntryValue | null): unknown {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  try {
    return JSON.parse(value);
  } catch {
    throw new UploadError('The mapping or options field was not valid JSON.');
  }
}

/** Upload names end up in storage keys and in the UI; strip anything hostile. */
export function sanitizeFileName(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? 'upload';
  return base.replace(/[^\w.\- ]+/g, '_').slice(0, 180) || 'upload';
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
