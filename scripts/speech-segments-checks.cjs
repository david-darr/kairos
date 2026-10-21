const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
(async()=>{
  const source=fs.readFileSync(path.join(__dirname,'../static/js/speechSegments.js'),'utf8');
  const {SpeechSegments,HeldSpeech}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
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
