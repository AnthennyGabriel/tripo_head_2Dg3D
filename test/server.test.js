import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

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
 }finally{if(child)await stop(child);await rm(dir,{recursive:true,force:true});}
});
