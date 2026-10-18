import { useEffect, useMemo, useState } from 'react';
import type { CatalogEntry } from '../assets/manifest';
import type { InstalledPack } from '../assets/storage';
import type { PlantPhoto } from '../assets/photos';
import { loadPlantTableData, plantTablePage, type PlantTableColumn, type PlantTableData } from './plantTableData';

export interface PlantTableProps {
  entries: CatalogEntry[];
  catalog: InstalledPack | null;
  onSelect: (entry: CatalogEntry) => void;
  photos?: Readonly<Record<string, readonly PlantPhoto[]>>;
}

const columns: { key: PlantTableColumn; label: string }[] = [
  { key: 'scientificName', label: 'Scientific name' }, { key: 'commonName', label: 'Common name' },
  { key: 'family', label: 'Family' }, { key: 'edibility', label: 'Edibility' },
  { key: 'medicinal', label: 'Medicinal' }, { key: 'otherUses', label: 'Other uses' },
];
const emptyData: ReadonlyMap<string, PlantTableData> = new Map();

export function PlantTable({ entries, catalog, onSelect, photos }: PlantTableProps) {
  const [query, setQuery] = useState('');
  const [family, setFamily] = useState('');
  const [minimums, setMinimums] = useState({ edibility: '', medicinal: '', otherUses: '' });
  const [sort, setSort] = useState<PlantTableColumn>('scientificName');
  const [descending, setDescending] = useState(false);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<25 | 50 | 100>(50);
  const [attempt, setAttempt] = useState(0);
  const [saved, setSaved] = useState<{
    catalog: InstalledPack; entries: CatalogEntry[]; data: ReadonlyMap<string, PlantTableData>;
    status: 'loading' | 'ready' | 'error'; error?: string;
  } | null>(null);
  const current = saved?.catalog === catalog && saved?.entries === entries ? saved : null;
  const ready = current?.status === 'ready';
  const data = ready ? current.data : emptyData;

  useEffect(() => {
    const controller = new AbortController();
    setFamily(''); setMinimums({ edibility: '', medicinal: '', otherUses: '' }); setPage(0);
    if (!catalog || !entries.length) { setSaved(null); return () => controller.abort(); }
    setSaved({ catalog, entries, data: emptyData, status: 'loading' });
    void loadPlantTableData(entries, catalog, controller.signal).then(data => {
      if (!controller.signal.aborted) setSaved({ catalog, entries, data, status: 'ready' });
    }).catch(error => {
      if (!controller.signal.aborted) setSaved({ catalog, entries, data: emptyData, status: 'error',
        error: error instanceof Error ? error.message : 'Plant data could not be opened. Reinstall the PFAF catalog.' });
    });
    return () => controller.abort();
  }, [catalog, entries, attempt]);

  const families = useMemo(() => [...new Set([...data.values()].flatMap(value => value.family ? [value.family] : []))]
    .sort((a, b) => a.localeCompare(b, 'en')), [data]);
  const result = useMemo(() => plantTablePage(entries, data, {
    query, family: ready ? family : '', minEdibility: ready && minimums.edibility !== '' ? Number(minimums.edibility) : null,
    minMedicinal: ready && minimums.medicinal !== '' ? Number(minimums.medicinal) : null,
    minOtherUses: ready && minimums.otherUses !== '' ? Number(minimums.otherUses) : null,
    sort, descending, page, pageSize,
  }), [entries, data, query, ready, family, minimums, sort, descending, page, pageSize]);

  return <section aria-label="Plant catalog">
    <label>Search plants <input type="search" value={query} onChange={event => { setQuery(event.target.value); setPage(0); }} /></label>
    {catalog && entries.length > 0 && !ready && current?.status !== 'error' && <p role="status">Loading plant data…</p>}
    {!catalog && <p>Install the PFAF catalog to load plant data.</p>}
    {current?.status === 'error' && <div role="alert"><p>{current.error}</p><button type="button" onClick={() => setAttempt(value => value + 1)}>Retry plant data</button></div>}
    <fieldset disabled={!ready}>
      <legend>Filter plants</legend>
      <label>Family <select value={family} onChange={event => { setFamily(event.target.value); setPage(0); }}>
        <option value="">All families</option>{families.map(value => <option key={value} value={value}>{value}</option>)}
      </select></label>{' '}
      {([{ key: 'edibility', label: 'Minimum edibility' }, { key: 'medicinal', label: 'Minimum medicinal' },
        { key: 'otherUses', label: 'Minimum other uses' }] as const).map(({ key, label }) => <label key={key}>{label}{' '}
          <select value={minimums[key]} onChange={event => { const value = event.target.value; setMinimums(previous => ({ ...previous, [key]: value })); setPage(0); }}>
            <option value="">Any rating</option>{[0, 1, 2, 3, 4, 5].map(value => <option key={value} value={value}>{value} / 5</option>)}
          </select>{' '}
        </label>)}
    </fieldset>
    <p role="status">Showing {result.start.toLocaleString()}–{result.end.toLocaleString()} of {result.total.toLocaleString()} plants{result.total !== entries.length && ` (${entries.length.toLocaleString()} in catalog)`}.</p>
    <div className="table-scroll">
      <table>
        <caption>PFAF plants. Use ratings are 0–5; — means unavailable.</caption>
        <thead><tr><th scope="col">Photo</th>{columns.map(column => <th key={column.key} scope="col" aria-sort={sort === column.key ? descending ? 'descending' : 'ascending' : undefined}>
          <button type="button" disabled={!ready && column.key !== 'scientificName' && column.key !== 'commonName'} onClick={() => {
            setDescending(sort === column.key ? !descending : false); setSort(column.key); setPage(0);
          }}>{column.label}{sort === column.key ? descending ? ' ↓' : ' ↑' : ''}</button>
        </th>)}</tr></thead>
        <tbody>{result.rows.map(entry => {
          const plant = data.get(entry.id);
          const photo = photos?.[entry.id]?.[0];
          return <tr key={entry.id}>
            <td>{photo ? <img src={photo.url} alt={`Reference photo of ${entry.scientificName}`} width={64}
              height={Math.max(1, Math.round(64 * photo.height / photo.width))} loading="lazy" /> : '—'}</td>
            <td><button type="button" onClick={() => onSelect(entry)}>{entry.scientificName}</button></td>
            <td>{entry.commonName || '—'}</td>
            <td>{ready ? plant?.family ?? '—' : '…'}</td>
            <td>{ready ? plant?.edibility ?? '—' : '…'}</td>
            <td>{ready ? plant?.medicinal ?? '—' : '…'}</td>
            <td>{ready ? plant?.otherUses ?? '—' : '…'}</td>
          </tr>;
        })}{result.rows.length === 0 && <tr><td colSpan={7}>No matching plants.</td></tr>}</tbody>
      </table>
    </div>
    <nav aria-label="Plant table pages">
      <button type="button" disabled={result.page === 0} onClick={() => setPage(0)}>First</button>{' '}
      <button type="button" disabled={result.page === 0} onClick={() => setPage(result.page - 1)}>Previous</button>{' '}
      <span>Page {result.pageCount ? result.page + 1 : 0} of {result.pageCount}</span>{' '}
      <button type="button" disabled={result.page + 1 >= result.pageCount} onClick={() => setPage(result.page + 1)}>Next</button>{' '}
      <button type="button" disabled={result.page + 1 >= result.pageCount} onClick={() => setPage(result.pageCount - 1)}>Last</button>{' '}
      <label>Rows per page <select value={pageSize} onChange={event => { setPageSize(Number(event.target.value) as 25 | 50 | 100); setPage(0); }}>
        {[25, 50, 100].map(value => <option key={value} value={value}>{value}</option>)}
      </select></label>
    </nav>
  </section>;
}
