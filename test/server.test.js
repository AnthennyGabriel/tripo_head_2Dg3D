import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {createHash} from 'node:crypto';

const root=new URL('../',import.meta.url),base='http://127.0.0.1:18771';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function start(dir){
 const child=spawn(process.execPath,['src/server.js'],{cwd:root,env:{...process.env,TRIPO_HEAD_SEED_EXAMPLE:'0',TRIPO_HEAD_PORT:'18771',TRIPO_HEAD_JOBS:dir,TRIPO_HEAD_CONFIG:path.join(dir,'empty.yaml'),TRIPO_CN_API_KEY:'',TRIPO_OVERSEAS_API_KEY:''},stdio:'pipe'});
 let log='';child.stderr.on('data',c=>log+=c);child.stdout.on('data',c=>log+=c);
 for(let i=0;i<100;i++){if(child.exitCode!==null)throw Error(log);try{const r=await fetch(base+'/api/health');if(r.ok)return child;}catch{}await pause(50);}
 child.kill();throw Error('server timeout '+log);
}
async function stop(child){if(child.exitCode!==null)return;const done=new Promise(r=>child.once('exit',r));child.kill('SIGTERM');await done;}
test('offline sheet preparation, history restoration, validation and local assets',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'head-server-'));let child;
 try{
  await writeFile(path.join(dir,'empty.yaml'),'regions: {}');child=await start(dir);
  const health=await (await fetch(base+'/api/health')).json();assert.equal(health.configured,false);
  const bytes=await sharp({create:{width:256,height:256,channels:3,background:'#999'}}).png().toBuffer();
  const r=await fetch(base+'/api/jobs?input_mode=sheet',{method:'POST',headers:{'Content-Type':'image/png'},body:bytes});assert.equal(r.status,202);const {id}=await r.json();
  let job;for(let i=0;i<100;i++){job=await (await fetch(base+'/api/jobs/'+id)).json();if(job.status==='awaiting_views')break;await pause(30);}
  assert.equal(job.status,'awaiting_views');assert.equal(Object.keys(job.tasks).length,0);assert.ok(job.files.view_front);
  await stop(child);child=await start(dir);
  job=await (await fetch(base+'/api/jobs/'+id)).json();assert.equal(job.status,'awaiting_views');
  const cont=await fetch(base+'/api/jobs/'+id+'/continue',{method:'POST',body:JSON.stringify({views:['front','left']})});assert.equal(cont.status,503);
  assert.equal((await (await fetch(base+'/api/jobs')).json()).length,1);
  const archive=await fetch(base+'/api/jobs/'+id+'/archive');assert.equal(archive.status,200);assert.equal(Buffer.from(await archive.arrayBuffer()).subarray(0,2).toString(),'PK');
  const hdr=await fetch(base+'/assets/environments/studio_small_09_1k.hdr');assert.equal(hdr.status,200);assert.ok((await hdr.arrayBuffer()).byteLength>100000);
  assert.equal((await fetch(base+'/vendor/build/three.module.js')).status,200);
  assert.equal((await fetch(base+'/config.yaml')).status,404);
  assert.equal((await fetch(base+'/api/jobs?input_mode=sheet&layout=front,front,left,right',{method:'POST',headers:{'Content-Type':'image/png'},body:bytes})).status,400);
  assert.equal((await fetch(base+'/api/jobs?input_mode=sheet',{method:'POST',headers:{'Content-Type':'image/png'},body:Buffer.from('invalid')})).status,400);
  assert.equal((await fetch(base+'/api/jobs?input_mode=sheet',{method:'POST',headers:{Origin:'https://other.invalid'},body:bytes})).status,403);
  const cases=[{id:'case1',label:'Case 1',tags:['test'],sha256:createHash('sha256').update(bytes).digest('hex')}];
  assert.equal((await fetch(base+'/api/benchmark/cases',{method:'POST',body:JSON.stringify(cases)})).status,200);
  const url=base+'/api/jobs?input_mode=sheet&case_id=case1&group=test&repeat=1';
  const responses=await Promise.all([0,1].map(()=>fetch(url,{method:'POST',headers:{'Content-Type':'image/png'},body:bytes}).then(r=>r.json())));
  assert.equal(responses[0].id,responses[1].id,'concurrent duplicate benchmark submission reuses one job');
  assert.equal((await fetch(url+'&prompt_profile=identity-v1',{method:'POST',headers:{'Content-Type':'image/png'},body:bytes})).status,409);
  assert.equal((await fetch(url+'&goal=sheet',{method:'POST',headers:{'Content-Type':'image/png'},body:bytes})).status,409);
  const bid=responses[0].id;
  assert.equal((await fetch(base+'/api/jobs/'+bid+'/review',{method:'POST',body:JSON.stringify({decision:'usable',reviewer_type:'agent'})})).status,200);
  const record=await(await fetch(base+'/api/jobs/'+bid)).json();assert.ok(record.agent_review);assert.equal(record.review,undefined);
  const summary=await(await fetch(base+'/api/benchmark')).json();assert.equal(summary.summary.reviewed,0);assert.equal(summary.summary.usable_rate,null);
  const changed=[{...cases[0],sha256:'a'.repeat(64)}];
  assert.equal((await fetch(base+'/api/benchmark/cases',{method:'POST',body:JSON.stringify(changed)})).status,409);
 }finally{if(child)await stop(child);await rm(dir,{recursive:true,force:true});}
});

test('edited versions persist separately from the original and approval is explicit',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'head-versions-'));let child;
 try{
  const folder=path.join(dir,'fixture');await mkdir(folder);const bytes=await readFile(new URL('../assets/examples/male2/head.glb',import.meta.url));
  await writeFile(path.join(folder,'head.glb'),bytes);await writeFile(path.join(folder,'job.json'),JSON.stringify({id:'fixture',status:'done',created_at:new Date().toISOString(),options:{},files:{model:'head.glb'}}));child=await start(dir);
  const endpoint=base+'/api/jobs/fixture/versions';
  assert.equal((await fetch(endpoint,{method:'POST',headers:{'Content-Type':'model/gltf-binary'},body:Buffer.from('invalid')})).status,400);
  const r=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'model/gltf-binary'},body:bytes});assert.equal(r.status,201);const v=await r.json();assert.equal(v.status,'draft');
  const update=await fetch(endpoint+'/'+v.id,{method:'POST',body:JSON.stringify({status:'approved',notes:'Fixture-only acceptance',settings:{operations:[]}})});assert.equal(update.status,200);
  await stop(child);child=await start(dir);const saved=await(await fetch(base+'/api/jobs/fixture')).json();assert.equal(saved.files.model,'head.glb');assert.equal(saved.versions[0].status,'approved');assert.deepEqual(await readFile(path.join(folder,'head.glb')),bytes);
  assert.equal((await fetch(base+'/api/jobs/fixture/files/'+v.file)).status,200);
 }finally{if(child)await stop(child);await rm(dir,{recursive:true,force:true});}
});
