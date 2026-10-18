import { useEffect, useRef, useState } from 'react';
import type { PlantPhoto } from '../assets/photos';
import type { CatalogEntry, PlantRecord } from '../assets/manifest';
import { readAsset, type InstalledPack } from '../assets/storage';

export function PlantDetails({ entry, catalog, photos, onClose }: { entry: CatalogEntry; catalog: InstalledPack; photos?: PlantPhoto[]; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [record, setRecord] = useState<PlantRecord | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);

  useEffect(() => {
    let current = true;
    setRecord(null); setError(null);
    void (async () => {
      try {
        const file = catalog.manifest.files.find(file => file.url === entry.detailFile);
        if (!file) throw new Error('This plant’s detail file is missing. Reinstall the PFAF catalog.');
        const records = await (await readAsset(catalog, file)).json() as Record<string, PlantRecord>;
        const plant = records[entry.id];
        if (!plant || plant.id !== entry.id || !plant.fields || !Array.isArray(plant.uses))
          throw new Error('This plant’s saved record is incomplete. Reinstall the PFAF catalog.');
        if (current) setRecord(plant);
      } catch (failure) {
        if (current) setError(failure instanceof Error ? failure.message : 'The plant details could not be opened. Reinstall the PFAF catalog.');
      }
    })();
    return () => { current = false; };
  }, [entry, catalog]);

  function closeRecord() {
    // Close while connected so the browser restores focus before React removes it.
    dialog.current?.close();
    onClose();
  }

  const fields = record?.fields;
  let sourceUrl: string | null = null;
  if (fields?.source_url) {
    try {
      const url = new URL(String(fields.source_url));
      if (url.protocol === 'https:' || url.protocol === 'http:') sourceUrl = url.href;
    } catch { /* A malformed recorded URL is never offered as a link. */ }
  }
  const manifest = catalog.manifest.kind === 'pfaf' ? catalog.manifest : null;

  return <dialog className="plant-dialog" ref={dialog} onCancel={event => { event.preventDefault(); closeRecord(); }} onClick={event => { if (event.target === event.currentTarget) closeRecord(); }} aria-labelledby="plant-title">
    <article className="plant-detail">
      <header className="detail-heading">
        <h2 id="plant-title">{entry.scientificName}</h2>
        <button onClick={closeRecord}>Close plant details</button>
      </header>
      {!fields && !error && <p className="status-message" role="status">Opening saved plant details…</p>}
      {error && <p className="error-message" role="alert">{error}</p>}
      {fields && <>
        <p>A catalog record does not confirm identity or safety.</p>
        <section className="hazard-panel"><h3>Known hazards</h3><p className="source-text">{fields.known_hazards === null || fields.known_hazards === undefined || fields.known_hazards === '' ? 'Information unavailable in this record.' : fields.known_hazards}</p></section>
        <section className="reference-gallery" aria-label="Reference photos"><h3>Reference photos</h3>
          {photos ? photos.length ? photos.map((photo, position) => <figure key={`${photo.url}:${position}`}>
            <img src={photo.url} alt={`Reference photo ${position + 1} of ${entry.scientificName}`} width={photo.width} height={photo.height} loading="lazy" decoding="async" />
            <figcaption><span className="source-text">{photo.credit ?? 'Credit not recorded.'}</span>{' '}<a href={photo.sourceUrl} target="_blank" rel="noreferrer">Original photo source</a></figcaption>
          </figure>) : <p>No reference photos recorded for this plant.</p> : <p>Reference photos are not available yet.</p>}
        </section>
        <dl className="ratings">{[
          { key: 'edibility_rating', label: 'Edibility' },
          { key: 'medicinal_rating', label: 'Medicinal' },
          { key: 'other_uses_rating', label: 'Other uses' },
        ].map(({ key, label }) => <div key={key}><dt>{label} rating</dt><dd>{fields[key] === null || fields[key] === undefined || fields[key] === '' ? <span className="rating-missing">Unavailable</span> : <>{fields[key]}<span> / 5</span></>}</dd></div>)}</dl>
        <p>PFAF use ratings, not identification confidence or safety.</p>
        <section className="detail-section"><h3>Names</h3><dl className="facts-grid">
          <div><dt>Scientific name</dt><dd>{fields.latin_name || record?.sourceKey}</dd></div>
          <div><dt>Common name</dt><dd>{fields.common_name || 'Unavailable'}</dd></div>
          <div><dt>Family</dt><dd>{fields.family || 'Unavailable'}</dd></div>
          <div><dt>Other names</dt><dd>{fields.other_names || 'Unavailable'}</dd></div>
          <div><dt>Synonyms</dt><dd>{fields.synonyms || 'Unavailable'}</dd></div>
        </dl></section>
        {[
          { key: 'edible_uses', title: 'Edible uses' },
          { key: 'medicinal_uses', title: 'Medicinal uses' },
          { key: 'other_uses', title: 'Other uses' },
        ].map(({ key, title }) => <section className="detail-section" key={key}><h3>{title}</h3><p className="source-text">{fields[key] === null || fields[key] === undefined || fields[key] === '' ? 'Information unavailable in this record.' : fields[key]}</p></section>)}
        {!!record?.uses.length && <section className="detail-section"><h3>Indexed uses</h3><ul className="indexed-uses">{record.uses.map(use => <li key={`${use.category}:${use.name}`}><strong>{use.name}</strong> <span className="muted">({use.category})</span>{use.description && <p className="source-text">{use.description}</p>}</li>)}</ul></section>}
        <details className="more-details"><summary>More from this record</summary>{[
          { key: 'summary', title: 'Summary' }, { key: 'physical_characteristics', title: 'Physical characteristics' },
          { key: 'habitats', title: 'Habitats' }, { key: 'native_range', title: 'Native range' },
          { key: 'range', title: 'Range' }, { key: 'cultivation_details', title: 'Cultivation' },
          { key: 'propagation', title: 'Propagation' }, { key: 'conservation_status', title: 'Conservation status' },
          { key: 'botanical_references', title: 'Botanical references' },
        ].map(({ key, title }) => fields[key] !== null && fields[key] !== undefined && fields[key] !== ''
          ? <section className="detail-section" key={key}><h4>{title}</h4><p className="source-text">{fields[key]}</p></section> : null)}</details>
        <details className="source-note"><summary>Source and freshness</summary>
          <p>{manifest?.attribution ?? 'Plants For A Future (PFAF)'}</p>
          <p>Record refresh: {fields.details_scraped_at ? String(fields.details_scraped_at) : 'unknown; the source did not record a refresh date.'}</p>
          <p>Catalog exported: {manifest?.exportedAt ?? 'unavailable'}. The export date does not establish when this plant’s information was reviewed.</p>
          <p>Bracketed reference markers are retained as recorded. Full reference sources may need an internet connection.</p>
          <div className="inline-links">{sourceUrl ? <a href={sourceUrl} target="_blank" rel="noreferrer">Recorded PFAF page</a> : <span>Recorded source page unavailable</span>}{manifest && <a href={manifest.termsUrl} target="_blank" rel="noreferrer">PFAF terms & attribution</a>}</div>
        </details>
      </>}
      <button className="button secondary detail-close" onClick={closeRecord}>Close record</button>
    </article>
  </dialog>;
}
