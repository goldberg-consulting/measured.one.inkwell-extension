# Body tables

Inkwell uses one presentation model for Markdown tables and generated CSV/JSON
tables. A table's attributes override document frontmatter, followed by project
defaults and the template's supported defaults.

Default and ETH Report support `booktabs`, `grid`, `plain`, `zebra`, and `compact`.
Booktabs uses horizontal rules, grid adds cell borders, plain removes rules,
zebra adds alternating row backgrounds, and compact reduces cell padding. An
explicit stripe or density setting overrides the preset's implied value.

```yaml
---
tables:
  preset: grid
  fontSize: 10pt
  density: compact
  headerWeight: bold
  headerBackground: '#eef3f8'
  stripe: true
  stripeColor: '#f5f5fa'
  ruleColor: '#446688'
  ruleThickness: 0.5pt
  paddingHorizontal: 4pt
  paddingVertical: 2pt
  alignment: [left, right]
  numericAlignment: right
  width: 100%
  overflow: wrap
  captionPosition: above
  captionStyle: normal
---
```

Place a caption immediately above or below the table. Use its attribute block
for a stable cross-reference label and table-specific overrides:

```markdown
| Item | Count |
|:-----|------:|
| Alpha | 12 |

: Counts by item {#tbl:counts .plain table-font-size=9pt table-caption-position=below}

See @tbl:counts.
```

`Table: Counts ...` is also accepted. The explicit caption-position setting
controls placement in both outputs; the caption's position in the Markdown
source does not determine the PDF position. Inkwell now reports Pandoc's actual
above-table default; the former below-caption preview was inconsistent with PDF.
A bare attribute line after a table is not a caption and does not attach table
settings. A label without a caption does not create a numbered table.

Per-table keys use the `table-` prefix: `table-preset` (or `.grid`, `.plain`, etc.),
`table-font-size`, `table-stripe`, `table-density`, `table-header-weight`,
`table-header-background`, `table-stripe-color`, `table-rule-color`,
`table-rule-thickness`, `table-padding-horizontal`, `table-padding-vertical`,
`table-alignment`, `table-numeric-alignment`, `table-width`,
`table-caption-position`, and `table-caption-style`. Canonical attributes win
when their compatibility aliases are also present. Alignment precedence is a
per-table attribute, then a Markdown colon marker, then a document/project
default, then automatic numeric alignment. Numeric inference requires every nonempty
cell in a column to be a signed decimal, exponent, grouped-thousands number, or
percentage; values are displayed literally.

Body-table styling is scoped around the table. It never installs global
`tabular` hooks or changes template title/header/layout tables. Fixed templates
retain their own table behavior and report unsupported overrides. Rho, RMxAA,
Ludus, and Hipster CV support width and wrapping within their existing table
layout while keeping other table styles under template control. Shrinking
fonts to fit a table is currently locked; `wrap` keeps the requested font size.
For styled tables, `auto` and `100%` use the available column width. Narrower
percentages and physical widths are supported. Preview places tables inside a
keyboard-accessible scroll wrapper.

CSV parsing preserves quoted commas, escaped quotes, embedded newlines, leading
zeroes, duplicate headers, empty cells, and literal Markdown pipes. JSON arrays
of records keep the union of columns in first-seen order; nested values are
literal JSON. Invalid or oversized data produces an explicit artifact diagnostic
and stops PDF publication, preserving the last successful PDF. Literal cells do
not execute code, substitute variables, render math, or become citations.

Raw LaTeX table source remains intact for compilation. Preview shows the source
and a limitation notice instead of guessing cell boundaries from `&` and `\\`.
Use the compiled PDF to inspect those tables. Fenced LaTeX examples stay code.
