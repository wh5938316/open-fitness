import { z } from 'zod';
import { randomToken, sha256 } from './crypto';
import { AppError, assert, notFound } from './errors';
import type { Env, ObjectStore } from './types';
import { id, operationId } from './domain/schemas';
import { FitnessService } from './domain/service';

export interface Asset {
  status: 'pending' | 'ready';
  objectKey: string;
  contentType: string;
  bytes?: number;
  width?: number;
  height?: number;
  sha256?: string;
  role: 'recipe_cover' | 'meal_photo' | 'thumbnail';
  processing: string;
  source?: string;
  createdBy: string;
  authorizationEpoch?: number;
}
export const imageTypes = ['image/png', 'image/jpeg', 'image/webp'] as const;
export function publicImageUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AppError(422, 'INVALID_IMAGE_SOURCE', 'invalidSource');
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  const ipv4 = /^\d+\.\d+\.\d+\.\d+$/.test(host);
  const numbers = host.split('.').map(Number);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    (url.port && url.port !== '443') ||
    !host.includes('.') ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.includes(':') ||
    host.includes('[') ||
    (ipv4 &&
      (numbers[0] === 0 ||
        numbers[0] === 10 ||
        numbers[0] === 127 ||
        numbers[0]! >= 224 ||
        (numbers[0] === 169 && numbers[1] === 254) ||
        (numbers[0] === 172 && numbers[1]! >= 16 && numbers[1]! <= 31) ||
        (numbers[0] === 192 && numbers[1] === 168) ||
        (numbers[0] === 100 && numbers[1]! >= 64 && numbers[1]! <= 127)))
  )
    throw new AppError(422, 'INVALID_IMAGE_SOURCE', 'invalidSource');
  return url;
}
export async function boundedBody(
  response: { body: ReadableStream<Uint8Array> | null; headers: Headers },
  max: number,
): Promise<ArrayBuffer> {
  if (Number(response.headers.get('Content-Length')) > max)
    throw new AppError(413, 'IMAGE_TOO_LARGE', 'imageTooLarge');
  if (!response.body) throw new AppError(422, 'EMPTY_IMAGE', 'invalidImage');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > max) throw new AppError(413, 'IMAGE_TOO_LARGE', 'imageTooLarge');
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes.buffer;
}
export function inspectImage(buffer: ArrayBuffer): {
  contentType: string;
  width: number;
  height: number;
} {
  const b = new Uint8Array(buffer);
  const v = new DataView(buffer);
  let result: { contentType: string; width: number; height: number } | undefined;
  if (
    b.length >= 45 &&
    b.slice(0, 8).every((n, i) => n === [137, 80, 78, 71, 13, 10, 26, 10][i]) &&
    v.getUint32(8) === 13 &&
    String.fromCharCode(...b.slice(12, 16)) === 'IHDR' &&
    String.fromCharCode(...b.slice(-8, -4)) === 'IEND'
  )
    result = { contentType: 'image/png', width: v.getUint32(16), height: v.getUint32(20) };
  if (b.length > 12 && b[0] === 255 && b[1] === 216 && b.at(-2) === 255 && b.at(-1) === 217) {
    for (let offset = 2; offset + 9 < b.length;) {
      if (b[offset] !== 255) break;
      const marker = b[offset + 1]!;
      if (marker === 255) {
        offset++;
        continue;
      }
      const length = v.getUint16(offset + 2);
      if (length < 2 || offset + 2 + length > b.length) break;
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) {
        result = {
          contentType: 'image/jpeg',
          height: v.getUint16(offset + 5),
          width: v.getUint16(offset + 7),
        };
        break;
      }
      offset += 2 + length;
    }
  }
  if (
    b.length >= 30 &&
    String.fromCharCode(...b.slice(0, 4)) === 'RIFF' &&
    String.fromCharCode(...b.slice(8, 12)) === 'WEBP' &&
    v.getUint32(4, true) + 8 === b.length
  ) {
    const type = String.fromCharCode(...b.slice(12, 16));
    if (type === 'VP8X')
      result = {
        contentType: 'image/webp',
        width: 1 + b[24]! + (b[25]! << 8) + (b[26]! << 16),
        height: 1 + b[27]! + (b[28]! << 8) + (b[29]! << 16),
      };
    if (type === 'VP8 ' && b[23] === 157 && b[24] === 1 && b[25] === 42)
      result = {
        contentType: 'image/webp',
        width: v.getUint16(26, true) & 16383,
        height: v.getUint16(28, true) & 16383,
      };
    if (type === 'VP8L' && b[20] === 47) {
      const bits = v.getUint32(21, true);
      result = {
        contentType: 'image/webp',
        width: (bits & 16383) + 1,
        height: ((bits >>> 14) & 16383) + 1,
      };
    }
  }
  if (
    !result ||
    result.width <= 0 ||
    result.height <= 0 ||
    result.width > 20000 ||
    result.height > 20000 ||
    result.width * result.height > 100000000
  )
    throw new AppError(422, 'INVALID_IMAGE', 'invalidImage');
  return result;
}

export class MediaService {
  constructor(
    private service: FitnessService,
    private env: Env,
    private store: ObjectStore,
    private baseUrl: string,
    private request: typeof fetch = fetch,
  ) {}
  register(): void {
    const fields = {
      operationId,
      role: z.enum(['recipe_cover', 'meal_photo', 'thumbnail']).default('recipe_cover'),
      processing: z.string().max(4000).default('Agent-provided processed image'),
    };
    this.service.add({
      name: 'create_media_upload',
      description:
        'Create a private image asset and a single-use upload URL valid for ten minutes. Upload the image bytes with HTTP PUT, then check complete_media_upload.',
      schema: z.object({ ...fields, contentType: z.enum(imageTypes) }),
      readOnly: false,
      method: 'POST',
      path: '/media/uploads',
      run: async (args) => {
        const owner = await this.env.DB.prepare(
          'SELECT session_epoch, status FROM owners WHERE id=?',
        )
          .bind(this.service.actor.ownerId)
          .first<{ session_epoch: number; status: string }>();
        if (!owner) throw new AppError(503, 'DATABASE_NOT_MIGRATED', 'internalError');
        if (owner.status !== 'active')
          throw new AppError(401, 'CONNECTION_REVOKED', 'unauthorized');
        const asset = await this.service.save<Asset>(
          'asset',
          {
            status: 'pending',
            objectKey: this.service.actor.ownerId + '/' + crypto.randomUUID(),
            contentType: args.contentType,
            role: args.role,
            processing: args.processing,
            createdBy: this.service.actor.id,
            authorizationEpoch: owner.session_epoch,
          },
          {},
        );
        const token = randomToken();
        return this.service.prepared(asset, undefined, {
          response: {
            asset,
            uploadUrl: `${this.baseUrl}/uploads/${token}`,
            method: 'PUT',
            contentType: args.contentType,
            expiresInSeconds: 600,
            maxBytes: this.maxBytes,
          },
          uploadTicket: {
            tokenHash: await sha256(token),
            assetId: asset.id,
            contentType: args.contentType,
            expiresAt: Date.now() + 600000,
          },
        });
      },
    });
    this.service.add({
      name: 'complete_media_upload',
      description:
        'Check that an uploaded asset passed validation and is ready to attach to a recipe or meal.',
      schema: z.object({ assetId: id }),
      readOnly: true,
      method: 'GET',
      path: '/media/uploads/:assetId',
      run: async (args) => {
        const asset = await this.service.require<Asset>('asset', args.assetId);
        assert(asset.data.status === 'ready', 'ASSET_NOT_READY');
        return { asset, contentUrl: `${this.baseUrl}/api/v1/media/${asset.id}/content` };
      },
    });
    this.service.add({
      name: 'import_recipe_image',
      description:
        'Import a processed image from a public HTTPS URL into private storage. Redirects and private-network targets are rejected. Attach the returned asset ID to a recipe.',
      schema: z.object({ ...fields, sourceUrl: z.url().max(4000) }),
      readOnly: false,
      method: 'POST',
      path: '/media/imports',
      run: async (args) => {
        const url = publicImageUrl(args.sourceUrl);
        let response: Response;
        try {
          response = await this.request(url.toString(), {
            redirect: 'error',
            signal: AbortSignal.timeout(15000),
            headers: { Accept: imageTypes.join(',') },
          });
        } catch {
          throw new AppError(422, 'IMAGE_FETCH_FAILED', 'invalidSource');
        }
        assert(response.ok, 'IMAGE_FETCH_FAILED');
        const body = await boundedBody(response, this.maxBytes);
        const image = inspectImage(body);
        const digest = await sha256(body);
        const objectKey =
          this.service.actor.ownerId + '/imports/' + crypto.randomUUID() + '-' + digest;
        await this.store.put(objectKey, body, image.contentType);
        const asset = await this.service.save<Asset>(
          'asset',
          {
            status: 'ready',
            objectKey,
            ...image,
            bytes: body.byteLength,
            sha256: digest,
            role: args.role,
            processing: args.processing,
            source: url.origin + url.pathname,
            createdBy: this.service.actor.id,
          },
          {},
        );
        return this.service.prepared(asset);
      },
    });
    this.service.add({
      name: 'attach_recipe_image',
      description:
        'Replace a recipe cover without changing its nutritional recipe version. The asset must be ready.',
      schema: z.object({
        operationId,
        recipeId: id,
        assetId: id,
        thumbnailAssetId: id.nullable().optional(),
        expectedVersion: z.number().int().positive(),
      }),
      readOnly: false,
      method: 'PUT',
      path: '/recipes/:recipeId/cover',
      run: async (args) => {
        await this.service.readyAsset(args.assetId);
        await this.service.readyAsset(args.thumbnailAssetId);
        const recipe = await this.service.require<any>('recipe', args.recipeId);
        const doc = await this.service.save(
          'recipe',
          {
            ...recipe.data,
            coverAssetId: args.assetId,
            coverThumbnailAssetId: args.thumbnailAssetId ?? null,
          },
          { id: recipe.id, expectedVersion: args.expectedVersion },
        );
        return this.service.prepared(doc, args.expectedVersion, {
          mediaReferences: [
            { assetId: args.assetId, targetKind: 'recipe', targetId: recipe.id, slot: 'cover' },
          ],
        });
      },
    });
  }
  get maxBytes(): number {
    const value = Number(this.env.MAX_IMAGE_BYTES ?? 10485760);
    return Number.isFinite(value) && value > 0 ? Math.min(value, 104857600) : 10485760;
  }
  async upload(request: Request, token: string): Promise<unknown> {
    const ticket = await this.env.DB.prepare(
      'UPDATE upload_tickets SET used_at=? WHERE token_hash=? AND used_at IS NULL AND expires_at>? RETURNING asset_id,content_type,owner_id',
    )
      .bind(Date.now(), await sha256(token), Date.now())
      .first<{ asset_id: string; content_type: string; owner_id: string }>();
    if (!ticket) throw new AppError(410, 'UPLOAD_EXPIRED', 'uploadExpired');
    if (ticket.owner_id !== this.service.actor.ownerId) throw notFound();
    const asset = await this.service.require<Asset>('asset', ticket.asset_id);
    assert(asset.data.status === 'pending', 'ASSET_ALREADY_UPLOADED');
    const owner = await this.env.DB.prepare(
      'SELECT id, session_epoch, status FROM owners WHERE id=?',
    )
      .bind(ticket.owner_id)
      .first<{ id: string; session_epoch: number; status: string }>();
    if (
      !owner ||
      owner.status !== 'active' ||
      owner.session_epoch !== asset.data.authorizationEpoch
    )
      throw new AppError(401, 'CONNECTION_REVOKED', 'unauthorized');
    const actor = {
      ...this.service.actor,
      id: asset.data.createdBy,
      kind: asset.data.createdBy === owner.id ? ('owner' as const) : ('bot' as const),
    };
    if (actor.kind === 'bot') {
      const bot = await this.env.DB.prepare('SELECT status,epoch,owner_id FROM bots WHERE id=?')
        .bind(actor.id)
        .first<{ status: string; epoch: number; owner_id: string }>();
      if (
        !bot ||
        bot.owner_id !== owner.id ||
        bot.status !== 'active' ||
        bot.epoch !== owner.session_epoch
      )
        throw new AppError(401, 'CONNECTION_REVOKED', 'unauthorized');
    }
    const body = await boundedBody(request, this.maxBytes);
    const image = inspectImage(body);
    assert(image.contentType === ticket.content_type, 'IMAGE_TYPE_MISMATCH');
    const digest = await sha256(body);
    await this.store.put(asset.data.objectKey, body, image.contentType);
    const updated = await this.service.save<Asset>(
      'asset',
      { ...asset.data, ...image, status: 'ready', bytes: body.byteLength, sha256: digest },
      { id: asset.id, expectedVersion: asset.version },
    );
    return this.service.repository.commit({
      actor,
      operation: 'upload_media',
      operationId: 'upload-' + asset.id,
      requestHash: digest,
      response: updated,
      mutations: [{ entity: updated, expectedVersion: asset.version }],
    });
  }
  async content(assetId: string, request: Request): Promise<Response> {
    const asset = await this.service.require<Asset>('asset', assetId);
    assert(asset.data.status === 'ready', 'ASSET_NOT_READY');
    const object = await this.store.get(asset.data.objectKey);
    if (!object) throw notFound();
    const headers = {
      'Content-Type': object.contentType,
      ETag: object.etag,
      'Cache-Control': 'private, max-age=300',
      'X-Content-Type-Options': 'nosniff',
    };
    if (request.headers.get('If-None-Match') === object.etag)
      return new Response(null, { status: 304, headers });
    return new Response(object.body, { headers });
  }
}

export async function cleanupMedia(env: Env): Promise<void> {
  const cutoff = new Date(Date.now() - 86400000).toISOString();
  const candidates = await env.DB.prepare(
    `SELECT owner_id,id,data FROM documents WHERE kind='asset' AND deleted=0 AND updated_at<? AND NOT EXISTS(SELECT 1 FROM media_references WHERE owner_id=documents.owner_id AND asset_id=documents.id) LIMIT 100`,
  )
    .bind(cutoff)
    .all<{ owner_id: string; id: string; data: string }>();
  for (const candidate of candidates.results) {
    const result = await env.DB.prepare(
      `UPDATE documents SET deleted=1,version=version+1,updated_at=? WHERE owner_id=? AND kind='asset' AND id=? AND deleted=0 AND NOT EXISTS(SELECT 1 FROM media_references WHERE owner_id=documents.owner_id AND asset_id=documents.id) RETURNING id`,
    )
      .bind(new Date().toISOString(), candidate.owner_id, candidate.id)
      .first();
    const original = JSON.parse(candidate.data) as Asset;
    if (
      result ||
      (
        await env.DB.prepare(
          "SELECT deleted FROM documents WHERE owner_id=? AND kind='asset' AND id=?",
        )
          .bind(candidate.owner_id, candidate.id)
          .first<{ deleted: number }>()
      )?.deleted
    ) {
      const shared = await env.DB.prepare(
        "SELECT id FROM documents WHERE owner_id=? AND kind='asset' AND deleted=0 AND json_extract(data,'$.objectKey')=? LIMIT 1",
      )
        .bind(candidate.owner_id, original.objectKey)
        .first();
      if (!shared) await env.MEDIA.delete(original.objectKey);
    }
  }
  const cursor = await env.CACHE.get('maintenance:r2-cursor');
  const objects = await env.MEDIA.list({
    limit: 100,
    ...(cursor ? { cursor } : {}),
  });
  for (const object of objects.objects) {
    if (object.uploaded.valueOf() >= Date.now() - 86400000) continue;
    const ownerId = object.key.split('/')[0];
    if (!ownerId || !object.key.includes('/')) continue;
    const tracked = await env.DB.prepare(
      "SELECT id FROM documents WHERE owner_id=? AND kind='asset' AND deleted=0 AND json_extract(data,'$.objectKey')=? LIMIT 1",
    )
      .bind(ownerId, object.key)
      .first();
    if (!tracked) await env.MEDIA.delete(object.key);
  }
  if (objects.truncated) await env.CACHE.put('maintenance:r2-cursor', objects.cursor);
  else await env.CACHE.delete('maintenance:r2-cursor');
  await env.DB.batch([
    env.DB.prepare('DELETE FROM upload_tickets WHERE expires_at<?').bind(Date.now()),
    env.DB.prepare('DELETE FROM auth_challenges WHERE expires_at<?').bind(Date.now()),
    env.DB.prepare('DELETE FROM sessions WHERE expires_at<?').bind(Date.now()),
    env.DB.prepare('DELETE FROM consent_claims WHERE expires_at<?').bind(Date.now()),
  ]);
}
