# Citations and bibliographies

Use **Inkwell: Configure Bibliography** to choose or create BibTeX files, select a
CSL style, and change the reference list. Each change is one undoable frontmatter
edit. The document stays unsaved until you save it. Cancelling a picker preserves
the document and existing files.

```yaml
bibliography: [references/primary.bib, references/supplement.bib]
csl: .inkwell/csl/journal.csl
link-citations: true
inkwell:
  references:
    scope: document
    heading: References
    font-size: small
    line-spacing: 1.0
    entry-spacing: 0.4em
    hanging-indent: 2em
    page-break: auto
```

An explicit document or project list disables automatic discovery. Without one,
Inkwell discovers sorted `.bib` files in the project root, `references/`, and
`.inkwell/references/`. The first file takes precedence when keys overlap; every
duplicate definition appears in diagnostics. Use `bibliography: []` to disable
all file discovery. Reference files must remain inside the project, including
when their paths contain symbolic links.

Document paths are relative to the document, with the existing project fallback
for nested documents retained. Project defaults use the project root. A missing
CSL or bibliography file is reported with its source location. The bundled
numeric CSL is used when no style is specified.

Pandoc processes citations for both preview and PDF. Narrative `@key`, grouped
`[@one; @two]`, suppressed-author `[-@key]`, locators `[@key, p. 12]`, prefixes,
suffixes, Unicode keys, and `nocite: '@*'` use its citation parser and the selected
CSL. Missing keys are reported individually, including within mixed valid and
missing groups. If Pandoc is unavailable, preview clearly labels its local
citation approximation; the chosen CSL is not claimed to have been applied.

An existing References heading or `::: {#refs}` placement block positions the
list. `scope: section` produces a bibliography for each top-level section with
separate citation targets. `page-break: always` starts each reference list on a
new PDF page; `auto` and `never` leave pagination to normal document flow.

Reference spacing and hanging indentation affect bibliography entries only.
Font choices show a lock when the template controls their size. Legacy boolean
hanging indentation and page-break values remain readable, as do numeric entry
spacing values (extra baselines). New settings use physical lengths and the
`auto`, `always`, or `never` page-break choices. Legacy aliases remain supported
through at least 0.7; `inkwell.hanging-indent` no longer changes ordinary lists.

Type `@` for citation suggestions. Hover shows the indexed title, author, year,
and source; Go to Definition opens the BibTeX entry. **Inkwell: Bibliography
Doctor** checks the current sources and lets you open reported problems. Changes
to bibliography files, CSL files, and project defaults invalidate cached data.
Opening the extension itself does not start a Pandoc process.
