const fs=require('node:fs');const path=require('node:path');
const root=__dirname;const zh=JSON.parse(fs.readFileSync(path.join(root,'src/js/languages/zh.json'),'utf8'));
const missing=new Map();let references=0;
function check(text,file,kind){text=text.trim();if(!/[A-Za-z]/.test(text)||text.includes('${')||text.includes('<')||text.length>300)return;references++;if(!zh[text]){const entry=missing.get(text)||{text,files:[],kind};if(entry.files.length<3)entry.files.push(path.relative(root,file));missing.set(text,entry);}}
function scan(file){const source=fs.readFileSync(file,'utf8');for(const match of source.matchAll(/alertify\.(?:error|success|warning|message)\(\s*(['"])((?:\\.|(?!\1)[^\r\n])*)\1/g))check(match[2].replace(/\\'/g,"'").replace(/\\"/g,'"'),file,'notification');for(const match of source.matchAll(/(?:title|name)\s*:\s*(['"])([^'"\r\n]+)\1/g))if(file.endsWith('config-menu.js'))check(match[2],file,'menu');for(const match of source.matchAll(/class=["'][^"']*\btrn\b[^"']*["'][^>]*>([^<]+)</g))check(match[1],file,'marked-text');}
function walk(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);if(entry.isDirectory()){if(!['languages','libs'].includes(entry.name))walk(file);}else if(entry.name.endsWith('.js'))scan(file);}}
walk(path.join(root,'src/js'));scan(path.join(root,'index.html'));
console.log(JSON.stringify({dictionaryKeys:Object.keys(zh).length,checkedLiteralReferences:references,missing:[...missing.values()]},null,2));
