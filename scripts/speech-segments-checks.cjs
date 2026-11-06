const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
(async()=>{
  const source=fs.readFileSync(path.join(__dirname,'../static/js/speechSegments.js'),'utf8');
  const {SpeechSegments,HeldSpeech,BargeIn,BARGE_VOICE_MS,BARGE_WARMUP_MS}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
  const rate=16000;
  const tone=(ms,volume=.04)=>Float32Array.from({length:Math.round(rate*ms/1000)},(_,i)=>volume*Math.sin(i*2*Math.PI*180/rate));
  const silence=ms=>new Float32Array(Math.round(rate*ms/1000));
  const held=[];const manual=new HeldSpeech({onSegment:(pcm,timing)=>held.push({pcm,timing})});
  const feed=parts=>{for(const part of parts)for(let at=0;at<part.length;at+=128)manual.push(part.subarray(at,at+128));};
  feed([tone(500)]);assert.equal(held.length,0,'Room audio outside a hold never becomes a recording');
  manual.begin();feed([tone(200,.002),tone(300),silence(1400),tone(300)]);
  assert.equal(held.length,0,'A held sentence survives a long natural pause without submission');
  manual.release();feed([silence(300)]);
  assert.equal(held.length,1);assert.equal(held[0].pcm.length,rate*2.38,'Full audio and 180 ms release tail are retained exactly');
  assert.ok(held[0].pcm.slice(0,rate*.2).some(v=>Math.abs(v)>.001),'Manual capture preserves quiet first syllables without a gate');
  manual.begin();feed([tone(200)]);manual.cancel();feed([silence(300)]);assert.equal(held.length,1,'Cancelling a hold discards unfinished audio');
  manual.begin();feed([tone(61000)]);assert.equal(held.length,2);assert.equal(held[1].pcm.length,rate*60,'Held recordings remain bounded at 60 seconds');
  function run(parts){const segments=[];let starts=0;const detector=new SpeechSegments({onStart:()=>starts++,onSegment:(pcm,timing)=>{if(pcm.length)segments.push({pcm,timing});}});
    for(const part of parts)for(let at=0;at<part.length;at+=128)detector.push(part.subarray(at,at+128));
    return {segments,starts,detector};
  }
  const quiet=run([silence(500),tone(160,.002),tone(500),silence(900)]);
  assert.equal(quiet.segments.length,1,'A quiet opening and voiced word form one utterance');
  const firstLoud=quiet.segments[0].pcm.findIndex(sample=>Math.abs(sample)>.01);
  assert.ok(firstLoud>rate*.16,'Pre-roll preserves the quiet opening before the loud vowel');
  assert.ok(quiet.segments[0].timing.endpoint_ms>=700&&quiet.segments[0].timing.endpoint_ms<720,'Sample-based endpoint has no renderer polling delay');
  assert.equal(run([silence(500),tone(450,.012),silence(900)]).segments.length,1,'An entirely quiet word below the previous peak threshold is captured');
  const pause=run([silence(500),tone(400),silence(450),tone(500),silence(900)]);
  assert.equal(pause.segments.length,1,'A natural mid-sentence pause does not split the sentence');
  assert.ok(pause.segments[0].timing.audio_ms>1300,'The pause and the second phrase remain present');
  assert.equal(run([tone(2500,.008)]).segments.length,0,'Stationary background energy calibrates as noise');
  assert.equal(run([silence(500),tone(20,.6),silence(1000)]).segments.length,0,'A click is not a spoken turn');
  const separated=run([silence(500),tone(350),silence(1000),tone(350),silence(1000)]);
  assert.equal(separated.segments.length,2,'Separate sentences both survive continuous capture');
  separated.detector.reset(true);
  for(const part of [tone(200),silence(900)])for(let at=0;at<part.length;at+=128)separated.detector.push(part.subarray(at,at+128));
  assert.equal(separated.segments.length,3,'Resuming after playback does not recalibrate over the first word');
  const long=run([silence(500),tone(62000),silence(1000)]);
  assert.ok(long.segments.length>=3&&long.segments.every(s=>s.pcm.length<=rate*30),'Long speech stays bounded without losing subsequent segments');
  // ---- rolling-transcript feed: new audio while an utterance runs, plus one flush at the first pause ----
  {
    const chunks=[];const segments=[];
    const d=new SpeechSegments({chunkMs:1000,onSegment:(pcm,timing)=>{if(pcm.length)segments.push({pcm,timing});},onChunk:(pcm,meta)=>chunks.push({pcm,pause:meta.pause})});
    for(const part of [silence(500),tone(2400),silence(900)])for(let at=0;at<part.length;at+=128)d.push(part.subarray(at,at+128));
    assert.equal(segments.length,1);
    const voiced=chunks.filter(c=>!c.pause),flush=chunks.filter(c=>c.pause);
    assert.ok(voiced.length>=2&&voiced.every(c=>c.pcm.length>=rate),'About one second of new audio is handed out at a time while speaking');
    assert.equal(flush.length,1,'One extra hand-off when the speaker first goes quiet');
    assert.ok(flush[0].pcm.length<rate*.45,'The pause flush carries only the audio since the last chunk (the first ~300 ms of silence)');
    const sent=chunks.reduce((n,c)=>n+c.pcm.length,0);
    assert.ok(sent>=segments[0].pcm.length&&sent<=segments[0].pcm.length+rate*.8,'The chunks cover the whole segment (they may run into the trailing silence)');
    const joined=new Float32Array(sent);let at=0;for(const c of chunks){joined.set(c.pcm,at);at+=c.pcm.length;}
    assert.deepEqual(Array.from(joined.subarray(0,segments[0].pcm.length)),Array.from(segments[0].pcm),'The chunks, joined, are the segment audio sample for sample (so a tail can be cut at any committed offset)');
    const off=run([silence(500),tone(2400),silence(900)]);assert.ok(off.segments.length===1,'Without a chunk callback nothing changes');
  }
  // ---- end of turn by meaning (Smart Turn): pause -> complete / incomplete -> cap, and the fallbacks ----
  {
    const srcTurn=fs.readFileSync(path.join(__dirname,'../static/js/turnEndpoint.js'),'utf8');
    const {createTurnEndpoint}=await import('data:text/javascript;base64,'+Buffer.from(srcTurn).toString('base64'));
    const {endOfTurn,SMART_CAP_MS}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
    // The pure decision.
    assert.equal(endOfTurn({quietMs:300,verdict:null}),false,'No verdict: the ordinary 700 ms silence wait');
    assert.equal(endOfTurn({quietMs:700,verdict:null}),true,'No verdict: ends at 700 ms exactly as before');
    assert.equal(endOfTurn({quietMs:200,verdict:true}),true,'Complete ends the turn right at the pause');
    assert.equal(endOfTurn({quietMs:1500,verdict:false}),false,'Incomplete keeps listening past the ordinary wait');
    assert.equal(endOfTurn({quietMs:SMART_CAP_MS,verdict:false}),true,'Incomplete is capped at 2.5 s of silence');
    assert.equal(endOfTurn({quietMs:900,verdict:null,silenceMs:900}),true,'Open Mic keeps its own 900 ms');
    // The segmenter: feed an utterance, answer the pause question, count where it ends.
    function smartRun(parts,{verdict,delayMs=0,smart=true}={}){
      const segments=[],asked=[];let heard=0;let pending=null;
      const d=new SpeechSegments({onSegment:(pcm,timing)=>{if(pcm.length)segments.push({pcm,timing});},onPause:(id,pcm)=>{asked.push({id,len:pcm.length});pending={id,at:heard+delayMs/1000*rate};}});
      d.smartTurn(smart);
      for(const part of parts)for(let at=0;at<part.length;at+=128){
        d.push(part.subarray(at,at+128));heard+=Math.min(128,part.length-at);
        if(pending&&verdict!==undefined&&heard>=pending.at){const p=pending;pending=null;d.answer(p.id,verdict);}
      }
      return {segments,asked,d};
    }
    const talk=[silence(500),tone(1200)];
    const base=smartRun([...talk,silence(1500)]);   // smart on, never answered
    assert.equal(base.asked.length,1,'One question per pause');
    assert.equal(base.segments.length,1);
    assert.ok(base.segments[0].timing.endpoint_ms>=700&&base.segments[0].timing.endpoint_ms<720,'Unanswered: exactly today\'s 700 ms');
    const complete=smartRun([...talk,silence(1500)],{verdict:true});
    assert.equal(complete.segments.length,1);
    assert.ok(complete.segments[0].timing.endpoint_ms>=200&&complete.segments[0].timing.endpoint_ms<240,`Complete ends at the ~200 ms pause (${complete.segments[0].timing.endpoint_ms} ms)`);
    const incomplete=smartRun([...talk,silence(3000)],{verdict:false});
    assert.equal(incomplete.segments.length,1);
    assert.ok(incomplete.segments[0].timing.endpoint_ms>=2500&&incomplete.segments[0].timing.endpoint_ms<2520,`Incomplete waits until the 2.5 s cap (${incomplete.segments[0].timing.endpoint_ms} ms)`);
    const resumed=smartRun([...talk,silence(800),tone(600),silence(3000)],{verdict:false});
    assert.equal(resumed.segments.length,1,'Speaking again during an incomplete wait continues the same utterance');
    assert.equal(resumed.asked.length,2,'The next pause asks a fresh question');
    assert.ok(resumed.segments[0].pcm.length>rate*2.4,'Both phrases are in the one segment');
    const slow=smartRun([...talk,silence(1500)],{verdict:false,delayMs:600});   // verdict arrives after 800 ms of quiet
    assert.ok(slow.segments[0].timing.endpoint_ms>=700&&slow.segments[0].timing.endpoint_ms<720,'A verdict that arrives after the ordinary wait changes nothing');
    const stale=smartRun([...talk,silence(150)],{});stale.d.answer(99,true);assert.equal(stale.segments.length,0,'An answer for another pause id is ignored');
    const off=smartRun([...talk,silence(1500)],{verdict:true,smart:false});
    assert.equal(off.asked.length,0,'Smart Turn off asks nothing');
    assert.ok(off.segments[0].timing.endpoint_ms>=700&&off.segments[0].timing.endpoint_ms<720,'Smart Turn off: exactly today\'s 700 ms');
    const win=smartRun([silence(500),tone(12000),silence(400)],{});
    assert.ok(win.asked[0].len<=rate*8,'The pause question carries at most the last 8 seconds');
    // The client endpoint module: no opinion on failure, latches off when unavailable.
    let calls=0;const live=createTurnEndpoint({encode:p=>p,post:async()=>{calls++;return {available:true,complete:true,probability:.9};}});
    assert.deepEqual(await live.ask(new Float32Array(10)),{complete:true,probability:.9});
    const missing=createTurnEndpoint({encode:p=>p,post:async()=>{calls++;return {available:false};}});
    calls=0;assert.equal(await missing.ask(new Float32Array(10)),null);assert.equal(await missing.ask(new Float32Array(10)),null);
    assert.equal(calls,1,'A server without the model/runtime is asked once, then the endpoint stays off');
    calls=0;const broken=createTurnEndpoint({encode:p=>p,post:async()=>{calls++;throw new Error('x');}});
    for(let i=0;i<5;i++)assert.equal(await broken.ask(new Float32Array(10)),null);
    assert.equal(calls,3,'Three failures in a row turn it off for the session');
    const hung=createTurnEndpoint({timeoutMs:20,encode:p=>p,post:(w,signal)=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('abort'))))});
    assert.equal(await hung.ask(new Float32Array(10)),null,'A verdict that never arrives is abandoned after the timeout');
  }
  // ---- barge-in: the user's voice over Kairos's own echo ----
  {
    const leak=(ms,volume=.008,hz=180)=>Float32Array.from({length:Math.round(rate*ms/1000)},(_,i)=>volume*Math.sin(i*2*Math.PI*hz/rate));
    const voice=(ms,volume=.05)=>Float32Array.from({length:Math.round(rate*ms/1000)},(_,i)=>volume*Math.sin(i*2*Math.PI*310/rate)+.5*volume*Math.sin(i*2*Math.PI*870/rate));
    const mix=(a,b)=>Float32Array.from(a,(v,i)=>v+(b[i]||0));
    const play=(parts,options={})=>{const hits=[];const detector=new BargeIn({...options,onBarge:hit=>hits.push(hit)});detector.reset(.002);let samples=0;
      // The worklet stops feeding the detector the moment it fires (the segmenter takes over), so does this.
      outer:for(const part of parts)for(let at=0;at<part.length;at+=128){detector.push(part.subarray(at,at+128));samples+=Math.min(128,part.length-at);if(hits.length){hits[0].at=samples/rate*1000;break outer;}}
      return {hits,detector};};
    // Echo alone, quiet or loud, steady or swelling, never interrupts.
    assert.equal(play([leak(3000,.006)]).hits.length,0,'A quiet leak of Kairos\'s own voice never interrupts');
    assert.equal(play([leak(3000,.04)]).hits.length,0,'A loud leak is learned as the floor during playback and never interrupts');
    assert.equal(play([leak(1000,.02),leak(600,.03),leak(1000,.02)]).hits.length,0,'The leak swelling with Kairos\'s loudest syllables stays under three times the learned floor');
    assert.equal(play([silence(3000)]).hits.length,0,'Silence is not a voice');
    assert.equal(play([leak(1000,.002),leak(10,.9),leak(1000,.002)]).hits.length,0,'A click is not a voice');
    // A backchannel ("mm-hm", a cough) is shorter than the interrupt time and passes.
    const mmhm=play([leak(800),mix(leak(1000),voice(190)),leak(1500)]);assert.equal(mmhm.hits.length,0,'A 190 ms "mm-hm" over the echo does not interrupt');
    const two=play([leak(800),mix(leak(1000),voice(150)),leak(1000)]);assert.equal(two.hits.length,0);
    const stutter=play([leak(500),mix(leak(300),voice(150)),leak(400),mix(leak(300),voice(150)),leak(1000)]);
    assert.equal(stutter.hits.length,0,'Two short sounds with a real gap between them are two backchannels, not one 300 ms voice');
    // Sustained speech interrupts after BARGE_VOICE_MS of voice, and hands over the audio so the first word is whole.
    assert.equal(BARGE_VOICE_MS,250);
    const speech=play([leak(800),mix(leak(1500),voice(1500)),leak(500)]);
    assert.equal(speech.hits.length,1,'Sustained speech over the echo interrupts, once');
    assert.ok(speech.hits[0].at>=800+BARGE_VOICE_MS-30&&speech.hits[0].at<=800+BARGE_VOICE_MS+60,`It fires ~${BARGE_VOICE_MS} ms after the voice starts (${speech.hits[0].at} ms)`);
    const heard=speech.hits[0].parts.reduce((n,part)=>n+part.length,0);
    assert.ok(heard>=rate*(.25+.25)&&heard<=rate*(.3+.3),'The hand-over holds the 300 ms before the onset and the 250 ms of voice');
    assert.ok(speech.hits[0].voiced>=rate*.25);
    const loudOverLoud=play([leak(1000,.03),mix(leak(1500,.03),voice(1500,.2))]);
    assert.equal(loudOverLoud.hits.length,1,'A voice well above a loud leak still interrupts');
    const shortGap=play([leak(600),mix(leak(150),voice(150)),leak(80),mix(leak(150),voice(150)),leak(800)]);
    assert.equal(shortGap.hits.length,1,'A dip shorter than BARGE_GAP_MS between syllables does not restart the count');
    assert.equal(play([leak(BARGE_WARMUP_MS+10),mix(leak(1000),voice(1000))]).hits.length,1,'Voice that starts right after the warm-up interrupts');
    // The seeded utterance carries on as a normal segment: onset kept, ended by the usual silence.
    const finished=[];const seg=new SpeechSegments({onSegment:(pcm,timing)=>{if(pcm.length)finished.push({pcm,timing});}});
    for(let at=0;at<silence(500).length;at+=128)seg.push(silence(500).subarray(at,at+128));
    const det=new BargeIn({onBarge:({parts,voiced})=>seg.begin(parts,voiced)});det.reset(seg.noise);
    // Playback stops the instant the barge fires, so after it only the user (then silence) reaches the segmenter.
    const before=[leak(800),mix(leak(1500),voice(1500))];let started=0;seg.onStart=()=>started++;
    outer:for(const part of before)for(let at=0;at<part.length;at+=128){det.push(part.subarray(at,at+128));if(seg.active)break outer;}
    assert.ok(seg.active,'the detector started the utterance');
    for(const part of [voice(1250),silence(1200)])for(let at=0;at<part.length;at+=128)seg.push(part.subarray(at,at+128));
    assert.equal(started,1);assert.equal(finished.length,1,'The interrupting sentence becomes one normal segment');
    assert.ok(finished[0].pcm.length>rate*1.5,'It holds the whole sentence, from the onset, not just what came after the interrupt');
    assert.ok(finished[0].timing.endpoint_ms>=700,'and ends on the usual silence endpoint');
  }
  const file=path.join(__dirname,'../data/ui-review/native-call-audio/native-call-test.wav');
  if(fs.existsSync(file)){
    const wav=fs.readFileSync(file);let offset=12,pcm=null;
    while(offset+8<=wav.length){const length=wav.readUInt32LE(offset+4);if(wav.toString('ascii',offset,offset+4)==='data'){pcm=new Float32Array(length/2);for(let i=0;i<pcm.length;i++)pcm[i]=wav.readInt16LE(offset+8+i*2)/32768;break;}offset+=8+length+(length%2);}
    assert.ok(pcm?.length,'Actual Windows-generated speech is available');
    const actual=run([silence(500),pcm,silence(1200)]);
    assert.ok(actual.segments.length>=1,'Real speech passes the detector');
    fs.mkdirSync(path.dirname(file),{recursive:true});
    function wavFile(samples,name){const bytes=Buffer.alloc(44+samples.length*2);bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(rate,24);bytes.writeUInt32LE(rate*2,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(samples.length*2,40);samples.forEach((v,i)=>bytes.writeInt16LE(Math.round(Math.max(-1,Math.min(1,v))*32767),44+i*2));fs.writeFileSync(path.join(path.dirname(file),name),bytes);}
    actual.segments.forEach((segment,i)=>wavFile(segment.pcm,`captured-speech-${i}.wav`));
    const quietWave=Float32Array.from(pcm,v=>v*.15);const low=run([silence(500),quietWave,silence(1200)]);
    assert.ok(low.segments.length,'Quiet real speech below the old detector threshold is retained');
    low.segments.forEach((segment,i)=>wavFile(segment.pcm,`quiet-captured-speech-${i}.wav`));
    for(const [name,wave] of [['held-speech.wav',pcm],['quiet-held-speech.wav',quietWave]]) {
      let count=0;const capture=new HeldSpeech({onSegment:(samples)=>{count++;wavFile(samples,name);}});
      capture.begin();for(let at=0;at<wave.length;at+=128)capture.push(wave.subarray(at,at+128));
      capture.release();for(let i=0;i<30;i++)capture.push(new Float32Array(128));
      assert.equal(count,1,'Actual speech remains one complete held utterance');
    }
    fs.writeFileSync(path.join(path.dirname(file),'capture-segments.json'),JSON.stringify({passed:true,input_samples:pcm.length,segments:actual.segments.map(s=>s.timing)},null,2));
  }
  console.log('PASS speech segmentation: quiet word onset, pre-roll, natural pauses, stationary noise, clicks, consecutive sentences, resume, bounded long speech and actual speech waveform.');
})().catch(error=>{console.error(error);process.exitCode=1;});
