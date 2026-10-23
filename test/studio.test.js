import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import sharp from 'sharp';
import {unzipSync} from 'fflate';
import {geometryMetrics,importedMetric,validateChecklist} from '../src/evaluation.js';
import {TaskQueue} from '../src/queue.js';
import {auditGlb} from '../src/mesh-audit.js';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
test('geometry metrics distinguish mismatch from agreement and require calibrated inputs',()=>{
 const a=[[.2,.2],[.8,.2],[.8,.8],[.2,.8]],d={aligned:true,reference_head_height:.6,reference_points:a,render_points:a,reference_polygon:a,render_polygon:a};
 assert.equal(geometryMetrics(d).landmark_nme,0);assert.equal(geometryMetrics(d).silhouette_iou,1);
 const r=geometryMetrics({...d,render_points:a.map(([x,y])=>[x+.1,y]),render_polygon:a.map(([x,y])=>[x+.1,y])});assert.ok(Math.abs(r.landmark_nme-1/6)<1e-10);assert.ok(r.silhouette_iou<.8);
 assert.throws(()=>geometryMetrics({...d,aligned:false}));assert.throws(()=>geometryMetrics({...d,render_points:[[0,0]]}));assert.throws(()=>importedMetric({metric:'lpips',value:.1}));assert.throws(()=>validateChecklist({views:{front:{pose:'automatic-pass'}}}));
});
test('queue bounds execution, deduplicates and releases waiting slots',async()=>{
 const resolvers={},started=[],q=new TaskQueue(1,j=>new Promise(r=>{started.push(j.id);resolvers[j.id]=r;}));q.add({id:'a'});q.add({id:'a'});q.add({id:'b'});q.add({id:'c'});await pause(5);assert.deepEqual(started,['a']);q.stop('c');resolvers.a();await pause(5);assert.deepEqual(started,['a','b']);resolvers.b();await pause(5);assert.deepEqual(q.snapshot().running,[]);
});
test('mesh audit measures actual model buffers without anatomy certification',async()=>{
 const b=await readFile(new URL('../assets/examples/male2/head.glb',import.meta.url)),r=auditGlb(b);assert.ok(r.primitives.length);assert.ok(r.primitives.some(p=>p.status==='measured'&&p.vertices>1000));assert.ok(r.unchecked.includes('self_intersections'));assert.ok(r.unchecked.includes('anatomy'));
});
test('quality studio preserves lineage, locks, idempotency, evidence and streaming backup',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'head-studio-')),base='http://127.0.0.1:18772';let child;
 const post=(route,d,headers)=>fetch(base+route,{method:'POST',headers:headers??{'Content-Type':'application/json'},body:headers?d:JSON.stringify(d)}),get=async route=>(await fetch(base+route)).json();
 try{
  await mkdir(path.join(dir,'model-fixture'));await writeFile(path.join(dir,'model-fixture','head.glb'),await readFile(new URL('../assets/examples/male2/head.glb',import.meta.url)));await writeFile(path.join(dir,'model-fixture','job.json'),JSON.stringify({id:'model-fixture',status:'done',created_at:new Date().toISOString(),options:{},files:{model:'head.glb'}}));
  await writeFile(path.join(dir,'empty.yaml'),'regions: {}');child=spawn(process.execPath,['src/server.js'],{cwd:new URL('../',import.meta.url),env:{...process.env,TRIPO_HEAD_SEED_EXAMPLE:'0',TRIPO_HEAD_PORT:'18772',TRIPO_HEAD_JOBS:dir,TRIPO_HEAD_CONFIG:path.join(dir,'empty.yaml'),TRIPO_CN_API_KEY:'',TRIPO_OVERSEAS_API_KEY:''},stdio:'pipe'});
  let log='';child.stderr.on('data',d=>log+=d);for(let i=0;i<100;i++){if(child.exitCode!==null)throw Error(log);try{if((await fetch(base+'/api/health')).ok)break;}catch{}await pause(40);}
  const png=await sharp({create:{width:256,height:256,channels:3,background:'#999'}}).png().toBuffer(),headers={'Content-Type':'image/png','Idempotency-Key':'fixture-request-1'},route='/api/jobs?input_mode=sheet';
  const one=await(await post(route,png,headers)).json(),two=await(await post(route,png,headers)).json();assert.equal(one.id,two.id);assert.equal(two.reused,true);
  assert.equal((await post(route+'&removal=hair',png,headers)).status,409);
  const prefix='/api/jobs/'+one.id;let j;for(let i=0;i<100;i++){j=await get(prefix);if(j.status==='awaiting_views')break;await pause(30);}assert.equal(j.status,'awaiting_views');
  assert.equal((await get('/api/health')).queue.running.length,0,'human confirmation releases the queue slot');
  const originalBytes=await readFile(path.join(dir,one.id,j.files.view_front));
  const forkHeaders={'Content-Type':'application/json','Idempotency-Key':'fixture-fork-1'},fork=await(await post(prefix+'/fork',JSON.stringify({from:'model'}),forkHeaders)).json();assert.ok(fork.id);assert.equal((await(await post(prefix+'/fork',JSON.stringify({from:'model'}),forkHeaders)).json()).id,fork.id);
  const cp='/api/jobs/'+fork.id,c=await get(cp);assert.equal(c.parent_id,one.id);assert.deepEqual(c.tasks,{});assert.equal(c.files.model,undefined);
  assert.equal((await post(cp+'/view-checks',{views:{front:{pose:'fail',evidence:'fixture'}},reviewer:'test'})).status,200);
  const old=c.files.view_front;assert.equal((await post(cp+'/replace-view?view=front',png,{'Content-Type':'image/png'})).status,200);const updated=await get(cp);assert.notEqual(updated.files.view_front,old);assert.equal(updated.view_checks,null);assert.equal((await get(prefix)).files.view_front,j.files.view_front);assert.ok(Object.values(updated.files).includes(old));
  await post(cp+'/manage',{locked:true});assert.equal((await post(cp+'/replace-view?view=front',png,{'Content-Type':'image/png'})).status,409);assert.equal((await post(cp+'/manage',{deleted:true})).status,409);await post(cp+'/manage',{locked:false,name:'Fixture candidate'});
  await post(cp+'/manage',{deleted:true});assert.equal((await get('/api/library')).total,2);assert.equal((await get('/api/library?trash=1')).total,1);await post(cp+'/manage',{deleted:false});assert.equal((await get('/api/library?size=1')).items.length,1);
  const ep='/api/jobs/model-fixture',img='data:image/png;base64,'+png.toString('base64'),ev=await(await post(ep+'/evidence',{images:{reference:img,render:img},settings:{mode:'clay'}})).json();assert.ok(ev.id);
  assert.equal((await post(cp+'/evidence',{images:{reference:img,render:img}})).status,409);
  const d={kind:'geometry',evidence_id:ev.id,aligned:true,reference_head_height:.8,reference_points:[[.2,.3],[.6,.3]],render_points:[[.2,.3],[.6,.3]]};const m=await(await post(ep+'/evaluation',d)).json();assert.equal(m.metrics.landmark_nme,0);
  const external={kind:'external',evidence_id:ev.id,metric:'arcface_cosine',value:.7,model:'fixture-only',model_sha256:'a'.repeat(64),preprocessing:'fixture-not-real-inference',reference_sha256:'b'.repeat(64),render_sha256:ev.images.render.sha256};assert.equal((await post(ep+'/evaluation',external)).status,400);external.reference_sha256=ev.images.reference.sha256;assert.equal((await post(ep+'/evaluation',external)).status,201);
  assert.equal((await post(cp+'/advice',{stage:'geometry',evidence:'fixture nose',action:'manual inspection',author:'agent'})).status,201);
  assert.equal((await post(ep+'/pair-vote',{other_job:'model-fixture',choice:'self',dimension:'identity',reviewer:'fixture'})).status,400,'cannot vote the same version against itself');
  assert.equal((await post(ep+'/manage',{accepted_version:'generated',reviewer:'fixture-only'})).status,200);assert.equal((await get(ep)).locked,true);assert.equal((await post(ep+'/manage',{accepted_version:'generated',reviewer:'fixture-only'})).status,409);
  const zip=unzipSync(new Uint8Array(await(await fetch(base+cp+'/archive')).arrayBuffer()));assert.ok(zip['job.json']);assert.ok(zip[old]);assert.equal(JSON.parse(Buffer.from(zip['job.json']).toString()).parent_id,one.id);
  const backup=unzipSync(new Uint8Array(await(await fetch(base+'/api/backup')).arrayBuffer()));assert.ok(backup[one.id+'/job.json']);assert.ok(backup[fork.id+'/job.json']);assert.ok(backup['backup-manifest.json']);assert.ok((await get('/api/storage')).used_bytes>0);
  assert.deepEqual(await readFile(path.join(dir,one.id,j.files.view_front)),originalBytes);
 }finally{if(child&&child.exitCode===null){const done=new Promise(r=>child.once('exit',r));child.kill();await done;}await rm(dir,{recursive:true,force:true});}
});
