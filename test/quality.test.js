import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {inspectViews,checkSelectedViews,inspectGlb} from '../src/quality.js';
import {benchmarkSummary,validateReview} from '../src/benchmark.js';
import {faceSheetPrompt,REMOVAL_MODES,MAX_PROMPT_LENGTH} from '../src/prompts.js';

test('blank view cannot be submitted, unsupported backgrounds only warn',async()=>{
 const blank=await sharp({create:{width:192,height:192,channels:3,background:'#fff'}}).png().toBuffer();
 const head=await sharp({create:{width:192,height:192,channels:3,background:'#fff'}}).composite([{input:Buffer.from('<svg width="192" height="192"><ellipse cx="96" cy="96" rx="48" ry="75" fill="#975"/></svg>')}]).png().toBuffer();
 const q=await inspectViews({front:head,left:blank});
 assert.throws(()=>checkSelectedViews(q,['front','left']),/空白/);assert.doesNotThrow(()=>checkSelectedViews(q,['front']));
 assert.equal(q.identity_verified,false);assert.equal(q.anatomy_verified,false);
});
test('benchmark excludes agent judgement and unknown repair time from human metrics',()=>{
 const jobs=[{benchmark:{},status:'done',credits:75,agent_review:{decision:'usable',reviewer_type:'agent'}},{benchmark:{},status:'done',credits:75,review:{decision:'usable',reviewer_type:'human',repair_minutes:null,issues:[]}}];
 let s=benchmarkSummary(jobs);assert.equal(s.reviewed,1);assert.equal(s.usable_rate,1);assert.equal(s.cost_per_usable,null);assert.equal(s.mean_repair_minutes,null);
 jobs[0].review=validateReview({decision:'reject',repair_minutes:0});s=benchmarkSummary(jobs);assert.equal(s.usable_rate,.5);assert.equal(s.cost_per_usable,150);assert.equal(s.mean_repair_minutes,0);
 jobs[0].billing_complete=false;assert.equal(benchmarkSummary(jobs).cost_per_usable,null);
 jobs[0].billing_complete=true;jobs[0].review=validateReview({decision:'rework',repair_minutes:20});assert.equal(benchmarkSummary(jobs).cost_per_usable,null);
 jobs[0].review=validateReview({decision:'repaired',repair_minutes:25});s=benchmarkSummary(jobs);assert.equal(s.usable_rate,.5);assert.equal(s.qualified,2);assert.equal(s.cost_per_usable,75);
});
test('truncated GLB cannot pass download validation and prompt fits provider limit',()=>{
 assert.throws(()=>inspectGlb(Buffer.from('glTF')),/GLB/);
 for(const mode of REMOVAL_MODES)assert.ok(faceSheetPrompt(mode,'identity-v1').length<=MAX_PROMPT_LENGTH);
 assert.throws(()=>faceSheetPrompt('keep','unknown'));
});

test('duplicate profile screening distinguishes identical from mirrored views',async()=>{
 const profile=await sharp(Buffer.from('<svg width="192" height="192"><rect width="192" height="192" fill="white"/><path d="M80 30 Q170 25 150 100 L110 160 L85 150 L90 100 L50 90 L80 70Z" fill="#975"/></svg>')).png().toBuffer();
 const opposite=await sharp(profile).flop().png().toBuffer();
 const same=await inspectViews({left:profile,right:profile});assert.ok(same.warnings.some(w=>w.code==='possibly_duplicate_profiles'));
 const mirrored=await inspectViews({left:profile,right:opposite});assert.ok(!mirrored.warnings.some(w=>w.code==='possibly_duplicate_profiles'));
});
