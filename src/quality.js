import sharp from 'sharp';

// Conservative screening, not a face detector or an identity/anatomy score.
export async function inspectViews(views) {
  const reports = {}, warnings = [],pixels={};
  for (const [view, bytes] of Object.entries(views)) {
    const {data,info} = await sharp(bytes).flatten({background:'#fff'}).resize(192,192,{fit:'fill'}).toColourspace('srgb').removeAlpha().raw().toBuffer({resolveWithObject:true});
    pixels[view]={data,channels:info.channels};
    let n=0,x0=192,y0=192,x1=-1,y1=-1,whiteBorder=0,borderCount=0,sum=0,sum2=0;
    for(let y=0;y<192;y++) for(let x=0;x<192;x++) {
      const i=(y*192+x)*info.channels,r=data[i],g=data[i+1],b=data[i+2],v=(r+g+b)/3;
      sum+=v;sum2+=v*v;
      const white=Math.min(r,g,b)>235;
      if(x<5||x>186||y<5||y>186){borderCount++;if(white)whiteBorder++;}
      if(!white){n++;x0=Math.min(x0,x);x1=Math.max(x1,x);y0=Math.min(y0,y);y1=Math.max(y1,y);}
    }
    const variance=Math.max(0,sum2/(192*192)-(sum/(192*192))**2);
    const usable=whiteBorder/borderCount>.8,occupancy=n/(192*192);
    const report={background_supported:usable,foreground_fraction:occupancy,contrast_std:Math.sqrt(variance),warnings:[]};
    if(variance<4||occupancy<.005) report.warnings.push('blank_or_flat');
    if(usable&&n) {
      report.bounds={left:x0/192,top:y0/192,right:(x1+1)/192,bottom:(y1+1)/192};
      report.height=(y1-y0+1)/192;
      if(x0<5||x1>186||y0<5||y1>186)report.warnings.push('near_panel_edge');
      if(report.height<.35)report.warnings.push('subject_too_small');
    } else report.warnings.push('background_needs_manual_check');
    reports[view]=report;
    warnings.push(...report.warnings.map(code=>({view,code})));
  }
  const heights=Object.values(reports).map(r=>r.height).filter(Number.isFinite);
  const heightSpread=heights.length>1?Math.max(...heights)/Math.min(...heights):null;
  if(heightSpread>1.25)warnings.push({view:'all',code:'inconsistent_subject_scale'});
  let sideDifference=null;
  if(pixels.left&&pixels.right){
    const a=pixels.left,b=pixels.right;let direct=0,flipped=0,n=0;
    for(let y=0;y<192;y++)for(let x=0;x<192;x++){
      const i=(y*192+x)*a.channels,j=(y*192+x)*b.channels,k=(y*192+191-x)*b.channels;
      if(Math.min(...a.data.subarray(i,i+3))>235&&Math.min(...b.data.subarray(j,j+3))>235)continue;
      for(let c=0;c<3;c++){direct+=Math.abs(a.data[i+c]-b.data[j+c]);flipped+=Math.abs(a.data[i+c]-b.data[k+c]);}n+=3;
    }
    sideDifference=n?{direct_mae:direct/n,flipped_mae:flipped/n}:null;
    if(sideDifference&&sideDifference.direct_mae<12&&sideDifference.direct_mae<sideDifference.flipped_mae*.65)warnings.push({view:'all',code:'possibly_duplicate_profiles'});
  }
  return {version:'screen-v1',method:'white-background silhouette heuristic',identity_verified:false,
    anatomy_verified:false,views:reports,height_ratio:heightSpread,side_difference:sideDifference,warnings,
    note:'仅筛查空白、边缘、尺度和近重复侧面风险；发型和非白背景会影响结果。人物、视角和结构仍需人工检查。'};
}

export function checkSelectedViews(quality, selected) {
  const flat=selected.filter(v=>quality?.views?.[v]?.warnings.includes('blank_or_flat'));
  if(flat.length)throw new Error(`所选视图疑似空白或纯色：${flat.join('、')}，请取消选择或更换输入。`);
}

export function inspectGlb(bytes) {
  if(bytes.length<20||bytes.toString('ascii',0,4)!=='glTF'||bytes.readUInt32LE(4)!==2||bytes.readUInt32LE(8)!==bytes.length)throw new Error('GLB头或文件长度无效');
  let json,offset=12;
  while(offset+8<=bytes.length){const n=bytes.readUInt32LE(offset),type=bytes.readUInt32LE(offset+4);offset+=8;if(offset+n>bytes.length)throw new Error('GLB区块截断');if(type===0x4e4f534a)json=JSON.parse(bytes.toString('utf8',offset,offset+n));offset+=n;}
  if(!json?.meshes?.length)throw new Error('GLB没有可展示网格');
  let triangles=0,vertices=0;
  for(const mesh of json.meshes)for(const p of mesh.primitives??[]){const a=json.accessors?.[p.attributes?.POSITION];if(!a?.count)throw new Error('模型缺少有效顶点');vertices+=a.count;if((p.mode??4)===4)triangles+=(json.accessors?.[p.indices]?.count??a.count)/3;}
  return {version:'glb-basic-v1',vertices,triangles,materials:json.materials?.length??0,images:json.images?.length??0,
    format_checked:true,anatomy_verified:false,note:'基础GLB结构统计，不是拓扑、解剖或相似度验收。'};
}
