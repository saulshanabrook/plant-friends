import { createHash } from 'node:crypto';
import { expect, test } from 'vitest';
import golden from '../../fixtures/numerical/resize-golden.json';
import { imageDimensions, normalizePixels, resizeAndCrop } from './preprocess';

for (const { width, height, rgbSha256 } of golden.cases) {
  test(`bicubic resize and crop match Pillow for ${width}×${height}`, () => {
    const rgb = new Uint8Array(width * height * 3);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) for (let c = 0; c < 3; c++)
      rgb[(y * width + x) * 3 + c] = (x * 13 + y * 7 + c * 59 + x * y % 113) % 256;
    const resized = resizeAndCrop(rgb, width, height);
    expect(createHash('sha256').update(resized).digest('hex')).toBe(rgbSha256);
    expect(normalizePixels(resized)).toHaveLength(3 * 224 * 224);
  });
}
test('checks encoded image dimensions before allocating decoded pixels', async () => {
  const header = new Uint8Array(24);
  const view = new DataView(header.buffer);
  view.setUint32(0, 0x89504e47); view.setUint32(4, 0x0d0a1a0a);
  view.setUint32(16, 6000); view.setUint32(20, 5000);
  await expect(imageDimensions(new Blob([header]))).rejects.toThrow('24 megapixels');
  await expect(imageDimensions(new Blob(['invalid']))).rejects.toThrow('JPEG, PNG, or WebP');
});
