# PDF raster regression baselines

The platform folders contain PNG pages and `baseline.json` toolchain records.
Normal comparisons never change them. Every page is rendered at 120 dpi; a page
passes when at most 0.5% of pixels differ by more than 10/255 in any RGB channel.
Page-count and size changes fail. Fonts, TeX packages, engine version, Pandoc,
renderer, and platform must match the recorded baseline before pixels can pass.

The initial macOS ARM baselines cover the demo templates and the physical
typography, table, and reference fixtures. They are regression references, not
proof that another platform or a release installation has passed. A missing or
different platform/toolchain requires a separate deliberate recording and review.

Run `scripts/check-raster-goldens.py` with `--manifest`, `--goldens`, `--output`,
`--artifact-sha256`, and `--extension-root` pointing to the verified extracted
VSIX. Each manifest entry names `id`, `template`, `pdfPath`, `logPath`, and,
when needed, `flsPath`. Supply the actual TeX or Python plotting font directories
with repeated `--font-dir` arguments. The renderer needs Pillow, PyMuPDF, Pandoc,
and Poppler's `pdftoppm`; `--pdftoppm` selects the renderer explicitly.

For intentional updates, add both `--record` and `--allow-baseline-write`.
Inspect every rendered page and the retained before/after/difference sheets in
the output directory before committing. A successful recording still reports
`requiresVisualReview: true`; it does not automatically approve its own output.

The real PDF tests can drive this check directly with `INKWELL_PDF_GOLDENS=check`,
`INKWELL_PDF_ASSET_ROOT`, `INKWELL_PDF_ARTIFACT_SHA256`, and
`INKWELL_PDF_FONT_DIRS` (path-separated directories). Recording additionally
requires `INKWELL_PDF_GOLDENS=record` and `INKWELL_PDF_GOLDENS_ALLOW_RECORD=1`.
All compile attempts and comparison evidence stay in disposable directories.
