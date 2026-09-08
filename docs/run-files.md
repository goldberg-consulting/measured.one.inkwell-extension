# Editable code and verified run output

Use **Inkwell: Extract Code Block to Script** on a runnable fence to move its source into a language-specific file under `.inkwell/scripts/`. Inkwell adds or preserves a stable block identity and changes the fence through an ordinary editor transaction. The script is user-owned source: keep it in version control and edit it directly. **Inkwell: Open Run Script** opens the file associated with a fence.

An extracted fence looks like this:

````markdown
```{python id="analysis" file=".inkwell/scripts/analysis.py" output="summary" inputs="data/input.csv,src/helper.py" depends-on="prepare-data"}
```
````

The external file is the source used for execution. Inkwell preserves display, output, caption, label, inputs, and dependency attributes during extraction. Failed source creation or an unsuccessful editor transaction leaves the document unchanged. Opening the new editor is a separate navigation step after extraction commits.

Before running, save external scripts and declared inputs. Inkwell rejects a run when a selected source script or a dependency script has unsaved changes; this prevents execution of an older disk copy. The Markdown document is saved and verified after any automatic identity edit. Untitled or read-only documents cannot publish persistent run output through the editor commands.

## Block identity and commands

IDs start with a letter, contain only letters, digits, `_`, and `-`, and have at most 64 characters. A valid, unique existing `label=` may serve as the identity. On the first run, Inkwell inserts missing IDs directly into editable fences before saving. Invalid or duplicate identities produce diagnostics on every conflicting fence and block execution.

Use **Run This Block** to run a selected fence and its dependencies, **Run Changed Blocks** to run stale blocks, or the existing **Run Code Blocks** command for the document. Unchanged cached blocks do not execute their source again. **Show Current Run Details** opens the verified manifest and identifies whether the last successful output still matches the current source and inputs. Failed attempts and their logs remain available in the history directories.

## Paths, inputs, and dependencies

Canonical `.inkwell/scripts/...` references resolve from the project root, including in nested documents. Other existing relative `file=` references retain document-first, project-root-fallback resolution. Sources must remain inside the project; absolute paths, traversal escapes, non-regular files, and escaping symlinks are rejected.

`inputs=` and `depends-on=` accept single- or double-quoted comma-separated lists. Spaces surrounding each item are ignored. Escape a literal comma as `\,`. Input globs resolve from the project root and support `*`, `**`, and `?`. Declare any additional files that affect a block's result. Generated run directories and `.git` are excluded from broad glob expansion.

The run fingerprint includes source contents, declared input contents, interpreter identity, relevant requirements and lockfiles, allowlisted environment settings, and upstream result hashes. Changing a dependency makes its dependents stale. Saved changes to inputs and external scripts refresh visible run state automatically. Execution is sequential in 0.5.

Explicit environment paths, including `env=` and `inkwell.runs.python-env`, must be project-relative, for example `.inkwell/venv`, and must remain inside the project. System interpreter discovery through `PATH` remains supported, as does a normal project virtual environment whose Python executable links to its system interpreter.

## Successful output and history

Inkwell stores generated output under:

```text
.inkwell/runs/<document-id>/<block-id>/
  current.json
  history/<run-id>/
    run.json
    stdout.txt
    stderr.txt
    artifacts/...
```

`current.json` points to a complete successful attempt. Inkwell verifies provenance and each published artifact's size and SHA-256 before using it. A failed, cancelled, timed-out, superseded, or changed-during-execution attempt cannot replace the last successful result. Stale last-successful output is inspectable but cannot be injected into a current preview or PDF.

The default limits are 300 seconds per block, 10 MiB each for stdout and stderr, 500 MiB per artifact, 2 GiB total artifacts, 1,000 declared input paths, and 2 GiB of hashed declared inputs. Retention preserves the current successful target and the ten most recent attempts. Configure validated limits in project `defaults.runs` or document settings, for example:

```yaml
inkwell:
  runs:
    timeout-seconds: 300
    retention-count: 10
    max-parallel: 1
    max-stdout-bytes: 10485760
    max-stderr-bytes: 10485760
    max-artifact-bytes: 524288000
    max-artifact-total-bytes: 2147483648
    max-input-paths: 1000
    max-input-bytes: 2147483648
```

Run diagnostics store an environment fingerprint, rather than the environment itself, and redact secret-like argument values. Raw HTML admitted into Markdown preview is sanitized; active scripts and unsafe URLs are removed. Standalone `.html` artifacts keep their existing literal-source presentation.

## Upgrading existing projects

Existing scripts remain user-owned. Extraction never overwrites an existing script. Scaffold upgrades preserve modified scripts and are handled by the scaffold ownership workflow.

Pre-0.5 `.inkwell/outputs/` files and obsolete identity histories are preserved as unverified generated data. They are not imported as current output. Rerun a block to create a verified entry in the current layout. Clearing the code cache removes generated output for the requested scope and preserves `.inkwell/scripts/`.

Input globs now use the project root consistently, so update old nested-document input paths when necessary. Canonical extracted script references always use the root `.inkwell/scripts/` directory. Explicit environment paths that escape the project now fail validation. Legacy ordinal environment behavior, including `INKWELL_BLOCK_INDEX`, remains compatible; reordering may require a rerun, while stable IDs prevent output from attaching to the wrong block.
