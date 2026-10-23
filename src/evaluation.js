const fail=message=>{throw Object.assign(Error(message),{status:400});};
export const CHECKS=['pose','identity','scale','features','asymmetry','crop','background'];
export function validateChecklist(data) {
  const result={reviewer:String(data.reviewer??'').slice(0,80),reviewer_type:data.reviewer_type==='agent'?'agent':'human',views:{},notes:String(data.notes??'').slice(0,3000),at:new Date().toISOString()};
  for(const v of ['front','left','back','right']){const d=data.views?.[v]??{},checks={};for(const k of CHECKS){const value=d[k]??'unchecked';if(!['pass','fail','unknown','unchecked'].includes(value))fail('检查项状态无效');checks[k]=value;}
    result.views[v]={...checks,pose_observed:String(d.pose_observed??'unknown').slice(0,80),evidence:String(d.evidence??'').slice(0,1500),source:d.source==='observed'?'observed':'inferred'};
    result.views[v].anchors={};for(const k of ['top','eye','chin'])if(d.anchors?.[k])result.views[v].anchors[k]=points([d.anchors[k]],1)[0];
  }return result;
}
function points(a,min){if(!Array.isArray(a)||a.length<min||a.length>1000||a.some(p=>!Array.isArray(p)||p.length!==2||p.some(n=>typeof n!=='number'||!Number.isFinite(n)||n<0||n>1)))fail('需要有效的归一化二维标注点');return a;}
const distance=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1]);
function inside(x,y,p){let yes=false;for(let i=0,j=p.length-1;i<p.length;j=i++){const a=p[i],b=p[j];if(((a[1]>y)!==(b[1]>y))&&(x<(b[0]-a[0])*(y-a[1])/(b[1]-a[1])+a[0]))yes=!yes;}return yes;}
function polygon(p){points(p,3);if(p.length>128)fail('轮廓最多128个点');const cross=(a,b,c)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);for(let i=0;i<p.length;i++){const a=p[i],b=p[(i+1)%p.length];if(distance(a,b)<1e-6)fail('轮廓相邻点重复');for(let j=i+2;j<p.length;j++){if(i===0&&j===p.length-1)continue;const c=p[j],d=p[(j+1)%p.length];if(cross(a,b,c)*cross(a,b,d)<0&&cross(c,d,a)*cross(c,d,b)<0)fail('轮廓线交叉，请沿外缘重新标注');}}return p;}
export function geometryMetrics(data){
  const result={method:'manual-aligned-annotations-v1',normalizer:'reference head-height',landmark_nme:null,silhouette_iou:null};
  if(!data.aligned)fail('请先确认相机、裁切和姿态已对齐');
  if(data.reference_points?.length||data.render_points?.length){const a=points(data.reference_points,2),b=points(data.render_points,2);if(a.length!==b.length)fail('两侧关键点数量需一致');
    const h=Number(data.reference_head_height);if(!Number.isFinite(h)||h<=0||h>1)fail('参考头高应在0到1之间');
    result.landmark_nme=a.reduce((n,p,i)=>n+distance(p,b[i]),0)/a.length/h;result.landmark_count=a.length;
  }
  if(data.reference_polygon?.length||data.render_polygon?.length){const a=polygon(data.reference_polygon),b=polygon(data.render_polygon);let union=0,intersection=0;
    for(let y=0;y<256;y++)for(let x=0;x<256;x++){const p=inside((x+.5)/256,(y+.5)/256,a),q=inside((x+.5)/256,(y+.5)/256,b);if(p||q)union++;if(p&&q)intersection++;}
    if(!union)fail('轮廓面积过小');result.silhouette_iou=intersection/union;result.mask_resolution=256;
  }
  if(result.landmark_nme===null&&result.silhouette_iou===null)fail('请标注成对关键点或封闭轮廓');return result;
}
export function importedMetric(data){
  if(!['arcface_cosine','lpips'].includes(data.metric)||typeof data.value!=='number'||!Number.isFinite(data.value))fail('指标名称或数值无效');
  if(data.metric==='arcface_cosine'&&(data.value< -1||data.value>1)||data.metric==='lpips'&&data.value<0)fail('指标超出有效范围');
  for(const k of ['model','model_sha256','preprocessing','reference_sha256','render_sha256'])if(typeof data[k]!=='string'||!data[k].trim()||data[k].length>2000)fail('外部指标必须注明模型、预处理与输入哈希');
  for(const k of ['model_sha256','reference_sha256','render_sha256'])if(!/^[a-f0-9]{64}$/.test(data[k]))fail('SHA256格式无效');
  return {...Object.fromEntries(['metric','value','model','model_sha256','preprocessing','reference_sha256','render_sha256'].map(k=>[k,data[k]])),source:'external_import',customer_validated:false,at:new Date().toISOString()};
}
