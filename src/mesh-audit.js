// Object-space diagnostics; does not certify anatomy, UV overlap or self-intersection.
export function auditGlb(bytes){
 let doc,bin;for(let o=12;o+8<=bytes.length;){const n=bytes.readUInt32LE(o),type=bytes.readUInt32LE(o+4);o+=8;if(o+n>bytes.length)throw Error('GLB区块截断');if(type===0x4e4f534a)doc=JSON.parse(bytes.toString('utf8',o,o+n));if(type===0x004e4942)bin=bytes.subarray(o,o+n);o+=n;}
 if(!doc||!bin)throw Error('需要内嵌二进制几何');
 const counts={SCALAR:1,VEC2:2,VEC3:3,VEC4:4},types={5120:[1,'getInt8'],5121:[1,'getUint8'],5122:[2,'getInt16'],5123:[2,'getUint16'],5125:[4,'getUint32'],5126:[4,'getFloat32']};
 function read(id){const a=doc.accessors?.[id];if(!a)return null;if(a.sparse)throw Error('稀疏属性暂不支持检测');const b=doc.bufferViews?.[a.bufferView],type=types[a.componentType],count=counts[a.type];if(!b||b.buffer!==0||!type||!count)throw Error('压缩或外部属性暂不支持检测');if(a.count>3_000_000)throw Error('属性过大，请离线检测');const stride=b.byteStride??type[0]*count,offset=(b.byteOffset??0)+(a.byteOffset??0);if(offset+(a.count-1)*stride+count*type[0]>bin.length)throw Error('属性越界');const view=new DataView(bin.buffer,bin.byteOffset,bin.byteLength),out=new Float64Array(a.count*count);for(let i=0;i<a.count;i++)for(let k=0;k<count;k++)out[i*count+k]=view[type[1]](offset+i*stride+k*type[0],true);return out;}
 const results=[];
 for(const [mi,mesh]of doc.meshes.entries())for(const [pi,p]of mesh.primitives.entries()){
  const r={mesh:mi,primitive:pi,status:'measured',boundary_edges:0,nonmanifold_edges:0,inconsistent_winding_edges:0,degenerate_triangles:0,invalid_indices:0,nonfinite_positions:0,invalid_normals:0,nonfinite_uv:0};
  try{if((p.mode??4)!==4)throw Error('仅支持三角网格');const pos=read(p.attributes.POSITION),norm=read(p.attributes.NORMAL),uv=read(p.attributes.TEXCOORD_0),idx=p.indices===undefined?null:read(p.indices);r.vertices=pos.length/3;r.triangles=(idx?.length??r.vertices)/3;r.has_normals=!!norm;r.has_uv=!!uv;r.nonfinite_positions=pos.filter(n=>!Number.isFinite(n)).length;r.nonfinite_uv=uv?uv.filter(n=>!Number.isFinite(n)).length:0;
   if(r.triangles>1_000_000)throw Error('超过100万三角面，请在制作软件中离线检查');
   if(norm)for(let i=0;i<norm.length;i+=3){const l=Math.hypot(norm[i],norm[i+1],norm[i+2]);if(!Number.isFinite(l)||Math.abs(l-1)>.05)r.invalid_normals++;}
   const lo=[Infinity,Infinity,Infinity],hi=[-Infinity,-Infinity,-Infinity];for(let i=0;i<pos.length;i++)if(Number.isFinite(pos[i])){lo[i%3]=Math.min(lo[i%3],pos[i]);hi[i%3]=Math.max(hi[i%3],pos[i]);}
   const extent=Math.hypot(...hi.map((v,i)=>v-lo[i]));const eps=Math.max(extent*1e-7,1e-12),weld=new Map(),ids=new Uint32Array(r.vertices);let next=0;
   for(let i=0;i<r.vertices;i++){const key=[0,1,2].map(k=>Math.round(pos[i*3+k]/eps)).join(',');if(!weld.has(key))weld.set(key,next++);ids[i]=weld.get(key);}r.welded_vertices=next;r.weld_tolerance=eps;
   const edges=new Map();for(let i=0;i<(idx?.length??r.vertices);i+=3){const t=[0,1,2].map(k=>idx?idx[i+k]:i+k);if(t.some(v=>!Number.isInteger(v)||v<0||v>=r.vertices)){r.invalid_indices++;continue;}
    const a=[0,1,2].map(k=>pos[t[1]*3+k]-pos[t[0]*3+k]),b=[0,1,2].map(k=>pos[t[2]*3+k]-pos[t[0]*3+k]);if(Math.hypot(a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0])<=eps*eps)r.degenerate_triangles++;
    for(let k=0;k<3;k++){const a=ids[t[k]],b=ids[t[(k+1)%3]],key=a<b?`${a}:${b}`:`${b}:${a}`,e=edges.get(key)??{n:0,d:0};e.n++;e.d+=a<b?1:-1;edges.set(key,e);}}
   for(const e of edges.values()){if(e.n===1)r.boundary_edges++;if(e.n>2)r.nonmanifold_edges++;if(e.n===2&&e.d!==0)r.inconsistent_winding_edges++;}
  }catch(e){r.status='unsupported';r.reason=e.message;}results.push(r);
 }
 return {method:'glb-object-space-seam-weld-v1',created_at:new Date().toISOString(),primitives:results,unchecked:['self_intersections','uv_overlap','anatomy','likeness'],note:'边界可能是正常颈部切口；焊接仅用于统计，不修改模型。压缩、稀疏及外部缓冲属性不会被假定通过。'};
}
