import test from 'node:test';
import assert from 'node:assert/strict';
import {buildGraph,softWeights,displace} from '../web/mesh-edit.js';
test('connected selection avoids a nearby disconnected layer and preserves a UV seam',()=>{
 const p=new Float32Array([0,0,0, 1,0,0, 0,1,0, 0,0,0, -1,0,0, 0,-1,0, 0,0,.01, 1,0,.01, 0,1,.01]);
 const indices=new Uint16Array([0,1,2,3,4,5,6,7,8]);const graph=buildGraph(p,indices);
 const w=softWeights(graph,p,0,2);assert.equal(w[0],1);assert.equal(w[3],1);assert.equal(w[6],0);assert.equal(w[1],.5);
 const before=p.slice(),result=displace(p,w,[.1,0,0]);assert.deepEqual(p,before);assert.equal(result.length,p.length);assert.equal(result[0],result[9]);assert.equal(result[18],p[18]);assert.ok(Math.abs(result[3]-1.05)<1e-6);
 assert.deepEqual(displace(p,w,[0,0,0]),p);assert.throws(()=>softWeights(graph,p,0,0));assert.throws(()=>displace(p,w,[NaN,0,0]));
});
