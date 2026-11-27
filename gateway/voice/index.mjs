/** Dictation through V-Scheduler automatic routing or a selected V-Voice worker. */
export const name = 'v-scheduler-speech';
export const inject = ['speechToText','settings'];
export function apply(ctx) {
  const base = process.env.VH_SCHEDULER_URL;
  const key = process.env.VH_SCHEDULER_KEY;
  if (!base || !key) throw new Error('Open v-harness through VOS to use V-Voice dictation.');
  const lifetime = new AbortController();
  const listeners = new Set();
  const placements = new Map();
  const languages = ['auto','zh','en','ja','ko','yue'];
  let modelCount = 0;
  let state = { phase: 'checking', startedAt: Date.now() };
  let preparing;
  let preparationAbort;
  const update = value => { state = value; for (const listener of listeners) listener(); };
  const get = async (path,signal) => {
    const response = await fetch(base + path, {headers:{authorization:'Bearer '+key},signal});
    if (!response.ok) throw new Error('V-Voice discovery failed (HTTP '+response.status+'). Refresh v-harness and check V-Voice/V-Scheduler.');
    return response.json();
  };
  const models = async signal => (await get('/v1/audio/models',signal)).data ?? [];
  const transcribe = async (input,signal,chosen) => {
    const timeout = AbortSignal.any([signal,lifetime.signal,AbortSignal.timeout(120000)]);
    const body = new FormData();
    if (chosen) {
      const available = (await get('/v1/audio/placements',timeout)).items ?? [];
      if (!available.some(row=>['deployment_id','executor_id','node_id','model_id'].every(key=>row[key]===chosen[key]))) {
        throw new Error('The selected V-Voice compute node is unavailable. Refresh recognition services and select an available node.');
      }
      body.set('deployment_id',chosen.deployment_id);
      body.set('executor_id',chosen.executor_id);
    } else {
      const available = await models(timeout);
      const model = available.find(item=>/sensevoice/i.test(item.id)) ?? available[0];
      if (!model) throw new Error('No automatic V-Voice ASR model is available. Select a prepared compute node or enable an ASR model in V-Voice.');
      body.set('model',model.id);
      body.set('response_format','json');
    }
    body.set('file',new Blob([input.audio],{type:'audio/wav'}),'recording.wav');
    if(input.language !== 'auto')body.set('language',input.language);
    const started=performance.now();
    const response=await fetch(base+(chosen?'/v1/audio/compute/transcriptions':'/v1/audio/transcriptions'),{method:'POST',headers:{authorization:'Bearer '+key},body,signal:timeout});
    if(!response.ok)throw new Error('V-Voice transcription failed (HTTP '+response.status+'). Check the selected model, compute node and scheduling resources.');
    const result=await response.json();
    if(chosen && (result.node_id!==chosen.node_id || result.executor_id!==chosen.executor_id || result.deployment_id!==chosen.deployment_id)) {
      throw new Error('V-Voice returned a different execution placement. The transcription was rejected.');
    }
    const transcript=chosen?result.transcription:result;
    if(typeof transcript?.text!=='string')throw new Error('V-Voice returned an invalid transcription response.');
    const wave=new DataView(input.audio.buffer,input.audio.byteOffset,input.audio.byteLength);
    return {text:transcript.text,audioSeconds:(input.audio.byteLength-44)/wave.getUint32(28,true),inferenceSeconds:(performance.now()-started)/1000};
  };
  const preparation = automatic => ({
    snapshot:()=>automatic && state.phase==='ready' && modelCount===0
      ? {phase:'failed',message:'No automatic ASR model is available. Select a prepared V-Voice compute node.'}:state,
    subscribe:listener=>{listeners.add(listener);return()=>listeners.delete(listener);},
    prepare:()=>prepare(),
    cancel:async()=>{preparationAbort?.abort();await preparing;update({phase:'cancelled'});},
  });
  const prepare = () => {
    if (preparing) return;
    update({phase:'checking',startedAt:Date.now()});
    preparationAbort = new AbortController();
    const signal=AbortSignal.any([lifetime.signal,preparationAbort.signal,AbortSignal.timeout(15000)]);
    preparing = (async()=>{
      const [automatic,roster] = await Promise.all([models(signal),get('/v1/audio/placements',signal)]);
      modelCount=automatic.length;
      const current = new Set();
      for(const row of roster.items ?? []) {
        const id='v-scheduler-voice/'+encodeURIComponent(row.deployment_id)+'/'+encodeURIComponent(row.executor_id);
        current.add(id);
        if(placements.has(id))continue;
        placements.set(id,ctx.speechToText.register({
          info:{id,name:`V-Voice · ${row.model_id} · ${row.node_id}`,location:'cloud',languages},
          preparation:preparation(false),transcribe:(input,signal)=>transcribe(input,signal,row),
        }));
      }
      for(const [id,remove]of placements)if(!current.has(id)){await remove();placements.delete(id);}
      if(!modelCount && !placements.size)throw new Error('No V-Voice ASR model or prepared compute node is available. Prepare a model in V-Voice, then retry.');
      update({phase:'ready'});
    })().catch(error=>{if(!lifetime.signal.aborted)update({phase:'failed',message:error.message});})
      .finally(()=>{preparing=undefined;preparationAbort=undefined;});
  };
  ctx.effect(async () => {
    const remove = ctx.speechToText.register({
      info:{id:'v-scheduler-voice',name:'V-Voice · V-Scheduler',location:'cloud',languages},
      preparation:preparation(true),transcribe:(input,signal)=>transcribe(input,signal),
    });
    if(ctx.speechToText.snapshot().selection.providerId === 'sensevoice-local') {
      try {await ctx.speechToText.configure({providerId:'v-scheduler-voice'});}catch(error){await remove();throw error;}
    }
    prepare();
    return async()=>{lifetime.abort();await preparing;await Promise.all([remove(),...[...placements.values()].map(dispose=>dispose())]);placements.clear();listeners.clear();};
  },'v-scheduler-speech: V-Voice providers');
}
