export interface Candidate { taxonId: string; similarity: number }

export function normalize(vector: Float32Array): Float32Array {
  let squared = 0;
  for (const value of vector) {
    if (!Number.isFinite(value)) throw new Error('The model returned a non-finite embedding.');
    squared += value * value;
  }
  const norm = Math.sqrt(squared);
  if (norm < 1e-12) throw new Error('The model returned an empty embedding.');
  return Float32Array.from(vector, value => value / norm);
}

export function rank(embedding: Float32Array, vectors: Float32Array, rows: string[], limit = 5): Candidate[] {
  if (vectors.length !== rows.length * embedding.length || new Set(rows).size !== rows.length)
    throw new Error('The catalog rows and vectors are incompatible.');
  const image = normalize(embedding);
  const results: Candidate[] = [];
  for (let row = 0; row < rows.length; row++) {
    let similarity = 0;
    for (let column = 0; column < image.length; column++) {
      const value = vectors[row * image.length + column];
      if (!Number.isFinite(value)) throw new Error('Invalid catalog vector. Reinstall the identification pack.');
      similarity += image[column] * value;
    }
    results.push({ taxonId: rows[row], similarity });
  }
  // Code-point order, independent of the device's language/collation settings.
  results.sort((a, b) => b.similarity - a.similarity || (a.taxonId < b.taxonId ? -1 : a.taxonId > b.taxonId ? 1 : 0));
  return results.slice(0, limit);
}
