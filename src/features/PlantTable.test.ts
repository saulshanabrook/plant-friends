import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, test, vi } from 'vitest';
import type { CatalogEntry } from '../assets/manifest';
import { readAsset, type InstalledPack } from '../assets/storage';
import { asset, catalog } from '../../tests/assets/fixtures';
import { PlantTable } from './PlantTable';
import { loadPlantTableData, plantTablePage, type PlantTableOptions } from './plantTableData';

vi.mock('../assets/storage', () => ({ readAsset: vi.fn() }));

// Fabricated source records exercise real loading and table algorithms, with
// only the installed-cache boundary doubled. No model/GPU work is involved.
function tableFixture() {
  const entries: CatalogEntry[] = [
    { id: 'a', scientificName: 'Abelia triflora', commonName: 'Indian Abelia', detailFile: 'details-0.json' },
    { id: 'b', scientificName: 'Abies delavayi', commonName: '', detailFile: 'details-0.json' },
    { id: 'c', scientificName: 'Abelmoschus esculentus', commonName: 'Okra', detailFile: 'details-1.json' },
    { id: 'd', scientificName: 'Missing fields', commonName: '', detailFile: 'details-1.json' },
  ];
  const metadata: Record<string, Record<string, unknown>> = {
    a: { family: 'Caprifoliaceae', synonyms: 'Zabelia triflora', edibility_rating: 0, medicinal_rating: 5, other_uses_rating: null },
    b: { family: 'Pinaceae', edibility_rating: 3, medicinal_rating: 1, other_uses_rating: 2 },
    c: { family: 'Malvaceae', synonyms: 'Hibiscus esculentus', other_names: 'Gumbo', edibility_rating: 5, medicinal_rating: 3, other_uses_rating: 0 },
    d: { family: '', medicinal_rating: null, other_uses_rating: '' },
  };
  const records: Record<string, { id: string; sourceKey: string; fields: Record<string, unknown>; uses: unknown[] }> = Object.fromEntries(entries.map(entry => [entry.id, {
    id: entry.id, sourceKey: entry.scientificName,
    fields: { latin_name: entry.scientificName, summary: 'Source prose that the table must not retain.', ...metadata[entry.id] }, uses: [],
  }]));
  const bodies = new Map(['details-0.json', 'details-1.json'].map(file => [file,
    JSON.stringify(Object.fromEntries(entries.filter(entry => entry.detailFile === file).map(entry => [entry.id, records[entry.id]])))]));
  const manifest = catalog();
  manifest.taxonCount = entries.length;
  manifest.files = [asset('index.json', JSON.stringify(entries)), ...[...bodies].map(([file, body]) => asset(file, body))];
  const pack: InstalledPack = { manifest, manifestUrl: 'https://plants.test/catalog/manifest.json', installedAt: '2026-10-17T00:00:00Z', persistent: false };
  vi.mocked(readAsset).mockImplementation(async (_pack, file) => {
    const body = bodies.get(file.url);
    if (!body) throw new Error('Unexpected fixture cache read');
    return new Response(body);
  });
  return { entries, records, bodies, pack };
}

const options: PlantTableOptions = {
  query: '', family: '', minEdibility: null, minMedicinal: null, minOtherUses: null,
  sort: 'scientificName', descending: false, page: 0, pageSize: 50,
};

beforeEach(() => { vi.mocked(readAsset).mockReset(); });

test('loads shards sequentially, preserves zero/missing values, and retains only table metadata', async () => {
  const fixture = tableFixture();
  let release!: (response: Response) => void;
  vi.mocked(readAsset).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const loading = loadPlantTableData(fixture.entries, fixture.pack, new AbortController().signal);
  expect(readAsset).toHaveBeenCalledTimes(1);
  release(new Response(fixture.bodies.get('details-0.json')));
  const result = await loading;
  expect(vi.mocked(readAsset).mock.calls.map(([, file]) => file.url)).toEqual(['details-0.json', 'details-1.json']);
  expect(result.get('a')).toEqual({ family: 'Caprifoliaceae', searchText: 'abelia triflora\nindian abelia\nzabelia triflora\ncaprifoliaceae', edibility: 0, medicinal: 5, otherUses: null });
  expect(result.get('d')).toMatchObject({ family: null, edibility: null, medicinal: null, otherUses: null });
  expect(JSON.stringify([...result.values()])).not.toContain('Source prose');
  expect(result.size).toBe(fixture.entries.length);
});

test('abort during a read never starts another shard or publishes partial metadata', async () => {
  const fixture = tableFixture();
  let release!: (response: Response) => void;
  vi.mocked(readAsset).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const controller = new AbortController();
  const loading = loadPlantTableData(fixture.entries, fixture.pack, controller.signal);
  const rejected = expect(loading).rejects.toMatchObject({ name: 'AbortError' });
  controller.abort();
  release(new Response(fixture.bodies.get('details-0.json')));
  await rejected;
  expect(readAsset).toHaveBeenCalledTimes(1);
});

test('missing shards, missing records and malformed JSON produce explicit recovery errors', async () => {
  const fixture = tableFixture();
  const entries = fixture.entries.map(entry => ({ ...entry, detailFile: 'missing.json' }));
  await expect(loadPlantTableData(entries, fixture.pack, new AbortController().signal)).rejects.toThrow('file is missing. Reinstall');
  expect(readAsset).not.toHaveBeenCalled();
  vi.mocked(readAsset).mockResolvedValueOnce(new Response('{}'));
  await expect(loadPlantTableData(fixture.entries, fixture.pack, new AbortController().signal)).rejects.toThrow('record is incomplete. Reinstall');
  vi.mocked(readAsset).mockResolvedValueOnce(new Response('invalid JSON'));
  await expect(loadPlantTableData(fixture.entries, fixture.pack, new AbortController().signal)).rejects.toThrow('could not be read. Reinstall');
});

test('invalid ratings and different source identities cannot silently become useful metadata', async () => {
  const fixture = tableFixture();
  fixture.records.a.fields.edibility_rating = '3';
  vi.mocked(readAsset).mockResolvedValueOnce(new Response(JSON.stringify(fixture.records)));
  await expect(loadPlantTableData(fixture.entries, fixture.pack, new AbortController().signal)).rejects.toThrow('rating is invalid');
  fixture.records.a.fields.edibility_rating = 0;
  fixture.records.a.sourceKey = 'Different plant';
  vi.mocked(readAsset).mockResolvedValueOnce(new Response(JSON.stringify(fixture.records)));
  await expect(loadPlantTableData(fixture.entries, fixture.pack, new AbortController().signal)).rejects.toThrow('record is incomplete');
});

test('searches real synonyms/other names and combines family and rating filters across the full index', async () => {
  const fixture = tableFixture();
  const data = await loadPlantTableData(fixture.entries, fixture.pack, new AbortController().signal);
  expect(plantTablePage(fixture.entries, data, { ...options, query: 'ZABELIA' }).rows.map(row => row.id)).toEqual(['a']);
  expect(plantTablePage(fixture.entries, data, { ...options, query: 'Gumbo Hibiscus' }).rows.map(row => row.id)).toEqual(['c']);
  expect(plantTablePage(fixture.entries, data, { ...options, family: 'Malvaceae', minEdibility: 4, minMedicinal: 3, minOtherUses: 0 }).rows.map(row => row.id)).toEqual(['c']);
  expect(plantTablePage(fixture.entries, data, { ...options, minEdibility: 0 }).rows.map(row => row.id).sort()).toEqual(['a', 'b', 'c']);
  expect(plantTablePage(fixture.entries, data, { ...options, query: 'Unknown plant' })).toMatchObject({ total: 0, start: 0, end: 0, page: 0, pageCount: 0 });
});

test('zero sorts numerically and unavailable values stay last in both directions', async () => {
  const fixture = tableFixture();
  const data = await loadPlantTableData(fixture.entries, fixture.pack, new AbortController().signal);
  expect(plantTablePage(fixture.entries, data, { ...options, sort: 'edibility' }).rows.map(row => row.id)).toEqual(['a', 'b', 'c', 'd']);
  expect(plantTablePage(fixture.entries, data, { ...options, sort: 'edibility', descending: true }).rows.map(row => row.id)).toEqual(['c', 'b', 'a', 'd']);
  expect(plantTablePage(fixture.entries, data, { ...options, sort: 'otherUses' }).rows.map(row => row.id)).toEqual(['c', 'b', 'a', 'd']);
  expect(plantTablePage(fixture.entries, data, { ...options, sort: 'otherUses', descending: true }).rows.map(row => row.id)).toEqual(['b', 'c', 'a', 'd']);
  expect(plantTablePage(fixture.entries, data, { ...options, sort: 'commonName', descending: true }).rows.map(row => row.id)).toEqual(['c', 'a', 'b', 'd']);
  expect(fixture.entries.map(row => row.id)).toEqual(['a', 'b', 'c', 'd']);
});

test('pagination is bounded and clamps when filtering or catalog size reduces the number of pages', () => {
  const entries = Array.from({ length: 120 }, (_, i) => ({ id: String(i).padStart(3, '0'), scientificName: `Plant ${String(i).padStart(3, '0')}`, commonName: '', detailFile: 'fixture.json' }));
  const page = plantTablePage(entries, new Map(), { ...options, page: 999 });
  expect(page).toMatchObject({ page: 2, pageCount: 3, start: 101, end: 120, total: 120 });
  expect(page.rows).toHaveLength(20);
  expect(plantTablePage(entries, new Map(), { ...options, page: 2, query: 'Plant 001' })).toMatchObject({ page: 0, pageCount: 1, start: 1, end: 1 });
  const html = renderToStaticMarkup(createElement(PlantTable, { entries, catalog: null, onSelect: vi.fn() }));
  expect(html.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1].match(/<tr>/g)).toHaveLength(50);
  expect(html.match(/<th\b/g)).toHaveLength(7);
  expect(html).toContain('aria-sort="ascending"');
  expect(html).toContain('<fieldset disabled=""');
  expect(html).toContain('aria-label="Plant table pages"');
});

test('optional photos use the exact catalog ID and primary image without fuzzy name matching', () => {
  const { entries } = tableFixture();
  const photo = { url: '/plant-friends/photos/pack/files/flower.webp', sha256: 'a'.repeat(64), bytes: 100,
    width: 200, height: 100, sourceUrl: 'https://example.test/original.jpg', credit: 'Original raw credit' };
  const props = { entries, catalog: null, onSelect: vi.fn() };
  const without = renderToStaticMarkup(createElement(PlantTable, props));
  expect(without).not.toContain('<img');
  const html = renderToStaticMarkup(createElement(PlantTable, { ...props, photos: {
    a: [photo, { ...photo, url: '/second.webp' }],
    'Abies delavayi': [{ ...photo, url: '/wrong-name-key.webp' }],
  } }));
  expect(html.match(/<img\b/g)).toHaveLength(1);
  expect(html).toContain('src="/plant-friends/photos/pack/files/flower.webp"');
  expect(html).toContain('alt="Reference photo of Abelia triflora" width="64" height="32" loading="lazy"');
  expect(html).not.toContain('wrong-name-key');
  expect(html).not.toContain('/second.webp');
  expect(html).toContain('<button type="button">Abelia triflora</button>');
  expect(html.match(/<th\b/g)).toHaveLength(7);
});
