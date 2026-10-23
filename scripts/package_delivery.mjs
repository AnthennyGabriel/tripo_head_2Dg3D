import {readFile,readdir,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {zipSync} from 'fflate';
const root=fileURLToPath(new URL('../',import.meta.url));
const out=process.argv[2]?path.resolve(process.argv[2]):path.join(root,'output');
await mkdir(out,{recursive:true});
const entries={},excluded=new Set(['node_modules','jobs','output','data','.env','config.yaml','config.local.yaml','.git']);
async function walk(dir,relative=''){
 for(const e of await readdir(dir,{withFileTypes:true})){
  if(excluded.has(e.name)||e.name.endsWith('.log')||(e.name.startsWith('.env')&&e.name!=='.env.example')||(e.name.startsWith('config.')&&e.name.endsWith('.yaml')&&e.name!=='config.example.yaml')||/\.(pem|key|p12|pfx|zip|tar|gz)$/i.test(e.name))continue;
  const rel=path.posix.join(relative,e.name),file=path.join(dir,e.name);
  if(e.isDirectory())await walk(file,rel);else entries['tripo-head-fallback/'+rel]=new Uint8Array(await readFile(file));
 }
}
await walk(root);const target=path.join(out,'tripo-head-fallback-source.zip');
await writeFile(target,zipSync(entries,{level:6}));console.log(target);
