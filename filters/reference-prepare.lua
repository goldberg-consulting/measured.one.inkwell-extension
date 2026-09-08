local common=dofile(PANDOC_SCRIPT_FILE:match('(.*/)')..'reference-common.lua')
function Pandoc(doc) return common.prepare(doc) end
