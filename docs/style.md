# Document style and reading size

Use **Inkwell: Configure Document Style** from the Command Palette to change the typography used by both preview and PDF. Open a saved Markdown document in a trusted local workspace, then choose where to store the setting:

- **This document** updates its frontmatter with one undoable editor change. The document stays unsaved until you save it. This choice does not create a project scaffold.
- **Project defaults** updates `.inkwell/manifest.json` for documents that do not provide their own override. Inkwell checks project readiness after you choose this scope and may offer workspace setup or migration first. Existing document frontmatter continues to take precedence.

Choose a setting, then select a supported value or enter one. Run the command again to change another setting. Cancel a style picker to leave that setting unchanged.

The available settings include body family and point size, line spacing, heading family/weight/scale/color, code/caption/table/reference sizes, and sans-serif and monospace families. Font families must be available to the selected PDF engine. The command does not install fonts.

Each setting shows its effective value. A lock icon means the selected template controls that option; its explanation appears beside the value. Selecting a locked item shows the explanation without opening a value editor. Fixed journal templates and custom templates without declared support may lock several options.

## Frontmatter and project defaults

The command writes canonical typography keys. For example:

```yaml
---
title: My document
typography:
  bodySize: 11pt
  lineSpacing: 1.4
---
```

The equivalent project defaults live under `defaults` in the manifest:

```json
{
  "schemaVersion": 4,
  "defaults": {
    "typography": {
      "bodySize": "11pt",
      "lineSpacing": 1.4
    }
  }
}
```

These examples show the relevant settings only. Inkwell preserves the other manifest fields, including managed-file records and fields added by a newer version.

Legacy keys such as `fontsize`, `mainfont`, `sansfont`, `monofont`, `heading-*`, `code-font-size`, `table-font-size`, and `caption-font-size` remain readable. The command preserves existing legacy values and writes the canonical setting that takes precedence over them. It also preserves YAML comments, the document's line endings and byte-order mark, unknown metadata, and the document body. A canonical dotted key already present in YAML is updated directly. Shared YAML maps can be overridden without changing other metadata that references the same anchor; a scalar anchor must be edited directly.

Sizes have explicit units. The shared configuration reader understands points, CSS lengths, and named LaTeX sizes such as `small` and `footnotesize`; each template exposes only the values its PDF adapter can reproduce. Relative `em`, `rem`, and percentage sizes refer to the document body, independently of the editor UI and viewer zoom. Physical conversion accounts for the slight difference between TeX points and CSS/PDF points. For a standard body size, use the supported 10 pt, 11 pt, or 12 pt choice. The same template rules apply to manual frontmatter and project defaults.

## Reading size is separate

Preview **A−**, **A+**, and **Reset** change reading size from 50% to 200%. The editor preference is `inkwell.preview.fontScale`. It affects document content in the preview and does not change frontmatter, generated TeX, or the compiled PDF. Toolbar and log text keep the editor's UI font.

PDF fit-width, fit-page, and custom zoom remain separate PDF viewing controls. Use **Configure Document Style** when the exported document itself should change.

## If an edit cannot be applied

If you switch documents, edit the document, change its configuration, or start another style command while a picker is open, the earlier edit is cancelled. Run the command again against the current document.

Project updates also stop when the manifest has unsaved editor changes or its bytes change during the picker. Save or revert those edits before trying again. A failed atomic write preserves the original manifest. Malformed manifests are preserved with a `manifest.json.malformed-….bak` backup and must be repaired before project defaults can change.
