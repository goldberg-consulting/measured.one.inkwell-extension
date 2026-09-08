# Document configuration and project upgrades

Inkwell reads YAML with one parser for preview, PDF compilation, bibliography
resolution, template selection, and code runs. Quoted strings, comments, block
scalars, flow lists, and block lists use standard YAML syntax. Invalid values
produce a diagnostic with their source location.

Block attributes override block-specific choices. Document frontmatter overrides
project manifest defaults, which override `defaults.yaml`, explicit Inkwell editor
authoring settings, template defaults, and built-in defaults. In `defaults.yaml`,
recognized top-level values override `metadata`, which overrides `variables`.
Template capabilities constrain the result and explain unsupported choices.
Viewer settings never enter the authoring configuration or its fingerprint.

Pandoc keys such as `fontsize`, `mainfont`, `linestretch`, and `bibliography`
remain canonical. New Inkwell options use nested kebab-case names under
`inkwell.typography`, `inkwell.tables`, `inkwell.references`, and `inkwell.runs`.
Legacy aliases, including `bibliography-scope` and `inkwell.code-display`, remain
readable through at least release 0.7. Native Pandoc
metadata, including `header-includes` and inline CSL `references` lists, is
preserved. The compiler applies inherited choices to a staged source copy.

A project manifest separates the JSON schema version from the installed scaffold
content version:

```json
{
  "schemaVersion": 1,
  "scaffoldVersion": 4,
  "template": "default",
  "defaults": {
    "typography": { "bodySize": "11pt" },
    "tables": {},
    "references": {},
    "runs": { "display": "output" }
  },
  "managedFiles": {}
}
```

The migration service owns `managedFiles`. Legacy `settings` and
`documentSettings` are normalized in memory and migrated with unknown JSON keys
intact. Ordinary rendering does not save this normalization back to disk.
Legacy schema-only manifests, including the transitional `schemaVersion: 4`
format, remain readable and migrate to schema 1 / scaffold 4 during setup.

Setup copies recognized values from project-root `defaults.yaml` into the
manifest without changing that YAML file. Project values retain precedence.
Conflicts receive a numbered manifest `.new` proposal; **Compare files** reviews
the alternative and **Keep my files** retains the project values while copying
the remaining defaults. Unknown Pandoc metadata stays in `defaults.yaml`, where
it continues to participate in rendering. Viewer preferences are never copied.
The final manifest checkpoint records the source hash and migration completion;
repeating setup performs no writes. If `defaults.yaml` changes during an
interrupted transaction, migration stops before publishing stale defaults.

An explicit document or project bibliography list replaces discovery, including
`bibliography: []`. Otherwise Inkwell discovers sorted `.bib` files in the project
root, `references/`, and `.inkwell/references/`. Earlier files win duplicate-key
lookup, while every duplicate definition receives a source diagnostic.
Document declarations are relative to the document, with the project-root
fallback retained for nested documents using `.inkwell/...` paths. Project and
`defaults.yaml` declarations are relative to the project root. The same rules
apply to CSL paths; a bare style name may resolve in the project's CSL folders.
Without an explicit CSL choice, Inkwell uses its bundled numeric style.

The first Inkwell action in a plain workspace offers **Set up this workspace**
and **Don't ask here**. Merely opening or switching Markdown files does not create
project files. Explicit **New Project** and **Setup Workspace** actions authorize
scaffold creation directly.

For an existing project, Inkwell checks the installed scaffold and applies safe
updates. An unchanged managed file can be upgraded atomically. An edited file is
preserved byte-for-byte, with a proposed replacement beside it using `.new` or a
numbered `.new` suffix. **Compare files** opens both versions; **Keep my files**
records user ownership and finishes the migration. Bibliographies, scripts,
documents, and local templates remain user-owned. Built-in runtime templates are
read from the extension instead of copied into each project.

A malformed manifest is backed up and reported. Repair the original JSON, then
repeat the action. Interrupted migration transactions resume on the next action;
the scaffold version advances only after all required writes succeed. Running
setup again on an unchanged healthy project performs zero writes.
