import {createReadStream} from 'node:fs';
import {Zip,ZipPassThrough} from 'fflate';

// Uncompressed ZIP avoids CPU stalls; one source chunk at a time honors HTTP backpressure.
export async function streamArchive(res,entries,filename) {
  res.writeHead(200,{'Content-Type':'application/zip','Content-Disposition':`attachment; filename="${filename}"`});
  let blocked=false,failure;
  const zip=new Zip((err,data,final)=>{if(err){failure=err;return;}if(!res.destroyed)blocked=!res.write(data)||blocked;if(final&&!res.destroyed)res.end();});
  const drain=async()=>{if(failure)throw failure;if(res.destroyed)throw Error('下载连接关闭');if(blocked){if(res.writableNeedDrain)await new Promise((resolve,reject)=>{const clear=()=>{res.off('drain',ready);res.off('close',closed);res.off('error',error);},ready=()=>{clear();resolve();},closed=()=>{clear();reject(Error('下载连接关闭'));},error=e=>{clear();reject(e);};res.once('drain',ready);res.once('close',closed);res.once('error',error);});blocked=false;}};
  try {for(const entry of entries){await drain();const part=new ZipPassThrough(entry.name);zip.add(part);
    if(entry.data){part.push(entry.data,true);await drain();}
    else {for await(const chunk of createReadStream(entry.path,{highWaterMark:64*1024})){part.push(chunk,false);await drain();}part.push(new Uint8Array(),true);}
  }await drain();zip.end();}catch(e){zip.terminate();res.destroy();throw e;}
}
