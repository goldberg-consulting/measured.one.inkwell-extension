-- Shared by the two ordered table passes. Uses only the Pandoc 2.17 Lua API.
-- JSON is parsed locally so older supported Pandoc versions need no external module.
local M = {}
function M.fail(message) error('Inkwell table: ' .. message, 0) end
function M.decode(text)
  if type(text) ~= 'string' then M.fail('expected JSON text') end
  local pos, length = 1, #text
  local function skip() local _, last = text:find('^%s*', pos); pos = (last or pos - 1) + 1 end
  local parse
  local function string_value()
    pos = pos + 1
    local parts = {}
    while pos <= length do
      local char = text:sub(pos, pos); pos = pos + 1
      if char == '"' then return table.concat(parts) end
      if char == '\\' then
        local escape = text:sub(pos, pos); pos = pos + 1
        local simple = { ['"']='"', ['\\']='\\', ['/']='/', b='\b', f='\f', n='\n', r='\r', t='\t' }
        if simple[escape] then parts[#parts+1] = simple[escape]
        elseif escape == 'u' then
          local hex = text:sub(pos, pos+3)
          if not hex:match('^%x%x%x%x$') then M.fail('invalid JSON Unicode escape') end
          local cp = tonumber(hex,16); pos = pos + 4
          if cp >= 0xD800 and cp <= 0xDBFF then
            local low = text:sub(pos, pos+5)
            if not low:match('^\\u%x%x%x%x$') then M.fail('missing JSON low surrogate') end
            local other = tonumber(low:sub(3),16)
            if other < 0xDC00 or other > 0xDFFF then M.fail('invalid JSON low surrogate') end
            cp = 0x10000 + (cp-0xD800)*0x400 + other-0xDC00; pos = pos + 6
          elseif cp >= 0xDC00 and cp <= 0xDFFF then M.fail('invalid JSON surrogate') end
          parts[#parts+1] = utf8.char(cp)
        else M.fail('invalid JSON escape') end
      elseif char:byte() < 32 then M.fail('unescaped control character in JSON')
      else parts[#parts+1] = char end
    end
    M.fail('unterminated JSON string')
  end
  parse = function(depth)
    if depth > 64 then M.fail('JSON nesting is too deep') end
    skip(); local char = text:sub(pos,pos)
    if char == '"' then return string_value() end
    if char == '{' or char == '[' then
      local object = char == '{'; local result, seen = setmetatable({}, {__jsonKind=char=='{' and 'object' or 'array'}), {}; pos = pos + 1; skip()
      local closing = object and '}' or ']'
      if text:sub(pos,pos) == closing then pos=pos+1; return result end
      while true do
        local key
        if object then
          skip(); if text:sub(pos,pos) ~= '"' then M.fail('JSON object key must be a string') end
          key=string_value(); skip()
          if seen[key] then M.fail('duplicate JSON key: '..key) end
          seen[key]=true
          if text:sub(pos,pos) ~= ':' then M.fail('missing JSON colon') end
          pos=pos+1
        else key=#result+1 end
        result[key]=parse(depth+1); skip()
        local delimiter=text:sub(pos,pos); pos=pos+1
        if delimiter==closing then return result end
        if delimiter~=',' then M.fail('invalid JSON delimiter') end
      end
    end
    for token,value in pairs({['true']=true,['false']=false}) do
      if text:sub(pos,pos+#token-1)==token then pos=pos+#token; return value end
    end
    if text:sub(pos,pos+3)=='null' then pos=pos+4; return M.null end
    local token=text:match('^-?%d+%.?%d*[eE]?[+-]?%d*',pos)
    if token then
      local value=tonumber(token)
      if value and value==value and value~=math.huge and value~=-math.huge and not token:match('^-?0%d') and not token:match('%.$') then pos=pos+#token; return value end
    end
    M.fail('invalid JSON value at byte '..pos)
  end
  local result=parse(0); skip()
  if pos<=length then M.fail('trailing JSON data') end
  return result
end
function M.is_array(value) return type(value)=='table' and getmetatable(value) and getmetatable(value).__jsonKind=='array' end
function M.is_object(value) return type(value)=='table' and getmetatable(value) and getmetatable(value).__jsonKind=='object' end
M.null = {} -- Keeps array indexes intact until schema validation rejects null cells.
function M.literal(text)
  local result = {}
  text = text:gsub('\r\n','\n'):gsub('\r','\n')
  local first = true
  for line in (text .. '\n'):gmatch('(.-)\n') do
    if not first then result[#result+1]=pandoc.LineBreak() end
    result[#result+1]=pandoc.Str(line)
    first=false
  end
  return result
end
function M.attributes(text)
  local attrs, classes, identifier = {}, {}, ''
  local pos=1
  while pos<=#text do
    local _,last=text:find('^%s*',pos);pos=(last or pos-1)+1
    if pos>#text then break end
    local char=text:sub(pos,pos)
    if char=='#' or char=='.' then
      local token=text:match('^[^%s]+',pos+1)
      if not token then M.fail('empty caption attribute') end
      if char=='#' then identifier=token else classes[#classes+1]=token end
      pos=pos+1+#token
    else
      local key=text:match('^[%w_-]+',pos)
      if not key then M.fail('invalid caption attribute') end
      pos=pos+#key
      if text:sub(pos,pos)~='=' then M.fail('caption attributes require key=value') end
      pos=pos+1
      local quote=text:sub(pos,pos);local value
      if quote=='"' or quote=="'" then
        local ending=text:find(quote,pos+1,true)
        if not ending then M.fail('unterminated caption attribute') end
        value=text:sub(pos+1,ending-1);pos=ending+1
      else value=text:match('^[^%s]+',pos);pos=pos+#(value or '') end
      attrs[key]=value or ''
    end
  end
  return identifier,classes,attrs
end
-- Older readers leave trailing caption attributes as ordinary inline text.
-- Consume only that plain suffix, retaining rich caption nodes byte-for-node.
function M.caption_attributes(t)
  local blocks=t.caption.long
  if #blocks==0 then return t end
  local last=blocks[#blocks]
  if last.t~='Plain' and last.t~='Para' then return t end
  local inlines=last.content
  local first=#inlines+1
  local pieces={}
  for i=#inlines,1,-1 do
    local inline=inlines[i]
    if inline.t=='Str' then table.insert(pieces,1,inline.text)
    elseif inline.t=='Space' or inline.t=='SoftBreak' then table.insert(pieces,1,' ')
    else break end
    first=i
  end
  local tail=table.concat(pieces)
  local prefix,raw=tail:match('^(.-){([^{}]-)}%s*$')
  if not raw or not (raw:match('#tbl:') or raw:match('table%-') or raw:match('%.booktabs') or raw:match('%.grid') or raw:match('%.plain') or raw:match('%.zebra') or raw:match('%.compact')) then return t end
  raw=raw:gsub('“','"'):gsub('”','"'):gsub('‘',"'"):gsub('’',"'")
  local identifier,classes,attrs=M.attributes(raw)
  if identifier~='' and t.identifier=='' then t.identifier=identifier end
  for _,class in ipairs(classes) do t.classes:insert(class) end
  for key,value in pairs(attrs) do if t.attributes[key]==nil then t.attributes[key]=value end end
  -- Remove the suffix from the end, retaining the exact leading inline nodes.
  local keep=#prefix:gsub('%s+$','')
  local result={}
  for i=1,first-1 do result[#result+1]=inlines[i] end
  for i=first,#inlines do
    local inline=inlines[i]
    local value=inline.t=='Str' and inline.text or ' '
    if keep>=#value then result[#result+1]=inline;keep=keep-#value
    elseif keep>0 then result[#result+1]=pandoc.Str(value:sub(1,keep));keep=0 end
  end
  last.content=result
  if #result==0 then blocks:remove(#blocks) else blocks[#blocks]=last end
  t.caption.long=blocks
  return t
end
return M
