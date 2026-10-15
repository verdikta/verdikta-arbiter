/**
 * Image attachment normalization.
 *
 * Runs once per /api/rank-and-justify request, before any provider is called,
 * so every model in the jury sees the same images and none of them is rejected
 * because of an image's dimensions or size.
 *
 * Before this existed a single oversized image could sink a whole evaluation:
 * a 2560 x 12268 px page screenshot (1.65 MB) was rejected by Claude (a side
 * over 8000 px) and by gpt-5.6-sol (30,720 patches over its 30,000 cap), so 0
 * of 2 jury models succeeded, the node never committed, and every oracle that
 * picked the request up failed the same way.
 *
 * Rules:
 * - An image that already fits every limit (and is not animated) is passed
 *   through byte-for-byte, so ordinary submissions are evaluated exactly as
 *   before and upgraded and older nodes agree on them.
 * - A tall or wide image that breaks a limit is narrowed to TILE_CROSS_PX and
 *   split into overlapping tiles along its long axis, so page screenshots stay
 *   legible. Each tile is preceded by a text label, and the prompt gets one
 *   line saying how the image was split.
 * - Any other image that breaks a limit is downscaled proportionally.
 * - An image that cannot be decoded (corrupt, unsupported format, decompression
 *   bomb) is omitted with a prompt note when DROP_UNPROCESSABLE_IMAGES is on
 *   (the default); with it off, the request fails with an error naming the image.
 *
 * Limits are measured after EXIF orientation. Image data is never logged.
 */

import sharp, { type Sharp, type SharpOptions } from 'sharp';
import { sniffMediaType } from '../../utils/media-type';

// Every request decodes different, untrusted images; libvips' operation cache
// would only hold on to their pixels.
sharp.cache(false);

export const IMAGE_LIMITS = {
  /**
   * Anthropic: "The maximum dimensions per image are 8000x8000 px."
   * https://platform.claude.com/docs/en/build-with-claude/vision#request-limits
   * Observed live (bounty 171): 400 "At least one of the image dimensions exceed
   * max allowed size: 8000 pixels".
   */
  MAX_SIDE_PX: 8000,
  /**
   * Anthropic: when a request carries more than 20 images, every image in it
   * must be at most 2000 px per side (same page). On Amazon Bedrock and Google
   * Cloud, document blocks such as PDFs count toward the 20 as well.
   */
  MANY_IMAGES_THRESHOLD: 20,
  MANY_IMAGES_MAX_SIDE_PX: 2000,
  /**
   * OpenAI: images are covered with 32 x 32 px patches,
   * patch_count = ceil(width / 32) x ceil(height / 32), and "the API supports up
   * to 30,000 patches per image"; larger images "are rejected, not automatically
   * resized". https://developers.openai.com/api/docs/guides/images-vision
   * Observed live from gpt-5.6-sol: "requires 30720 patches after processing,
   * exceeding the limit of 30000".
   */
  PATCH_PX: 32,
  MAX_PATCHES: 30_000,
  /**
   * Per-image size, counted base64-encoded. Anthropic allows 10 MB on its own
   * API but 5 MB on Amazon Bedrock and Google Cloud (vision page above), and
   * OpenRouter can serve Claude from either, so 5 MB is the figure every route
   * meets. OpenAI's current vision guide gives no per-image size, only 512 MB
   * per request (link above); the providers' own 20 MB checks stay in place.
   */
  MAX_IMAGE_BASE64_BYTES: 5_000_000,
  /** Images we produce aim at this share of each limit. */
  SAFETY_MARGIN: 0.95,
  /**
   * Tiles for tall / wide images. 1568 px is the long edge Claude's standard
   * resolution tier processes without downscaling (vision page, "Resolution and
   * token cost"); a 1568 x 1568 tile is 2,401 OpenAI patches.
   */
  TILE_CROSS_PX: 1568,
  TILE_LENGTH_PX: 1568,
  /** So a line of text cut at one tile's edge appears whole in the next. */
  TILE_OVERLAP_PX: 64,
  /** Beyond this many tiles the image is shrunk until it fits in this many. */
  MAX_TILES_PER_IMAGE: 12,
  /** Long side / short side above which an over-limit image is split, not shrunk. */
  EXTREME_ASPECT_RATIO: 2.5,
  /** Lossy output (JPEG sources, and anything forced lossy by the size limit). */
  JPEG_QUALITY: 85,
  /** sharp's default. Larger inputs fail on the header, before any pixel is decoded. */
  LIMIT_INPUT_PIXELS: 268_402_689,
} as const;

/** Formats Anthropic, OpenAI, xAI and OpenRouter all accept (see their vision guides). */
const SUPPORTED_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** Each pass of the size loop shrinks the image to this share of the previous one. */
const ENCODE_SHRINK_FACTOR = 0.75;
const MAX_ENCODE_ATTEMPTS = 6;

const LOG_PREFIX = '[image-normalize]';

type OutputFormat = 'png' | 'jpeg' | 'webp';

const OUTPUT_MEDIA_TYPE: Record<OutputFormat, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

interface Region {
  left: number;
  top: number;
  width: number;
  height: number;
}

type Plan =
  | { kind: 'keep' }
  | { kind: 'resize'; width: number; height: number }
  | {
      kind: 'tile';
      direction: 'vertical' | 'horizontal';
      /** Size of the whole image before it is cut. */
      width: number;
      height: number;
      regions: Region[];
    };

interface InspectedImage {
  index: number;
  name: AttachmentName;
  mediaType: string;
  buffer: Buffer;
  /** Length of the base64 payload as received - what a provider would be sent. */
  encodedLength: number;
  /** Dimensions after EXIF orientation. */
  width: number;
  height: number;
  animated: boolean;
}

interface EncodedImage {
  data: Buffer;
  format: OutputFormat;
  width: number;
  height: number;
}

interface AttachmentName {
  /** "medium_article.png", or "Attachment 3" when the caller sent no name. */
  display: string;
  /** How a note refers to it after the word "Attachment": the name, or its number. */
  ref: string;
}

export interface ImageChange {
  index: number;
  name: string;
  action: 'split' | 'resized' | 'omitted';
  /** The line added to the prompt for this image. */
  note: string;
  reason?: string;
}

export interface NormalizeImagesOptions {
  /** Original file names, index-aligned with the attachments (untrusted input). */
  names?: unknown;
  /** The jury; Anthropic's many-image rule only applies when a Claude model is in it. */
  models?: Array<{ provider?: string; model?: string }>;
  /** Request / aggregation id for log lines. */
  requestTag?: string;
  /** Overrides DROP_UNPROCESSABLE_IMAGES. */
  dropUnprocessable?: boolean;
  log?: (line: string) => void;
}

export interface NormalizeImagesResult {
  /** Replaces the request's attachments; untouched entries are the same strings. */
  attachments: string[];
  /** One line per changed or omitted image, for the prompt. */
  promptNotes: string[];
  changes: ImageChange[];
}

/** Thrown, with DROP_UNPROCESSABLE_IMAGES off, for an image that cannot be used. */
export class UnprocessableImageError extends Error {
  constructor(
    readonly attachmentIndex: number,
    readonly attachmentName: string,
    readonly reason: string,
  ) {
    super(`Image attachment ${attachmentName} could not be processed: ${reason}`);
    this.name = 'UnprocessableImageError';
  }
}

/**
 * Whether an image that cannot be decoded or normalized is omitted (with a
 * prompt note) instead of failing the request. On unless
 * DROP_UNPROCESSABLE_IMAGES is false / 0 / off / no.
 */
export function dropUnprocessableImagesEnabled(): boolean {
  const value = process.env.DROP_UNPROCESSABLE_IMAGES?.trim().toLowerCase();
  return !(value === 'false' || value === '0' || value === 'off' || value === 'no');
}

/** Appends the attachment notes to the prompt; returns it unchanged when there are none. */
export function appendAttachmentNotes(prompt: string, notes: string[]): string {
  if (notes.length === 0) return prompt;
  return `${prompt}\n\nNotes on the attachments (added by the arbiter while preparing them for the models):\n${notes
    .map(note => `- ${note}`)
    .join('\n')}`;
}

/**
 * Makes every image attachment fit every provider's limits.
 *
 * @param attachments - The request's attachments: data URIs and raw text.
 * @returns The attachments to send (same order, unchanged entries untouched),
 *          the prompt notes, and a description of each change.
 * @throws UnprocessableImageError when an image cannot be used and dropping is off.
 */
export async function normalizeImageAttachments(
  attachments: string[],
  options: NormalizeImagesOptions = {},
): Promise<NormalizeImagesResult> {
  const log = options.log ?? ((line: string) => console.log(line));
  const tag = options.requestTag ? `${options.requestTag} ` : '';
  const dropUnprocessable = options.dropUnprocessable ?? dropUnprocessableImagesEnabled();
  const names = Array.isArray(options.names) ? options.names : [];

  const images: InspectedImage[] = [];
  const changes: ImageChange[] = [];
  const omitted = new Set<number>();
  let documentBlocks = 0;

  const omit = (index: number, name: AttachmentName, error: unknown) => {
    const reason = describeFailure(error);
    if (!dropUnprocessable) {
      throw new UnprocessableImageError(index, name.display, reason);
    }
    omitted.add(index);
    changes.push({
      index,
      name: name.display,
      action: 'omitted',
      reason,
      note: `Attachment ${name.ref} could not be processed and was omitted: ${reason}.`,
    });
    log(`${LOG_PREFIX} ${tag}attachment ${index + 1} (${name.display}) omitted: ${reason}`);
  };

  for (let index = 0; index < attachments.length; index++) {
    const attachment = attachments[index];
    if (typeof attachment !== 'string' || !attachment.startsWith('data:')) continue;
    const comma = attachment.indexOf(',');
    if (comma < 0) continue;

    const payload = attachment.slice(comma + 1);
    const declared = attachment.slice(5, comma).split(';')[0].trim().toLowerCase();
    const mediaType = detectMediaType(declared, payload);
    if (mediaType === 'application/pdf') {
      documentBlocks++;
      continue;
    }
    if (!mediaType.startsWith('image/')) continue;

    const name = attachmentName(names, index);
    try {
      images.push(await inspectImage(index, name, mediaType, payload));
    } catch (error) {
      omit(index, name, error);
    }
  }

  if (images.length === 0 && changes.length === 0) {
    return { attachments, promptNotes: [], changes: [] };
  }

  let maxSide: number = IMAGE_LIMITS.MAX_SIDE_PX;
  let plans = new Map(images.map(image => [image.index, planImage(image, maxSide)] as const));
  const blocks = countImageBlocks(plans) + documentBlocks;
  if (blocks > IMAGE_LIMITS.MANY_IMAGES_THRESHOLD && (options.models ?? []).some(isAnthropicModel)) {
    // Re-planning at 2000 px can only add tiles, so the count stays over 20.
    maxSide = IMAGE_LIMITS.MANY_IMAGES_MAX_SIDE_PX;
    plans = new Map(images.map(image => [image.index, planImage(image, maxSide)] as const));
    log(
      `${LOG_PREFIX} ${tag}${countImageBlocks(plans) + documentBlocks} image/document blocks with an ` +
        `Anthropic model in the jury: every image capped at ${maxSide}x${maxSide} px`,
    );
  }

  const replacements = new Map<number, string[]>();
  for (const image of images) {
    const plan = plans.get(image.index)!;
    if (plan.kind === 'keep') continue;
    try {
      const outputs = plan.kind === 'tile' ? await renderTiles(image, plan) : [await renderResized(image, plan)];
      assertWithinLimits(outputs, maxSide);
      replacements.set(image.index, toAttachments(image, plan, outputs));
      changes.push(describeChange(image, plan, outputs));
      log(`${LOG_PREFIX} ${tag}${summarize(image, plan, outputs)}`);
    } catch (error) {
      omit(image.index, image.name, error);
    }
  }

  const normalized: string[] = [];
  attachments.forEach((attachment, index) => {
    if (omitted.has(index)) return;
    normalized.push(...(replacements.get(index) ?? [attachment]));
  });

  changes.sort((a, b) => a.index - b.index);
  return { attachments: normalized, promptNotes: changes.map(change => change.note), changes };
}

/** The bytes decide the type (the declared header is submitter-supplied); sniffing is silent here. */
function detectMediaType(declared: string, payload: string): string {
  try {
    const prefix = payload.replace(/\s/g, '').slice(0, 64);
    return sniffMediaType(Buffer.from(prefix, 'base64')) ?? declared;
  } catch {
    return declared;
  }
}

function attachmentName(names: unknown[], index: number): AttachmentName {
  const raw = names[index];
  if (typeof raw === 'string') {
    // A file name from the submitter's manifest: keep it on one short line.
    const clean = raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 200);
    if (clean) return { display: clean, ref: clean };
  }
  return { display: `Attachment ${index + 1}`, ref: String(index + 1) };
}

function decodeOptions(): SharpOptions {
  return { limitInputPixels: IMAGE_LIMITS.LIMIT_INPUT_PIXELS, failOn: 'error' };
}

/** Reads the header only - nothing is decoded for an image that fits. */
async function inspectImage(
  index: number,
  name: AttachmentName,
  mediaType: string,
  payload: string,
): Promise<InspectedImage> {
  if (!SUPPORTED_MEDIA_TYPES.has(mediaType)) {
    throw new Error(`unsupported image format ${mediaType} (supported: PNG, JPEG, GIF, WebP)`);
  }
  const buffer = Buffer.from(payload, 'base64');
  const metadata = await sharp(buffer, decodeOptions()).metadata();
  if (!metadata.width || !metadata.height) {
    throw new Error('image has no readable dimensions');
  }
  const swapped = (metadata.orientation ?? 1) >= 5;
  const oriented = metadata.autoOrient ?? {
    width: swapped ? metadata.height : metadata.width,
    height: swapped ? metadata.width : metadata.height,
  };
  return {
    index,
    name,
    mediaType,
    buffer,
    encodedLength: payload.length,
    width: oriented.width,
    height: oriented.height,
    animated: (metadata.pages ?? 1) > 1,
  };
}

function patchCount(width: number, height: number): number {
  return Math.ceil(width / IMAGE_LIMITS.PATCH_PX) * Math.ceil(height / IMAGE_LIMITS.PATCH_PX);
}

/** Limit checks are symmetric in width and height, so EXIF orientation cannot change the answer. */
function withinDimensionLimits(width: number, height: number, maxSide: number): boolean {
  return width <= maxSide && height <= maxSide && patchCount(width, height) <= IMAGE_LIMITS.MAX_PATCHES;
}

function base64Length(byteLength: number): number {
  return Math.ceil(byteLength / 3) * 4;
}

function planImage(image: InspectedImage, maxSide: number): Plan {
  const { width, height } = image;
  const fits =
    withinDimensionLimits(width, height, maxSide) && image.encodedLength <= IMAGE_LIMITS.MAX_IMAGE_BASE64_BYTES;
  if (fits && !image.animated) return { kind: 'keep' };

  const aspect = Math.max(width, height) / Math.min(width, height);
  if (!fits && aspect > IMAGE_LIMITS.EXTREME_ASPECT_RATIO) {
    const tiles = planTiles(width, height, maxSide);
    if (tiles) return tiles;
  }
  return planResize(width, height, maxSide);
}

/**
 * Narrows the image to the tile width (never widening it) and cuts it along its
 * long axis. If that would take more than MAX_TILES_PER_IMAGE tiles, the image
 * is shrunk until it fits in exactly that many - keeping it as legible as the
 * tile budget allows. Returns null when the result would be a single tile.
 */
function planTiles(width: number, height: number, maxSide: number): Plan | null {
  const vertical = height >= width;
  const cross = vertical ? width : height;
  const long = vertical ? height : width;

  const sideTarget = Math.floor(maxSide * IMAGE_LIMITS.SAFETY_MARGIN);
  const tileLength = Math.min(IMAGE_LIMITS.TILE_LENGTH_PX, sideTarget);
  const step = tileLength - IMAGE_LIMITS.TILE_OVERLAP_PX;
  const maxLong = tileLength + (IMAGE_LIMITS.MAX_TILES_PER_IMAGE - 1) * step;

  let scale = Math.min(1, Math.min(IMAGE_LIMITS.TILE_CROSS_PX, sideTarget) / cross);
  if (long * scale > maxLong) scale = maxLong / long;
  const scaledCross = Math.max(1, Math.round(cross * scale));
  const scaledLong = Math.min(maxLong, Math.max(1, Math.round(long * scale)));
  if (scaledLong <= tileLength) return null;

  const count = 1 + Math.ceil((scaledLong - tileLength) / step);
  const regions: Region[] = [];
  for (let k = 0; k < count; k++) {
    const start = k * step;
    const length = Math.min(tileLength, scaledLong - start);
    regions.push(
      vertical
        ? { left: 0, top: start, width: scaledCross, height: length }
        : { left: start, top: 0, width: length, height: scaledCross },
    );
  }
  return {
    kind: 'tile',
    direction: vertical ? 'vertical' : 'horizontal',
    width: vertical ? scaledCross : scaledLong,
    height: vertical ? scaledLong : scaledCross,
    regions,
  };
}

/** The largest proportional size (never larger than the original) within every target. */
function planResize(width: number, height: number, maxSide: number): Plan {
  const sideTarget = Math.floor(maxSide * IMAGE_LIMITS.SAFETY_MARGIN);
  const patchTarget = Math.floor(IMAGE_LIMITS.MAX_PATCHES * IMAGE_LIMITS.SAFETY_MARGIN);
  const patchArea = IMAGE_LIMITS.PATCH_PX * IMAGE_LIMITS.PATCH_PX;

  let scale = Math.min(1, sideTarget / Math.max(width, height), Math.sqrt((patchTarget * patchArea) / (width * height)));
  const size = () => ({ width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) });
  let target = size();
  // Rounding each side up to whole patches can still overshoot; step down until it doesn't.
  while (patchCount(target.width, target.height) > patchTarget) {
    scale *= 0.99;
    target = size();
  }
  return { kind: 'resize', ...target };
}

function countImageBlocks(plans: Map<number, Plan>): number {
  let count = 0;
  plans.forEach(plan => {
    count += plan.kind === 'tile' ? plan.regions.length : 1;
  });
  return count;
}

function isAnthropicModel(model: { provider?: string; model?: string }): boolean {
  const provider = (model.provider ?? '').toLowerCase();
  const name = (model.model ?? '').toLowerCase();
  // Claude reached through OpenRouter shows up as "anthropic/claude-...".
  return provider.includes('anthropic') || name.includes('claude') || name.startsWith('anthropic/');
}

/** PNG and GIF stay lossless (as PNG - re-encoding GIF would re-quantize its palette). */
function preferredFormat(mediaType: string): OutputFormat {
  if (mediaType === 'image/jpeg') return 'jpeg';
  if (mediaType === 'image/webp') return 'webp';
  return 'png';
}

function withFormat(image: Sharp, format: OutputFormat): Sharp {
  switch (format) {
    case 'png':
      return image.png();
    case 'webp':
      return image.webp({ lossless: true });
    case 'jpeg':
      // 4:4:4 keeps coloured text sharp; JPEG has no alpha, so flatten onto white.
      return image
        .flatten({ background: '#ffffff' })
        .jpeg({ quality: IMAGE_LIMITS.JPEG_QUALITY, chromaSubsampling: '4:4:4' });
  }
}

function scaleSide(length: number, factor: number): number {
  return Math.max(1, Math.floor(length * factor));
}

/**
 * Encodes in the preferred format, falls back to JPEG when that is over the
 * per-image size target, and shrinks the image when even JPEG is.
 *
 * @param make - Builds a fresh pipeline for the image at `factor` of its planned size.
 */
async function encodeWithinSizeLimit(
  make: (factor: number) => Sharp,
  preferred: OutputFormat,
): Promise<EncodedImage> {
  const target = Math.floor(IMAGE_LIMITS.MAX_IMAGE_BASE64_BYTES * IMAGE_LIMITS.SAFETY_MARGIN);
  const formats: OutputFormat[] = preferred === 'jpeg' ? ['jpeg'] : [preferred, 'jpeg'];
  let factor = 1;
  for (let attempt = 0; attempt < MAX_ENCODE_ATTEMPTS; attempt++) {
    for (const format of formats) {
      const { data, info } = await withFormat(make(factor), format).toBuffer({ resolveWithObject: true });
      if (base64Length(data.length) <= target) {
        return { data, format, width: info.width, height: info.height };
      }
    }
    factor *= ENCODE_SHRINK_FACTOR;
  }
  throw new Error(`image could not be encoded under ${formatBytes(target)} (base64)`);
}

async function renderResized(image: InspectedImage, plan: Extract<Plan, { kind: 'resize' }>): Promise<EncodedImage> {
  // Default page selection reads only the first frame of an animated GIF / WebP.
  return encodeWithinSizeLimit(
    factor =>
      sharp(image.buffer, decodeOptions())
        .rotate()
        .resize(scaleSide(plan.width, factor), scaleSide(plan.height, factor), { fit: 'fill' }),
    preferredFormat(image.mediaType),
  );
}

async function renderTiles(image: InspectedImage, plan: Extract<Plan, { kind: 'tile' }>): Promise<EncodedImage[]> {
  // Decode and scale once; every tile is cut from the same pixels, so the
  // overlapping strips of neighbouring tiles are identical.
  const { data, info } = await sharp(image.buffer, decodeOptions())
    .rotate()
    .resize(plan.width, plan.height, { fit: 'fill' })
    .toColourspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true });
  const raw = { width: info.width, height: info.height, channels: info.channels as 1 | 2 | 3 | 4 };

  const tiles: EncodedImage[] = [];
  for (const region of plan.regions) {
    tiles.push(
      await encodeWithinSizeLimit(factor => {
        const tile = sharp(data, { raw }).extract(region);
        return factor < 1
          ? tile.resize(scaleSide(region.width, factor), scaleSide(region.height, factor), { fit: 'fill' })
          : tile;
      }, preferredFormat(image.mediaType)),
    );
  }
  return tiles;
}

/** Belt and braces: nothing leaves this module over a hard limit. */
function assertWithinLimits(outputs: EncodedImage[], maxSide: number): void {
  for (const output of outputs) {
    if (
      !withinDimensionLimits(output.width, output.height, maxSide) ||
      base64Length(output.data.length) > IMAGE_LIMITS.MAX_IMAGE_BASE64_BYTES
    ) {
      throw new Error(`normalized image ${output.width}x${output.height} still exceeds the limits`);
    }
  }
}

function toDataUri(output: EncodedImage): string {
  return `data:${OUTPUT_MEDIA_TYPE[output.format]};base64,${output.data.toString('base64')}`;
}

/** Tiles are each preceded by a text label so the models can tell the parts apart. */
function toAttachments(image: InspectedImage, plan: Plan, outputs: EncodedImage[]): string[] {
  if (plan.kind !== 'tile') return outputs.map(toDataUri);
  return outputs.flatMap((output, k) => [
    `[${image.name.display} (part ${k + 1} of ${outputs.length})]`,
    toDataUri(output),
  ]);
}

function describeChange(image: InspectedImage, plan: Plan, outputs: EncodedImage[]): ImageChange {
  const name = image.name.display;
  const sentences: string[] = [];
  let action: ImageChange['action'];

  if (plan.kind === 'tile') {
    action = 'split';
    const order = plan.direction === 'vertical' ? 'top to bottom' : 'left to right';
    sentences.push(`${name} was split into ${outputs.length} parts, ${order}; neighbouring parts overlap slightly.`);
  } else {
    action = 'resized';
    const output = outputs[0];
    if (output.width !== image.width || output.height !== image.height) {
      sentences.push(
        `${name} was downscaled from ${image.width}x${image.height} to ${output.width}x${output.height} px to fit model input limits.`,
      );
    } else if (!image.animated) {
      const as = OUTPUT_MEDIA_TYPE[output.format] !== image.mediaType ? ` as ${output.format.toUpperCase()}` : '';
      sentences.push(`${name} was re-encoded${as} to fit model input size limits.`);
    }
  }
  if (image.animated) {
    sentences.push(`${name} is animated; only its first frame is included.`);
  }
  return { index: image.index, name, action, note: sentences.join(' ') };
}

function summarize(image: InspectedImage, plan: Plan, outputs: EncodedImage[]): string {
  const total = outputs.reduce((sum, output) => sum + output.data.length, 0);
  const source =
    `attachment ${image.index + 1} (${image.name.display}): ${image.width}x${image.height} ` +
    `${image.mediaType} ${formatBytes(image.buffer.length)}${image.animated ? ' animated' : ''}`;
  if (plan.kind === 'tile') {
    const sizes = Array.from(new Set(outputs.map(output => `${output.width}x${output.height}`))).join(', ');
    return `${source} -> ${outputs.length} tiles (${plan.direction}; ${sizes}) ${formatBytes(total)} total`;
  }
  const output = outputs[0];
  return `${source} -> ${output.width}x${output.height} ${OUTPUT_MEDIA_TYPE[output.format]} ${formatBytes(total)}`;
}

function describeFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/exceeds pixel limit/i.test(message)) {
    return `image is larger than the ${IMAGE_LIMITS.LIMIT_INPUT_PIXELS.toLocaleString('en-US')}-pixel decoding limit`;
  }
  const firstLine = message.split('\n')[0].trim().replace(/:$/, '');
  return firstLine.slice(0, 200) || 'unknown error';
}

function formatBytes(bytes: number): string {
  return bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(2)} MB` : `${(bytes / 1000).toFixed(1)} kB`;
}
