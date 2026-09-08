# Templates

Inkwell ships with ten Pandoc and LaTeX templates. Each template declares the
PDF engine it needs, so selecting a template also selects the compatible
compiler. Set the template in document frontmatter or choose **Inkwell: Select
LaTeX Template** from the Command Palette.

```yaml
---
template: tufte
title: "A short technical note"
---
```

Document frontmatter takes precedence over the project template in
`.inkwell/manifest.json`. See [configuration](configuration.md) for the full
precedence order.

## Built-in templates

| Template | ID | Class | Engine | Example |
| --- | --- | --- | --- | --- |
| Inkwell Default | `default` | `article` | XeLaTeX | [source](../examples/demo-default.md) |
| Tufte Handout | `tufte` | `tufte-handout` | pdfLaTeX | [source](../examples/demo-tufte.md) |
| Tufte Book VDQI | `tufte-book-vdqi` | `tufte-book` | pdfLaTeX | [source](../examples/demo-tufte-book-vdqi.md) |
| Rho Academic Article | `rho` | `rho` | pdfLaTeX | [source](../examples/demo-rho.md) |
| TMSCE | `tmsce` | `tmsce` | pdfLaTeX | [source](../examples/demo-tmsce.md) |
| Ludus Academik | `ludus` | `ludusofficial` | XeLaTeX | [source](../examples/demo-ludus.md) |
| RMxAA | `rmxaa` | `rmaa-rho` | pdfLaTeX | [source](../examples/demo-rmxaa.md) |
| KTH Letter | `kth-letter` | `kth-letter` | pdfLaTeX | — |
| ETH Report | `eth-report` | KOMA-Script `standard` | XeLaTeX | [source](../examples/demo-eth-report.md) |
| Hipster CV | `hipster-cv` | `simplehipstercv` | pdfLaTeX | [source](../examples/demo-hipster-cv.md) |

The [example gallery](examples.md) shows the frontmatter and features for each
template. Built-in template source lives in [`../templates/`](../templates/).

## Custom templates

A custom template is a directory containing a Pandoc wrapper and any LaTeX
classes, styles, fonts, bibliography styles, or images it needs. Inkwell looks
for template IDs in this precedence order:

| Location | Scope | Path |
| --- | --- | --- |
| Project-local | One project | `.inkwell/templates/<id>/` |
| Global | All projects on this machine | `~/.inkwell/templates/<id>/` |
| Built-in | Packaged with Inkwell | `<extension>/templates/<id>/` |

A project-local or global directory with the same ID as a built-in replaces it
only when it supplies its own top-level `.latex` or `template*.tex` wrapper. A directory containing
only supporting files does not shadow a built-in wrapper. Setup / Repair treats
`.inkwell/templates/` as user-owned and never replaces it during scaffold
migration.

### Create a template directory

Use the directory name as the template ID. A complete, portable template might
look like this:

```text
my-journal/
  template.json          # display metadata and required engine
  my-journal.latex       # top-level Pandoc wrapper
  my-journal.cls         # the journal's LaTeX document class
  my-journal.sty         # optional style files
  logos/logo.png         # optional images
```

The wrapper (a top-level `.latex` file or a `.tex` filename starting with
`template`) is what makes a custom template discoverable and is required when
overriding a built-in ID. `template.json` is recommended: it supplies the
template-picker name, description, and engine. Without a manifest, Inkwell uses
the directory name as the display name and XeLaTeX as the engine.

```json
{
  "name": "My Journal",
  "description": "Short description shown in the template picker.",
  "engine": "xelatex"
}
```

`engine` may be `"xelatex"`, `"pdflatex"`, or `"lualatex"`. It is a hard
requirement: Inkwell reports a missing selected engine instead of silently
switching to a different one.

### Write the Pandoc wrapper

The wrapper maps Pandoc variables such as `$title$`, `$author$`, and `$body$`
to the journal class. At minimum, it needs a document class, a document body,
and Pandoc's body variable.

```latex
\documentclass{my-journal}

\title{$if(title)$$title$$else$Untitled$endif$}
\author{$for(author)$$author$$sep$ \and $endfor$}

% Pandoc compatibility
\providecommand{\tightlist}{\setlength{\itemsep}{0pt}\setlength{\parskip}{0pt}}

$for(header-includes)$
$header-includes$
$endfor$

\begin{document}
\maketitle

$body$

\end{document}
```

Use `$if(field)$...$endif$` blocks for optional journal metadata. For example,
a DOI, issue number, or author-affiliation list can be supplied through YAML
frontmatter and rendered only when present.

The bundled wrappers are working references: [RMxAA](../templates/rmxaa/rmxaa.latex)
handles dual-language abstracts and two-column details, while
[TMSCE](../templates/tmsce/tmsce.latex) and
[Ludus](../templates/ludus/ludus.latex) are smaller starting points.

### Add supporting files

Keep the journal's `.cls`, `.sty`, `.bst`, `.bib`, font, and image files with
the wrapper. Nested folders are preserved in the temporary compile directory,
so a wrapper can use a path such as
`\documentclass{my-class-dir/my-journal}`.

Inkwell copies these template support-file extensions:

```text
.cls .sty .bst .bib .def .fd .cfg .clo .ldf
.png .jpg .jpeg .pdf .eps .svg
.ttf .otf .woff .woff2
```

Keep the original journal package together until the first successful compile;
removing a seemingly unused `.sty`, font, or image often causes an indirect
class dependency to fail.

### Select and test it

Reference the directory ID in frontmatter:

```yaml
---
template: my-journal
title: "Paper Title"
---
```

Start with a short document, compile it, and compare the result with the
journal's supplied sample. Then add metadata fields one at a time, wiring each
into the wrapper with an optional Pandoc block. This keeps a class-file or
frontmatter mistake easy to locate.

To adapt an existing journal package:

1. Create a global or project-local template directory.
2. Copy its classes, styles, bibliography styles, fonts, and images into it.
3. Add `template.json` with the intended engine.
4. Translate the sample `.tex` preamble into a top-level `.latex` wrapper.
5. Replace fixed values with Pandoc variables and optional `$if(...)$` blocks.
6. Compile a minimal Markdown document before moving a full manuscript.
