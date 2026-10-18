# Claude Fable consultation: similarity and abstention

An actual subprocess completed successfully during the 2026-10-17 research session. The CLI model alias `fable` resolved to **`claude-fable-5-1`**, as reported by its initialization event. This is advisory review; the subprocess had no browsing or other tools, and explicitly distinguished supplied facts from remembered literature. No user photographs or credentials were included.

Invocation used `claude -p --model fable --effort max --output-format json --no-session-persistence --safe-mode --tools '' --strict-mcp-config --mcp-config '{"mcpServers":{}}' --permission-mode dontAsk --permission-prompts none`, with the prompt supplied on stdin. The prompt included current cosine/prompt math, 8,796-label catalog limitations, pinned model/scale, existing positive/negative examples, actual library behavior and the primary literature list. It asked for precise minimal presentation, alternatives for unknown rejection, validation gates, and criticism of tempting shortcuts. Raw process events are local scratch, not published research evidence.

Recommendations considered useful:

- Prefer five ranked suggestions with equal visual treatment; omit default numbers, percentage bars, tiers and acceptance highlighting until supported.
- Treat similarity, closed-catalog softmax and correctness probability as different quantities. Do not normalize just the displayed five.
- Resolve botanical concepts and synonym mappings before interpreting row-level margins or summing taxonomic probabilities.
- Compare an expanded vocabulary of absent plant names and non-plant distractors against simpler scores. This gives excluded plants competitors beyond PFAF; success on hard relatives remains an experiment, not a result.
- Use grouped held-out observations, explicit near-relative negatives, risk–coverage and uncertainty intervals before an abstention rule. Evaluate the shipped preprocessing/vector/ONNX pipeline.

Corrections made during independent review:

- A single incorrect high-softmax result does not alone establish statistical miscalibration; it shows a high score can still be wrong. Calibration requires groups of outcomes.
- Hybrid/cultivar distinctions cannot be discarded categorically. Their observability and correct mapping require botanical decisions and validation.
- Higher-rank summation does not automatically repair duplicate/synonymous leaf labels; define non-duplicated botanical events first.
- Distribution shift is a threat to exchangeability, not proof that every future phone photo violates it. Conformal coverage remains conditional on the relevant assumptions and label universe.
- Contrastive cross-entropy depends on logit magnitudes, not just ordering. Its scale still is not a fitted PFAF calibration temperature.
- MCM's inspected code uses cosine/τ with default τ=1; it is not the checkpoint-scale softmax. Existing research includes semantically difficult OOD experiments, so calling it only far-OOD evidence would overstate the limitation. Local hard-relative tests are still missing.
- Suggested sample counts and a prediction that negative-name expansion will win were judgments, not established evidence. Quantization and automatic taxonomy collapsing were not authorized by this research and were not implemented.

The resulting recommendation, exact source equations, reproducible calculations and proposed evaluation are in [the synthesis](similarity-research.md) and [official-model source review](bioclip2-similarity-sources.md). This consultation did not alter the model, ranking, cutoffs or score display.
