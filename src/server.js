import { randomUUID, createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile, rename, cp } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TripoClient } from '@vastai/tripo-sdk';
import YAML from 'js-yaml';
import sharp from 'sharp';
import { TaskQueue } from './queue.js';
import { streamArchive } from './archive.js';
import { studioRoutes } from './studio.js';
import { MODEL_VERSIONS, IMAGE_SIZES, TEXTURE_QUALITIES, runPipeline } from './pipeline.js';
import { generationPlan, TRIPO_VIEW_ORDER } from './sheet.js';
import { REMOVAL_MODES, PROMPT_PROFILES } from './prompts.js';
import { checkSelectedViews, inspectGlb } from './quality.js';
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
const jobs=new Map(), writes=new Map();
const queue=new TaskQueue(Math.min(4,Math.max(1,Math.floor(Number(process.env.TRIPO_HEAD_CONCURRENCY)||2))),execute);
const studio=studioRoutes({jobs,JOBS,send,body,persist,launch,queue,regions,options});
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
async function body(req,limit=MAX){let n=0;const chunks=[];for await(const c of req){n+=c.length;if(n>limit)throw Object.assign(new Error(`上传不能超过${limit/1024/1024}MB`),{status:413});chunks.push(c);}return Buffer.concat(chunks);}
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
 if(queue.running.has(job.id)||queue.pending.some(j=>j.id===job.id))return;
 await persist(job,{status:'queued',queued_at:new Date().toISOString(),error:null});queue.add(job);
}
async function execute(job,signal){
  const dir=path.join(JOBS,job.id);
  try{
   signal.throwIfAborted();
   await persist(job,{status:'running',error:null,timings:{...job.timings,local_queue:(job.timings?.local_queue??0)+Math.max(0,(Date.now()-Date.parse(job.queued_at))/1000)}});
   await runPipeline({client:regions[job.options.region]?.client,reference:{data:await readFile(path.join(dir,job.files.reference)),filename:job.files.reference,contentType:'image/png'},
    options:job.options,dir,state:structuredClone(job),update:p=>persist(job,p),signal,
    chooseViews:async()=>{await persist(job,{status:'awaiting_views',stage:'choose',progress:0,awaiting_since:new Date().toISOString()});throw Object.assign(Error('views ready'),{code:'AWAIT_VIEWS'});}});
   await persist(job,{status:'done',stage:'done',progress:100});
  }catch(e){if(e.code==='AWAIT_VIEWS')return;await persist(job,{status:job.submission_pending?'needs_attention':signal.aborted?'paused':'failed',error:signal.aborted?'本地等待已停止，外部任务可能仍运行或计费。':cleanError(e)});}
}
async function create(req,res,q){
 let o;try{o=options(q);}catch(e){return send(res,400,{error:cleanError(e)});}
 if(o.inputMode==='concept'&&!regions[o.region].client)return send(res,503,{error:'未配置生成服务。可直接导入已有四宫格或预览本地GLB。'});
 if(!['image/png','image/jpeg','image/webp'].includes((req.headers['content-type']??'').split(';')[0]))return send(res,415,{error:'只支持PNG/JPEG/WebP'});
 const bytes=await body(req);let png;
 const sourceHash=createHash('sha256').update(bytes).digest('hex');
 const requestKey=req.headers['idempotency-key'];
 if(requestKey&&(typeof requestKey!=='string'||!/^[\w-]{8,100}$/.test(requestKey)))return send(res,400,{error:'请求编号无效'});
 const fingerprint=createHash('sha256').update(JSON.stringify({sourceHash,options:o,benchmark:[q.get('case_id'),q.get('group'),q.get('repeat'),q.get('goal')]})).digest('hex');
 const reused=requestKey?[...jobs.values()].find(j=>j.request?.key===requestKey):null;
 if(reused){if(reused.request.fingerprint!==fingerprint)return send(res,409,{error:'同一请求编号不可用于不同输入'});return send(res,200,{id:reused.id,reused:true});}
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
 const job={id,status:'running',stage:'upload',progress:0,quality_gate:'structured-v1',options:o,initial_options:structuredClone(o),files:{reference:'reference.png'},tasks:{},
  source_sha256:sourceHash,request:requestKey?{key:requestKey,fingerprint}:null,...(benchmark?{benchmark}:{}),created_at:new Date().toISOString()};
 jobs.set(id,job);await persist(job);await launch(job);send(res,202,{id});
}
async function continueJob(req,res,job){
 if(job.status!=='awaiting_views')return send(res,409,{error:'任务当前不在等待视图确认'});
 let d,o;try{d=JSON.parse((await body(req)).toString());generationPlan(d.views,{swapSides:d.swap_sides});
  o=modelOptions({model:d.model??job.options.modelVersion,texture:d.texture??job.options.texture,texture_quality:d.texture_quality??job.options.textureQuality,face_limit:d.face_limit??job.options.faceLimit});
 }catch(e){return send(res,400,{error:cleanError(e)});}
 if(!regions[job.options.region]?.client)return send(res,503,{error:'未配置该生成服务的API Key，视图已保存。'});
 try{checkSelectedViews(job.quality,d.views);}catch(e){return send(res,422,{error:cleanError(e)});}
 if(job.quality?.warnings?.length&&!d.quality_ack)return send(res,422,{error:'存在四视图检查提醒，请核对后确认继续。'});
 if(job.locked||job.deleted_at)return send(res,409,{error:'任务已锁定或删除'});
 if(job.status!=='awaiting_views')return send(res,409,{error:'视图已提交，请勿重复提交'});
 if(job.quality_gate==='structured-v1'){
  const unchecked=d.views.filter(v=>!job.view_checks?.views?.[v]||['pose','identity','scale','features','asymmetry','crop','background'].some(k=>job.view_checks.views[v][k]==='unchecked'));
  if(unchecked.length)return send(res,422,{error:'请先进入「质量关卡、候选与任务管理」，完成所选视图的逐项检查；无法判断的项目请如实标记。'});
  const unknown=d.views.filter(v=>Object.values(job.view_checks.views[v]).includes('unknown'));
  if(unknown.length&&!d.accept_failed_views)return send(res,422,{error:'所选视图含无法判断的项目，请明确接受风险或补充参考。'});
 }
 const failures=d.views.filter(v=>Object.values(job.view_checks?.views?.[v]??{}).includes('fail'));
 if(failures.length&&!d.accept_failed_views)return send(res,422,{error:'所选视图有人工标记的问题，请修正、剔除或明确接受风险。'});
 Object.assign(job.options,o,{views:d.views,swapSides:typeof d.swap_sides==='boolean'?d.swap_sides:job.options.swapSides});
 await persist(job,{status:'queued',stage:'model',timings:{...job.timings,human_confirmation:(job.timings?.human_confirmation??0)+(job.awaiting_since?Math.max(0,(Date.now()-Date.parse(job.awaiting_since))/1000):0)},sheet_review:{acknowledged:true,accept_failed_views:!!d.accept_failed_views,reviewer_type:d.reviewer_type==='agent'?'agent':'human',notes:String(d.sheet_notes??'').slice(0,2000),at:new Date().toISOString()}});
 await queue.settled(job.id);await launch(job);
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
  if(job.status==='queued'){await persist(job,{status:'paused',error:'服务已重启；排队任务等待手动恢复，未提交新请求。'});}
  if(['running','stopping'].includes(job.status)){
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
  if(parts[0]==='api'&&parts[1]==='jobs'&&parts[2]&&!req.jobLocked)return studio.exclusive(parts[2],()=>{req.jobLocked=true;return handle(req,res);});
 }
 if(req.method==='GET'&&url.pathname==='/api/health')return send(res,200,{ok:true,instance_notice:process.env.TRIPO_HEAD_INSTANCE_NOTICE??null,configured:Object.values(regions).some(r=>r.client),queue:queue.snapshot(),metrics:{arcface:'external_import_only',lpips:'external_import_only'},regions:Object.fromEntries(Object.entries(regions).map(([id,r])=>[id,{label:r.label,configured:!!r.client}]))});
 if(req.method==='POST'&&url.pathname==='/api/services/check'){
  const result=await Promise.all(Object.entries(regions).map(async([id,r])=>{if(!r.client)return[id,{configured:false,available:false}];try{const b=await r.client.getBalance();return[id,{configured:true,available:true,balance:Number.isFinite(b.balance)?b.balance:null}];}catch(e){return[id,{configured:true,available:false,error:cleanError(e)}];}}));
  return send(res,200,{checked_at:new Date().toISOString(),regions:Object.fromEntries(result)});
 }
 if(await studio(req,res,url,parts))return;
 if(req.method==='GET'&&url.pathname==='/api/jobs')return send(res,200,[...jobs.values()].filter(j=>!j.deleted_at).sort((a,b)=>b.created_at.localeCompare(a.created_at)));
 if(req.method==='GET'&&url.pathname==='/api/benchmark'){
  const trials=[...jobs.values()].filter(j=>j.benchmark&&!j.deleted_at);
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
  if(req.method==='POST'&&(job.locked||job.deleted_at))return send(res,409,{error:'任务已锁定或移入回收站；请创建候选或恢复后操作'});
  if(req.method==='GET'&&parts.length===3)return send(res,200,job);
  if(req.method==='POST'&&parts[3]==='versions'&&parts.length===4){
   if(job.status!=='done'||!job.files.model)return send(res,409,{error:'原模型尚未完成'});
   if((job.versions?.length??0)>=30)return send(res,409,{error:'此任务已保存30个版本，请下载归档后另建任务'});
   if(req.headers['content-type']!=='model/gltf-binary')return send(res,415,{error:'需要GLB文件'});
   const bytes=await body(req,80*1024*1024);let stats;try{stats=inspectGlb(bytes);}catch{return send(res,400,{error:'修改版GLB无效'});}
   const id=randomUUID(),name=`edit-${id}.glb`,record={id,file:name,sha256:createHash('sha256').update(bytes).digest('hex'),created_at:new Date().toISOString(),status:'draft',notes:'',stats};
   await writeFile(path.join(JOBS,job.id,name),bytes);await persist(job,{versions:[...(job.versions??[]),record],files:{...job.files,[`edit_${id}`]:name}});return send(res,201,record);
  }
  if(req.method==='POST'&&parts[3]==='versions'&&parts.length===5){
   const v=job.versions?.find(v=>v.id===parts[4]);if(!v)return send(res,404,{error:'版本不存在'});
   let data;try{data=JSON.parse((await body(req)).toString());if(!['draft','approved'].includes(data.status)||typeof data.notes!=='string'||data.notes.length>3000||JSON.stringify(data.settings??{}).length>1000000)throw Error();}catch{return send(res,400,{error:'版本备注或设置无效'});}
   const next={...v,status:data.status,notes:data.notes,settings:data.settings??{},updated_at:new Date().toISOString(),approved_at:data.status==='approved'?new Date().toISOString():null};
   const name=`edit-${v.id}.json`;await writeFile(path.join(JOBS,job.id,name),JSON.stringify(next,null,2));await persist(job,{versions:job.versions.map(x=>x.id===v.id?next:x),files:{...job.files,[`edit_meta_${v.id}`]:name}});return send(res,200,next);
  }
  if(req.method==='POST'&&parts[3]==='review'&&parts.length===4){
   let review;try{review=validateReview(JSON.parse((await body(req)).toString()));}catch(e){return send(res,400,{error:cleanError(e)});}
   const field=review.reviewer_type==='agent'?'agent_review':'review';
   await persist(job,{[field]:review});return send(res,200,{id:job.id,[field]:review});
  }
  if(req.method==='POST'&&parts[3]==='continue'&&parts.length===4)return continueJob(req,res,job);
  if(req.method==='POST'&&parts[3]==='resume'&&parts.length===4){
   if(!['interrupted','failed','paused'].includes(job.status)||(job.status!=='paused'&&!job.tasks?.model&&!job.tasks?.face_sheet)||job.submission_pending)return send(res,409,{error:'没有可安全恢复的外部任务ID，未重复提交'});
   if(!regions[job.options.region]?.client)return send(res,503,{error:'未配置原服务凭证'});
   await persist(job,{recoveries:[...(job.recoveries??[]),{at:new Date().toISOString(),prior_status:job.status,tasks:job.tasks}]});await launch(job);return send(res,202,{id:job.id});
  }
  if(req.method==='GET'&&parts[3]==='files'&&parts.length===5&&Object.values(job.files).includes(parts[4]))return file(res,resolveFile(path.join(JOBS,job.id),parts[4]));
  if(req.method==='GET'&&parts[3]==='receipt'&&parts.length===4)return file(res,path.join(JOBS,job.id,'job.json'));
  if(req.method==='GET'&&parts[3]==='archive'&&parts.length===4){
   const entries=[{name:'job.json',data:Buffer.from(JSON.stringify(job,null,2))},...[...new Set(Object.values(job.files))].map(name=>({name,path:resolveFile(path.join(JOBS,job.id),name)}))];return streamArchive(res,entries,`head-${job.id}.zip`);
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
