-- Only Pandoc body Table nodes enter this group. Template-owned title, header,
-- resume and layout tables are emitted later by the writer and are untouched.
function Pandoc(document)
  if not FORMAT:match("latex") then return document end
  if not document.meta["inkwell-body-table-typography"] then return document end
  return document:walk({
    Table = function(table)
      return pandoc.Div({
        pandoc.RawBlock("latex", "\\begingroup\\inkwellbodytablesize"),
        table,
        pandoc.RawBlock("latex", "\\endgroup")
      })
    end
  })
end
