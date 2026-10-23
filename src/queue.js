// Only running pipeline segments occupy a slot. Human review yields the slot.
export class TaskQueue {
  constructor(limit, run) { this.limit=limit;this.run=run;this.pending=[];this.running=new Map();this.completions=new Map(); }
  add(job) { if(this.running.has(job.id)||this.pending.some(j=>j.id===job.id))return;this.pending.push(job);this.drain(); }
  remove(id) { this.pending=this.pending.filter(j=>j.id!==id); }
  drain() { while(this.running.size<this.limit&&this.pending.length){const job=this.pending.shift();const controller=new AbortController();this.running.set(job.id,controller);
    let done;this.completions.set(job.id,new Promise(r=>done=r));
    Promise.resolve().then(()=>this.run(job,controller.signal)).catch(()=>{}).finally(()=>{this.running.delete(job.id);this.completions.delete(job.id);done();this.drain();});} }
  settled(id) { return this.completions.get(id)??Promise.resolve(); }
  stop(id) { this.remove(id);this.running.get(id)?.abort(); }
  snapshot() { return {limit:this.limit,running:[...this.running.keys()],pending:this.pending.map(j=>j.id)}; }
}
