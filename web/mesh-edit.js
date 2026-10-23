// Connected soft selection over triangle edges. Position-identical UV seam
// vertices share a graph node; UVs, indices and vertex count remain unchanged.
export function buildGraph(positions, indices, epsilon=1e-7) {
 const groups=[],vertexGroup=new Uint32Array(positions.length/3),keys=new Map();
 for(let i=0;i<vertexGroup.length;i++){
  const key=[0,1,2].map(k=>Math.round(positions[i*3+k]/epsilon)).join(',');
  let g=keys.get(key);if(g===undefined){g=groups.length;keys.set(key,g);groups.push({vertex:i,members:[],edges:new Set()});}
  vertexGroup[i]=g;groups[g].members.push(i);
 }
 const count=indices?.length??vertexGroup.length;
 for(let i=0;i+2<count;i+=3){const a=[0,1,2].map(k=>vertexGroup[indices?indices[i+k]:i+k]);for(let k=0;k<3;k++){groups[a[k]].edges.add(a[(k+1)%3]);groups[a[(k+1)%3]].edges.add(a[k]);}}
 return {groups,vertexGroup};
}
export function softWeights(graph,positions,seed,radius){
 if(!Number.isInteger(seed)||seed<0||seed>=graph.vertexGroup.length||!Number.isFinite(radius)||radius<=0)throw Error('Invalid selection');
 const distances=new Float64Array(graph.groups.length).fill(Infinity),heap=[];
 function push(pair){let i=heap.length;heap.push(pair);while(i){const p=(i-1)>>1;if(heap[p][0]<=pair[0])break;heap[i]=heap[p];i=p;}heap[i]=pair;}
 function pop(){const first=heap[0],last=heap.pop();if(heap.length){let i=0;while(i*2+1<heap.length){let c=i*2+1;if(c+1<heap.length&&heap[c+1][0]<heap[c][0])c++;if(heap[c][0]>=last[0])break;heap[i]=heap[c];i=c;}heap[i]=last;}return first;}
 const start=graph.vertexGroup[seed];distances[start]=0;push([0,start]);
 while(heap.length){const [d,g]=pop();if(d!==distances[g]||d>radius)continue;const a=graph.groups[g].vertex*3;
  for(const n of graph.groups[g].edges){const b=graph.groups[n].vertex*3;const nd=d+Math.hypot(positions[a]-positions[b],positions[a+1]-positions[b+1],positions[a+2]-positions[b+2]);if(nd<distances[n]&&nd<radius){distances[n]=nd;push([nd,n]);}}
 }
 const weights=new Float32Array(graph.vertexGroup.length);
 for(let i=0;i<weights.length;i++){const t=distances[graph.vertexGroup[i]]/radius;if(t<1)weights[i]=1-t*t*(3-2*t);}
 return weights;
}
export function displace(base,weights,delta,out=new Float32Array(base.length)){
 if(delta.length!==3||delta.some(x=>!Number.isFinite(x))||weights.length*3!==base.length)throw Error('Invalid deformation');
 for(let i=0;i<weights.length;i++)for(let k=0;k<3;k++)out[i*3+k]=base[i*3+k]+weights[i]*delta[k];return out;
}
