import { el } from './api.js';
import { botStatusLine } from './botStatus.js';
import { profileSprite, kipSheets } from './ecosystemAvatar.js';
import { assignment, villageLayout, roadRoute, PLACES } from './ecosystemModel.js';
import { buildingArt, villageGround } from './ecosystemArt.js';

const seed = text => [...String(text)].reduce((n,c)=>(n*31+c.charCodeAt(0))>>>0,7);
const distance = (a,b) => Math.hypot(a.x-b.x,a.y-b.y);

export function mountAgentEcosystem(host, open, retry = () => {}) {
  if (!document.getElementById('agent-ecosystem-style')) document.head.append(el('link', {
    id:'agent-ecosystem-style',rel:'stylesheet',href:'/static/css/agent-ecosystem.css',
  }));
  let disposed=false, layout=villageLayout([],[]), zoom=.85, overview=true, shown=false, paused=false;
  let agents=[], teams=[], agentsError=false, teamsError=false, frame=0, resizeFrame=0, lastTime=0, watchdog=0, inset=0;
  let layoutKey='', selected=null, detailKey='', drag=null;
  const records=new Map(), buildings=new Map();
  const reduced=matchMedia('(prefers-reduced-motion: reduce)'), phone=matchMedia('(max-width: 768px)');
  const rootState=()=>({agents,teams,agentsError,teamsError});
  const ground=el('div',{class:'ecosystem-ground','aria-hidden':'true'});
  const structures=el('div',{class:'ecosystem-structures'}), actors=el('div',{class:'ecosystem-actors'});
  const world=el('div',{class:'ecosystem-world'},[ground,structures,actors]);
  const extent=el('div',{class:'ecosystem-extent'},[world]);
  const viewport=el('div',{class:'ecosystem-viewport',tabindex:'0',role:'region','aria-label':'Agent village. Arrow keys pan; use Find in village to locate agents and places.'},[extent]);
  const summary=el('p',{class:'ecosystem-summary'}), status=el('p',{class:'ecosystem-sync',role:'status',text:'Loading your ecosystem…'});
  const percent=el('output',{class:'ecosystem-zoom-value','aria-label':'Map zoom'});
  const control=(label,text,fn)=>el('button',{type:'button',class:'ecosystem-control','aria-label':label,title:label,text,onclick:fn});
  const locate=el('select',{class:'ecosystem-locate','aria-label':'Find in village'});
  const motion=control('Pause village motion','Pause',()=>{paused=!paused;syncMotion();});
  const more=el('details',{class:'ecosystem-more'},[el('summary',{text:'More','aria-label':'More map controls'})]);
  more.append(el('div',{class:'ecosystem-extra-tools'},[
    control('Pan left','←',()=>pan(-180,0)),control('Pan up','↑',()=>pan(0,-180)),
    control('Pan down','↓',()=>pan(0,180)),control('Pan right','→',()=>pan(180,0)),
    el('p',{text:'Working agents travel to inferred workplaces. Idle agents live at home. Locations are a visualization; tasks still run in Kairos.'}),
  ]));
  const tools=el('div',{class:'ecosystem-map-tools','aria-label':'Map controls'},[
    control('Zoom out','−',()=>scale(zoom/1.3)),percent,control('Zoom in','+',()=>scale(zoom*1.3)),
    control('Fit village to screen','Fit',()=>{overview=true;fit();}),motion,more,locate,
  ]);
  const detail=el('section',{class:'ecosystem-detail','aria-label':'Village details',hidden:true});
  const retryButton=control('Retry ecosystem sync','Retry sync',retry);retryButton.hidden=true;
  host.append(el('header',{class:'ecosystem-header'},[el('h2',{text:'Agent Ecosystem'}),summary]),tools,viewport,
    el('footer',{class:'ecosystem-footer'},[status,retryButton]),detail);

  function sizing() {
    const scaled=layout.width*zoom;
    inset=Math.max(0,(viewport.clientWidth-scaled)/2);
    world.style.width=`${layout.width}px`;world.style.height=`${layout.height}px`;
    world.style.left=`${inset}px`;world.style.transform=`scale(${zoom})`;
    extent.style.width=`${Math.max(viewport.clientWidth,scaled)}px`;
    extent.style.height=`${Math.max(viewport.clientHeight,layout.height*zoom)}px`;
    percent.value=percent.textContent=`${Math.round(zoom*100)}%`;
    host.classList.toggle('ecosystem-overview',zoom<.55);
  }
  function scale(value,center=null) {
    const oldX=(viewport.scrollLeft+viewport.clientWidth/2-inset)/zoom;
    const oldY=(viewport.scrollTop+viewport.clientHeight/2)/zoom;
    overview=false;zoom=Math.max(.02,Math.min(1.8,value));sizing();
    viewport.scrollLeft=(center?.x??oldX)*zoom+inset-viewport.clientWidth/2;
    viewport.scrollTop=(center?.y??oldY)*zoom-viewport.clientHeight/2;
  }
  function fit() {
    if (!shown || !viewport.clientWidth || !viewport.clientHeight) return;
    zoom=Math.max(.02,Math.min(1,(viewport.clientWidth-16)/layout.width,(viewport.clientHeight-16)/layout.height));
    sizing();viewport.scrollLeft=0;viewport.scrollTop=0;
  }
  function pan(x,y) {overview=false;viewport.scrollBy({left:x,top:y});}
  function placeFor(key) {
    if (!key) return null;
    if (key.kind==='agent') {const r=records.get(key.id);return r?.atHome ? layout.homes.find(h=>h.id===key.id) : r?.position;}
    if (key.kind==='home') return layout.homes.find(h=>h.id===key.id);
    return (key.kind==='team'?layout.teams:layout.sites).find(b=>b.id===key.id);
  }
  function inspect(kind,id,opener=null) {
    selected={kind,id,opener};detailKey='';drawDetail();
    const point=placeFor(selected);
    if (point) scale(Math.max(.85,zoom),{x:point.x,y:point.y+70});
    detail.querySelector('h3')?.focus({preventScroll:true});
  }
  function closeDetail() {
    const opener=selected?.opener;selected=null;detail.hidden=true;detail.replaceChildren();detailKey='';
    if (opener?.isConnected && !opener.hidden) opener.focus({preventScroll:true});
  }
  locate.addEventListener('change',()=>{const option=locate.selectedOptions[0];if(option?.dataset.kind)inspect(option.dataset.kind,option.value,locate);locate.selectedIndex=0;});
  function drawLocator() {
    const groups=[['Agents','agent',agents],['Workplaces','place',layout.sites],['Teams','team',teams]];
    locate.replaceChildren(el('option',{value:'',text:'Find agent or place…'}),...groups.map(([label,kind,items])=>
      el('optgroup',{label},items.map(item=>el('option',{value:item.id,text:item.name,'data-kind':kind})))));
  }
  function drawDetail() {
    if (!selected) return;
    const {kind,id}=selected, agent=(kind==='agent'||kind==='home')?agents.find(a=>a.id===id):null;
    const team=kind==='team'?teams.find(t=>t.id===id):null, place=kind==='place'?layout.sites.find(p=>p.id===id):null;
    if (!agent&&!team&&!place) {closeDetail();return;}
    const record=agent?records.get(id):null;
    const signature=JSON.stringify([kind,id,agent,team,place,agentsError,teamsError,record?.phase]);
    if(signature===detailKey)return;detailKey=signature;
    const title=el('h3',{text:agent?.name||team?.name||place.name,tabindex:'-1'});
    const close=control('Close village details','×',closeDetail);
    const body=el('div',{class:'ecosystem-detail-body'});
    if(agent){
      const work=assignment(agent,agentsError), state=botStatusLine(agent);
      const location=record?.atHome?'At home':record?.phase==='returning'?'Returning home':record?.phase==='walking'?`Heading to ${PLACES[work.place].name}`:work.working?`At ${PLACES[work.place].name}`:'At home';
      body.append(profileSprite(agent),el('p',{text:agentsError?'Activity unavailable. Movement is paused.':`${state.text} · ${location}`}),
        el('p',{text:work.task||agent.role||'No current task'}));
      if(work.working)body.append(el('p',{class:'ecosystem-detail-note',text:`${work.source} → ${PLACES[work.place].name}. Destination is inferred from task and role keywords.`}));
      body.append(el('button',{class:'btn primary',type:'button',text:'Open direct message',onclick:()=>{closeDetail();open('agent',id);}}));
    }else if(team){
      body.append(el('p',{text:teamsError?'Team activity unavailable':`${team.state||'Unknown'} · ${team.mission||'Team workspace'}`}),
        el('button',{class:'btn primary',type:'button',text:'Open group chat',onclick:()=>{closeDetail();open('team',id);}}));
    }else{
      body.append(el('p',{text:place.description}));
      const residents=agents.filter(a=>assignment(a).working&&assignment(a).place===id);
      if(!residents.length)body.append(el('p',{text:'No agents currently working here.'}));
      for(const a of residents)body.append(el('button',{class:'btn ecosystem-occupant',type:'button',text:`${a.name} · ${agentsError?'Activity unavailable':botStatusLine(a).text}`,onclick:()=>inspect('agent',a.id,locate)}));
    }
    const focused=detail.contains(document.activeElement)?{tag:document.activeElement.tagName,label:document.activeElement.getAttribute('aria-label'),text:document.activeElement.textContent}:null;
    detail.replaceChildren(el('header',{},[title,close]),body);detail.hidden=false;
    if(focused){const replacement=[...detail.querySelectorAll('button,h3')].find(n=>n.tagName===focused.tag&&(focused.tag==='H3'||(focused.label?n.getAttribute('aria-label')===focused.label:n.textContent===focused.text)));(replacement||close).focus({preventScroll:true});}
  }
  host.addEventListener('keydown',event=>{if(event.key==='Escape'&&selected){event.preventDefault();closeDetail();}});
  function drawStructure(building) {
    const key=`${building.kind}:${building.id}`;
    let entry=buildings.get(key);
    if(!entry){
      const button=el('button',{type:'button',class:`ecosystem-building ecosystem-${building.kind}`,'data-ecosystem-key':building.kind==='team'?`team:${building.id}`:key});
      const sign=el('strong',{class:'ecosystem-sign'}),art=el('span',{class:'ecosystem-house','aria-hidden':'true'}),badge=el('span',{class:'ecosystem-team-status'});
      button.append(sign,art,badge);
      button.addEventListener('click',()=>{
        if(building.kind==='home'&&!phone.matches)open('agent',building.id);
        else if(building.kind==='team'&&!phone.matches)open('team',building.id);
        else inspect(building.kind==='home'?'agent':building.kind==='team'?'team':'place',building.id,button);
      });
      entry={button,sign,art,badge,profileKey:''};buildings.set(key,entry);structures.append(button);
    }
    const {button,sign,art,badge}=entry;
    button.style.left=`${building.x}px`;button.style.top=`${building.y}px`;sign.textContent=building.name;
    if(!entry.drawn){art.innerHTML=buildingArt(building.kind,seed(building.id));entry.drawn=true;}
    if(building.kind==='home'){
      // Kip sleeps at home when the bot is off (mascot, 2026-10-22).
      const agent=agents.find(a=>a.id===building.id), pose=botStatusLine(agent).state==='off'?'sleeping':'idle', spec=JSON.stringify([agent?.avatar||agent?.id,pose]);
      if(entry.profileKey!==spec){entry.resident?.remove();entry.resident=el('span',{class:'ecosystem-home-resident','aria-hidden':'true'},[profileSprite(agent,pose)]);button.append(entry.resident);entry.profileKey=spec;}
      button.setAttribute('aria-label',`${agent.name}’s home. ${botStatusLine(agent).text}. Open direct message`);
    }else if(building.kind==='team'){
      const team=teams.find(t=>t.id===building.id);badge.textContent=teamsError?'State unavailable':team.state||'Unknown';
      button.setAttribute('aria-label',`${building.name}, ${badge.textContent}. Open group chat`);
    }else{
      badge.textContent=building.description;
      button.setAttribute('aria-label',`${building.name}. ${building.description}. View agents here`);
    }
    button.title=button.getAttribute('aria-label');
  }
  function homeState(record) {
    const home=buildings.get(`home:${record.id}`);if(!home)return;
    home.resident.hidden=!record.atHome;
    home.badge.textContent=agentsError?'Activity unavailable':record.atHome?`${record.work.waiting?'Needs you':'At home'}`:record.phase==='returning'?'Returning home':'Away';
    home.button.classList.toggle('ecosystem-home-occupied',record.atHome);
    home.button.classList.toggle('ecosystem-state-needs_you',record.work.waiting);
  }
  function position(record) {
    record.node.style.transform=`translate(${record.position.x}px,${record.position.y}px) translate(-50%,-100%)`;
    record.node.dataset.x=String(record.position.x);record.node.dataset.y=String(record.position.y);
    record.node.dataset.motion=record.phase;record.node.hidden=record.atHome;
    homeState(record);
  }
  function pointAt(building,inside=false,offset=0){return {x:building.x+offset,y:inside?building.y+125:building.road-12,road:building.road};}
  function syncAgent(agent,index,reset=false) {
    const work=assignment(agent,agentsError), home=layout.homes.find(h=>h.id===agent.id), site=layout.sites.find(s=>s.id===work.place);
    const offset=(index%3-1)*28, destination=work.working?pointAt(site,false,offset):pointAt(home,true);
    let record=records.get(agent.id);
    if(!record){
      const node=el('button',{class:'ecosystem-character',type:'button','data-ecosystem-key':`agent:${agent.id}`});
      node.addEventListener('click',()=>phone.matches?inspect('agent',agent.id,node):open('agent',agent.id));
      const sprite=el('span',{class:'ecosystem-sprite','aria-hidden':'true'}),name=el('strong',{class:'ecosystem-sign'}),state=el('span',{class:'ecosystem-agent-status'});
      node.append(state,sprite,name);actors.append(node);
      record={id:agent.id,node,sprite,name,state,position:{...destination},route:[],atHome:!work.working,phase:work.working?'working':'home',profileKey:'',targetKey:'',circuit:0};records.set(agent.id,record);
    }
    record.work=work;record.home=home;record.site=site;record.destination=destination;
    record.node.dataset.destination=work.place;
    const spec=JSON.stringify(agent.avatar||agent.id);
    if(record.profileKey!==spec){record.sprite.replaceChildren(profileSprite(agent));for(const [name,value] of Object.entries(kipSheets(agent)))record.sprite.style.setProperty(name,value);record.profileKey=spec;}
    const state=botStatusLine(agent);record.name.textContent=agent.name;
    record.node.className=`ecosystem-character ecosystem-state-${agentsError?'unknown':state.state}`;
    record.state.textContent=agentsError?'State unavailable':state.text;
    record.node.setAttribute('aria-label',`${agent.name}, ${record.state.text}. Open direct message`);record.node.title=record.node.getAttribute('aria-label');
    const targetKey=JSON.stringify([work.working,work.waiting,work.place,work.task,agentsError]);
    if(agentsError){record.route=[];record.phase='unknown';}
    else if(reset||reduced.matches){record.position={...destination};record.route=[];record.atHome=!work.working;record.phase=work.waiting?'waiting':work.working?'working':'home';}
    else if(record.targetKey!==targetKey){
      if(work.waiting&&work.working){record.route=[];record.phase='waiting';}
      else if(distance(record.position,destination)>2){record.route=roadRoute(record.position,destination,layout).slice(1);record.atHome=false;record.phase=work.working?'walking':'returning';}
      else{record.route=[];record.atHome=!work.working;record.phase=work.waiting?'waiting':work.working?'working':'home';}
    }
    record.targetKey=targetKey;position(record);
  }
  function workingCircuit(record) {
    const x=record.destination.x, y=record.site.road;
    record.route=[{x,y},{x:x+30,y},{x:x-30,y},{x,y},{...record.destination}];
    record.phase='working';
  }
  function tick(time) {
    frame=0;if(disposed||!shown||host.hidden||document.hidden||paused||agentsError)return;
    if(reduced.matches){agents.forEach((agent,i)=>syncAgent(agent,i,true));syncMotion();return;}
    const delta=Math.min(.05,(time-(lastTime||time))/1000);lastTime=time;
    for(const record of records.values()){
      if((record.work.waiting&&record.work.working)||record.work.unavailable||record.atHome||record.node.matches(':focus,:hover'))continue;
      if(!record.route.length&&record.work.moving)workingCircuit(record);
      const next=record.route[0];if(!next)continue;
      const length=distance(record.position,next), step=delta*85;
      if(length<=step){record.position={...next};record.route.shift();
        if(!record.route.length){record.atHome=!record.work.working;record.phase=record.work.working?'working':'home';drawDetail();}
      }else{record.position.x+=(next.x-record.position.x)/length*step;record.position.y+=(next.y-record.position.y)/length*step;}
      position(record);
    }
    if([...records.values()].some(r=>r.route.length||r.work.moving))frame=requestAnimationFrame(tick);
  }
  function syncMotion() {
    cancelAnimationFrame(frame);frame=0;lastTime=0;
    motion.textContent=paused?'Resume':'Pause';motion.setAttribute('aria-label',paused?'Resume village motion':'Pause village motion');motion.setAttribute('aria-pressed',String(paused));
    host.classList.toggle('ecosystem-motion-paused',paused||reduced.matches||agentsError||!shown);
    if(!paused&&!reduced.matches&&!agentsError&&shown&&!document.hidden&&!host.hidden&&[...records.values()].some(r=>r.route.length||r.work.moving))frame=requestAnimationFrame(tick);
  }
  function update(next,projectionOnly=false) {
    if(disposed)return;
    ({agents=[],teams=[],agentsError=false,teamsError=false}=next);
    agents=[...agents].sort((a,b)=>String(a.id).localeCompare(String(b.id)));teams=[...teams].sort((a,b)=>String(a.id).localeCompare(String(b.id)));
    if(!projectionOnly){clearTimeout(watchdog);if(!agentsError)watchdog=setTimeout(()=>{if(!disposed)update({...rootState(),agentsError:true});},30000);}
    const text=agentsError?'Agents offline · motion paused':teamsError?'Teams offline · last known buildings':'Synced · locations inferred from work';
    if(status.textContent!==text)status.textContent=text;
    retryButton.hidden=!agentsError&&!teamsError;host.classList.toggle('ecosystem-stale',agentsError||teamsError);
    summary.textContent=`${agents.length} ${agents.length===1?'agent':'agents'} · ${teams.length} ${teams.length===1?'team':'teams'} · ${agents.filter(a=>assignment(a).working).length} working${agentsError?' (last known)':''}`;
    const nextLayout=villageLayout(agents,teams,phone.matches?3:4), nextKey=JSON.stringify(nextLayout), changed=nextKey!==layoutKey;
    if(changed){layout=nextLayout;layoutKey=nextKey;ground.innerHTML=villageGround(layout);drawLocator();}
    const activeKeys=new Set([...layout.sites,...layout.homes,...layout.teams].map(b=>`${b.kind}:${b.id}`));
    for(const [key,entry]of buildings)if(!activeKeys.has(key)){entry.button.remove();buildings.delete(key);}
    for(const building of [...layout.sites,...layout.homes,...layout.teams])drawStructure(building);
    for(const [id,record]of records)if(!agents.some(a=>a.id===id)){record.node.remove();records.delete(id);}
    agents.forEach((agent,i)=>syncAgent(agent,i,changed));
    let empty=world.querySelector('.ecosystem-empty');
    if(!agents.length&&!teams.length){if(!empty){empty=el('p',{class:'ecosystem-empty'});world.append(empty);}empty.textContent=agentsError?'Your village will return when agents reconnect.':'Create agents and teams in Chats to bring your village to life.';}else empty?.remove();
    sizing();if(changed&&overview)fit();drawDetail();syncMotion();
  }
  viewport.addEventListener('pointerdown',event=>{
    if(event.pointerType!=='mouse'||event.button!==0||event.target.closest('button'))return;
    overview=false;drag={x:event.clientX,y:event.clientY,left:viewport.scrollLeft,top:viewport.scrollTop};
    viewport.setPointerCapture(event.pointerId);viewport.classList.add('is-dragging');event.preventDefault();
  });
  viewport.addEventListener('pointermove',event=>{if(drag){viewport.scrollLeft=drag.left-(event.clientX-drag.x);viewport.scrollTop=drag.top-(event.clientY-drag.y);}});
  const endDrag=()=>{drag=null;viewport.classList.remove('is-dragging');};
  for(const event of ['pointerup','pointercancel','lostpointercapture'])viewport.addEventListener(event,endDrag);
  viewport.addEventListener('touchstart',()=>{overview=false;},{passive:true});
  viewport.addEventListener('keydown',event=>{
    if(event.target!==viewport)return;const delta={ArrowLeft:[-120,0],ArrowRight:[120,0],ArrowUp:[0,-120],ArrowDown:[0,120]}[event.key];
    if(delta){event.preventDefault();pan(...delta);}if(event.key==='Home'){event.preventDefault();overview=true;fit();}
  });
  const resize=new ResizeObserver(()=>{cancelAnimationFrame(resizeFrame);resizeFrame=requestAnimationFrame(()=>{resizeFrame=0;if(disposed)return;if(overview)fit();else sizing();});});resize.observe(viewport);
  const visibility=()=>syncMotion(), reducedChange=()=>{agents.forEach((a,i)=>syncAgent(a,i,true));syncMotion();};
  const phoneChange=()=>update(rootState(),true);
  document.addEventListener('visibilitychange',visibility);reduced.addEventListener('change',reducedChange);phone.addEventListener('change',phoneChange);
  return {update,reveal(){shown=true;if(overview)fit();syncMotion();},conceal(){shown=false;syncMotion();},destroy(){disposed=true;cancelAnimationFrame(frame);cancelAnimationFrame(resizeFrame);clearTimeout(watchdog);resize.disconnect();document.removeEventListener('visibilitychange',visibility);reduced.removeEventListener('change',reducedChange);phone.removeEventListener('change',phoneChange);endDrag();host.replaceChildren();}};
}
