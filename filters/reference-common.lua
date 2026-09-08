-- Shared AST placement and presentation for document/section citeproc.
local json=dofile(PANDOC_SCRIPT_FILE:match('(.*/)')..'table-common.lua')
local M={}
function M.options(meta)
 local options={heading='References',hangingIndentPt=22,lineSpacing=1,entrySpacingPt=4.4,pageBreak='auto',fontSizePt=11,fontSupported=false}
 if meta['inkwell-reference-options'] then
  local encoded=pandoc.utils.stringify(meta['inkwell-reference-options'])
  if encoded:sub(1,4)~='hex:' then error('Invalid reference options encoding') end
  encoded=encoded:sub(5)
  if #encoded%2~=0 or encoded:find('[^%x]') then error('Invalid reference options encoding') end
  local values=json.decode(encoded:gsub('%x%x',function(byte) return string.char(tonumber(byte,16)) end))
  for key,value in pairs(values) do options[key]=value end
 end
 for key,limits in pairs({lineSpacing={.1,10},hangingIndentPt={0,40000},entrySpacingPt={0,40000},fontSizePt={.1,200}}) do
  local n=tonumber(options[key])
  if not n or n~=n or n<limits[1] or n>limits[2] then error('Invalid reference '..key) end
  options[key]=n
 end
 if type(options.heading)~='string' then error('Invalid reference heading') end
 if type(options.fontSupported)~='boolean' then error('Invalid reference font capability') end
 if options.pageBreak~='auto' and options.pageBreak~='always' and options.pageBreak~='never' then error('Invalid reference page break') end
 return options
end
local function is_refs(block)
 return block.t=='Div' and (block.identifier=='refs' or block.classes:includes('csl-bib-body'))
end
function M.prepare(doc)
 local options=M.options(doc.meta)
 local identifiers,has_cites={},false
 doc:walk({Div=function(div) identifiers[div.identifier]=true end,Cite=function() has_cites=true end})
 local marker='inkwell-reference-placement'
 while identifiers[marker] do marker=marker..'-next' end
 local slots=0
 -- Citeproc populates every #refs div. Retain one authoritative slot in
 -- document order, including nested containers, and preserve any authored
 -- text in all slots before removing their bibliography-only wrappers.
 doc=doc:walk({traverse='topdown',Div=function(div)
  if not is_refs(div) then return nil end
  slots=slots+1
  local content=div.content
  if slots==1 then content:insert(pandoc.Div({},pandoc.Attr(marker))) end
  return content
 end})
 local heading=false
 doc=doc:walk({traverse='topdown',Header=function(block)
  local text=pandoc.utils.stringify(block.content):lower()
  if not heading and (block.identifier=='refs' or text==options.heading:lower() or text=='references') then
   heading=true
   block.content={pandoc.Str(options.heading)}
   if block.identifier=='refs' then block.identifier='references-heading' end
   if not block.classes:includes('inkwell-reference-heading') then block.classes:insert('inkwell-reference-heading') end
   if not block.classes:includes('unnumbered') then block.classes:insert('unnumbered') end
   block.classes:insert(marker..'-heading')
   return block
  end
 end})
 if not has_cites and not doc.meta.nocite and slots==0 and not heading then return doc end
 local function make_heading()
  return pandoc.Header(2,{pandoc.Str(options.heading)},pandoc.Attr('',{'inkwell-reference-heading','unnumbered'}))
 end
 -- Blocks walks nested lists and divs as well as the document body. A heading
 -- remains before its explanatory paragraphs when the slot is nonadjacent.
 doc=doc:walk({Blocks=function(blocks)
  local out=pandoc.List()
  for _,block in ipairs(blocks) do
   if block.t=='Div' and block.identifier==marker then
    if not heading then out:insert(make_heading()) end
    block.identifier='refs'
   end
   local selected_heading=block.t=='Header' and block.classes:includes(marker..'-heading')
   if selected_heading then block.classes=block.classes:filter(function(class) return class~=marker..'-heading' end) end
   out:insert(block)
   if selected_heading and slots==0 then out:insert(pandoc.Div({},pandoc.Attr('refs'))) end
  end
  return out
 end})
 if not heading and slots==0 then doc.blocks:insert(make_heading());doc.blocks:insert(pandoc.Div({},pandoc.Attr('refs'))) end
 -- The AST owns heading placement; citeproc must not append a second heading.
 doc.meta['reference-section-title']=nil
 return doc
end
function M.style(doc)
 local options=M.options(doc.meta)
 return doc:walk({Div=function(div)
  if not is_refs(div) then return nil end
  div.classes=div.classes:filter(function(class) return class~='hanging-indent' end)
  if options.hangingIndentPt>0 then div.classes:insert('hanging-indent') end
  -- The native writer owns CSL item structure; exact lengths are scoped by
  -- reference-render rather than rounded to citeproc's integer baseline count.
  div.attributes['entry-spacing']='0'
  div.attributes['line-spacing']=tostring(options.lineSpacing)
  return div
 end})
end
return M
