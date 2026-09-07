-- Run after crossref and citeproc. Only native document-body Tables are rendered
-- here; raw LaTeX and the template's own layout tabulars never enter this pass.
local directory = PANDOC_SCRIPT_FILE:match('^(.*[/\\])') or ''
local common = dofile(directory .. 'table-common.lua')
local presets={booktabs=true,grid=true,plain=true,zebra=true,compact=true}
local fallback={preset='booktabs',stripe=false,density='normal',fontSizePt=10,headerWeight='bold',stripeColor='#f5f5fa',ruleColor='#000000',ruleThicknessPt=.4,paddingHorizontalPt=6,paddingVerticalPt=0,alignment='source',numericAlignment='inherit',width='auto',overflow='wrap',captionPosition='above',captionStyle='normal'}
local attribute_fields={
 ['table-preset']='preset',['table-style']='preset',['table-density']='density',['table-font-size']='fontSizePt',
 ['table-stripe']='stripe',['table-header-weight']='headerWeight',['table-header-background']='headerBackground',
 ['table-stripe-color']='stripeColor',['table-rule-color']='ruleColor',['table-rule-thickness']='ruleThicknessPt',
 ['table-padding-horizontal']='paddingHorizontalPt',['table-padding-vertical']='paddingVerticalPt',
 ['table-alignment']='alignment',['table-numeric-alignment']='numericAlignment',['table-width']='width',
 ['table-overflow']='overflow',['table-caption-position']='captionPosition',['table-caption-style']='captionStyle',
}
local function clone(value) local copy={};for k,v in pairs(value or {}) do copy[k]=v end;return copy end
local function number(value,minimum,maximum,name)
 local n=tonumber(value)
 if not n or n~=n or n<minimum or n>maximum then common.fail('invalid '..name..'; expected '..minimum..'–'..maximum) end
 return n
end
local function choice(value,allowed,name)
 for _,item in ipairs(allowed) do if value==item then return value end end
 common.fail('invalid '..name..': '..tostring(value))
end
local function color(value,name,options)
 if value==nil or value==common.null or value=='none' or value=='transparent' then return nil end
 if type(value)~='string' then common.fail('invalid '..name..' color') end
 value=value:match('^%s*(.-)%s*$')
 value=(options.colors or {})[value:lower()] or value
 if value=='transparent' or value=='none' then return nil end
 local red,green,blue=value:match('^rgb%(%s*(%d+)%s*,%s*(%d+)%s*,%s*(%d+)%s*%)$')
 if red then value=string.format('#%02x%02x%02x',number(red,0,255,name),number(green,0,255,name),number(blue,0,255,name)) end
 if value:match('^#%x%x%x$') then value='#'..value:sub(2,2):rep(2)..value:sub(3,3):rep(2)..value:sub(4,4):rep(2) end
 if not value:match('^#%x%x%x%x%x%x$') then common.fail('invalid '..name..' color; use #RRGGBB') end
 return value:sub(2):upper()
end
local function points(value,name,options,minimum,maximum)
 if type(value)=='number' then return number(value,minimum,maximum,name) end
 if (options.namedSizes or {})[value] then return number(options.namedSizes[value],minimum,maximum,name) end
 local amount,unit=tostring(value):match('^([%d.]+)%s*(%%?%a*)$')
 if not amount then common.fail('invalid '..name..' size') end
 local n=tonumber(amount)
 if not n then common.fail('invalid '..name..' size') end
 if unit=='px' then n=n*.75 elseif unit=='em' or unit=='rem' then n=n*(options.bodySizePt or 11)
 elseif unit=='%' then n=n*(options.bodySizePt or 11)/100 elseif unit~='' and unit~='pt' then common.fail('invalid '..name..' unit') end
 return number(n,minimum,maximum,name)
end
local function validate(field,value,options)
 local rule={}
 for _,candidate in ipairs(options.attributeSchema or {}) do if candidate.field==field then rule=candidate;break end end
 if rule.type=='size' then return points(value,field,options,rule.minimum or 0,rule.maximum or 200) end
 if field=='preset' then if not presets[value] then common.fail('invalid table preset') end;return value end
 if field=='stripe' then
  if value==true or value=='true' then return true elseif value==false or value=='false' then return false end
  common.fail('table stripe must be true or false')
 end
 if field=='fontSizePt' then return points(value,'table font',options,1,72) end
 if field=='ruleThicknessPt' then return points(value,'rule thickness',options,0,8) end
 if field=='paddingHorizontalPt' or field=='paddingVerticalPt' then return points(value,'table padding',options,0,72) end
 if field=='headerBackground' or field=='stripeColor' or field=='ruleColor' then local c=color(value,field,options);return c and '#'..c:lower() or nil end
 if field=='density' then return choice(value,{'compact','normal','comfortable'},field) end
 if field=='headerWeight' then if value==400 or value=='400' then value='normal' elseif value==700 or value=='700' then value='bold' end;return choice(value,{'normal','bold'},field) end
 if field=='captionPosition' then return choice(value,{'above','below'},field) end
 if field=='captionStyle' then return choice(value,{'normal','italic'},field) end
 if field=='overflow' then return choice(value,{'wrap'},'overflow (PDF fit would change the selected font size)') end
 if field=='numericAlignment' then return choice(value,{'source','inherit','left','right','center'},field) end
 if field=='alignment' then
  local aliases={l='left',c='center',r='right',left='left',center='center',right='right'}
  if value=='source' then return {} end
  local parts={}
  if type(value)=='table' then parts=value else for part in tostring(value):gmatch('[^,%s]+') do parts[#parts+1]=part end end
  if #parts>100 then common.fail('too many column alignments') end
  local result={}
  for _,part in ipairs(parts) do if not aliases[part] then common.fail('invalid column alignment') end;result[#result+1]=aliases[part] end
  return result
 end
 if field=='width' then
  if value=='auto' then return value end
  if type(value)=='number' then value=value..'%' end
  local n,unit=tostring(value):match('^([%d.]+)(%%?%a*)$')
  if unit=='%' or unit=='' then return number(n,0.000001,100,'table width')..'%' end
  local factors={pt=1,px=.75,['in']=72.27,cm=72.27/2.54,mm=72.27/25.4}
  if not factors[unit] then common.fail('invalid width unit') end
  return number(tonumber(n)*factors[unit],0.000001,1000,'table width')..'pt'
 end
 return value
end
local function resolve(t,options)
 local overrides={}
 local fields=clone(attribute_fields)
 for _,rule in ipairs(options.attributeSchema or {}) do for _,alias in ipairs(rule.aliases or {}) do fields[alias]=rule.field end end
 for _,class in ipairs(t.classes) do if presets[class] then overrides.preset=class end end
 for key,value in pairs(t.attributes) do
  local field=fields[key]
  if field then overrides[field]=value end
 end
 -- Canonical aliases are first in the shared schema, independently of the
 -- order attributes happen to appear in Pandoc's map.
 for _,rule in ipairs(options.attributeSchema or {}) do
  for _,alias in ipairs(rule.aliases or {}) do if t.attributes[alias]~=nil then overrides[rule.field]=t.attributes[alias];break end end
 end
 local active=options.enabled==true or next(overrides)~=nil or t.classes:includes('inkwell-generated-table')
 if not active then return nil end
 local styles=clone(fallback)
 for key,value in pairs(options.defaults or {}) do styles[key]=value end
 if overrides.preset then
  local preset=validate('preset',overrides.preset,options)
  styles.preset=preset
  local next_defaults=(options.presets or {})[preset]
  if next_defaults then for key,value in pairs(next_defaults) do styles[key]=value end
  else styles.preset=preset;styles.stripe=preset=='zebra';styles.density=preset=='compact' and 'compact' or 'normal' end
  for _,key in ipairs(options.explicit or {}) do styles[key]=(options.defaults or {})[key] end
 end
 for key,value in pairs(overrides) do
  if (options.supported or {})[key]==false then common.fail(key..' is owned by the '..(options.templateId or 'selected')..' template and cannot be overridden on a table') end
  local normalized=validate(key,value,options)
  local allowed=(options.allowed or {})[key]
  if allowed then
   local matched=false
   for _,candidate in ipairs(allowed) do if normalized==candidate then matched=true end end
   if not matched then common.fail(key..' is not supported by the selected template') end
  end
  styles[key]=normalized
 end
 if overrides.preset or overrides.density then
  local padding=(options.densityPadding or {normal={6,3},compact={3,1.5},comfortable={8,5}})[styles.density]
  local explicitly={}
  for _,key in ipairs(options.explicit or {}) do explicitly[key]=true end
  if padding then
   if not explicitly.paddingHorizontalPt and overrides.paddingHorizontalPt==nil then styles.paddingHorizontalPt=padding[1] end
   if not explicitly.paddingVerticalPt and overrides.paddingVerticalPt==nil then styles.paddingVerticalPt=padding[2] end
  end
 end
 for key,value in pairs(styles) do if value~=common.null then styles[key]=validate(key,value,options) else styles[key]=nil end end
 if ({rho=true,rmxaa=true,ludus=true,['hipster-cv']=true})[options.templateId] and styles.captionPosition~='above' then common.fail('this two-column table bridge requires caption position above') end
 styles.attributeAlignment=overrides.alignment~=nil
 return styles
end
local function prefix_cell(cell,prefix)
 if prefix=='' then return end
 local first=cell.contents[1]
 if first and (first.t=='Plain' or first.t=='Para') then first.content:insert(1,pandoc.RawInline('latex',prefix));cell.contents[1]=first
 else cell.contents:insert(1,pandoc.RawBlock('latex',prefix)) end
end
local marker_id=0
local function end_marker(cell)
 marker_id=marker_id+1
 local marker='\\inkwellTableRowMarker{'..marker_id..'}'
 local last=cell.contents[#cell.contents]
 if last and (last.t=='Plain' or last.t=='Para') then last.content:insert(pandoc.RawInline('latex',marker));cell.contents[#cell.contents]=last
 else cell.contents:insert(pandoc.RawBlock('latex',marker)) end
end
local function replace_spec(tex,spec)
 local _,last=tex:find('\\begin{longtable}%b[]%{')
 if not last then common.fail('this Pandoc writer did not produce the expected longtable structure') end
 local depth,pos=1,last+1
 while depth>0 do
  local char=tex:sub(pos,pos)
  if char=='' then common.fail('unterminated Pandoc column specification') end
  if char=='{' then depth=depth+1 elseif char=='}' then depth=depth-1 end
  pos=pos+1
 end
 return tex:sub(1,last)..spec..tex:sub(pos-1)
end
local function numeric_value(value)
 value=value:match('^%s*(.-)%s*$')
 if value=='' then return false end
 value=value:gsub('%%$','')
 local exponent=value:find('[eE]')
 if exponent then
  if not value:sub(exponent+1):match('^[+-]?%d+$') then return false end
  value=value:sub(1,exponent-1)
 end
 value=value:gsub('^[+-]','')
 local integer,fraction=value:match('^(.-)%.(.*)$')
 if integer then if fraction~='' and not fraction:match('^%d+$') then return false end else integer=value end
 if integer=='' then return fraction~=nil and fraction~='' end
 if integer:find(',') then
  local first,rest=integer:match('^(%d%d?%d?)(,.*)$')
  if not first then return false end
  while #rest>0 do
   if not rest:sub(1,4):match('^,%d%d%d$') then return false end
   rest=rest:sub(5)
  end
  return true
 end
 return integer:match('^%d+$')~=nil
end
local function numeric_columns(t)
 local valid,seen={},{}
 for i=1,#t.colspecs do valid[i]=true end
 for _,body in ipairs(t.bodies) do for _,row in ipairs(body.body) do
  local column=1
  for _,cell in ipairs(row.cells) do
   local parts={}
   local plain=true
   if cell.row_span>1 or cell.col_span>1 then plain=false end
   for _,block in ipairs(cell.contents) do
    if block.t~='Plain' and block.t~='Para' then plain=false;break end
    for _,inline in ipairs(block.content) do
     if inline.t=='Str' then parts[#parts+1]=inline.text elseif inline.t=='Space' then parts[#parts+1]=' ' else plain=false;break end
    end
   end
   local value=table.concat(parts):match('^%s*(.-)%s*$')
   for i=column,column+cell.col_span-1 do
    if not plain then valid[i]=false elseif value~='' then seen[i]=true;if not numeric_value(value) then valid[i]=false end end
   end
   column=column+cell.col_span
  end
 end end
 for i=1,#t.colspecs do valid[i]=valid[i] and seen[i] end
 return valid
end
local function render(t,style,options)
 local n=#t.colspecs
 if n==0 then return t end
 local width_only=(options.supported or {}).preset==false
 local numeric=numeric_columns(t)
 local grid=not width_only and style.preset=='grid'
 local is_plain=not width_only and style.preset=='plain'
 local body_row=0
 local function decorate(rows,header)
  for _,row in ipairs(rows) do
   if not header then body_row=body_row+1 end
   for _,cell in ipairs(row.cells) do
    if grid and (cell.row_span>1 or cell.col_span>1) then common.fail('grid rules for merged cells are not supported; choose booktabs or plain for this table') end
    local background=header and style.headerBackground or (not header and style.stripe and body_row%2==0 and style.stripeColor or nil)
    local prefix=''
    local background_color=background and color(background,'background',options) or nil
    if background_color then prefix=prefix..'\\cellcolor[HTML]{'..background_color..'}' end
    if header then prefix=prefix..(style.headerWeight=='bold' and '\\bfseries ' or '\\mdseries ') end
    prefix_cell(cell,prefix)
    local padding=style.paddingVerticalPt or 0
    if padding>0 then
     cell.contents:insert(1,pandoc.RawBlock('latex','\\kern'..padding..'pt'))
     cell.contents:insert(pandoc.RawBlock('latex','\\inkwellCellPaddingEnd{'..padding..'}'))
    end
   end
   if grid and #row.cells>0 then end_marker(row.cells[#row.cells]) end
  end
 end
 if not width_only then
 decorate(t.head.rows,true)
 for _,body in ipairs(t.bodies) do decorate(body.head,true);decorate(body.body,false) end
 decorate(t.foot.rows,false)
 end
 if style.captionStyle=='italic' then
  for _,block in ipairs(t.caption.long) do if block.t=='Plain' or block.t=='Para' then block.content={pandoc.Emph(block.content)} end end
 end
 local width=style.width or 'auto'
 local dimension='\\linewidth'
 if width:match('%%$') then dimension='('..tonumber(width:sub(1,-2))/100 ..'\\linewidth)'
 elseif width~='auto' then dimension=width end
 local fractions,total={},0
 for i,spec in ipairs(t.colspecs) do fractions[i]=spec[2] or 0;total=total+fractions[i] end
 if total<=0 then for i=1,n do fractions[i]=1/n end else for i=1,n do fractions[i]=fractions[i]/total end end
 local alignment_map={left=pandoc.AlignLeft,right=pandoc.AlignRight,center=pandoc.AlignCenter}
 for i,spec in ipairs(t.colspecs) do
  local align
  if type(style.alignment)=='table' then align=style.alignment[i] else align=style.alignment end
  local source=tostring(spec[1])~='AlignDefault'
  if align and (style.attributeAlignment or not source) then spec[1]=alignment_map[align] or common.fail('invalid column alignment')
  elseif not source and not align and style.numericAlignment~='source' and style.numericAlignment~='inherit' and numeric[i] then spec[1]=alignment_map[style.numericAlignment] end
  spec[2]=fractions[i];t.colspecs[i]=spec
 end
 -- Construct fresh fragment options. Assigning nil to an inherited template
 -- does not clear Pandoc's compiled template on all supported versions.
 local writer_options=pandoc.WriterOptions(PANDOC_WRITER_OPTIONS)
 writer_options.template=pandoc.template.compile('$body$')
 writer_options.wrap_text='none'
 -- Feature-probe the writer option: earlier Pandoc versions retain the
 -- default above position and receive an actionable error for below.
 local caption_option=pcall(function() writer_options.table_caption_position=style.captionPosition end)
 if not caption_option and style.captionPosition=='below' then common.fail('this Pandoc version cannot place table captions below; update Pandoc or choose above') end
 local tex=pandoc.write(pandoc.Pandoc({t}),'latex',writer_options)
 local specs={}
 for i,spec in ipairs(t.colspecs) do
  local align=tostring(spec[1]);local command=align=='AlignRight' and '\\raggedleft' or align=='AlignCenter' and '\\centering' or '\\raggedright'
  local padding=(width_only and 2*(n-1) or 2*n)..'\\tabcolsep'
  local rules=grid and (' - '..(n+1)..'\\arrayrulewidth') or ''
  specs[#specs+1]='>{'..command..'\\arraybackslash}p{('..dimension..' - '..padding..rules..') * \\real{'..string.format('%.8f',fractions[i])..'}}'
 end
 local edge=grid and '|' or (width_only and '@{}' or '')
 tex=replace_spec(tex,edge..table.concat(specs,grid and '|' or '')..edge)
 if grid then
  tex=tex:gsub('\\inkwellTableRowMarker{%d+}(%s*\\end{minipage}%s*\\\\)','%1\\hline')
  tex=tex:gsub('\\inkwellTableRowMarker{%d+}(%s*\\\\)','%1\\hline')
  if tex:find('\\inkwellTableRowMarker') then common.fail('unsupported writer row boundary; choose booktabs for this table') end
  tex=tex:gsub('\\toprule\\noalign{}','\\hline'):gsub('\\midrule\\noalign{}',''):gsub('\\bottomrule\\noalign{}','')
 elseif is_plain then tex=tex:gsub('\\toprule\\noalign{}',''):gsub('\\midrule\\noalign{}',''):gsub('\\bottomrule\\noalign{}','') end
 if width_only then return pandoc.RawBlock('latex','\\begingroup\n% Inkwell bounded table width; template presentation preserved.\n'..tex..'\n\\endgroup') end
 -- A multiline cell may get a writer-owned trailing strut. Keep it from
 -- creating an empty extra line after our terminal padding marker.
 tex=tex:gsub('\\inkwellCellPaddingEnd{([%d.]+)}%s*\\strut','\\par\\kern%1pt')
 tex=tex:gsub('\\inkwellCellPaddingEnd{([%d.]+)}','\\par\\kern%1pt')
 local before={'\\begingroup','% Inkwell native body-table scope',
  '\\makeatletter\\let\\inkwellSavedRuleColor\\CT@arc@\\makeatother',
  '\\setlength{\\tabcolsep}{'..style.paddingHorizontalPt..'pt}\\renewcommand{\\arraystretch}{1}',
  '\\setlength{\\arrayrulewidth}{'..style.ruleThicknessPt..'pt}\\setlength{\\heavyrulewidth}{'..style.ruleThicknessPt..'pt}\\setlength{\\lightrulewidth}{'..style.ruleThicknessPt..'pt}',
  '\\arrayrulecolor[HTML]{'..(color(style.ruleColor,'rule',options) or '000000')..'}'}
 if (options.supported or {}).fontSizePt~=false then before[#before+1]='\\def\\baselinestretch{1}\\fontsize{'..style.fontSizePt..'pt}{'..(style.fontSizePt*1.2)..'pt}\\selectfont' end
 -- The existing float bridges append a bottomrule; keep their behavior local.
 if is_plain then before[#before+1]='\\let\\bottomrule\\relax' end
 local after='\\makeatletter\\global\\let\\CT@arc@\\inkwellSavedRuleColor\\makeatother\n\\endgroup'
 return pandoc.RawBlock('latex',table.concat(before,'\n')..'\n'..tex..'\n'..after)
end
function Pandoc(doc)
 if not FORMAT:match('latex') then return doc end
 local options={}
 if doc.meta['inkwell-table-options'] then
  local encoded=pandoc.utils.stringify(doc.meta['inkwell-table-options'])
  if encoded:sub(1,4)=='hex:' then
   encoded=encoded:sub(5)
   if #encoded%2~=0 or encoded:find('[^%x]') then common.fail('invalid encoded table options') end
   encoded=encoded:gsub('%x%x',function(byte) return string.char(tonumber(byte,16)) end)
  end
  options=common.decode(encoded)
 end
 if next(options) and options.schemaVersion~=1 then common.fail('unsupported table options schemaVersion') end
 local changed=false
 local feature_tables=pandoc.List()
 doc=doc:walk({Table=function(t)
  t=common.caption_attributes(t)
  local style=resolve(t,options)
  if not style then return t end
  -- The outer writer sees RawBlock after conversion. Retain its feature
  -- metadata so an image or highlighted block occurring only in a table
  -- still receives the template's normal package and macro definitions.
  feature_tables:insert(t:clone())
  changed=true;return render(t,style,options)
 end})
 if changed then
  local has_code=false
  pandoc.Pandoc(feature_tables):walk({
   Image=function() doc.meta.graphics=true end,
   CodeBlock=function() has_code=true end,
   Code=function(code) if #code.classes>0 then has_code=true end end,
  })
  if has_code then
   local feature_options=pandoc.WriterOptions(PANDOC_WRITER_OPTIONS)
   feature_options.template=pandoc.template.compile('$highlighting-macros$')
   local macros=pandoc.write(pandoc.Pandoc(feature_tables),'latex',feature_options)
   if macros~='' then doc.meta['highlighting-macros']=pandoc.MetaBlocks({pandoc.RawBlock('latex',macros)}) end
  end
  local includes=doc.meta['header-includes']
  if not includes then includes=pandoc.MetaList({}) elseif includes.t~='MetaList' then includes=pandoc.MetaList({includes}) end
  includes:insert(pandoc.MetaBlocks({pandoc.RawBlock('latex','% Inkwell semantic body tables: packages precede body-local assignments.\n\\usepackage{array,booktabs,longtable,calc,colortbl}')}))
  doc.meta['header-includes']=includes
 end
 return doc
end
