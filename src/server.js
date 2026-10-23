import { randomUUID, createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile, rename, cp } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TripoClient } from '@vastai/tripo-sdk';
import YAML from 'js-yaml';
import sharp from 'sharp';
import { zipSync } from 'fflate';
import { MODEL_VERSIONS, IMAGE_SIZES, TEXTURE_QUALITIES, runPipeline } from './pipeline.js';
import { generationPlan, TRIPO_VIEW_ORDER } from './sheet.js';
import { REMOVAL_MODES, PROMPT_PROFILES } from './prompts.js';
import { checkSelectedViews } from './quality.js';
import { validateReview, benchmarkSummary } from './benchmark.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const HOST = process.env.TRIPO_HEAD_HOST ?? '127.0.0.1';
const PORT = Number(process.env.TRIPO_HEAD_PORT ?? 8771);
const JOBS = path.resolve(process.env.TRIPO_HEAD_JOBS ?? path.join(ROOT,'jobs'));
const CONFIG = process.env.TRIPO_HEAD_CONFIG ?? path.join(ROOT,'config.local.yaml');
let config = {};
try { config = YAML.load(await readFile(CONFIG,'utf8')) ?? {}; }
catch (e) { if (e.code !== 'ENOENT') throw new Error('配置文件格式错误'); }
const regions = Object.fromEntries(['cn','overseas'].map(id => {
  const r=config.regions?.[id] ?? {};
  const key=process.env[`TRIPO_${id.toUpperCase()}_API_KEY`] ?? r.api_key;
  const base=process.env[`TRIPO_${id.toUpperCase()}_BASE_URL`] ?? r.base_url;
  const valid=key && !/^(YOUR_|CHANGE_|replace|example)/i.test(key);
  return [id,{ label:r.label ?? (id==='cn'?'国内':'海外'), key:valid?key:null,
    client:valid ? new TripoClient({ apiKey:key, retries:0, ...(base?{baseUrl:base}:{}) }) : null }];
}));
const jobs=new Map(), active=new Map(), waiters=new Map(), writes=new Map();
let creationTail=Promise.resolve();
async function serializedCreate(req,res,q){const previous=creationTail;let release;creationTail=new Promise(r=>release=r);await previous;try{await create(req,res,q);}finally{release();}}
let benchmarkCases=[];
try{benchmarkCases=JSON.parse(await readFile(path.join(JOBS,'benchmark-cases.json'),'utf8'));}catch{}
const MAX=20*1024*1024;
const idValid=id=>/^[a-zA-Z0-9_-]{1,80}$/.test(id);
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.json':'application/json',
 '.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.hdr':'application/octet-stream',
 '.glb':'model/gltf-binary','.wasm':'application/wasm'};
const cleanError=e=>{
  let msg=String(e?.message ?? e);
  for(const r of Object.values(regions)) if(r.key) msg=msg.split(r.key).join('[redacted]');
  return msg.slice(0,1500);
};
function send(res,status,data){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data));}
async function body(req){let n=0;const chunks=[];for await(const c of req){n+=c.length;if(n>MAX)throw Object.assign(new Error('上传不能超过20MB'),{status:413});chunks.push(c);}return Buffer.concat(chunks);}
function resolveFile(root,name){const f=path.resolve(root,name);if(!f.startsWith(path.resolve(root)+path.sep))throw Object.assign(new Error('文件不存在'),{status:404});return f;}
async function file(res,f){const s=await stat(f);if(!s.isFile())throw Object.assign(new Error('文件不存在'),{status:404});res.writeHead(200,{'Content-Type':mime[path.extname(f).toLowerCase()]??'application/octet-stream','Content-Length':s.size,'X-Content-Type-Options':'nosniff'});createReadStream(f).pipe(res);}
async function persist(job,patch={}){
 Object.assign(job,patch,{updated_at:new Date().toISOString()});
 const snapshot=JSON.stringify(job,null,2),folder=path.join(JOBS,job.id);
 const pending=(writes.get(job.id)??Promise.resolve()).catch(()=>{}).then(async()=>{
  await mkdir(folder,{recursive:true});await writeFile(path.join(folder,'job.tmp'),snapshot);await rename(path.join(folder,'job.tmp'),path.join(folder,'job.json'));
 });writes.set(job.id,pending);await pending;
}
function modelOptions(data={}){
 const o={modelVersion:data.model??'h3.1',texture:data.texture??true,textureQuality:data.texture_quality??'detailed'};
 if(!Object.hasOwn(MODEL_VERSIONS,o.modelVersion))throw new Error('未知模型版本');
 if(typeof o.texture!=='boolean'||!TEXTURE_QUALITIES.includes(o.textureQuality))throw new Error('贴图配置无效');
 if(data.face_limit!==undefined&&data.face_limit!==null&&data.face_limit!==''){
  o.faceLimit=Number(data.face_limit);if(!Number.isInteger(o.faceLimit)||o.faceLimit<1000||o.faceLimit>2000000)throw new Error('面数范围为1000–2000000');
 }return o;
}
function options(q){
 const o={inputMode:q.get('input_mode')??'concept',region:q.get('region')??'cn',removal:q.get('removal')??'keep',imageSize:q.get('image_size')??'2K',swapSides:q.get('swap_sides')==='1',
  promptProfile:q.get('prompt_profile')??'baseline',
  ...modelOptions({model:q.get('model')??undefined,texture:q.get('texture')!=='0',texture_quality:q.get('texture_quality')??undefined,face_limit:q.get('face_limit')})};
 if(!['concept','sheet'].includes(o.inputMode)||!Object.hasOwn(regions,o.region)||!REMOVAL_MODES.includes(o.removal)||!IMAGE_SIZES.includes(o.imageSize)||!PROMPT_PROFILES.includes(o.promptProfile))throw new Error('输入选项无效');
 if(q.has('layout')){o.layout=q.get('layout').split(',');if(o.layout.length!==4||new Set(o.layout).size!==4||o.layout.some(v=>!TRIPO_VIEW_ORDER.includes(v)))throw new Error('四宫格视角不能重复或缺失');}
 return o;
}
async function launch(job){
 if(active.has(job.id))return;
 const promise=(async()=>{
  const dir=path.join(JOBS,job.id);
  try{
   await persist(job,{status:'running',error:null});
   await runPipeline({client:regions[job.options.region]?.client,reference:{data:await readFile(path.join(dir,job.files.reference)),filename:job.files.reference,contentType:'image/png'},
    options:job.options,dir,state:structuredClone(job),update:p=>persist(job,p),
    chooseViews:()=>new Promise((resolve,reject)=>{waiters.set(job.id,resolve);persist(job,{status:'awaiting_views',stage:'choose',progress:0}).catch(reject);})});
   await persist(job,{status:'done',stage:'done',progress:100});
  }catch(e){waiters.delete(job.id);await persist(job,{status:job.submission_pending?'needs_attention':'failed',error:cleanError(e)});}
 })();active.set(job.id,promise);promise.catch(e=>console.error('任务状态保存失败：'+cleanError(e))).finally(()=>active.delete(job.id));
}
async function create(req,res,q){
 let o;try{o=options(q);}catch(e){return send(res,400,{error:cleanError(e)});}
 if(o.inputMode==='concept'&&!regions[o.region].client)return send(res,503,{error:'未配置生成服务。可直接导入已有四宫格或预览本地GLB。'});
 if(!['image/png','image/jpeg','image/webp'].includes((req.headers['content-type']??'').split(';')[0]))return send(res,415,{error:'只支持PNG/JPEG/WebP'});
 const bytes=await body(req);let png;
 const sourceHash=createHash('sha256').update(bytes).digest('hex');
 let benchmark;
 if(q.has('case_id')){
  const caseId=q.get('case_id'),group=q.get('group'),repeat=Number(q.get('repeat'));
  const c=benchmarkCases.find(c=>c.id===caseId);
  if(!c||c.sha256!==sourceHash||!idValid(group??'')||!Number.isInteger(repeat)||repeat<1||repeat>10)return send(res,400,{error:'样本、源图哈希或重复编号无效'});
  const goal=q.get('goal')??'model';if(!['model','sheet'].includes(goal))return send(res,400,{error:'试验目标无效'});
  benchmark={case_id:caseId,group,repeat,label:c.label,tags:c.tags,goal};
  const existing=[...jobs.values()].find(j=>j.benchmark?.case_id===caseId&&j.benchmark.group===group&&j.benchmark.repeat===repeat);
  if(existing){if(JSON.stringify(existing.initial_options??existing.options)!==JSON.stringify(o)||(existing.benchmark.goal??'model')!==goal)return send(res,409,{error:'同一试验编号已有不同配置，请使用新的组名'});return send(res,200,{id:existing.id,reused:true});}
 }
 try{const image=sharp(bytes,{limitInputPixels:40_000_000});const meta=await image.metadata();if(!['png','jpeg','webp'].includes(meta.format)||meta.width<64||meta.height<64)throw new Error();png=await image.rotate().png().toBuffer();}
 catch{return send(res,400,{error:'图片无效、过小或超过4000万像素'});}
 const id=randomUUID(),dir=path.join(JOBS,id);await mkdir(dir,{recursive:true});await writeFile(path.join(dir,'reference.png'),png);
 const job={id,status:'running',stage:'upload',progress:0,options:o,initial_options:structuredClone(o),files:{reference:'reference.png'},tasks:{},
  source_sha256:sourceHash,...(benchmark?{benchmark}:{}),created_at:new Date().toISOString()};
 jobs.set(id,job);await persist(job);launch(job);send(res,202,{id});
}
async function continueJob(req,res,job){
 if(job.status!=='awaiting_views')return send(res,409,{error:'任务当前不在等待视图确认'});
 let d,o;try{d=JSON.parse((await body(req)).toString());generationPlan(d.views,{swapSides:d.swap_sides});
  o=modelOptions({model:d.model??job.options.modelVersion,texture:d.texture??job.options.texture,texture_quality:d.texture_quality??job.options.textureQuality,face_limit:d.face_limit??job.options.faceLimit});
 }catch(e){return send(res,400,{error:cleanError(e)});}
 if(!regions[job.options.region]?.client)return send(res,503,{error:'未配置该生成服务的API Key，视图已保存。'});
 try{checkSelectedViews(job.quality,d.views);}catch(e){return send(res,422,{error:cleanError(e)});}
 if(job.quality?.warnings?.length&&!d.quality_ack)return send(res,422,{error:'存在四视图检查提醒，请核对后确认继续。'});
 Object.assign(job.options,o,{views:d.views,swapSides:typeof d.swap_sides==='boolean'?d.swap_sides:job.options.swapSides});
 await persist(job,{status:'running',stage:'model',sheet_review:{acknowledged:true,reviewer_type:d.reviewer_type==='agent'?'agent':'human',notes:String(d.sheet_notes??'').slice(0,2000),at:new Date().toISOString()}});
 const resume=waiters.get(job.id);waiters.delete(job.id);
 if(resume)resume(d.views);else launch(job);
 send(res,202,{id:job.id});
}
await mkdir(JOBS,{recursive:true});
if(process.env.TRIPO_HEAD_SEED_EXAMPLE!=='0'){
 const sample=path.join(ROOT,'assets/examples/male2');
 try{await stat(path.join(JOBS,'example-male2','job.json'));}
 catch(e){if(e.code==='ENOENT'){try{await cp(sample,path.join(JOBS,'example-male2'),{recursive:true});}catch(e){console.error('示例加载失败：'+cleanError(e));}}}
}
for(const id of await readdir(JOBS)){
 if(!idValid(id))continue;
 try{const job=JSON.parse(await readFile(path.join(JOBS,id,'job.json'),'utf8'));if(job.id!==id||!job.options||!job.files)continue;jobs.set(id,job);
  if(job.status==='running'){
   const recoverable=job.tasks?.model||job.tasks?.face_sheet;
   await persist(job,{status:recoverable&&!job.submission_pending?'interrupted':'needs_attention',error:recoverable?'服务已重启，可恢复原任务查询。':'服务重启时请求状态未确认，未自动重复提交。'});
  }
 }catch{}
}

async function handle(req,res){
 const url=new URL(req.url,'http://localhost'),parts=url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
 if(url.pathname==='/favicon.ico'){res.writeHead(204);return res.end();}
 if(req.method==='POST'){
  const origin=req.headers.origin;if(origin&&origin!==`http://${req.headers.host}`&&origin!==`https://${req.headers.host}`)return send(res,403,{error:'拒绝跨站请求'});
 }
 if(req.method==='GET'&&url.pathname==='/api/health')return send(res,200,{ok:true,configured:Object.values(regions).some(r=>r.client),regions:Object.fromEntries(Object.entries(regions).map(([id,r])=>[id,{label:r.label,configured:!!r.client}]))});
 if(req.method==='GET'&&url.pathname==='/api/jobs')return send(res,200,[...jobs.values()].sort((a,b)=>b.created_at.localeCompare(a.created_at)));
 if(req.method==='GET'&&url.pathname==='/api/benchmark'){
  const trials=[...jobs.values()].filter(j=>j.benchmark);
  return send(res,200,{cases:benchmarkCases,jobs:trials,summary:benchmarkSummary(trials),groups:Object.fromEntries([...new Set(trials.map(j=>j.benchmark.group))].map(g=>[g,benchmarkSummary(trials.filter(j=>j.benchmark.group===g))]))});
 }
 if(req.method==='POST'&&url.pathname==='/api/benchmark/cases'){
  let data;try{data=JSON.parse((await body(req)).toString());if(!Array.isArray(data)||data.length>100||new Set(data.map(c=>c.id)).size!==data.length||data.some(c=>!idValid(c.id??'')||!/^[a-f0-9]{64}$/.test(c.sha256??'')||typeof c.label!=='string'||!Array.isArray(c.tags)||c.tags.some(t=>typeof t!=='string'||t.length>100)))throw Error();}catch{return send(res,400,{error:'回归样本清单无效'});}
  if(benchmarkCases.some(c=>[...jobs.values()].some(j=>j.benchmark?.case_id===c.id)&&!data.some(n=>n.id===c.id&&n.sha256===c.sha256)))return send(res,409,{error:'已运行样本不可替换源图；请创建新样本编号'});
  benchmarkCases=data.map(c=>({id:c.id,label:c.label.slice(0,80),sha256:c.sha256,tags:c.tags}));await writeFile(path.join(JOBS,'benchmark-cases.json'),JSON.stringify(benchmarkCases,null,2));return send(res,200,{count:benchmarkCases.length});
 }
 if(req.method==='POST'&&url.pathname==='/api/jobs')return serializedCreate(req,res,url.searchParams);
 if(parts[0]==='api'&&parts[1]==='jobs'&&parts[2]){
  const job=jobs.get(parts[2]);if(!job)return send(res,404,{error:'任务不存在'});
  if(req.method==='GET'&&parts.length===3)return send(res,200,job);
  if(req.method==='POST'&&parts[3]==='review'&&parts.length===4){
   let review;try{review=validateReview(JSON.parse((await body(req)).toString()));}catch(e){return send(res,400,{error:cleanError(e)});}
   const field=review.reviewer_type==='agent'?'agent_review':'review';
   await persist(job,{[field]:review});return send(res,200,{id:job.id,[field]:review});
  }
  if(req.method==='POST'&&parts[3]==='continue'&&parts.length===4)return continueJob(req,res,job);
  if(req.method==='POST'&&parts[3]==='resume'&&parts.length===4){
   if(!['interrupted','failed'].includes(job.status)||(!job.tasks?.model&&!job.tasks?.face_sheet)||job.submission_pending)return send(res,409,{error:'没有可安全恢复的外部任务ID，未重复提交'});
   if(!regions[job.options.region]?.client)return send(res,503,{error:'未配置原服务凭证'});
   launch(job);return send(res,202,{id:job.id});
  }
  if(req.method==='GET'&&parts[3]==='files'&&parts.length===5&&Object.values(job.files).includes(parts[4]))return file(res,resolveFile(path.join(JOBS,job.id),parts[4]));
  if(req.method==='GET'&&parts[3]==='receipt'&&parts.length===4)return file(res,path.join(JOBS,job.id,'job.json'));
  if(req.method==='GET'&&parts[3]==='archive'&&parts.length===4){
   const data={'job.json':new Uint8Array(Buffer.from(JSON.stringify(job,null,2)))};
   for(const name of new Set(Object.values(job.files)))data[name]=new Uint8Array(await readFile(resolveFile(path.join(JOBS,job.id),name)));
   const zip=zipSync(data,{level:0});res.writeHead(200,{'Content-Type':'application/zip','Content-Disposition':`attachment; filename="head-${job.id}.zip"`});return res.end(Buffer.from(zip));
  }
  return send(res,404,{error:'接口不存在'});
 }
 if(req.method==='GET'){
  if(parts[0]==='vendor')return file(res,resolveFile(path.join(ROOT,'node_modules/three'),parts.slice(1).join('/')));
  if(parts[0]==='assets')return file(res,resolveFile(path.join(ROOT,'assets'),parts.slice(1).join('/')));
  return file(res,resolveFile(path.join(ROOT,'web'),url.pathname==='/'?'index.html':parts.join('/')));
 }return send(res,405,{error:'不支持的请求'});
}
const server=http.createServer((req,res)=>handle(req,res).catch(e=>{if(!res.headersSent)send(res,e.status??(e.code==='ENOENT'?404:500),{error:e.code==='ENOENT'?'文件不存在':cleanError(e)});else res.destroy();}));
server.listen(PORT,HOST,()=>console.log(`Head fallback ready: http://${HOST}:${PORT}`));
async function shutdown(){server.close();await Promise.allSettled([...writes.values()]);process.exit(0);}
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
