---
template: tufte-book-vdqi
title: "A Tufte-Style Book"
subtitle: "With a VDQI Title and Contents Page"
author: "Inkwell"
edition: "First edition"
date: "June 2026"
publisher: "Measured One Press"
top-level-division: chapter

# --- Class options ---
classoption:
  - justified
  # - a4paper
  # - symmetric

# --- Front matter ---
toc: true
lof: true
lot: true
copyright: true
copyright-holder: "Measured One"
license: "Licensed for demonstration and testing of the Inkwell extension."
dedication: |
  Dedicated to readers who prefer evidence, proportion, and quiet pages.
epigraphs:
  - text: "Above all else show the data."
    author: "Edward R. Tufte"

# --- Bibliography ---
bibliography: .inkwell/references/refs.bib
link-citations: true

# --- Cross-reference prefixes ---
figPrefix: "Figure"
tblPrefix: "Table"
eqnPrefix: "Equation"
secPrefix: "Chapter"

# --- Inkwell styling ---
inkwell:
  code-display: output
  tables: booktabs
---

\part{Visual Evidence}

# The Design of Analytical Pages {#sec:pages}

\newthought{The pages} of an analytical book should carry evidence with as
little ceremony as possible. Tufte's book design gives the main text a calm
measure while reserving the margin for sidenotes, captions, and small
annotations.

\marginnote{The template uses \texttt{tufte-book}, so ordinary footnotes become
sidenotes and margin notes can be placed explicitly.}

This demo compiles from Markdown through Pandoc [@macfarlane2023], while the
template supplies the VDQI-inspired title page and contents styling from the
downloaded LaTeX source.

The important structural convention is simple: with
`top-level-division: chapter`, each top-level Markdown heading becomes a book
chapter. Raw LaTeX `\part{...}` commands may be placed between chapters to
create large divisions in the table of contents.

## A Compact Comparison {#sec:comparison}

The front matter differs from the default Inkwell title page in three visible
ways: the author's name sits at the top, the title appears just above the page
center, and the publisher rests at the bottom margin.

| Element | VDQI-style treatment |
|---------|----------------------|
| Author | Serif italic at the top of the page |
| Title | Large serif title above center |
| Edition | Small caps sans serif below the title |
| Publisher | Serif italic at the bottom margin |

: Title page structure used by the Tufte Book VDQI template. {#tbl:title-page}

The book template keeps the visual language of the handout template, but it
adds front matter, back matter, parts, chapters, and a table of contents tuned
for longer work. In practical use, this means that the same Inkwell document
can grow from a short technical note into a coherent manual or monograph
without changing the authoring format.

\begin{fullwidth}

Full-width passages can span the main text and margin when the argument needs
more horizontal space. Use them sparingly; the extra width is most effective
when it lets a table, figure, or short aside breathe.

\end{fullwidth}

# Chapter Structure from Markdown {#sec:chapters}

\newthought{A Tufte-style book} in Inkwell is compiled as one Markdown source
file today. The compiler sends that file through Pandoc, Pandoc turns the
top-level headings into chapters, and the LaTeX template handles the book
front matter and layout.

That does not mean the book must feel like a single long article. Parts,
chapters, sections, tables, figures, margin notes, and citations all work
together inside one source file. The table below shows the authoring pattern.

| Markdown or LaTeX source | Book result |
|--------------------------|-------------|
| `\part{Visual Evidence}` | Part entry in the contents |
| `# Chapter Title` | Numbered chapter |
| `## Section Title` | Section inside the chapter |
| `\marginnote{...}` | Unnumbered note in the margin |
| `\begin{fullwidth}` | Text block across the main text and margin |

: Common source patterns for a Tufte Book VDQI document. {#tbl:source-patterns}

If you prefer to draft chapters in separate files, the current extension does
not yet assemble a folder of Markdown chapters automatically. The reliable
workflow is to compile a master Markdown document. A future multi-file book
mode could add a frontmatter `chapters:` list and concatenate those files
before Pandoc runs.

\begin{marginfigure}
\centering
\fbox{\rule{0pt}{1.2in}\rule{0.85\linewidth}{0pt}}
\caption{A margin figure can hold a small image, sparkline, or schematic beside
the chapter text.}
\end{marginfigure}

The blank margin figure above is intentional: it keeps the demo self-contained
without requiring an external asset. In a real book, replace the framed rule
with `\includegraphics[width=\linewidth]{path/to/figure.pdf}`.

\part{Margin and Measure}

# Sidenotes and Citations {#sec:sidenotes}

\newthought{Margin material} lets supporting context travel beside the sentence
that needs it. This is especially useful for source notes, short definitions,
and small clarifications. The extension's code and citation pipeline follow the
same Markdown workflow as the other templates [@knuth1984].

\marginnote{Use \texttt{\textbackslash marginnote} for short, unnumbered
margin comments beside the sentence that needs them.}

Longer arguments still belong in the main text. The margin is best treated as a
parallel channel, not a second essay.

## Numbered Sidenotes {#sec:numbered-sidenotes}

Ordinary Markdown footnotes compile as LaTeX footnotes, and the Tufte class
places them in the margin.^[This is a numbered sidenote produced from a
Markdown footnote.] Use this style for notes that are part of the reading
sequence.

Use `\marginnote{...}` for unnumbered asides, labels, and small reminders. Use
numbered sidenotes when the note should have a visible anchor in the main text.
Both styles are useful, but they should not be mixed casually on every
sentence.

## Citations in the Margin Style {#sec:citation-style}

Pandoc citeproc keeps bibliography handling consistent across templates. A
book chapter can cite software, articles, reports, or books using the same
`[@key]` syntax used by shorter Inkwell documents [@macfarlane2023].

The generated references appear wherever the bibliography heading is placed in
the Markdown source. In this demo the references heading sits at the end of the
book, after the final chapter.

# Full-Width Displays {#sec:fullwidth-displays}

\newthought{The main text column} is intentionally narrow. It improves reading
rhythm, but some comparisons need more width. Tufte layouts solve this by
allowing occasional full-width material.

\begin{fullwidth}

| Page element | Best use | Caution |
|--------------|----------|---------|
| Main text | Narrative, argument, definitions | Keep paragraphs concise |
| Margin note | Local context, short citations, reminders | Avoid multi-paragraph notes |
| Full-width block | Wide tables, dense comparisons, larger figures | Use sparingly |
| Part page | Major conceptual division | Do not over-segment a short work |

: Choosing the right page region for analytical content.

\end{fullwidth}

The full-width table appears in the flow of the chapter, but it occupies the
same horizontal measure as the body plus margin. This is helpful for comparative
material that would otherwise become cramped or hard to scan.

The same pattern works for a figure. Wrap a normal LaTeX figure or Markdown
table in `fullwidth` only when the extra space improves the reader's ability to
see the structure.

\part{A Small Demonstration Book}

# From Notes to Chapters {#sec:notes-to-chapters}

\newthought{A useful book demo} should contain enough structure to prove that
front matter, parts, chapters, and lists are working. This chapter is written
only to make that structure visible in the compiled PDF.

In an actual project, you might use the first part to establish concepts, the
second part to present evidence, and the third part to collect methods or
appendices. The Tufte Book VDQI template does not impose that organization; it
only makes the organization visible.

## A Drafting Rhythm {#sec:drafting-rhythm}

One practical rhythm is to start every chapter with a `\newthought{...}` phrase,
then place the first margin note only after the chapter's purpose is clear. The
reader should not have to choose between reading the main text and reading the
margin before the chapter has begun.

\marginnote{Margin notes work best when they reward attention without becoming
required for basic comprehension.}

After the opening paragraph, ordinary sections can carry the chapter forward.
The top-level heading creates the chapter; second-level headings create the
sections that appear inside that chapter.

## A Longer Paragraph Block {#sec:longer-block}

This paragraph exists to make the compiled demo feel more like a book page than
a template smoke test. A book layout should demonstrate line length, margin
balance, heading spacing, footnote placement, table captions, and the visual
distance between adjacent chapters. These details are hard to judge from a
two-page sample because the table of contents has almost nothing to list and
the page rhythm never has time to settle.

The point of a longer demo is not filler for its own sake. It creates enough
surface area to catch integration problems: a contents entry that wraps badly,
a chapter heading that starts too close to the top margin, a long table that
does not belong in the main measure, or a sidenote that collides with another
piece of marginal material.

# A Reproducible Book Workflow {#sec:workflow}

\newthought{The Inkwell workflow} keeps source text, code outputs, figures, and
bibliography files under one project root. For a book, the same principle
applies: keep the manuscript in Markdown, keep generated artifacts in
`.inkwell/`, and let the compiler produce the PDF in an isolated build
directory.

The current template expects the book manuscript to be one Markdown document.
That is the most predictable path because Pandoc sees the whole table of
contents, all cross-references, and all citations in one run.

## Possible Future Multi-File Mode {#sec:future-multifile}

A multi-file mode would be a good future extension: a master file could declare
chapter files in frontmatter, and Inkwell could assemble those files before
calling Pandoc.

```yaml
chapters:
  - chapters/01-pages.md
  - chapters/02-sidenotes.md
  - chapters/03-workflow.md
```

That feature is not required for the template to work, but it would make larger
books easier to maintain. Until then, the single master document is the working
model.

## References
