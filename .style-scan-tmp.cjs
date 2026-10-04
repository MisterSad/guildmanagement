const fs=require('fs'),path=require('path');
const walk=(d,o=[])=>{for(const e of fs.readdirSync(d)){const p=path.join(d,e);fs.statSync(p).isDirectory()?walk(p,o):(/\.(ts|js)$/.test(p)&&o.push(p));}return o;};
let total=0,stat=0,dyn=0;const perFile={};const dynSamples=[];
for(const f of walk('src')){const s=fs.readFileSync(f,'utf8');
  for(const m of s.matchAll(/style=(\\?["'])/g)){total++;perFile[f]=(perFile[f]||0)+1;
    // find the attribute value up to the matching quote char; dynamic if a JS concat/template appears inside
    const q=m[1].replace('\\\\','');const start=m.index+m[0].length;const rest=s.slice(start,start+400);
    const end=rest.indexOf(q==='"'?'"':"'");const val=end>=0?rest.slice(0,end):rest;
    if(/'\s*\+|\+\s*'|\$\{|`/.test(val)){dyn++; if(dynSamples.length<25) dynSamples.push(path.relative('.',f)+': '+val.slice(0,110));} else stat++; }}
console.log({total,stat,dyn});
console.log(Object.entries(perFile).sort((a,b)=>b[1]-a[1]).map(([f,n])=>n+' '+path.relative('.',f)).join('\n'));
console.log('--- dynamic samples'); console.log(dynSamples.join('\n'));
