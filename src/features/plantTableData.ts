import type { CatalogEntry } from '../assets/manifest';
import { readAsset, type InstalledPack } from '../assets/storage';

export interface PlantTableData {
  family: string | null;
  searchText: string;
  edibility: number | null;
  medicinal: number | null;
  otherUses: number | null;
}
export type PlantTableColumn = 'scientificName' | 'commonName' | 'family' | 'edibility' | 'medicinal' | 'otherUses';
export interface PlantTableOptions {
  query: string;
  family: string;
  minEdibility: number | null;
  minMedicinal: number | null;
  minOtherUses: number | null;
  sort: PlantTableColumn;
  descending: boolean;
  page: number;
  pageSize: 25 | 50 | 100;
}

const collator = new Intl.Collator('en', { sensitivity: 'base' });

/** Read one bounded installed shard at a time; retain no full plant records. */
export async function loadPlantTableData(entries: CatalogEntry[], catalog: InstalledPack, signal: AbortSignal): Promise<Map<string, PlantTableData>> {
  if (catalog.manifest.kind !== 'pfaf' || entries.length !== catalog.manifest.taxonCount || new Set(entries.map(entry => entry.id)).size !== entries.length)
    throw new Error('The saved catalog index is incomplete. Reinstall the PFAF catalog.');
  const groups = new Map<string, CatalogEntry[]>();
  for (const entry of entries) {
    const group = groups.get(entry.detailFile);
    if (group) group.push(entry); else groups.set(entry.detailFile, [entry]);
  }
  const result = new Map<string, PlantTableData>();
  for (const [filename, group] of groups) {
    signal.throwIfAborted();
    const file = catalog.manifest.files.find(file => file.url === filename);
    if (!file) throw new Error('A saved plant data file is missing. Reinstall the PFAF catalog.');
    const response = await readAsset(catalog, file);
    signal.throwIfAborted();
    const records = await response.json().catch(() => { throw new Error('Saved plant data could not be read. Reinstall the PFAF catalog.'); }) as unknown;
    signal.throwIfAborted();
    if (!records || typeof records !== 'object' || Array.isArray(records))
      throw new Error('Saved plant data is invalid. Reinstall the PFAF catalog.');
    for (const entry of group) {
      const record = (records as Record<string, unknown>)[entry.id];
      if (!record || typeof record !== 'object' || Array.isArray(record) ||
          !('id' in record) || record.id !== entry.id || !('sourceKey' in record) || record.sourceKey !== entry.scientificName ||
          !('fields' in record) || !record.fields || typeof record.fields !== 'object' || Array.isArray(record.fields))
        throw new Error('A saved plant record is incomplete. Reinstall the PFAF catalog.');
      const fields = record.fields as Record<string, unknown>;
      const metadata: PlantTableData = { family: null, searchText: '', edibility: null, medicinal: null, otherUses: null };
      for (const [source, target] of [['edibility_rating', 'edibility'], ['medicinal_rating', 'medicinal'], ['other_uses_rating', 'otherUses']] as const) {
        const value = fields[source];
        if (value === null || value === undefined || value === '') continue;
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 5)
          throw new Error('A saved plant rating is invalid. Reinstall the PFAF catalog.');
        metadata[target] = value;
      }
      for (const key of ['family', 'synonyms', 'other_names']) {
        if (fields[key] !== null && fields[key] !== undefined && typeof fields[key] !== 'string')
          throw new Error('Saved plant names or family are invalid. Reinstall the PFAF catalog.');
      }
      metadata.family = typeof fields.family === 'string' && fields.family.trim() ? fields.family.trim() : null;
      metadata.searchText = [entry.scientificName, entry.commonName, fields.synonyms, fields.other_names, metadata.family]
        .filter(value => typeof value === 'string').join('\n').normalize('NFKC').toLocaleLowerCase('en');
      result.set(entry.id, metadata);
    }
  }
  return result;
}

/** Filter/sort the entire local index before slicing a bounded display page. */
export function plantTablePage(entries: CatalogEntry[], metadata: ReadonlyMap<string, PlantTableData>, options: PlantTableOptions) {
  const terms = options.query.trim().normalize('NFKC').toLocaleLowerCase('en').split(/\s+/).filter(Boolean);
  const filtered = entries.filter(entry => {
    const data = metadata.get(entry.id);
    const names = data?.searchText ?? `${entry.scientificName}\n${entry.commonName}`.normalize('NFKC').toLocaleLowerCase('en');
    return terms.every(term => names.includes(term)) && (!options.family || data?.family === options.family) &&
      (options.minEdibility === null || (data?.edibility !== null && data?.edibility !== undefined && data.edibility >= options.minEdibility)) &&
      (options.minMedicinal === null || (data?.medicinal !== null && data?.medicinal !== undefined && data.medicinal >= options.minMedicinal)) &&
      (options.minOtherUses === null || (data?.otherUses !== null && data?.otherUses !== undefined && data.otherUses >= options.minOtherUses));
  });
  filtered.sort((a, b) => {
    const av = options.sort === 'scientificName' || options.sort === 'commonName' ? a[options.sort].trim() || null : metadata.get(a.id)?.[options.sort] ?? null;
    const bv = options.sort === 'scientificName' || options.sort === 'commonName' ? b[options.sort].trim() || null : metadata.get(b.id)?.[options.sort] ?? null;
    // Missing values stay last in either direction; real zero remains numeric.
    if (av === null && bv !== null) return 1;
    if (bv === null && av !== null) return -1;
    const comparison = av === null || bv === null ? 0 : typeof av === 'number' && typeof bv === 'number' ? av - bv : collator.compare(String(av), String(bv));
    return comparison ? comparison * (options.descending ? -1 : 1) : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const pageCount = Math.ceil(filtered.length / options.pageSize);
  const page = Math.max(0, Math.min(options.page, Math.max(0, pageCount - 1)));
  const rows = filtered.slice(page * options.pageSize, (page + 1) * options.pageSize);
  return { rows, total: filtered.length, page, pageCount, start: rows.length ? page * options.pageSize + 1 : 0, end: page * options.pageSize + rows.length };
}
