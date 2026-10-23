import {randomUUID,createHash} from 'node:crypto';
import {mkdir,copyFile,readFile,writeFile,stat,readdir,statfs} from 'node:fs/promises';
import path from 'node:path';
import {Worker} from 'node:worker_threads';
import sharp from 'sharp';
import {inspectViews} from './quality.js';
import {validateChecklist,geometryMetrics,importedMetric} from './evaluation.js';
import {streamArchive} from './archive.js';
const now=()=>new Date().toISOString();
const hash=b=>createHash('sha256').update(b).digest('hex');
const bad=(text,status=400)=>{throw Object.assign(Error(text),{status});};
const views=['front','left','back','right'];
const json=async(req,body,limit=2*1024*1024)=>{try{return JSON.parse((await body(req,limit)).toString());}catch(e){if(e.status===413)throw e;bad('JSON内容无效');}};
export function studioRoutes({jobs,JOBS,send,body,persist,launch,queue,regions,options}){
 const tails=new Map();
 async function exclusive(id,fn){const previous=tails.get(id)??Promise.resolve();let release;const pending=new Promise(r=>release=r);tails.set(id,pending);await previous;try{return await fn();}finally{release();if(tails.get(id)===pending)tails.delete(id);}}
 async function audit(job,action,detail={}){await persist(job,{audit:[...(job.audit??[]),{at:now(),action,...detail}]});}
 function writable(job){if(job.locked||job.deleted_at)bad('已锁定或在回收站中，请创建候选或恢复后操作',409);if(['running','queued','stopping'].includes(job.status))bad('请等待任务完成或先停止本地任务',409);}
 function entries(job,prefix=''){return [{name:prefix+'job.json',data:Buffer.from(JSON.stringify(job,null,2))},...new Set(Object.values(job.files))].map(e=>typeof e==='string'?{name:prefix+e,path:path.join(JOBS,job.id,e)}:e);}
 async function handle(req,res,url,parts){
  if(req.method==='GET'&&url.pathname==='/api/library'){
   const page=Math.max(1,Math.floor(Number(url.searchParams.get('page'))||1)),size=Math.min(50,Math.max(1,Math.floor(Number(url.searchParams.get('size'))||12))),trash=url.searchParams.get('trash')==='1',q=(url.searchParams.get('q')??'').toLowerCase();
   const list=[...jobs.values()].filter(j=>!!j.deleted_at===trash&&`${j.name??''} ${j.benchmark?.label??''} ${j.id}`.toLowerCase().includes(q)).sort((a,b)=>b.created_at.localeCompare(a.created_at));
   send(res,200,{page,size,total:list.length,items:list.slice((page-1)*size,page*size),queue:queue.snapshot()});return true;
  }
  if(req.method==='GET'&&url.pathname==='/api/storage'){
   async function usage(dir){let n=0;for(const e of await readdir(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())n+=await usage(p);else if(e.isFile())n+=(await stat(p)).size;}return n;}
   const fs=await statfs(JOBS);send(res,200,{used_bytes:await usage(JOBS),free_bytes:fs.bavail*fs.bsize,job_count:jobs.size,trash_count:[...jobs.values()].filter(j=>j.deleted_at).length,warning:fs.bavail*fs.bsize<2*1024**3});return true;
  }
  if(req.method==='GET'&&url.pathname==='/api/backup'){
   const list=[...jobs.values()].filter(j=>!['running','queued','stopping'].includes(j.status));
   const manifest={created_at:now(),included:list.map(j=>j.id),excluded_active:[...jobs.values()].filter(j=>!list.includes(j)).map(j=>j.id),restore:'Stop service. Extract each job folder into the jobs volume; keep job IDs. Restart. Credentials are excluded.'};
   const e=[{name:'backup-manifest.json',data:Buffer.from(JSON.stringify(manifest,null,2))},...list.flatMap(j=>entries(j,`${j.id}/`))];
   try{e.push({name:'benchmark-cases.json',data:await readFile(path.join(JOBS,'benchmark-cases.json'))});}catch{}
   await streamArchive(res,e,'head-backup.zip');return true;
  }
  if(parts[0]!=='api'||parts[1]!=='jobs'||!parts[2]||parts.length!==4)return false;
  const action=parts[3],handled=['manage','fork','start','stop','view-checks','replace-view','evidence','evaluation','pair-vote','advice','mesh-audit'];if(!handled.includes(action)||req.method!=='POST')return false;
  const job=jobs.get(parts[2]);if(!job)bad('任务不存在',404);
  await (async()=>{
   const dir=path.join(JOBS,job.id);
   if(action==='stop'){
    if(!['queued','running'].includes(job.status))bad('此任务没有正在进行的本地等待',409);
    const running=queue.running.has(job.id);queue.stop(job.id);await persist(job,{status:running?'stopping':'paused',stopped_at:now()});await audit(job,'local_stop',{remote_cancelled:false});send(res,200,{id:job.id,remote_cancelled:false,message:'只停止本地执行或查询；已提交外部任务可能继续运行和计费。'});return;
   }
   if(action==='manage'){
    const d=await json(req,body);if(['running','queued','stopping'].includes(job.status))bad('运行中的任务请先停止再管理',409);
    if(job.locked&&d.deleted===true)bad('请先解除锁定再移入回收站',409);
    const patch={};if(d.name!==undefined){if(typeof d.name!=='string'||!d.name.trim()||d.name.length>100)bad('名称应为1–100字');patch.name=d.name.trim();}
    if(typeof d.locked==='boolean')patch.locked=d.locked;if(typeof d.deleted==='boolean')patch.deleted_at=d.deleted?now():null;
    if(d.accepted_version!==undefined){if(job.locked)bad('请先解除锁定再更改认可版本',409);if(job.status!=='done'||!job.files.model||(d.accepted_version!=='generated'&&!job.versions?.some(v=>v.id===d.accepted_version)))bad('认可版本不存在');if(!String(d.reviewer??'').trim())bad('请填写认可记录人');patch.acceptance={version:d.accepted_version,reviewer:String(d.reviewer).slice(0,80),at:now()};patch.locked=true;}
    await persist(job,patch);await audit(job,'manage',patch);send(res,200,job);return;
   }
   if(action==='fork'){
    const d=await json(req,body);if(!['sheet','model'].includes(d.from))bad('候选起点无效');if(['running','queued','stopping'].includes(job.status))bad('原任务尚未稳定，请稍后创建候选',409);
    const key=req.headers['idempotency-key'];if(key&&(typeof key!=='string'||!/^[\w-]{8,100}$/.test(key)))bad('请求编号无效');
    const fingerprint=hash(Buffer.from(JSON.stringify(d))),existing=key?[...jobs.values()].find(j=>j.fork_request?.key===key):null;
    if(existing){if(existing.parent_id!==job.id||existing.fork_request.fingerprint!==fingerprint)bad('请求编号已用于另一候选配置',409);send(res,200,{id:existing.id,reused:true});return;}
    const o={...job.options};delete o.views;
    if(d.from==='sheet'){
      const p=new URLSearchParams({input_mode:'concept',region:o.region??'cn',removal:d.removal??o.removal??'keep',prompt_profile:d.prompt_profile??o.promptProfile??'baseline',image_size:o.imageSize??'2K',model:o.modelVersion??'h3.1',texture:o.texture===false?'0':'1',texture_quality:o.textureQuality??'detailed'});Object.assign(o,options(p));
    }
    const files={},id=randomUUID(),folder=path.join(JOBS,id);await mkdir(folder,{recursive:true});
    const keys=d.from==='model'?['reference','face_sheet','view_front','view_left','view_back','view_right','provenance','quality']:['reference'];
    if(d.from==='model'&&!views.every(v=>job.files[`view_${v}`]))bad('需要先完成四视图',409);
    for(const k of keys)if(job.files[k]){files[k]=job.files[k];await copyFile(path.join(dir,files[k]),path.join(folder,files[k]));}
    // Parent provenance is retained as evidence, but new model config gets its own update.
    const child={id,name:String(d.name??`${job.name??job.benchmark?.label??job.id.slice(0,8)} · 候选`).slice(0,100),parent_id:job.id,root_id:job.root_id??job.id,fork_from:d.from,parent_snapshot:structuredClone({options:job.options,files:job.files,source_sha256:job.source_sha256,model_sha256:job.model_sha256}),fork_request:key?{key,fingerprint}:null,status:d.from==='model'?'awaiting_views':'draft',stage:d.from==='model'?'choose':'upload',progress:0,files,options:o,initial_options:structuredClone(o),source_sha256:job.source_sha256,tasks:{},billing:{},credits:null,created_at:now(),quality:d.from==='model'?job.quality:undefined,awaiting_since:d.from==='model'?now():null};
    child.quality_gate='structured-v1';jobs.set(id,child);await persist(child);await audit(job,'fork',{child_id:id,from:d.from});send(res,201,{id});return;
   }
   writable(job);
   if(action==='mesh-audit'){
    const d=await json(req,body),version=d.version??'generated',name=version==='generated'?job.files.model:job.versions?.find(v=>v.id===version)?.file;if(!name?.endsWith('.glb'))bad('请选择GLB模型');
    const result=await new Promise((resolve,reject)=>{const w=new Worker(new URL('./audit-worker.js',import.meta.url),{workerData:path.join(dir,name)}),timer=setTimeout(()=>{w.terminate();reject(Error('网格检测超时'));},120000);w.once('message',m=>{clearTimeout(timer);m.error?reject(Error(m.error)):resolve(m.result);});w.once('error',e=>{clearTimeout(timer);reject(e);});w.once('exit',code=>{clearTimeout(timer);if(code)reject(Error('检测进程退出'));});});
    const record={id:randomUUID(),version,model_sha256:hash(await readFile(path.join(dir,name))),...result};await persist(job,{mesh_audits:[...(job.mesh_audits??[]),record]});send(res,201,record);return;
   }
   if(action==='start'){
    const d=await json(req,body);if(job.status!=='draft'||!d.acknowledge_cost)bad('仅草稿可启动，且需确认外部生成可能收费',409);if(!regions[job.options.region]?.client)bad('服务尚未配置',503);await launch(job);send(res,202,{id:job.id});return;
   }
   if(action==='view-checks'){
    const data=validateChecklist(await json(req,body));data.file_hashes=Object.fromEntries(await Promise.all(views.filter(v=>job.files[`view_${v}`]).map(async v=>[v,hash(await readFile(path.join(dir,job.files[`view_${v}`])))])));
    const field=data.reviewer_type==='agent'?'agent_view_checks':'view_checks';await persist(job,{[field]:data});await audit(job,'view_checks',{reviewer_type:data.reviewer_type});send(res,200,data);return;
   }
   if(action==='replace-view'){
    if(job.status!=='awaiting_views'||job.tasks?.model)bad('请先从四视图创建候选；已生成模型的输入不可修改',409);
    const view=url.searchParams.get('view');if(!views.includes(view))bad('视角无效');
    const bytes=await body(req),image=sharp(bytes,{limitInputPixels:40_000_000}),meta=await image.metadata();if(!['png','jpeg','webp'].includes(meta.format)||meta.width<64||meta.height<64)bad('图片格式或尺寸无效');
    const png=await image.rotate().png().toBuffer(),name=`view-${view}-${randomUUID()}.png`,previous=job.files[`view_${view}`];await writeFile(path.join(dir,name),png);
    const files={...job.files,[`view_${view}`]:name,...(previous?{[`prior_${randomUUID()}`]:previous}:{})};
    const buffers=Object.fromEntries(await Promise.all(views.map(async v=>[v,await readFile(path.join(dir,files[`view_${v}`]))]))),quality=await inspectViews(buffers);
    const qname=`quality-${randomUUID()}.json`;await writeFile(path.join(dir,qname),JSON.stringify(quality,null,2));files.quality=qname;
    await persist(job,{files,quality,view_checks:null,agent_view_checks:null,view_revisions:[...(job.view_revisions??[]),{view,previous,file:name,sha256:hash(png),at:now(),operation:(url.searchParams.get('operation')??'replacement').slice(0,500)}]});send(res,200,job);return;
   }
   if(action==='evidence'){
    if(job.status!=='done'||!job.files.model)bad('需要已完成的模型才能保存评价证据',409);
    const data=await json(req,body,12*1024*1024),images={};if(!data.images||Object.keys(data.images).length>3)bad('最多上传三张证据截图');
    const id=randomUUID(),files={...job.files};for(const [k,value]of Object.entries(data.images)){if(!['reference','render','mask'].includes(k)||typeof value!=='string'||!value.startsWith('data:image/png;base64,'))bad('证据图片无效');const bytes=Buffer.from(value.split(',')[1],'base64'),meta=await sharp(bytes,{limitInputPixels:4_000_000}).metadata();if(meta.format!=='png')bad('需要PNG');const name=`evidence-${id}-${k}.png`;await writeFile(path.join(dir,name),bytes);files[`evidence_${id}_${k}`]=name;images[k]={file:name,sha256:hash(bytes)};}
    if(!images.reference||!images.render)bad('需要参考图与渲染图');
    const version=data.version??'generated';if(version!=='generated'&&!job.versions?.some(v=>v.id===version))bad('模型版本不存在');
    const record={id,images,settings:data.settings??{},version,created_at:now()};await persist(job,{files,evidence:[...(job.evidence??[]),record]});send(res,201,record);return;
   }
   if(action==='evaluation'){
    const d=await json(req,body),e=job.evidence?.find(e=>e.id===d.evidence_id);if(!e)bad('请先从对照台保存评价截图');
    let metrics;if(d.kind==='geometry')metrics=geometryMetrics(d);else if(d.kind==='external'){metrics=importedMetric(d);if(metrics.reference_sha256!==e.images.reference.sha256||metrics.render_sha256!==e.images.render.sha256)bad('指标输入哈希与证据截图不符');}else bad('评价类型无效');
    const record={id:randomUUID(),evidence_id:e.id,version:e.version,kind:d.kind,metrics,annotations:d.kind==='geometry'?d:null,reviewer:String(d.reviewer??'').slice(0,80),at:now()};await persist(job,{evaluations:[...(job.evaluations??[]),record]});send(res,201,record);return;
   }
   if(action==='pair-vote'){
    const d=await json(req,body),other=jobs.get(d.other_job);if(!other||other.deleted_at||!job.files.model||!other.files.model)bad('对照任务无效');
    const selfVersion=d.self_version??'generated',otherVersion=d.other_version??'generated';
    for(const [j,v]of [[job,selfVersion],[other,otherVersion]])if(v!=='generated'&&!j.versions?.some(x=>x.id===v))bad('对照模型版本不存在');
    if(other.id===job.id&&selfVersion===otherVersion)bad('请选择不同版本');
    if(job.source_sha256&&other.source_sha256&&job.source_sha256!==other.source_sha256)bad('成对比较需要同一源图人物');
    if(!['self','other','tie','neither'].includes(d.choice)||!['identity','shape','appearance'].includes(d.dimension)||!String(d.reviewer??'').trim())bad('请选择维度、判断并填写评价人');
    const record={id:randomUUID(),other_job:other.id,self_version:selfVersion,other_version:otherVersion,choice:d.choice,dimension:d.dimension,reviewer:String(d.reviewer).slice(0,80),notes:String(d.notes??'').slice(0,2000),blind:!!d.blind,mode:String(d.mode??'').slice(0,80),at:now()};await persist(job,{pair_votes:[...(job.pair_votes??[]),record]});send(res,201,record);return;
   }
   if(action==='advice'){
    const d=await json(req,body);if(!['sheet','geometry','material','camera','unknown'].includes(d.stage)||!String(d.evidence??'').trim()||!String(d.action??'').trim())bad('请填写问题阶段、可核对证据和建议操作');
    const record={id:randomUUID(),stage:d.stage,evidence:String(d.evidence).slice(0,3000),action:String(d.action).slice(0,2000),comparison:String(d.comparison??'').slice(0,2000),author:d.author==='agent'?'agent':'human',applied:false,at:now()};await persist(job,{advice:[...(job.advice??[]),record]});send(res,201,record);
   }
  })();return true;
 }
 return Object.assign(handle,{exclusive});
}
