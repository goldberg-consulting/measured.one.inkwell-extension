# Releasing the exact tested Inkwell candidate

The release workflows consume an existing VSIX. They never rebuild it during RC or final publication. `candidate.json` binds the release commit, extension version, VSIX SHA-256, and packaged `out/assets-manifest.json` SHA-256. The doctor output schema ships at `schemas/doctor.schema.json`.

Run workflows from the release commit itself, using its branch or tag in the Actions dispatch selector. Cross-run artifact consumers authenticate the producing workflow through GitHub's API and require the expected repository, source commit, trusted workflow, supported event, and successful completion. Pull-request artifacts remain useful review diagnostics but cannot authorize publication.

## Candidate checks

1. Run **Verify** on the intended commit. It builds one `inkwell-candidate` artifact. Linux and macOS consume those bytes for package identity, behavior, migrations, mocked installers, required offline preview, and real extension-host activation.
2. Its reusable demo job runs all ten documents through the packaged runtime, with one warmup and five measured repetitions on two independent runs. It also runs the real editor run/extract/edit/insert/PDF fixture and the warm-preview responsiveness measurement.
3. Supply a valid comparable baseline to the benchmark job before claiming its gate. A baseline containing an incomplete PDF is invalid. Missing baselines leave performance evidence absent; they never imply a waiver. The three retained measurement reports are recomputed during evidence aggregation.
4. Retain PDF parity, 0.4 upgrade and any remaining required evidence. Each record includes its actual report files and their hashes. The PDF parity gate requires all ten templates, normalized-style parity, a pinned toolchain fingerprint and raster results within 0.5% differing pixels at a 10/255 channel threshold.

Use `scripts/release-evidence.mjs record` only after the named probe succeeds. Passing summaries without required measurements are rejected. Platform-specific records must match both the producer and actual report platform.

## RC and installation checks

Run **Assemble release evidence** with stage `rc`, then **Publish immutable release candidate**, selecting the successful candidate and evidence run IDs. The RC URL uses the full release commit in its tag. Existing assets must compare byte-for-byte; replacement is prohibited.

Create the Homebrew candidate in its own review branch. Its cask must contain the exact immutable RC URL and checksum. Run **macOS installation journey** with that tap commit, release commit, RC URL and SHA-256. Scheduled runs require the corresponding `INKWELL_RC_COMMIT`, `INKWELL_RC_URL`, `INKWELL_RC_SHA256` and `INKWELL_RC_TAP_COMMIT` repository variables.

The installation workflow retains machine details, installer output, full doctor JSON, scaffold manifest and a real PDF for full MacTeX cask installation and standalone setup using existing TinyTeX. It verifies that standalone setup preserves the TeX root. It intentionally does not label its headless smoke as proof of the clean editor New Project/Preview journey. That independent UI evidence remains mandatory, along with 0.4 upgrade and file-preservation checks.

Supplemental evidence is downloaded from authenticated runs and selected by gate name, so artifact naming differences cannot omit reports or overwrite the base package/platform evidence. Missing gates, conflicting records and different candidate hashes stop aggregation.

## Final publication and completion

Assemble stage `publish` only after all installation and candidate gates pass. Dispatch **Release** for the exact version tag, candidate run and evidence run. It starts from the audited tap commit and permits only the validated RC-to-final URL/version/checksum change. A moved tap requires renewed evidence unless its complete tree already matches the intended final tree. Normal pushes preserve newer tap changes.

After publication, verify the canonical command on a clean profile:

```sh
brew install --cask goldberg-consulting/inkwell/inkwell
```

Retain public installation, reinstall, uninstall-preservation and final public-URL tap audit evidence for the same release commit and VSIX SHA-256. Assemble stage `complete`, then rerun **Release** with that evidence run. The release remains visibly pending until these final gates pass. Reruns reuse and compare public assets rather than replacing them.
