from __future__ import annotations

import numpy as np
import pytest
from numpy.typing import NDArray

from tools.plant_assets.diagnose_fp16 import normalized_scores


def test_diagnostic_scores_use_browser_fp32_normalization_and_fp64_accumulation() -> None:
    embedding = np.zeros(768, dtype=np.float32)
    embedding[:2] = [3, 4]
    vectors = np.zeros((2, 768), dtype=np.float32)
    vectors[0, :2] = [0.6, 0.8]
    vectors[1, 0] = 1
    normalized, scores = normalized_scores(embedding, vectors)
    np.testing.assert_array_equal(normalized[:2], np.asarray([0.6, 0.8], dtype=np.float32))
    assert normalized.dtype == np.float32
    assert scores[0] == float(np.float32(0.6)) ** 2 + float(np.float32(0.8)) ** 2
    assert scores[1] == float(np.float32(0.6))


@pytest.mark.parametrize("embedding", [
    np.zeros(768, dtype=np.float32), np.full(768, np.nan, dtype=np.float32), np.ones(767, dtype=np.float32),
])
def test_diagnostic_does_not_report_metrics_for_invalid_embeddings(embedding: NDArray[np.float32]) -> None:
    with pytest.raises(ValueError, match="nonzero|finite"):
        normalized_scores(embedding, np.ones((1, 768), dtype=np.float32))
