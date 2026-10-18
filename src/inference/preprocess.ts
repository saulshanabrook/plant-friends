export const PHOTO_LIMITS = { bytes: 20 * 1024 * 1024, pixels: 24_000_000, side: 32768, aspect: 32 };
const MEAN = [0.48145466, 0.4578275, 0.40821073];
const STD = [0.26862954, 0.26130258, 0.27577711];
const PRECISION = 2 ** 22;

/** Precompute a separable, antialiased cubic kernel and its integer coefficients.
 * Matches Pillow's documented bicubic filter and 8-bit intermediate rounding.
 * Reference: Pillow src/libImaging/Resample.c (see numerical fixtures).
 */
function coefficients(input: number, output: number): { start: number; weights: number[] }[] {
  const scale = input / output;
  const filterScale = Math.max(1, scale);
  const support = 2 * filterScale;
  const kernels = [];
  for (let x = 0; x < output; x++) {
    const center = (x + 0.5) * scale;
    const start = Math.max(0, Math.trunc(center - support + 0.5));
    const end = Math.min(input, Math.trunc(center + support + 0.5));
    const values = [];
    let total = 0;
    for (let source = start; source < end; source++) {
      const distance = Math.abs((source - center + 0.5) / filterScale);
      const value = distance < 1
        ? ((1.5 * distance - 2.5) * distance) * distance + 1
        : distance < 2 ? ((-0.5 * distance + 2.5) * distance - 4) * distance + 2 : 0;
      values.push(value);
      total += value;
    }
    kernels.push({ start, weights: values.map(value => {
      const scaled = value / total * PRECISION;
      return Math.trunc(scaled + (scaled < 0 ? -0.5 : 0.5));
    }) });
  }
  return kernels;
}

export function resizeAndCrop(rgb: Uint8Array, width: number, height: number): Uint8Array {
  if (rgb.length !== width * height * 3 || width < 1 || height < 1) throw new Error('Invalid RGB image dimensions.');
  const resizedWidth = width <= height ? 224 : Math.floor(width * 224 / height);
  const resizedHeight = height <= width ? 224 : Math.floor(height * 224 / width);
  const horizontal = coefficients(width, resizedWidth);
  const vertical = coefficients(height, resizedHeight);
  const intermediate = new Uint8Array(resizedWidth * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < resizedWidth; x++) {
    const kernel = horizontal[x];
    for (let c = 0; c < 3; c++) {
      let sum = PRECISION / 2;
      for (let k = 0; k < kernel.weights.length; k++) sum += rgb[(y * width + kernel.start + k) * 3 + c] * kernel.weights[k];
      intermediate[(y * resizedWidth + x) * 3 + c] = Math.min(255, Math.max(0, Math.floor(sum / PRECISION)));
    }
  }
  // Python's round() uses ties to even for the center-crop coordinates.
  const halfX = (resizedWidth - 224) / 2;
  const halfY = (resizedHeight - 224) / 2;
  const left = halfX % 1 === 0.5 ? Math.floor(halfX) + Math.floor(halfX) % 2 : Math.round(halfX);
  const top = halfY % 1 === 0.5 ? Math.floor(halfY) + Math.floor(halfY) % 2 : Math.round(halfY);
  const cropped = new Uint8Array(224 * 224 * 3);
  for (let y = 0; y < 224; y++) for (let x = 0; x < 224; x++) {
    const kernel = vertical[y + top];
    for (let c = 0; c < 3; c++) {
      let sum = PRECISION / 2;
      for (let k = 0; k < kernel.weights.length; k++) sum += intermediate[((kernel.start + k) * resizedWidth + x + left) * 3 + c] * kernel.weights[k];
      cropped[(y * 224 + x) * 3 + c] = Math.min(255, Math.max(0, Math.floor(sum / PRECISION)));
    }
  }
  return cropped;
}

export function normalizePixels(rgb: Uint8Array): Float32Array {
  const tensor = new Float32Array(3 * 224 * 224);
  for (let c = 0; c < 3; c++) for (let i = 0; i < 224 * 224; i++) {
    tensor[c * 224 * 224 + i] = Math.fround(
      Math.fround(Math.fround(rgb[i * 3 + c] / 255) - Math.fround(MEAN[c])) / Math.fround(STD[c]));
  }
  return tensor;
}

export async function imageDimensions(photo: Blob): Promise<{ width: number; height: number }> {
  if (!photo.size || photo.size > PHOTO_LIMITS.bytes) throw new Error('Choose a photo smaller than 20 MiB.');
  const bytes = new Uint8Array(await photo.slice(0, 1024 * 1024).arrayBuffer());
  const view = new DataView(bytes.buffer);
  let width = 0, height = 0;
  if (bytes.length >= 24 && view.getUint32(0) === 0x89504e47 && view.getUint32(4) === 0x0d0a1a0a) {
    width = view.getUint32(16); height = view.getUint32(20);
  } else if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 8 < bytes.length) {
      if (bytes[offset++] !== 0xff) break;
      while (offset < bytes.length && bytes[offset] === 0xff) offset++;
      if (offset + 7 >= bytes.length) break;
      const marker = bytes[offset++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      const size = view.getUint16(offset);
      if (size < 2) break;
      if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
        height = view.getUint16(offset + 3); width = view.getUint16(offset + 5); break;
      }
      offset += size;
    }
  } else if (bytes.length >= 30 && view.getUint32(0) === 0x52494646 && view.getUint32(8) === 0x57454250) {
    const chunk = view.getUint32(12);
    if (chunk === 0x56503858) {
      width = 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16);
      height = 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16);
    } else if (chunk === 0x56503820) {
      width = view.getUint16(26, true) & 0x3fff; height = view.getUint16(28, true) & 0x3fff;
    } else if (chunk === 0x5650384c && bytes[20] === 0x2f) {
      const bits = view.getUint32(21, true);
      width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1;
    }
  }
  if (!width || !height) throw new Error('Use a valid JPEG, PNG, or WebP photo. HEIC and other formats need conversion first.');
  if (width * height > PHOTO_LIMITS.pixels || Math.max(width, height) > PHOTO_LIMITS.side || Math.max(width / height, height / width) > PHOTO_LIMITS.aspect)
    throw new Error('Choose a photo under 24 megapixels and crop very long panoramas first.');
  return { width, height };
}

export async function preparePhoto(photo: Blob): Promise<Float32Array> {
  await imageDimensions(photo);
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(photo, { imageOrientation: 'from-image', colorSpaceConversion: 'none' }); }
  catch { throw new Error('This browser could not decode the photo. Try another JPEG, PNG, or WebP image.'); }
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) { bitmap.close(); throw new Error('Image processing is unavailable in this browser.'); }
  context.drawImage(bitmap, 0, 0);
  const width = bitmap.width, height = bitmap.height;
  bitmap.close();
  const pixels = context.getImageData(0, 0, width, height).data;
  canvas.width = 1; canvas.height = 1;
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    const alpha = pixels[i * 4 + 3];
    for (let c = 0; c < 3; c++) rgb[i * 3 + c] = Math.floor((pixels[i * 4 + c] * alpha + 255 * (255 - alpha) + 127) / 255);
  }
  return normalizePixels(resizeAndCrop(rgb, width, height));
}
