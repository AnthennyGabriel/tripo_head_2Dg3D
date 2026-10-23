import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { ImageModel, ModelVersion, TripoAPIError } from '@vastai/tripo-sdk';
import { faceSheetPrompt } from './prompts.js';
import { generationPlan, splitSheet, TRIPO_VIEW_ORDER } from './sheet.js';
import { inspectViews, checkSelectedViews, inspectGlb } from './quality.js';

export const MODEL_VERSIONS = Object.freeze({ 'h3.1': ModelVersion.H3_1, 'h3.0': ModelVersion.H3_0 });
export const IMAGE_SIZES = Object.freeze(['4K', '2K']);
export const TEXTURE_QUALITIES = Object.freeze(['detailed', 'standard']);
export const STAGES = Object.freeze(['upload', 'face_sheet', 'split', 'choose', 'model', 'download']);
const TEMPLATE = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'assets/head_template.png');

export function modelOptions(options) {
  const params = { model: MODEL_VERSIONS[options.modelVersion], geometry_quality: 'detailed', texture: options.texture };
  if (options.texture) Object.assign(params, { texture_quality: options.textureQuality,
    texture_alignment: 'original_image', texture_version: 'v3.5-20260815', delight: true });
  if (options.faceLimit) params.face_limit = options.faceLimit;
  return params;
}

/** Resumes durable artifacts and task IDs; never repeats an ambiguous submission. */
export async function runPipeline({ client, reference, options, dir, update, chooseViews, state = {} }) {
  const files = { ...state.files }, tasks = { ...state.tasks }, billing = { ...state.billing };
  const started = performance.now();
  const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
  const timings={...state.timings};let phase=null,tick=started;
  const persist=update;
  update=async patch=>{
    if(patch.stage&&patch.stage!==phase){const now=performance.now();if(phase)timings[phase]=(timings[phase]??0)+(now-tick)/1000;phase=patch.stage;tick=now;}
    await persist({...patch,timings:{...timings}});
  };
  if (state.submission_pending && !tasks[state.submission_pending]) {
    throw new Error('上次提交结果未知，需要核对服务端任务，系统未重复提交收费请求。');
  }
  const save = async (name, data) => { await writeFile(path.join(dir, name), data); return name; };
  const track = stage => ({ pollingIntervalMs: 2500, timeoutMs: 20 * 60_000,
    onProgress: task => { update({ stage, progress: task.progress ?? 0,service_status:task.status??null }).catch(() => {}); } });
  const submit = async (stage, call) => {
    await update({ stage, submission_pending: stage });
    const id = await submitWhenAllowed(call);
    tasks[stage] = id;
    await update({ tasks: { ...tasks }, submission_pending: null });
    return id;
  };
  const account = async task => {
    const n=task.credits_consumed==null||task.credits_consumed===''?null:Number(task.credits_consumed);
    billing[task.task_id] = Number.isFinite(n)&&n>=0?n:null;
    const values=Object.values(billing),known=values.filter(Number.isFinite);
    await update({ billing: { ...billing }, credits: known.length?known.reduce((a,b) => a+b, 0):null,billing_complete:known.length===values.length });
  };
  if(!files.provenance){
    const template=await readFile(TEMPLATE),prompt=options.inputMode==='concept'?faceSheetPrompt(options.removal,options.promptProfile??'baseline'):null;
    const provenance={pipeline_version:'0.3.0',split_policy:'equal-padding-v2',prompt_profile:options.promptProfile??'baseline',prompt,template_sha256:hash(template),reference_sha256:hash(reference.data),
      model_options:modelOptions(options),image_model:ImageModel.BANANA_PRO,created_at:new Date().toISOString(),seed:null,
      note:'记录配置用于追溯；外部服务无固定种子保证，重复调用不承诺逐像素一致。'};
    files.provenance=await save('provenance.json',Buffer.from(JSON.stringify(provenance,null,2)));await update({files:{...files}});
  }
  let sheet;
  if (files.face_sheet) sheet = await readFile(path.join(dir, files.face_sheet));
  else if (options.inputMode === 'sheet') {
    sheet = reference.data;
    files.face_sheet = await save('face_sheet.png', sheet);
    await update({ files: { ...files } });
  } else {
    if (!client) throw new Error('原画生成视图需要配置生成服务。已有四宫格可先本地拆图。');
    if (!tasks.face_sheet) {
      await update({ stage: 'upload', progress: 0 });
      const a = await client.uploadFile(reference.data, { filename: reference.filename, contentType: reference.contentType });
      const b = await client.uploadFile(await readFile(TEMPLATE), { filename: 'head_template.png', contentType: 'image/png' });
      const provenance=JSON.parse(await readFile(path.join(dir,files.provenance),'utf8'));
      await submit('face_sheet', () => client.imageToImage({ inputs: [a.file_token,b.file_token],
        model: ImageModel.BANANA_PRO, prompt: provenance.prompt, aspect_ratio: '1:1', size: options.imageSize }));
    }
    const task = await client.waitForTask(tasks.face_sheet, track('face_sheet'));
    await account(task);
    const url = task.output?.generated_image_url ?? task.output?.image_url ?? task.output?.image_urls?.[0];
    if (!url) throw new Error('四视图任务未返回图片。');
    const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`四视图下载失败 HTTP ${response.status}`);
    sheet = Buffer.from(await response.arrayBuffer());
    files.face_sheet = await save('face_sheet.png', sheet);
    await update({ files: { ...files } });
  }
  if (!TRIPO_VIEW_ORDER.every(v => files[`view_${v}`])) {
    await update({ stage: 'split', progress: 0 });
    const views = await splitSheet(sheet, { layout: options.layout });
    for (const view of TRIPO_VIEW_ORDER) files[`view_${view}`] = await save(`view_${view}.png`, views[view]);
    await update({ files: { ...files } });
  }
  let quality=state.quality;
  if(!quality){
    const views=Object.fromEntries(await Promise.all(TRIPO_VIEW_ORDER.map(async v=>[v,await readFile(path.join(dir,files[`view_${v}`]))])));
    quality=await inspectViews(views);files.quality=await save('quality.json',Buffer.from(JSON.stringify(quality,null,2)));
    await update({quality,files:{...files}});
  }
  if(!options.views)await update({stage:'choose',progress:0});
  const selected = options.views ?? await chooseViews();
  checkSelectedViews(quality,selected);
  options.views = selected;
  const plan = generationPlan(selected, { swapSides: options.swapSides });
  if (!client) throw new Error('未配置生成服务，四视图已保存，可配置后继续。');
  await update({ status: 'running', stage: 'model', progress: 0, options: { ...options } });
  if (!tasks.model) {
    const provenance=JSON.parse(await readFile(path.join(dir,files.provenance),'utf8'));
    provenance.model_options=modelOptions(options);provenance.selected_views=selected;provenance.swap_sides=!!options.swapSides;
    await save(files.provenance,Buffer.from(JSON.stringify(provenance,null,2)));
    const used = plan.mode === 'image' ? [plan.view] : plan.slots.filter(Boolean);
    const tokens = {};
    for (const view of used) tokens[view] = (await client.uploadFile(await readFile(path.join(dir, files[`view_${view}`])),
      { filename: `${view}.png`, contentType: 'image/png' })).file_token;
    await submit('model', () => plan.mode === 'image'
      ? client.imageToModel({ input: tokens[plan.view], ...modelOptions(options) })
      : client.multiviewToModel({ inputs: plan.slots.map(v => v ? tokens[v] : ''), ...modelOptions(options) }));
  }
  const task = await client.waitForTask(tasks.model, track('model'));
  await account(task);
  await update({ stage: 'download', progress: 0 });
  const model = await client.downloadModel(task);
  if (!model) throw new Error('生成服务未返回模型文件。');
  const ext = new URL(model.url).pathname.match(/\.(glb|fbx|obj|usdz)$/i)?.[1]?.toLowerCase() ?? 'glb';
  const bytes = Buffer.from(model.data);
  if (ext === 'glb' && bytes.subarray(0,4).toString() !== 'glTF') throw new Error('下载内容不是有效GLB。');
  files.model = await save(`head.${ext}`, bytes);
  const modelQuality=ext==='glb'?inspectGlb(bytes):{format_checked:false,format:ext};
  files.model_quality=await save('model_quality.json',Buffer.from(JSON.stringify(modelQuality,null,2)));
  await update({stage:'done',files: { ...files },model_quality:modelQuality,model_sha256:hash(bytes), last_run_seconds: (performance.now()-started)/1000 });
  return files;
}

async function submitWhenAllowed(call) {
  for (let attempt = 0; ; attempt++) {
    try { return await call(); }
    catch (error) {
      if (!(error instanceof TripoAPIError) || error.code !== 2000 || attempt >= 19) throw error;
      await new Promise(r => setTimeout(r, 30_000));
    }
  }
}
