import { expect, test } from 'vitest';
import { normalize, rank } from './scoring';

test('cosine ranking normalizes image vectors and breaks ties by stable ID', () => {
  expect(rank(new Float32Array([3, 0]), new Float32Array([0, 1, 1, 0, 1, 0]), ['c', 'b', 'a']))
    .toEqual([{ taxonId: 'a', similarity: 1 }, { taxonId: 'b', similarity: 1 }, { taxonId: 'c', similarity: 0 }]);
});
test('rejects corrupt embeddings and incompatible mappings', () => {
  expect(() => normalize(new Float32Array([0, 0]))).toThrow('empty');
  expect(() => normalize(new Float32Array([NaN]))).toThrow('non-finite');
  expect(() => rank(new Float32Array([1, 0]), new Float32Array([1]), ['a'])).toThrow('incompatible');
});
