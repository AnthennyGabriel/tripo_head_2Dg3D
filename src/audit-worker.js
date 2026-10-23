import {parentPort,workerData} from 'node:worker_threads';
import {readFile} from 'node:fs/promises';
import {auditGlb} from './mesh-audit.js';
try{parentPort.postMessage({result:auditGlb(await readFile(workerData))});}catch(e){parentPort.postMessage({error:e.message});}
