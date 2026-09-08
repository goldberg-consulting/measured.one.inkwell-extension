# Reliability baseline

`phase0-baseline.json` records three runs of the ten committed demos using the
unmodified compiler and runner from `cb0a8d54a746448b1325bd9235435c076f3be0c2`.
The harness seeded the shipped example scripts and bibliography, including the
missing Fourier entry. Every project, run, and PDF was created in a temporary
directory. Local edits to the RMxAA demo were preserved and excluded from this
committed-source corpus.

The baseline exposes a previously hidden failure: the Python report produced a
partial PDF after `breaklines undefined`, and the old compiler reported success.
Its timing must not be treated as a successful-build performance target.
`phase1-validation.json` records all ten demos successfully running and compiling
with zero unresolved references and the expected PDF text after the safety fixes.

The records separate compiler wall time, child-process TeX passes, Pandoc,
planning/staging/publication overhead, code runs, citation rendering, preview
rendering, and PDF payload preparation. Machine details and corpus hashes are
included. Module load time is explicitly a proxy, not full extension-host
activation. Browser page painting and the mutating legacy activation doctor were
not run by this headless baseline; real-host measurements remain a release gate.

Run `npm run test:demos -- --repetitions=3 --report=benchmarks/current.json` with
Pandoc, the template engines, pandoc-crossref, and Python with matplotlib, numpy,
and pypdf available. `INKWELL_TEST_PYTHON` selects the Python environment;
`INKWELL_PDF_PYTHON` optionally selects a separate PDF-text extraction interpreter.
For local verification that preserves edited examples, add `--committed-examples`.
CI uses the checked-out examples directly. The report fails on process errors,
unresolved final references, missing expected text, or unsuccessful code runs.

The warning allowlist is empty. Every future exception must name one demo, an
exact warning pattern, and a reason. First-pass TeX warnings are expected during
reference convergence; Pandoc warnings, final TeX warnings, and compiler
diagnostics for unresolved computed values are judged.

Baseline safety reproductions were run before source edits: six PDF-publication,
eight runner, three preview, and three Python/scaffold regressions failed. Further
review added revision coalescing, process descendants, symlink source identity,
index-dependent scripts, and clearing during active multi-block runs.

Phase 4 adds `phase4-validation.json` (all ten committed demos, zero unresolved
references) and `phase4-typography.json` (six real Default/ETH PDFs at 10/11/12 pt).
The typography report compares extracted font faces, point sizes, RGB heading
color, and baseline positions with the shared style model. It also checks a
separate template-layout table sentinel. Installed test fonts are Times New
Roman, Arial, and Courier New; Linux font portability and actual browser font
loading remain separate release gates. To rerun the PDF fixture on a configured
machine, set `INKWELL_TYPOGRAPHY_PDF=1` and `INKWELL_PDF_PYTHON` to an interpreter
with PyMuPDF before running `tests/typography-pdf.test.cjs`.

The viewer suite runs the shipped bundled client and its state modules.
`INKWELL_CHROME_BIN` enables a real headless browser check with a temporary profile
for PDF fit resizing and reachable page edges at high zoom. It never opens the
user's normal browser profile or fetches external preview scripts.

## Release measurements

`release-baseline.json` repeats the frozen Phase 0 compiler on the current corpus
using one unmeasured warmup and five measured iterations. Machine, runtime, source,
script, and bibliography identities must match subsequent comparisons. Its Python
report still produces an incomplete PDF, so this baseline cannot silently satisfy
the release performance gate. The report preserves that failure explicitly.

`scripts/check-demos.cjs --vsix-root=/extracted/extension --vsix=/candidate.vsix`
uses the packaged compiler and runner in one process. Every extracted archive
entry is verified before and after the runs. Add `--warmups=1 --repetitions=5` and
run the experiment twice, without other substantial CPU work. Both reports must
identify the same VSIX. Environment preparation happens before timing begins.
The Python fixture environment is copied into the temporary project to obey the
same containment rules as user projects.

The packaged authoring planner now persists missing block IDs in disposable demo
copies before execution, matching the editor workflow. Reports retain both the
original corpus hashes and the prepared-source hashes. Repository documents are
never modified by the harness.

`phase8-packaged-run1.json`, `phase8-packaged-run2.json`, and
`phase8-performance.json` are historical diagnostic measurements, not current
release evidence. Their harness missed unresolved compiler binding warnings and
did not persist anonymous run IDs. Visual review also found missing exports in
the seeded scatter example and raw Markdown inside the book's full-width TeX
example. Correcting these inputs changes the corpus. The original Phase 0 report
remains unchanged; a valid current performance comparison is still required.

`scripts/check-benchmark-regression.mjs` takes `--baseline=`, `--candidate=`,
`--confirmation=`, and `--report=` paths. Both corpus medians must improve by at
least 30 percent. A per-demo regression above 10 percent fails when confirmed on
both runs. Missing samples, differing machines/runtimes/corpora, incomplete PDFs,
or mismatched artifacts block the result. A failed baseline needs an explicit
release decision and follow-up; the comparison never invents a waiver.

Actual editor activation and warm preview responsiveness have a separate harness
in `scripts/check-extension-host.cjs`. Its report distinguishes synchronous
callback duration from timer lag. Offline browser counters come from
`tests/offline-preview.test.cjs`, with `INKWELL_PREVIEW_ASSET_ROOT` set to the
verified extracted VSIX. These measurements are not substitutes for one another.
