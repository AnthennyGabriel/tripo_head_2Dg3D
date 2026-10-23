import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {runPipeline} from '../src/pipeline.js';

const defaults={inputMode:'sheet',modelVersion:'h3.1',texture:true,textureQuality:'detailed',layout:['front','back','left','right'],swapSides:false};
async function fixture(){
 const dir=await mkdtemp(path.join(tmpdir(),'head-pipeline-'));
 const data=await sharp({create:{width:256,height:256,channels:3,background:'#bbaaaa'}}).png().toBuffer();
 const state={files:{},tasks:{}},calls=[];
 const update=async p=>{Object.assign(state,structuredClone(p));calls.push({op:'persist',tasks:structuredClone(state.tasks),pending:state.submission_pending});};
 const client={uploadFile:async()=>{calls.push({op:'upload'});return {file_token:'fixture-token'};},
  imageToImage:async()=>{throw Error('Direct sheet must never call image generation');},
  multiviewToModel:async p=>{calls.push({op:'submit',params:p});return 'fixture-model';},
  waitForTask:async id=>{assert.equal(state.tasks.model,id,'task ID durable before waiting');calls.push({op:'wait'});return {task_id:id,credits_consumed:'2'};},
  downloadModel:async()=>({url:'https://fixture.invalid/head.glb',data:await readFile(new URL('../assets/examples/male2/head.glb',import.meta.url))})};
 return {dir,data,state,calls,update,client};
}
test('direct sheet bypasses image generation and records ID before polling',async()=>{
 const f=await fixture();try{
  await runPipeline({...f,reference:{data:f.data},options:{...defaults},chooseViews:async()=>['front','left']});
  assert.equal(f.calls.filter(c=>c.op==='upload').length,2);
  assert.equal(f.calls.filter(c=>c.op==='submit').length,1);
  assert.deepEqual(f.calls.find(c=>c.op==='submit').params.inputs,['fixture-token','fixture-token','','']);
  assert.equal(f.state.submission_pending,null);assert.equal(f.state.credits,2);
  assert.equal((await readFile(path.join(f.dir,'head.glb'))).subarray(0,4).toString(),'glTF');
 }finally{await rm(f.dir,{recursive:true,force:true});}
});
test('known task resumes polling without uploading or resubmitting',async()=>{
 const f=await fixture();try{
  await runPipeline({...f,reference:{data:f.data},options:{...defaults},chooseViews:async()=>['front','left']});
  const options={...defaults,views:['front','left']};f.calls.length=0;
  await runPipeline({...f,reference:{data:f.data},options,state:structuredClone(f.state),chooseViews:()=>{throw Error('Should not ask again');}});
  assert.equal(f.calls.filter(c=>['submit','upload'].includes(c.op)).length,0);
  assert.equal(f.state.credits,2,'resumed billing does not count same task twice');
 }finally{await rm(f.dir,{recursive:true,force:true});}
});
test('ambiguous submission is not automatically charged again',async()=>{
 const f=await fixture();try{
  await assert.rejects(runPipeline({...f,reference:{data:f.data},options:{...defaults},state:{submission_pending:'model',tasks:{}},chooseViews:async()=>['front']}),/提交结果未知/);
  assert.equal(f.calls.length,0);
 }finally{await rm(f.dir,{recursive:true,force:true});}
});
