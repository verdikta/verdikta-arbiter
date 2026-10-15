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
 * Then the whole request is held to the request-wide limits of the providers in
 * the jury (Claude: 100 images, 20 MB; OpenAI: 1,500 images, 512 MB):
 * - Too many images: tall / wide images are cut into fewer parts (all of them
 *   to the same cap), and if one part each is still too many, the last images
 *   are omitted with a prompt note.
 * - Too many bytes: the images this module already changed are sent as JPEG
 *   and then scaled down step by step, largest first. Images that fit are only
 *   touched once that is not enough, and the last images are omitted only if
 *   even that fails. Each image affected gets a prompt note.
 * Every decision follows from the request alone (the images and the jury), never
 * from operator configuration, so every operator sends the models the same thing.
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
  /**
   * Anthropic, images per request: "100 per request on the API, for models with
   * a 200k-token context window", 600 for all other models (vision page above).
   * A model id does not say which window a model has, so 100 applies whenever
   * Claude is in the jury. PDFs count too: Bedrock and Google Cloud count
   * document blocks toward the many-image threshold, so they are counted here.
   */
  ANTHROPIC_MAX_IMAGES_PER_REQUEST: 100,
  /**
   * Anthropic, whole request: 32 MB on the Messages API, but "Bedrock limits
   * requests to 20 MB, and Google Cloud limits requests to 30 MB"; over it is a
   * 413 request_too_large. https://platform.claude.com/docs/en/api/overview#request-size-limits
   * OpenRouter can serve Claude from either, and whether a node uses OpenRouter is
   * operator configuration, so 20 MB keeps every operator's attachments the same.
   */
  ANTHROPIC_MAX_REQUEST_BYTES: 20_000_000,
  /** OpenAI: "Up to 1,500 images per request", "Up to 512 MB total payload per request" (vision guide above). */
  OPENAI_MAX_IMAGES_PER_REQUEST: 1500,
  OPENAI_MAX_REQUEST_BYTES: 512_000_000,
  /**
   * Images we produce aim at this share of each limit. For the request size the
   * other 5% (1 MB of Claude's 20) covers the prompt and the JSON around it; the
   * prompt is bounded by the context window far below that. Text and PDF
   * attachments are counted in full.
   */
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
/**
 * Steps the request-size budget can take on one image: JPEG at its planned size,
 * then JPEG at ENCODE_SHRINK_FACTOR, ^2, ^3 and ^4 of it (about a third).
 */
const REQUEST_BUDGET_STEPS = 5;

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

type TilePlan = Extract<Plan, { kind: 'tile' }>;
type ResizePlan = Extract<Plan, { kind: 'resize' }>;

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

/** One image as it will go into the request, while the request-wide limits are applied. */
interface PreparedImage {
  image: InspectedImage;
  /** What the per-image limits (and the image count) call for; 'keep' = send as received. */
  plan: Plan;
  /** The image-count limit cut it into fewer parts than the per-image limits alone would. */
  fewerParts: boolean;
  /** The plan the outputs were rendered from: `plan`, or `plan` scaled down by the request-size budget. */
  rendered: Plan;
  /** Null while the image is sent as received. */
  outputs: EncodedImage[] | null;
  /** Request-size budget step the outputs come from (0 = none), and the last step tried. */
  budgetStep: number;
  triedStep: number;
  /** What the image puts into the request (tile labels included), and its length. */
  attachments: string[];
  bytes: number;
}

/** The lowest request-wide limits among the providers in the jury. */
interface RequestLimits {
  /** Image blocks plus document blocks. */
  maxBlocks: number;
  maxBytes: number;
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

  const omit = (
    index: number,
    name: AttachmentName,
    reason: string,
    note = `Attachment ${name.ref} could not be processed and was omitted: ${reason}.`,
  ) => {
    if (!dropUnprocessable) {
      throw new UnprocessableImageError(index, name.display, reason);
    }
    omitted.add(index);
    changes.push({ index, name: name.display, action: 'omitted', reason, note });
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
      omit(index, name, describeFailure(error));
    }
  }

  if (images.length === 0 && changes.length === 0) {
    return { attachments, promptNotes: [], changes: [] };
  }

  const models = options.models ?? [];
  const limits = requestLimits(models);
  let maxSide: number = IMAGE_LIMITS.MAX_SIDE_PX;
  const planAll = (maxTiles: number) =>
    new Map(images.map(image => [image.index, planImage(image, maxSide, maxTiles)] as const));

  let plans = planAll(IMAGE_LIMITS.MAX_TILES_PER_IMAGE);
  if (countImageBlocks(plans) + documentBlocks > IMAGE_LIMITS.MANY_IMAGES_THRESHOLD && models.some(isAnthropicModel)) {
    // Re-planning at 2000 px can only add tiles, so the count stays over 20.
    maxSide = IMAGE_LIMITS.MANY_IMAGES_MAX_SIDE_PX;
    plans = planAll(IMAGE_LIMITS.MAX_TILES_PER_IMAGE);
    log(
      `${LOG_PREFIX} ${tag}${countImageBlocks(plans) + documentBlocks} image/document blocks with an ` +
        `Anthropic model in the jury: every image capped at ${maxSide}x${maxSide} px`,
    );
  }

  // Request-wide image count. Depends on dimensions only, never on encoded sizes.
  const fullPlans = plans;
  let blocks = countImageBlocks(plans) + documentBlocks;
  if (blocks > limits.maxBlocks) {
    const before = blocks;
    let tileCap: number = IMAGE_LIMITS.MAX_TILES_PER_IMAGE;
    while (blocks > limits.maxBlocks && tileCap > 1) {
      tileCap--;
      plans = planAll(tileCap);
      blocks = countImageBlocks(plans) + documentBlocks;
    }
    // Every image is one block now; the last ones do not fit.
    const overflow: InspectedImage[] = [];
    for (let i = images.length - 1; i >= 0 && blocks > limits.maxBlocks; i--) {
      overflow.unshift(images[i]);
      blocks -= blockCount(plans.get(images[i].index)!);
    }
    log(
      `${LOG_PREFIX} ${tag}${before} image/document blocks over the ${limits.maxBlocks}-per-request limit: ` +
        `at most ${tileCap} part${tileCap === 1 ? '' : 's'} per image` +
        (overflow.length ? `, last ${overflow.length} image${overflow.length === 1 ? '' : 's'} omitted` : '') +
        ` -> ${blocks} blocks`,
    );
    for (const image of overflow) {
      omit(
        image.index,
        image.name,
        `over the limit of ${limits.maxBlocks} images per request`,
        `Attachment ${image.name.ref} was omitted: the models accept at most ${limits.maxBlocks} images per request.`,
      );
    }
  }

  const prepared: PreparedImage[] = [];
  for (const image of images) {
    if (omitted.has(image.index)) continue;
    const plan = plans.get(image.index)!;
    const full = fullPlans.get(image.index)!;
    const entry: PreparedImage = {
      image,
      plan,
      fewerParts: full.kind === 'tile' && blockCount(plan) < blockCount(full),
      rendered: plan,
      outputs: null,
      budgetStep: 0,
      triedStep: 0,
      attachments: [attachments[image.index]],
      bytes: attachments[image.index].length,
    };
    if (plan.kind !== 'keep') {
      try {
        const outputs = await render(image, plan, preferredFormats(image.mediaType), maxSide);
        setOutputs(entry, plan, outputs, 0);
      } catch (error) {
        omit(image.index, image.name, describeFailure(error));
        continue;
      }
    }
    prepared.push(entry);
  }

  // Request-wide size: everything else in the request is fixed; only images can give.
  const imageIndexes = new Set(images.map(image => image.index));
  let fixedBytes = 0;
  attachments.forEach((attachment, index) => {
    if (!imageIndexes.has(index) && !omitted.has(index) && typeof attachment === 'string') {
      fixedBytes += Buffer.byteLength(attachment);
    }
  });
  const overBudget = await fitRequestSize(prepared, fixedBytes, limits.maxBytes, maxSide, line =>
    log(`${LOG_PREFIX} ${tag}${line}`),
  );
  for (const entry of overBudget) {
    omit(
      entry.image.index,
      entry.image.name,
      `over the ${formatBytes(limits.maxBytes)} request size limit`,
      `Attachment ${entry.image.name.ref} was omitted: with it the request would exceed the models' ` +
        `${formatBytes(limits.maxBytes)} size limit.`,
    );
  }

  const replacements = new Map<number, string[]>();
  for (const entry of prepared) {
    if (omitted.has(entry.image.index) || !entry.outputs) continue;
    replacements.set(entry.image.index, entry.attachments);
    changes.push(describeChange(entry, limits));
    log(`${LOG_PREFIX} ${tag}${summarize(entry)}`);
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

/** The lowest documented request-wide limits among the jury's providers; others set none. */
function requestLimits(models: Array<{ provider?: string; model?: string }>): RequestLimits {
  const limits: RequestLimits = { maxBlocks: Infinity, maxBytes: Infinity };
  if (models.some(isAnthropicModel)) {
    limits.maxBlocks = Math.min(limits.maxBlocks, IMAGE_LIMITS.ANTHROPIC_MAX_IMAGES_PER_REQUEST);
    limits.maxBytes = Math.min(limits.maxBytes, IMAGE_LIMITS.ANTHROPIC_MAX_REQUEST_BYTES);
  }
  if (models.some(isOpenAIModel)) {
    limits.maxBlocks = Math.min(limits.maxBlocks, IMAGE_LIMITS.OPENAI_MAX_IMAGES_PER_REQUEST);
    limits.maxBytes = Math.min(limits.maxBytes, IMAGE_LIMITS.OPENAI_MAX_REQUEST_BYTES);
  }
  return limits;
}

function planImage(image: InspectedImage, maxSide: number, maxTiles: number): Plan {
  const { width, height } = image;
  const fits =
    withinDimensionLimits(width, height, maxSide) && image.encodedLength <= IMAGE_LIMITS.MAX_IMAGE_BASE64_BYTES;
  if (fits && !image.animated) return { kind: 'keep' };

  const aspect = Math.max(width, height) / Math.min(width, height);
  if (!fits && aspect > IMAGE_LIMITS.EXTREME_ASPECT_RATIO) {
    const tiles = planTiles(width, height, maxSide, maxTiles);
    if (tiles) return tiles;
  }
  return planResize(width, height, maxSide);
}

/**
 * Narrows the image to the tile width (never widening it) and cuts it along its
 * long axis. If that would take more than `maxTiles` tiles, the image is shrunk
 * until it fits in exactly that many - keeping it as legible as the tile budget
 * allows. Returns null when the result would be a single tile.
 */
function planTiles(width: number, height: number, maxSide: number, maxTiles: number): TilePlan | null {
  const vertical = height >= width;
  const cross = vertical ? width : height;
  const long = vertical ? height : width;

  const sideTarget = Math.floor(maxSide * IMAGE_LIMITS.SAFETY_MARGIN);
  const tileLength = Math.min(IMAGE_LIMITS.TILE_LENGTH_PX, sideTarget);
  const step = tileLength - IMAGE_LIMITS.TILE_OVERLAP_PX;
  const maxLong = tileLength + (maxTiles - 1) * step;

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
function planResize(width: number, height: number, maxSide: number): ResizePlan {
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

/**
 * Scales a tile plan down by `factor`, keeping its number of tiles. Region edges
 * are scaled (start rounded down, end rounded up), so the tiles still cover the
 * whole image and neighbours still overlap.
 */
function scaleTilePlan(plan: TilePlan, factor: number): TilePlan {
  const width = scaleSide(plan.width, factor);
  const height = scaleSide(plan.height, factor);
  const sx = width / plan.width;
  const sy = height / plan.height;
  const regions = plan.regions.map(region => {
    const left = Math.floor(region.left * sx);
    const top = Math.floor(region.top * sy);
    const right = Math.min(width, Math.ceil((region.left + region.width) * sx));
    const bottom = Math.min(height, Math.ceil((region.top + region.height) * sy));
    return { left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
  });
  return { ...plan, width, height, regions };
}

function blockCount(plan: Plan): number {
  return plan.kind === 'tile' ? plan.regions.length : 1;
}

function countImageBlocks(plans: Map<number, Plan>): number {
  let count = 0;
  plans.forEach(plan => {
    count += blockCount(plan);
  });
  return count;
}

function isAnthropicModel(model: { provider?: string; model?: string }): boolean {
  const provider = (model.provider ?? '').toLowerCase();
  const name = (model.model ?? '').toLowerCase();
  // Claude reached through OpenRouter shows up as "anthropic/claude-...".
  return provider.includes('anthropic') || name.includes('claude') || name.startsWith('anthropic/');
}

function isOpenAIModel(model: { provider?: string; model?: string }): boolean {
  const provider = (model.provider ?? '').toLowerCase();
  const name = (model.model ?? '').toLowerCase();
  return provider === 'openai' || name.startsWith('openai/');
}

/**
 * PNG and GIF stay lossless (as PNG - re-encoding GIF would re-quantize its
 * palette), with JPEG as the fallback when that is over the per-image size target.
 */
function preferredFormats(mediaType: string): OutputFormat[] {
  if (mediaType === 'image/jpeg') return ['jpeg'];
  if (mediaType === 'image/webp') return ['webp', 'jpeg'];
  return ['png', 'jpeg'];
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
 * Encodes in the first format that is within the per-image size target, and
 * shrinks the image when none of them is.
 *
 * @param make - Builds a fresh pipeline for the image at `factor` of its planned size.
 * @param formats - Formats to try, in order of preference.
 */
async function encodeWithinSizeLimit(
  make: (factor: number) => Sharp,
  formats: OutputFormat[],
): Promise<EncodedImage> {
  const target = Math.floor(IMAGE_LIMITS.MAX_IMAGE_BASE64_BYTES * IMAGE_LIMITS.SAFETY_MARGIN);
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

/** Renders a resize or tile plan and checks the result against every per-image limit. */
async function render(
  image: InspectedImage,
  plan: ResizePlan | TilePlan,
  formats: OutputFormat[],
  maxSide: number,
): Promise<EncodedImage[]> {
  const outputs =
    plan.kind === 'tile' ? await renderTiles(image, plan, formats) : [await renderResized(image, plan, formats)];
  assertWithinLimits(outputs, maxSide);
  return outputs;
}

async function renderResized(image: InspectedImage, plan: ResizePlan, formats: OutputFormat[]): Promise<EncodedImage> {
  // Default page selection reads only the first frame of an animated GIF / WebP.
  return encodeWithinSizeLimit(
    factor =>
      sharp(image.buffer, decodeOptions())
        .rotate()
        .resize(scaleSide(plan.width, factor), scaleSide(plan.height, factor), { fit: 'fill' }),
    formats,
  );
}

async function renderTiles(image: InspectedImage, plan: TilePlan, formats: OutputFormat[]): Promise<EncodedImage[]> {
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
      }, formats),
    );
  }
  return tiles;
}

function setOutputs(entry: PreparedImage, rendered: Plan, outputs: EncodedImage[], budgetStep: number): void {
  entry.rendered = rendered;
  entry.outputs = outputs;
  entry.budgetStep = budgetStep;
  entry.attachments = toAttachments(entry.image, rendered, outputs);
  entry.bytes = byteLength(entry.attachments);
}

/**
 * Brings the request under the size limit (less the safety margin). Each image
 * can take up to REQUEST_BUDGET_STEPS steps: JPEG at its planned size, then JPEG
 * at 75%, 56%, 42% and 32% of it. A step that does not make it smaller is
 * passed over. The image contributing the most bytes (lowest index on a tie)
 * takes the next step, until the request fits:
 *
 * 1. Only the images this module already changed take steps.
 * 2. If that is not enough, they are restored and every image takes steps, so
 *    a small changed image is not degraded for nothing.
 * 3. If even that is not enough, the last images are omitted until the rest
 *    fits at their smallest, and the rest are fitted again from the start.
 *
 * Every choice follows from the request, so every operator ends up with the
 * same images. Nothing changes when the text and documents are over the budget
 * by themselves: no image could make the request fit.
 *
 * @returns The images that must be omitted, in index order.
 */
async function fitRequestSize(
  prepared: PreparedImage[],
  fixedBytes: number,
  maxBytes: number,
  maxSide: number,
  log: (line: string) => void,
): Promise<PreparedImage[]> {
  const budget = Math.floor(maxBytes * IMAGE_LIMITS.SAFETY_MARGIN);
  const total = (entries: PreparedImage[]) => entries.reduce((sum, entry) => sum + entry.bytes, fixedBytes);
  const start = total(prepared);
  if (start <= budget) return [];
  if (fixedBytes >= budget) {
    log(
      `request is ${formatBytes(start)}, but its text and documents alone are ${formatBytes(fixedBytes)}, over ` +
        `the ${formatBytes(budget)} request-size budget; images left as they are`,
    );
    return [];
  }

  const initial = new Map(prepared.map(entry => [entry, { ...entry }] as const));
  const reset = (entries: PreparedImage[]) => entries.forEach(entry => Object.assign(entry, initial.get(entry)));
  // Rendering is deterministic, so a step rendered once can be reused after a reset.
  const renders = new Map<string, Awaited<ReturnType<typeof renderBudgetStep>> | null>();

  const shrink = async (pool: PreparedImage[], entries: PreparedImage[]) => {
    while (total(entries) > budget) {
      let entry: PreparedImage | undefined;
      for (const candidate of pool) {
        if (candidate.triedStep < REQUEST_BUDGET_STEPS && (!entry || candidate.bytes > entry.bytes)) entry = candidate;
      }
      if (!entry) return;
      entry.triedStep++;
      // JPEG at the planned size cannot beat outputs that already are exactly that.
      if (entry.triedStep === 1 && entry.outputs?.every(output => output.format === 'jpeg')) continue;
      const key = `${entry.image.index}:${entry.triedStep}`;
      if (!renders.has(key)) renders.set(key, await renderBudgetStep(entry, maxSide).catch(() => null));
      const step = renders.get(key);
      if (!step) {
        entry.triedStep = REQUEST_BUDGET_STEPS; // it cannot get smaller; leave it as it is
      } else if (byteLength(toAttachments(entry.image, step.plan, step.outputs)) < entry.bytes) {
        setOutputs(entry, step.plan, step.outputs, entry.triedStep);
      }
    }
  };
  const fit = async (entries: PreparedImage[]) => {
    await shrink(entries.filter(entry => entry.plan.kind !== 'keep'), entries);
    if (total(entries) > budget) {
      reset(entries);
      await shrink(entries, entries);
    }
  };

  let kept = prepared;
  await fit(kept);
  const over: PreparedImage[] = [];
  while (total(kept) > budget) {
    over.unshift(kept[kept.length - 1]);
    kept = kept.slice(0, -1);
  }
  if (over.length > 0) {
    reset(kept);
    await fit(kept);
  }

  const reduced = kept.filter(entry => entry.budgetStep > 0);
  const unchanged = reduced.filter(entry => entry.plan.kind === 'keep').length;
  log(
    `request ${formatBytes(start)} over the ${formatBytes(budget)} request-size budget ` +
      `(${formatBytes(maxBytes)} limit): ${reduced.length} image${reduced.length === 1 ? '' : 's'} ` +
      `sent as JPEG / scaled down (${unchanged} of them otherwise unchanged)` +
      (over.length ? `, last ${over.length} image${over.length === 1 ? '' : 's'} omitted` : '') +
      ` -> ${formatBytes(total(kept))}`,
  );
  return over;
}

/** The image as JPEG at ENCODE_SHRINK_FACTOR^(step - 1) of its planned size (tiles keep their count). */
async function renderBudgetStep(
  entry: PreparedImage,
  maxSide: number,
): Promise<{ plan: ResizePlan | TilePlan; outputs: EncodedImage[] }> {
  const { image } = entry;
  const factor = ENCODE_SHRINK_FACTOR ** (entry.triedStep - 1);
  const base: ResizePlan | TilePlan =
    entry.plan.kind === 'keep' ? { kind: 'resize', width: image.width, height: image.height } : entry.plan;
  const plan: ResizePlan | TilePlan =
    base.kind === 'tile'
      ? scaleTilePlan(base, factor)
      : { kind: 'resize', width: scaleSide(base.width, factor), height: scaleSide(base.height, factor) };
  return { plan, outputs: await render(image, plan, ['jpeg'], maxSide) };
}

function byteLength(attachments: string[]): number {
  return attachments.reduce((sum, attachment) => sum + attachment.length, 0);
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

function describeChange(entry: PreparedImage, limits: RequestLimits): ImageChange {
  const { image, rendered: plan } = entry;
  const outputs = entry.outputs!;
  const name = image.name.display;
  const sentences: string[] = [];
  const forRequestSize = entry.budgetStep > 0;
  let action: ImageChange['action'];

  if (plan.kind === 'tile') {
    action = 'split';
    const order = plan.direction === 'vertical' ? 'top to bottom' : 'left to right';
    sentences.push(`${name} was split into ${outputs.length} parts, ${order}; neighbouring parts overlap slightly.`);
    if (entry.fewerParts) {
      sentences.push(
        `It was scaled down to fit in ${outputs.length} parts because the models accept at most ${limits.maxBlocks} images per request.`,
      );
    }
    if (forRequestSize) {
      const scaled =
        entry.budgetStep > 1
          ? ` scaled down to ${plan.direction === 'vertical' ? `${plan.width} px wide` : `${plan.height} px tall`} and`
          : '';
      sentences.push(`To keep the whole request within the models' size limit, the parts were${scaled} sent as JPEG.`);
    }
  } else {
    action = 'resized';
    const output = outputs[0];
    const as = OUTPUT_MEDIA_TYPE[output.format] !== image.mediaType ? ` as ${output.format.toUpperCase()}` : '';
    if (forRequestSize) {
      const why = "to keep the whole request within the models' size limit";
      sentences.push(
        output.width !== image.width || output.height !== image.height
          ? `${name} was downscaled from ${image.width}x${image.height} to ${output.width}x${output.height} px and sent as JPEG ${why}.`
          : `${name} was re-encoded${as} ${why}.`,
      );
    } else if (output.width !== image.width || output.height !== image.height) {
      sentences.push(
        `${name} was downscaled from ${image.width}x${image.height} to ${output.width}x${output.height} px to fit model input limits.`,
      );
    } else if (!image.animated) {
      sentences.push(`${name} was re-encoded${as} to fit model input size limits.`);
    }
    if (entry.fewerParts) {
      sentences.push(`It was not split into parts because the models accept at most ${limits.maxBlocks} images per request.`);
    }
  }
  if (image.animated) {
    sentences.push(`${name} is animated; only its first frame is included.`);
  }
  return { index: image.index, name, action, note: sentences.join(' ') };
}

function summarize(entry: PreparedImage): string {
  const { image, rendered: plan } = entry;
  const outputs = entry.outputs!;
  const total = outputs.reduce((sum, output) => sum + output.data.length, 0);
  const source =
    `attachment ${image.index + 1} (${image.name.display}): ${image.width}x${image.height} ` +
    `${image.mediaType} ${formatBytes(image.buffer.length)}${image.animated ? ' animated' : ''}`;
  const budget = entry.budgetStep > 0 ? ` (request-size step ${entry.budgetStep})` : '';
  if (plan.kind === 'tile') {
    const sizes = Array.from(new Set(outputs.map(output => `${output.width}x${output.height}`))).join(', ');
    return `${source} -> ${outputs.length} tiles (${plan.direction}; ${sizes}) ${formatBytes(total)} total${budget}`;
  }
  const output = outputs[0];
  return `${source} -> ${output.width}x${output.height} ${OUTPUT_MEDIA_TYPE[output.format]} ${formatBytes(total)}${budget}`;
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
