-- section-bibliographies.lua — per-section reference lists.
--
-- Enabled by Inkwell when frontmatter sets `bibliography-scope: section`.
-- The document is split at headers of level <= `section-bibs-level`
-- (default 1: chapters in book templates, top sections elsewhere) and at
-- raw LaTeX \part{...} commands, then citeproc runs on each segment with
-- the document's own metadata (bibliography, csl, link-citations). Each
-- segment's reference list therefore lands at the end of that segment —
-- directly under a trailing "## References" heading when the author
-- provides one, mirroring the document-level convention.
--
-- Inkwell passes this filter INSTEAD of --citeproc: running both would
-- render citations twice and duplicate every bibliography. Citation
-- numbering restarts per segment, the standard convention for
-- per-chapter bibliographies.

local function split_level(meta)
  local lvl = meta["section-bibs-level"]
  if lvl then
    local n = tonumber(pandoc.utils.stringify(lvl))
    if n then return n end
  end
  return 1
end

-- \part{...} lives between chapters as a raw block; a chapter's
-- references must land before the next part page, so parts start a new
-- segment too.
local function is_part_break(block)
  return block.t == "RawBlock"
    and block.format:match("tex")
    and block.text:match("^\\part%*?[{%[]") ~= nil
end

function Pandoc(doc)
  local level = split_level(doc.meta)

  local segments = {}
  local current = {}
  for _, block in ipairs(doc.blocks) do
    local starts_segment = (block.t == "Header" and block.level <= level)
      or is_part_break(block)
    if starts_segment and #current > 0 then
      segments[#segments + 1] = current
      current = {}
    end
    current[#current + 1] = block
  end
  if #current > 0 then
    segments[#segments + 1] = current
  end

  local out = pandoc.List()
  for i, seg in ipairs(segments) do
    local segdoc = pandoc.utils.citeproc(pandoc.Pandoc(seg, doc.meta))
    -- citeproc emits its list in a div with identifier "refs"; several
    -- of those in one document would produce duplicate LaTeX
    -- hypertargets, so make each one unique.
    segdoc = segdoc:walk({
      Div = function(div)
        if div.identifier == "refs" then
          div.identifier = "refs-" .. tostring(i)
          return div
        end
      end,
    })
    out:extend(segdoc.blocks)
  end

  doc.blocks = out
  return doc
end
