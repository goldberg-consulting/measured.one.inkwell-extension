# README image sources

The top-level README uses one conceptual illustration and two Inkwell preview
closeups. The banner is artwork. The closeups render the actual preview code
in a browser with a small host bridge, using a disposable example project.

## Banner

- Asset: [`hero-banner.png`](hero-banner.png).
- Generated: 2026-09-08, using Codex's built-in image generation tool.
- No reference image; prompt below. No programmatic image edits.

```text
Use case: ads-marketing. Asset type: replacement GitHub README hero banner for Inkwell, a Markdown-to-PDF editor extension.
Create a polished, restrained editorial illustration in a wide landscape composition approximately 2:1. Deep ink-blue background with subtle paper texture; warm white sheets, muted teal and restrained copper accents. Evoke the existing Inkwell fountain-pen/paper identity without reproducing an app interface.
At the left/top put the exact title "Inkwell" in large elegant warm-white lettering, and beneath it the exact subtitle "Write. Run. Publish." Both must be perfectly readable at GitHub README size.
Below and to the right, tell one clear visual story: a dark Markdown manuscript sheet with a few minimal code-like lines, a small clean plot emerging from analysis, and a beautiful white typeset report with generous margins, a chart and short text-like rules. Connect the progression subtly through the arrangement of paper rather than giant arrows. Add a small tasteful fountain-pen nib motif. Keep most of the image calm and uncluttered.
This is a conceptual editorial banner, not a screenshot. No toolbar, no fake buttons, no badges, no invented app features, no tiny pseudo-readable paragraphs, no extra text, no watermark. The words Inkwell and Write. Run. Publish. are the only actual typography. High quality finished publication artwork.
```


## Usage screenshots

- Assets: [`run-preview.jpg`](run-preview.jpg) and
  [`compile-preview.jpg`](compile-preview.jpg), saved in the capture tool's
  native JPEG format without further editing.
- Captured: 2026-09-08, from the Inkwell 0.5.0 preview shell, provider, and
  bundled browser assets on macOS. These are standalone preview captures,
  not full editor-window screenshots.
- Source: [`readme-example.md`](readme-example.md). Its data is a small,
  deliberately synthetic example; the Node block really generates the CSV.
- Candidate: commit `bbf33e2cd7deeed615265e12ac109a97c209d620`;
  VSIX SHA-256 `ef9b96b132e7163f935cf4e97c002bbf4212885aa29e09e25bd2c19be4d5c67e`.
- A disposable Cursor 1.128.0 profile and workspace ran the Node code and
  compiled the PDF using that candidate. The capture uses the current checkout's
  actual preview shell/provider (including this PR's Run tooltip correction)
  and the candidate's exact bundled client/CSS/vendor assets. The host bridge supplies that sample document and
  compiled PDF. No editor chrome or preview controls are invented.

To refresh the captures, copy the example into a prepared Inkwell project,
open Preview, run its code, and Compile. Capture Draft with the completed Run
panel visible, then the PDF tab with the Run panel closed. The PDF capture
shows its results page at 145% custom zoom. Keep the toolbar
readable and avoid personal files, paths, or unrelated editor panels.
