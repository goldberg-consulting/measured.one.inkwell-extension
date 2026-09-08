local common=dofile(PANDOC_SCRIPT_FILE:match('(.*/)')..'reference-common.lua')
local function html(block)
 return pandoc.write(pandoc.Pandoc({block}),'html',{wrap_text='none'})
end
function Pandoc(doc)
 doc=common.style(doc)
 local options=common.options(doc.meta)
 local preview=doc.meta['inkwell-preview-citations']~=nil
 if preview then
  return doc:walk({
   Cite=function(cite) return pandoc.RawInline('html',html(pandoc.Plain({cite})):gsub('%s+$','')) end,
   Header=function(header)
    if header.classes:includes('inkwell-reference-heading') then
     header.classes:insert('references-heading')
     return pandoc.RawBlock('html',html(header))
    end
   end,
   Div=function(div)
    if not div.classes:includes('csl-bib-body') then return nil end
    div.attributes.style='font-size:'..string.format('%.6f',options.fontSizePt*72/72.27)..'pt;line-height:'..(options.lineSpacing*1.2)..';--inkwell-reference-entry-space:'..string.format('%.6f',options.entrySpacingPt*72/72.27)..'pt;--inkwell-reference-indent:'..string.format('%.6f',options.hangingIndentPt*72/72.27)..'pt;'
    return pandoc.RawBlock('html',html(div))
   end,
  })
 end
 if FORMAT:match('latex') then
  doc=doc:walk({
   Header=function(header)
    if options.pageBreak=='always' and header.classes:includes('inkwell-reference-heading') then return {pandoc.RawBlock('latex','\\clearpage'),header} end
   end,
   Div=function(div)
    if not div.classes:includes('csl-bib-body') then return nil end
    local before='\\begingroup\n\\def\\baselinestretch{1}\n'
    if options.fontSupported then before=before..'\\fontsize{'..options.fontSizePt..'pt}{'..options.fontSizePt*1.2*options.lineSpacing..'pt}\\selectfont\n'
    else before=before..'\\linespread{'..options.lineSpacing..'}\\selectfont\n' end
    before=before..'\\setlength{\\cslhangindent}{'..options.hangingIndentPt..'pt}\n'
    -- Place the length after the native environment begins: its definition
    -- initializes itemsep, so a begin hook would be overwritten.
    div.content:insert(1,pandoc.RawBlock('latex','\\setlength{\\itemsep}{'..options.entrySpacingPt..'pt}'))
    return {pandoc.RawBlock('latex',before),div,pandoc.RawBlock('latex','\\endgroup')}
   end,
  })
 end
 return doc
end
