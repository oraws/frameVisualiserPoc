# Supplier-matched material quality pipeline

This stage runs after the standard Mainline material build. It creates a separate
`supplier-matched-v4-candidate` variant and never changes the visualiser's active
material index.

It checks each candidate against all available supplier views for:

- perceptual colour and colour variation;
- texture detail and physical-looking scale;
- atlas-boundary seams and repeated patterns;
- clipped blacks, whites and overprocessed contrast;
- roughness and relief in one fixed, neutral lighting preview.

When a local Ollama vision model is available, three bounded roles supplement
the hard checks: a reference analyst, a candidate critic on every attempt, and a
final sales-quality reviewer. The model can adjust parameters between attempts,
but cannot bypass a failed numerical gate or promote a material. Four attempts
are made by default and the best result is retained for review.

```bash
# Build one SKU and let the pipeline choose an installed vision model.
npm run materials:quality -- --sku POL-4100

# Choose the local model explicitly.
npm run materials:quality -- --sku POL-4100 --ollama-model qwen3-vl:30b

# Run deterministic QA without Ollama.
npm run materials:quality -- --sku POL-4100 --no-ollama

# Process every existing supplier-derived material candidate.
npm run materials:quality
```

Each output contains the final PBR maps, a supplier comparison board,
`material-diagnostic.jpg`, every attempted candidate, and `quality-report.json`.
The status is either `automated-approved-candidate` or `human-review-required`.
Approval in the live visualiser remains the final step before a candidate is
added to a runtime material index.

## Visualiser workflow

Choose a moulding in **Frame detail**, then select **Review selected frame with
Ollama** or open the **Ollama review** presentation tab. Select any installed
vision model and add the **Profile**, **Texture & colour**, or both prompt blocks.
The combined prompt remains editable before it is sent. The local server reports the selected model, progress,
attempt history, numerical gates, model observations, and final confidence. On
completion the visualiser loads the new candidate maps with a fresh cache key,
and loads a generated profile cross-section when profile review was requested,
so the frame changes without a page reload. Profile geometry is constrained by
supplier dimensions and explicit catalogue labels before the vision model checks
the comparison board. A failed final review remains
clearly marked for inspection even though its candidate can be viewed.

Installed Qwen 3.8 vision variants are supported and take precedence as the
default selection. The server checks Ollama's reported model capabilities before
showing a candidate in the selector.
