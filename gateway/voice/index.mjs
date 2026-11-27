/** Dictation provider using the existing tenant-scoped V-Scheduler inference proxy. */
export const name = 'v-scheduler-speech';
export const inject = ['speechToText','settings'];
export function apply(ctx) {
  const base = process.env.VH_SCHEDULER_URL;
  const key = process.env.VH_SCHEDULER_KEY;
  if (!base || !key) throw new Error('Open v-harness through VOS to use V-Voice dictation.');
  const lifetime = new AbortController();
  const listeners = new Set();
  let state = { phase: 'checking', startedAt: Date.now() };
  let preparing;
  let preparationAbort;
  const update = value => { state = value; for (const listener of listeners) listener(); };
  const models = async signal => {
    const response = await fetch(base + '/v1/audio/models', {headers:{authorization:'Bearer '+key}, signal});
    if (!response.ok) throw new Error('V-Scheduler voice discovery failed (HTTP '+response.status+'). Refresh v-harness and check V-Voice.');
    const data = (await response.json()).data;
    if (!Array.isArray(data) || !data.length) throw new Error('No V-Voice ASR model is available through V-Scheduler. Enable an ASR model in V-Voice, then retry.');
    return data;
  };
  const prepare = () => {
    if (preparing) return;
    update({phase:'checking',startedAt:Date.now()});
    preparationAbort = new AbortController();
    preparing = models(AbortSignal.any([lifetime.signal,preparationAbort.signal,AbortSignal.timeout(15000)]))
      .then(()=>update({phase:'ready'}),error=>{if(!lifetime.signal.aborted)update({phase:'failed',message:error.message});})
      .finally(()=>{preparing=undefined;preparationAbort=undefined;});
  };
  ctx.effect(async () => {
    const remove = ctx.speechToText.register({
      info:{id:'v-scheduler-voice',name:'V-Voice · V-Scheduler',location:'cloud',languages:['auto','zh','en','ja','ko','yue']},
      preparation:{snapshot:()=>state,subscribe:listener=>{listeners.add(listener);return()=>listeners.delete(listener);},prepare,cancel:async()=>{preparationAbort?.abort();await preparing;update({phase:"cancelled"});}},
      async transcribe(input, signal) {
        const timeout = AbortSignal.any([signal,lifetime.signal,AbortSignal.timeout(120000)]);
        const available = await models(timeout);
        const model = available.find(item=>/sensevoice/i.test(item.id)) ?? available[0];
        const body = new FormData();
        body.set('model',model.id);
        body.set('file',new Blob([input.audio],{type:'audio/wav'}),'recording.wav');
        body.set('response_format','json');
        if(input.language !== 'auto')body.set('language',input.language);
        const started=performance.now();
        const response=await fetch(base+'/v1/audio/transcriptions',{method:'POST',headers:{authorization:'Bearer '+key},body,signal:timeout});
        if(!response.ok)throw new Error('V-Voice transcription through V-Scheduler failed (HTTP '+response.status+'). Check the model and scheduling resources.');
        const result=await response.json();
        if(typeof result.text!=='string')throw new Error('V-Voice returned an invalid transcription response.');
        const wave=new DataView(input.audio.buffer,input.audio.byteOffset,input.audio.byteLength);
        return {text:result.text,audioSeconds:(input.audio.byteLength-44)/wave.getUint32(28,true),inferenceSeconds:(performance.now()-started)/1000};
      },
    });
    if(ctx.speechToText.snapshot().selection.providerId === 'sensevoice-local') {
      try {await ctx.speechToText.configure({providerId:'v-scheduler-voice'});}catch(error){await remove();throw error;}
    }
    prepare();
    return async()=>{lifetime.abort();await preparing;await remove();listeners.clear();};
  },'v-scheduler-speech: V-Voice provider');
}
