const XLSX=require('xlsx');const fs=require('fs');
const dir='C:/Users/edget/Downloads/';
const D=(c)=>(c<0?'-':'')+'$'+(Math.abs(c)/100).toLocaleString(undefined,{minimumFractionDigits:2});
// find all xls that are Waterview, classify by report type
const files=fs.readdirSync(dir).filter(f=>/\.(xls|xlsx)$/i.test(f));
const wv=[];
for(const f of files){
  try{const wb=XLSX.readFile(dir+f);const rows=XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{header:1,defval:null,raw:false});
  const a=String((rows[0]||[])[0]||'');const t=String((rows[1]||[])[0]||'');
  if(/Waterview/i.test(a)) wv.push({f,type:t.slice(0,55)});}catch(e){}
}
console.log('Waterview files on disk:');
wv.forEach(x=>console.log(`  ${x.f}  ::  ${x.type}`));
// check Waterview full-2025 conversion date + fund structure from a balance sheet if present
