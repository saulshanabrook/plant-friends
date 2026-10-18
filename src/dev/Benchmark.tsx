import { useEffect, useState } from 'react';
import { createDiagnostics } from './api';

export function Benchmark() {
  const [status, setStatus] = useState('Ready for an explicit model installation.');
  const [report, setReport] = useState<unknown>(null);
  const [api] = useState(() => createDiagnostics(setStatus));
  useEffect(() => { window.plantFriends = api; return () => api.dispose(); }, [api]);
  async function run(action: () => Promise<unknown>) {
    try { setReport(await action()); }
    catch (error) { setStatus(error instanceof Error ? error.message : String(error)); throw error; }
  }
  return <main style={{ maxWidth: 900, padding: 24, margin: 'auto', fontFamily: 'system-ui' }}>
    <h1>Plant Friends · developer checks</h1>
    <p>Real BioCLIP 2 inference. PFAF coverage and physical phone support require separate evidence.</p>
    <p role="status">{status}</p>
    <p><button onClick={() => void run(() => api.install('pfaf')).catch(() => {})}>Install PFAF catalog</button>{' '}
      <button onClick={() => void run(() => api.install('bioclip2')).catch(() => {})}>Install prepared BioCLIP pack</button>{' '}
      <button onClick={() => void run(() => api.load()).catch(() => {})}>Load real model</button></p>
    <label>Run a local photo <input type="file" accept="image/jpeg,image/png,image/webp" onChange={event => {
      const photo = event.target.files?.[0];
      if (photo) void run(() => api.identifyPhoto(photo)).catch(() => {});
    }} /></label>
    <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{report ? JSON.stringify(report, null, 2) : ''}</pre>
  </main>;
}
