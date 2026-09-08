# Preview and compilation

Draft, Print View, and the PDF viewer work offline. Inkwell packages the pinned
math, diagram, highlighting, and PDF libraries with the extension. Optional
features load when the document uses them. Plain Markdown appears first; a late
result from an older edit cannot replace the current document.

The PDF viewer renders pages near the viewport and keeps at most six canvases.
Zoom and scrolling reuse the loaded PDF. Fit width, fit page, custom zoom, the
selected tab, and each document's scroll position are remembered independently.
Document typography changes the output; viewer zoom only changes its display.

Compile requests retain their document and source version. A newer pending
request replaces an older pending request for that document. Requests for other
documents keep their place. The toolbar and editor commands use the same queue.
Timed compilation skips a successfully compiled revision when its inputs and
published PDF remain unchanged. Changes to project files, scripts, dependencies,
bibliographies, styles, or templates invalidate that reuse.

Every executed compilation produces a fresh PDF in a temporary directory.
Verified auxiliary state can avoid an unnecessary TeX pass. Changed dependencies,
unresolved references, rerun warnings, incomplete logs, and bibliography tools
retain the required passes. A failure preserves the last successfully published
PDF. Clearing generated caches does not delete scripts, documents, or references.

Built-in template support files use bounded, verified copies in temporary
storage. Custom templates retain their normal per-attempt staging. Compiler
reports include phase durations, cache hits, TeX pass counts, and reasons for
additional passes; those measurements accompany release benchmark reports.

Release validation uses the actual packaged extension in disposable editor
profiles, actual browser rendering with external requests blocked, and repeated
demo compilation from the same VSIX. A passing local test is recorded separately
from Linux CI, clean macOS installation, and public release evidence. See
[installation checks](installation.md) for the remaining publication requirements.
