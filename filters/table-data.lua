-- Run before pandoc-crossref so generated tables get ordinary captions/labels.
local directory = PANDOC_SCRIPT_FILE:match('^(.*[/\\])') or ''
local common = dofile(directory .. 'table-common.lua')
local function cell(value)
  if type(value)~='string' then common.fail('data cells must be strings') end
  return pandoc.Cell({pandoc.Plain(common.literal(value))})
end
local function decode(block)
  if not block.classes:includes('inkwell-table-data') then return block end
  if #block.text>12*1024*1024 then common.fail('data payload exceeds the 12 MiB limit') end
  local data=common.decode(block.text)
  if not common.is_object(data) or data.schemaVersion~=1 then common.fail('unsupported data schemaVersion; expected 1') end
  if not common.is_array(data.headers) or #data.headers==0 then common.fail('data table needs at least one header column') end
  if not common.is_array(data.rows) then common.fail('data rows must be an array') end
  if #data.headers>256 or #data.rows>10000 or (#data.rows+1)*#data.headers>50000 then common.fail('data table exceeds the row, column, or cell limit') end
  local head,specs={},{}
  for _,value in ipairs(data.headers) do head[#head+1]=cell(value);specs[#specs+1]={pandoc.AlignDefault} end
  local rows={}
  for number,row in ipairs(data.rows) do
    if not common.is_array(row) or #row~=#head then common.fail('data row '..number..' has a different column width from the header') end
    local cells={};local record_size=0
    for _,value in ipairs(row) do cells[#cells+1]=cell(value);record_size=record_size+#value end
    if record_size>1024*1024 then common.fail('data record exceeds the 1 MiB limit') end
    rows[#rows+1]=pandoc.Row(cells)
  end
  if data.caption~=nil and type(data.caption)~='string' then common.fail('caption must be a string') end
  if data.label~=nil and (type(data.label)~='string' or not data.label:match('^tbl:[%w_.:%-]+$')) then common.fail('label must be a safe tbl: identifier') end
  local attrs={}
  if data.attributes~=nil then
    if not common.is_object(data.attributes) then common.fail('attributes must be an object') end
    for key,value in pairs(data.attributes) do
      if type(key)~='string' or type(value)~='string' then common.fail('attributes must contain string values') end
      attrs[key]=value
    end
  end
  -- Caption comes from document metadata and remains Markdown; data cells
  -- above are literal strings and never pass through a Markdown reader.
  local caption=data.caption and pandoc.read(data.caption,'markdown+raw_tex+citations').blocks or {}
  local body={attr=pandoc.Attr(),row_head_columns=0,head={},body=rows}
  return pandoc.Table(caption,specs,pandoc.TableHead({pandoc.Row(head)}),{body},pandoc.TableFoot({}),pandoc.Attr(data.label or '',{'inkwell-generated-table'},attrs))
end
function Pandoc(doc)
  return doc:walk({CodeBlock=decode,Table=common.caption_attributes})
end
