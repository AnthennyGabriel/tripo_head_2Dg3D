import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';

const [command,input,base='http://127.0.0.1:8771',group='baseline-repeat2',profile='baseline']=process.argv.slice(2);
const specs=[['male1','男1',['无发','眼罩遮挡','不对称疤痕']],['male2','男2',['无发','雀斑','微张嘴']],['female1','女1',['无发','年龄纹理','肩部']],['female2','女2',['有发','正侧面设定板','风格化']],['female3','女3',['无发','浅眉','雀斑']]];
async function api(url,options){const r=await fetch(base+url,options);const data=await r.json();if(!r.ok)throw new Error(data.error??`HTTP ${r.status}`);return data;}
async function wait(id,stop){for(;;){const j=await api(`/api/jobs/${id}`);if(stop.includes(j.status)||['failed','needs_attention','interrupted'].includes(j.status)){console.log(`${j.benchmark?.case_id??id} #${j.benchmark?.repeat??''}: ${j.status}; credits=${j.credits??'unknown'}`);return j;}await new Promise(r=>setTimeout(r,3000));}}
async function pool(items,fn){let index=0;await Promise.all([0,1].map(async()=>{while(index<items.length)await fn(items[index++]);}));}
if(command==='prepare'){
 const cases=await Promise.all(specs.map(async([id,label,tags])=>({id,label,tags,sha256:createHash('sha256').update(await readFile(path.join(input,label+'.png'))).digest('hex')})));
 await api('/api/benchmark/cases',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(cases)});
 const trials=cases.flatMap(c=>[1,2].map(repeat=>({...c,repeat})));
 await pool(trials,async c=>{
  const q=new URLSearchParams({input_mode:'concept',case_id:c.id,group,repeat:String(c.repeat),prompt_profile:profile,removal:'keep',image_size:'2K',model:'h3.1',texture:'1',texture_quality:'detailed',face_limit:'100000',region:'cn'});
  const data=await api('/api/jobs?'+q,{method:'POST',headers:{'Content-Type':'image/png'},body:await readFile(path.join(input,c.label+'.png'))});
  console.log(`${c.id} #${c.repeat}: ${data.id}${data.reused?' reused':''}`);await wait(data.id,['awaiting_views','done']);
 });
}else if(command==='generate'){
 const plan=JSON.parse(await readFile(input,'utf8'));
 if(!Array.isArray(plan)||plan.length>10||plan.some(p=>!p.id||!p.notes||!Array.isArray(p.views)))throw Error('Plan must contain <=10 explicitly reviewed jobs, views and notes.');
 await pool(plan,async p=>{
  const job=await api('/api/jobs/'+p.id);
  if(job.status==='done')return;
  if(job.status==='awaiting_views')await api(`/api/jobs/${p.id}/continue`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({views:p.views,swap_sides:p.swap_sides,quality_ack:true,reviewer_type:'agent',sheet_notes:p.notes})});
  else if(job.status!=='running')throw Error('Job requires manual recovery: '+p.id);
  await wait(p.id,['done']);
 });
}else if(command==='report'){
 console.log(JSON.stringify(await api('/api/benchmark'),null,2));
}else throw Error('Usage: node scripts/benchmark.mjs prepare <image-directory> [base-url] [group] [baseline|identity-v1] | generate <review-plan.json> [base-url] | report unused [base-url]');
