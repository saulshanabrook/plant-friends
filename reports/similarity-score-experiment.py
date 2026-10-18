"""Re-score saved FP32 fixtures; no model execution or network. Run from repo root."""
import hashlib
import json
from pathlib import Path

import numpy as np

root = Path(__file__).resolve().parents[1]
reference = json.loads((root / 'reports/python-reference.json').read_text())
pointer = json.loads((root / 'public/model.json').read_text())
manifest_path = root / 'public' / pointer['url']
manifest = json.loads(manifest_path.read_text())
assert manifest['id'] == reference['packId']
receipts = {f['url']: f for f in manifest['files']}
inputs = {}
for name in ['vectors.f32', 'rows.json']:
    data = (manifest_path.parent / name).read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    assert digest == receipts[name]['sha256']
    inputs[name] = digest
rows = json.loads((manifest_path.parent / 'rows.json').read_text())
vectors = np.fromfile(manifest_path.parent / 'vectors.f32', dtype='<f4').reshape(len(rows), 768).astype(np.float64)
assert np.max(np.abs(np.linalg.norm(vectors, axis=1) - 1)) < 1e-5
samples = []
for sample in reference['samples']:
    path = root / 'public/fixtures/reference' / sample['embeddingUrl']
    data = path.read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    assert digest == sample['embeddingFile']['sha256']
    embedding = np.frombuffer(data, dtype='<f4').astype(np.float64)
    cosine = vectors @ (embedding / np.linalg.norm(embedding))
    order = sorted(range(len(rows)), key=lambda i: (-cosine[i], rows[i]))[:5]
    assert rows[order[0]] == sample['pythonTopFive'][0]['taxonId']
    assert abs(cosine[order[0]] - sample['pythonTopFive'][0]['similarity']) < 1e-5
    shifted = cosine - cosine.max()
    weights = np.exp(100 * shifted)
    full = weights / weights.sum()
    restricted = weights[order] / weights[order].sum()
    mcm_weights = np.exp(shifted)
    samples.append({
        'id': sample['id'], 'embeddingSha256': digest,
        'topFive': [{'taxonId': rows[i], 'cosine': float(cosine[i]), 'fullCatalogSoftmaxScale100': float(full[i]), 'topFiveOnlySoftmaxScale100': float(restricted[j])} for j, i in enumerate(order)],
        'cosineMargin': float(cosine[order[0]] - cosine[order[1]]),
        'topFiveMassFullCatalogScale100': float(full[order].sum()),
        'mcmStyleMaximumCosineSoftmaxTau1': float(mcm_weights.max() / mcm_weights.sum()),
    })
result = {
    'scope': 'Descriptive math using ten existing numerical/pipeline fixtures and saved FP32 embeddings; no calibration, new inference, OOD benchmark or probability-of-correctness claim. Some fixtures are synthetic; landscape/webp share an identical embedding.',
    'packId': manifest['id'], 'catalogId': reference['catalogId'], 'candidateCount': len(rows),
    'arithmetic': 'float64 analytic re-scoring of stored float32 vectors/embeddings; normalized image; scale100 approximation to pinned checkpoint scalar',
    'inputSha256': inputs, 'samples': samples,
}
(root / 'reports/similarity-score-experiment.json').write_text(json.dumps(result, indent=2) + '\n')
for s in samples:
    top = s['topFive'][0]
    print(s['id'], top['taxonId'], 'cosine', round(top['cosine'], 4), 'full', round(top['fullCatalogSoftmaxScale100'], 4), 'top5-only', round(top['topFiveOnlySoftmaxScale100'], 4))
