const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
(async()=>{
  const source=fs.readFileSync(path.join(__dirname,'../static/js/ecosystemModel.js'),'utf8');
  const {assignment,classifyWork,villageLayout,roadRoute}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
  assert.equal(classifyWork('CS homework and quiz'),'school');
  assert.equal(classifyWork('Debug Python code'),'lab');
  assert.equal(classifyWork('Deploy database server'),'datacenter');
  assert.equal(classifyWork('Read research papers'),'library');
  assert.equal(classifyWork('Design a video'),'studio');
  assert.equal(classifyWork('Review email inbox'),'office');
  const developer={id:'a',name:'A',enabled:true,role:'Software developer',status:'working',status_detail:'CS class homework'};
  assert.equal(assignment(developer).place,'school','Current task overrides standing role');
  assert.equal(assignment({...developer,status_detail:'Continue'}).place,'lab','Role supplies a labeled fallback');
  assert.equal(assignment({...developer,role:'General helper',status_detail:''}).place,'commons');
  assert.equal(assignment({...developer,needs_you:1}).moving,false,'Attention pauses motion');
  assert.equal(assignment(developer,true).moving,false,'Unavailable activity cannot drive movement');
  assert.equal(assignment({...developer,status:'idle',status_detail:'Debug code'}).working,false,'Old task labels cannot trigger work');
  assert.equal(assignment({...developer,status:'idle',activity:{working:true,name:'Server deployment',detail:''}}).place,'datacenter','Live chat activity is supported');
  const layout=villageLayout([developer],[]), next=villageLayout([{...developer,status_detail:'Debug code'}],[]);
  assert.deepEqual(layout,next,'Task changes preserve town geometry');
  assert.equal(layout.homes.length,1);
  const connected=town=>{
    const visited=new Set([0]),pending=[0];
    while(pending.length){const id=pending.pop();for(const edge of town.graph.edges){const other=edge.a===id?edge.b:edge.b===id?edge.a:null;if(other!==null&&!visited.has(other)){visited.add(other);pending.push(other);}}}
    assert.equal(visited.size,town.graph.nodes.length,'Every building and loop is reachable');
  };
  const home=layout.homes[0],lab=layout.sites.find(s=>s.id==='lab');
  const route=roadRoute({x:home.x,y:home.y+125},{x:lab.x,y:lab.road-12},layout);
  assert.ok(route.some(p=>p.x===510&&p.y===560)&&route.some(p=>p.x===910&&p.y===560),'A commute crosses the actual lake bridge');
  assert.ok(new Set(layout.sites.map(b=>b.y)).size>=6,'Public buildings are staggered rather than arranged in rows');
  assert.equal(layout.lakes.length,2);
  assert.equal(layout.paths.filter(p=>p.kind==='bridge').length,2);
  const phone=villageLayout([developer],[],3);
  assert.ok(phone.width<layout.width,'Phone has its own portrait landscape');
  for(const town of [layout,phone]){
    connected(town);
    assert.ok(town.paths.some(p=>p.kind==='trail'));
    for(const b of [...town.sites,...town.homes,...town.teams]){
      const path=roadRoute({x:b.x,y:b.y+125},{x:town.sites[0].x,y:town.sites[0].road-12},town);
      assert.ok(path.length>=2);
    }
    // Retarget from the middle of an existing segment without teleporting
    // back to an endpoint or cutting across the landscape.
    const edge=town.graph.edges.find(e=>e.kind==='bridge'),a=town.graph.nodes[edge.a],b=town.graph.nodes[edge.b];
    const middle={x:(a.x+b.x)/2,y:(a.y+b.y)/2};
    const reroute=roadRoute(middle,{x:town.homes[0].x,y:town.homes[0].y+125},town);
    assert.deepEqual(reroute[0],middle);
    assert.equal(reroute[1].y,middle.y,'Reroute stays on its bridge until reaching the bank');
  }
  const crowded=villageLayout(Array.from({length:24},(_,i)=>({id:String(i),name:'Agent '+i})),Array.from({length:11},(_,i)=>({id:String(i),name:'Team '+i})));
  connected(crowded);
  assert.ok(Math.max(...crowded.teams.map(t=>t.road))<crowded.height);
  const inPolygon=(p,polygon)=>{
    let inside=false;for(let i=0,j=polygon.length-1;i<polygon.length;j=i++){
      const a=polygon[i],b=polygon[j];if((a[1]>p.y)!==(b[1]>p.y)&&p.x<(b[0]-a[0])*(p.y-a[1])/(b[1]-a[1])+a[0])inside=!inside;
    }return inside;
  };
  const hitsRoof=(a,b,house,margin=0)=>{
    let low=0,high=1;const dx=b.x-a.x,dy=b.y-a.y;
    for(const [p,q]of [[-dx,a.x-(house.x-95-margin)],[dx,house.x+95+margin-a.x],[-dy,a.y-(house.y+35-margin)],[dy,house.y+145+margin-a.y]]){
      if(!p){if(q<0)return false;}else{const t=q/p;if(p<0)low=Math.max(low,t);else high=Math.min(high,t);if(low>high)return false;}
    }return true;
  };
  for(const town of [layout,phone,crowded,villageLayout(Array.from({length:24},(_,i)=>({id:String(i),name:'A'+i})),Array.from({length:11},(_,i)=>({id:String(i),name:'T'+i})),3)]){
    connected(town);
    for(const edge of town.graph.edges){
      const a=town.graph.nodes[edge.a],b=town.graph.nodes[edge.b];
      if(edge.kind!=='drive')for(const house of [...town.sites,...town.homes,...town.teams])assert.ok(!hitsRoof(a,b,house,edge.kind==='trail'?12.5:20),'Painted public route clears '+house.id+' '+JSON.stringify([a,b]));
      if(edge.kind!=='bridge')for(let step=0,count=Math.ceil(Math.hypot(b.x-a.x,b.y-a.y)/8);step<=count;step++){
        const t=count?step/count:0,p={x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t};
        assert.ok(!town.lakes.some(lake=>inPolygon(p,lake)),'Water crossings use actual bridge edges');
        const width=edge.kind==='trail'?12.5:edge.kind==='drive'?15.5:20;
        const length=Math.hypot(b.x-a.x,b.y-a.y)||1;
        for(const side of [-1,1]) {
          const bank={x:p.x+side*width*(b.y-a.y)/length,y:p.y-side*width*(b.x-a.x)/length};
          assert.ok(!town.lakes.some(lake=>inPolygon(bank,lake)),'Painted road banks stay clear of water '+JSON.stringify([a,b,bank]));
        }
      }
    }
  }
  console.log('PASS Ecosystem model: all workplace types, current-task/role fallback, attention/offline gates, live chat work, stable homes, irregular landscapes, connected loops/bridges, mid-route retargeting and larger rosters.');
})().catch(error=>{console.error(error);process.exitCode=1;});
