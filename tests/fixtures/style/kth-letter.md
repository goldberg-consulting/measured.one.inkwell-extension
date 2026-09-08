---
template: kth-letter
name: KthSenderMarker
email: sender@example.invalid
web: https://example.invalid
telephone: '+46 8 000 00 00'
location: Stockholm
recipient:
  - KthRecipientMarker
  - Research Office
  - Stockholm, Sweden
opening: KthOpeningMarker,
closing: KthClosingMarker,
dnr: KTH-2026-FIXTURE
header-includes:
  - '\date{7 September 2026}'
fontsize: 18pt
mainfont: Arial
linestretch: 2
columns: 2
pdf-engine: xelatex
heading-font: Arial
heading-weight: normal
heading-scale: 2
heading-color: '#336699'
caption-font-size: 6pt
table-font-size: 7pt
reference-font-size: 6pt
tables:
  preset: grid
  stripe: true
  caption-position: below
references:
  - id: kth-reference
    type: book
    title: KthReferenceMarker
    author: [{family: Fixture}]
    issued: {date-parts: [[2026]]}
---

# KthHeadingMarker

KthBodyMarker cites [@kth-reference].

## KthSubheadingMarker

KthBaselineOne\
KthBaselineTwo

| Column | Value |
|:--|:--|
| KthTableMarker | Native letter typography |

: KthCaptionMarker {#tbl:kth-capabilities}

::: {#refs}
:::
