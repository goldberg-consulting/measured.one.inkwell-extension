# Changelog

## 0.1.0 (2026-02-22)

Initial release.

- Live preview panel with HTML, PDF, and log tabs
- Pandoc + LaTeX compilation (XeLaTeX and pdfLaTeX, selected per template)
- Runnable code blocks: Python, R, Shell, Node with content-addressed caching
- Four built-in templates: Inkwell Default, TMSCE, Ludus Academik, RMxAA
- Custom template support via global (`~/.inkwell/templates/`) or project-local (`.inkwell/templates/`) directories
- YAML frontmatter styling: code backgrounds, borders, font sizes, booktabs tables, column layout
- Citation support via `--citeproc` with automatic `.bib` file discovery
- New Project scaffolding command
- Toolchain detection with guided Pandoc and LaTeX installation
- Python venv management per document or per block
