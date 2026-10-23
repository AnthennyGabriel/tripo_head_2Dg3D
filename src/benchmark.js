export function validateReview(data) {
  if(!data||!['pending','usable','rework','repaired','reject'].includes(data.decision))throw new Error('评价状态无效');
  const minutes=data.repair_minutes===null||data.repair_minutes===''||data.repair_minutes===undefined?null:Number(data.repair_minutes);
  if(minutes!==null&&(!Number.isFinite(minutes)||minutes<0||minutes>100000))throw new Error('返修时间无效');
  if(!['human','agent'].includes(data.reviewer_type??'human'))throw new Error('评价来源无效');
  const issues=Array.isArray(data.issues)?data.issues:[];
  if(issues.length>20||issues.some(x=>typeof x!=='string'||x.length>100))throw new Error('问题标签无效');
  return {decision:data.decision,repair_minutes:minutes,issues,notes:String(data.notes??'').slice(0,3000),
    sheet_redraw_needed:typeof data.sheet_redraw_needed==='boolean'?data.sheet_redraw_needed:null,
    reviewer_type:data.reviewer_type??'human',reviewer:String(data.reviewer??'客户').slice(0,80),updated_at:new Date().toISOString()};
}
export function benchmarkSummary(jobs) {
  const list=jobs.filter(j=>j.benchmark),models=list.filter(j=>j.benchmark.goal!=='sheet'),done=models.filter(j=>j.status==='done');
  const human=done.filter(j=>j.review?.reviewer_type==='human'&&j.review.decision!=='pending');
  const firstPass=human.filter(j=>j.review.decision==='usable');
  const accepted=human.filter(j=>['usable','repaired'].includes(j.review.decision));
  const unfinished=human.filter(j=>j.review.decision==='rework');
  const known=list.filter(j=>Number.isFinite(j.credits)&&j.billing_complete!==false);
  const repair=human.filter(j=>j.review.repair_minutes!==null&&Number.isFinite(j.review.repair_minutes));
  const sheetReviewed=list.filter(j=>j.review?.reviewer_type==='human'&&typeof j.review.sheet_redraw_needed==='boolean');
  const redraw=sheetReviewed.filter(j=>j.review.sheet_redraw_needed);
  const issueCounts={};for(const j of human)for(const issue of new Set(j.review.issues))issueCounts[issue]=(issueCounts[issue]??0)+1;
  return {trials:list.length,models_planned:models.length,sheet_only_completed:list.filter(j=>j.benchmark.goal==='sheet'&&j.files?.face_sheet).length,completed:done.length,failed:list.filter(j=>['failed','needs_attention'].includes(j.status)).length,
    reviewed:human.length,pending_review:done.length-human.length,usable:firstPass.length,qualified:accepted.length,awaiting_repair:unfinished.length,
    usable_rate:human.length?firstPass.length/human.length:null,
    known_credits:known.reduce((s,j)=>s+j.credits,0),unknown_billing:list.length-known.length,
    cost_per_usable:accepted.length&&!unfinished.length&&known.length===list.length&&human.length===models.length?known.reduce((s,j)=>s+j.credits,0)/accepted.length:null,
    repair_samples:repair.length,mean_repair_minutes:repair.length?repair.reduce((s,j)=>s+j.review.repair_minutes,0)/repair.length:null,issue_counts:issueCounts,
    sheet_reviewed:sheetReviewed.length,sheet_redraw_count:redraw.length,sheet_redraw_rate:sheetReviewed.length?redraw.length/sheetReviewed.length:null,
    note:'直接初稿可用率只统计人工已评模型；返修后可用单独计入合格数量。全部模型评价且返修有结论后才计算合格模型成本。待评不记失败，AI意见不计入客户通过率。成本包含所选组全部试验，包括只生成四视图的对照。'};
}
