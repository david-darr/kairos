// Pure presentation rules. These locations describe work; they never schedule it.
export const PLACES = {
  commons: { name: 'Commons', description: 'General work and conversations', kind: 'commons' },
  school: { name: 'School', description: 'Classes, coursework and studying', kind: 'school' },
  lab: { name: 'Development lab', description: 'Code, builds and debugging', kind: 'lab' },
  datacenter: { name: 'Data center', description: 'Servers, infrastructure and deployments', kind: 'datacenter' },
  library: { name: 'Library', description: 'Research, reading and reference work', kind: 'library' },
  studio: { name: 'Creative studio', description: 'Design, media and creative production', kind: 'studio' },
  office: { name: 'Office', description: 'Planning, messages and administration', kind: 'office' },
};
const topics = [
  ['school', /\b(school|homework|coursework|course|class|classes|assignment|semester|exam|quiz|lecture|study|studying|student|tutor|curriculum)\b/i],
  ['datacenter', /\b(server|servers|infrastructure|deploy|deployment|hosting|devops|database|databases|docker|kubernetes|cloud|network)\b/i],
  ['lab', /\b(dev|developer|development|code|coding|programming|software|debug|debugging|bug|bugs|build|compile|test|tests|repo|repository|roblox|api)\b/i],
  ['studio', /\b(design|designer|ui|ux|art|image|images|illustration|video|music|media|animation|blender|creative|photography)\b/i],
  ['library', /\b(research|read|reading|reference|references|paper|papers|literature|archive|archives|archivist|fact.check)\b/i],
  ['office', /\b(email|inbox|calendar|meeting|schedule|planning|plan|admin|administration|finance|budget|business|outreach|job|jobs|recruit)\b/i],
];
export function classifyWork(text) {
  return topics.find(([, pattern]) => pattern.test(String(text || '')))?.[0] || 'commons';
}
export function assignment(agent, unavailable = false) {
  const activity = agent.activity;
  const working = agent.enabled !== false && (activity?.working ?? agent.status === 'working');
  const waiting = !!activity?.waiting || agent.status === 'needs_you' || (agent.needs_you || 0) > 0;
  const task = activity?.working ? `${activity.name || ''} ${activity.detail || ''}` : working ? agent.status_detail || '' : '';
  const explicit = classifyWork(task);
  const role = classifyWork(`${agent.role || ''} ${agent.blurb || ''}`);
  return { working, waiting, moving: working && !waiting && !unavailable,
    place: explicit === 'commons' ? role : explicit,
    source: explicit !== 'commons' ? 'Current work' : role !== 'commons' ? 'Agent role' : 'General work',
    task: activity?.name || (working ? agent.status_detail : '') || '',
    unavailable,
  };
}
// Two hand-composed landscapes, with stable extensions for larger rosters.
// Buildings keep their identity and position when the current task changes.
export function villageLayout(agents, teams, columns = 4) {
  const portrait = columns === 3;
  const width = portrait ? 1320 : 1800;
  const locations = portrait ? {
    commons:[680,120], school:[260,280], lab:[1080,380], datacenter:[1060,1060],
    library:[280,1040], studio:[300,1550], office:[780,1570],
  } : {
    commons:[800,140], school:[330,190], lab:[1320,220], datacenter:[1480,750],
    library:[500,850], studio:[240,1150], office:[1040,1100],
  };
  const position = (id,name,kind,xy) => ({id,name,kind,x:xy[0],y:xy[1],road:xy[1]+205});
  const sites=Object.entries(PLACES).map(([id,p])=>({...position(id,p.name,p.kind,locations[id]),description:p.description}));
  const firstHomes=portrait?[[210,700],[780,850]]:[[200,650],[1010,600]];
  const extensionStart=portrait?1930:1520, bandHeight=portrait?540:560;
  const homes=agents.map((agent,i)=>{
    const n=i-2, slot=n%3, band=Math.floor(n/3);
    const xy=i<2?firstHomes[i]:[
      (portrait?[260,800,1100]:[300,920,1510])[slot],
      extensionStart+band*bandHeight+[20,180,60][slot],
    ];
    return position(agent.id,`${agent.name}’s home`,'home',xy);
  });
  const teamStart=extensionStart+Math.ceil(Math.max(0,homes.length-2)/3)*bandHeight;
  const buildings=teams.map((team,i)=>{
    const n=i-1,slot=n%3,band=Math.floor(n/3);
    const xy=i===0?(portrait?[1080,1630]:[1480,1150]):[
      (portrait?[270,1040,650]:[430,1410,900])[slot],
      teamStart+band*700+[160,0,320][slot],
    ];
    return position(team.id,team.name,'team',xy);
  });
  const paths=[];
  const add=(kind,points)=>paths.push({kind,points:points.map(([x,y])=>({x,y}))});
  const lines=portrait?[
    ['road',[[470,600],[360,650],[60,680],[60,980],[60,1400],[60,1900],[460,1870],[780,1870],[920,1870],[1240,1900],[1260,1300],[1260,700],[1150,680],[910,600]]],
    ['bridge',[[470,600],[910,600]]],
    ['road',[[910,600],[920,370],[680,325]]],
    ['road',[[360,650],[330,560],[260,485]]],
    ['road',[[1150,680],[1080,585]]],
    ['road',[[1260,1300],[1060,1350],[1060,1265]]],
    ['road',[[1260,1300],[850,1320],[850,1510],[920,1510],[920,1870]]],
    ['road',[[850,1320],[850,1140],[780,1055]]],
    ['trail',[[470,600],[430,850],[430,1300],[350,1330],[460,1510],[460,1870]]],
    ['road',[[350,1330],[280,1245]]],
    ['trail',[[430,1300],[470,1410]]],
    ['bridge',[[470,1410],[810,1410]]],
    ['trail',[[810,1410],[850,1510]]],
    ['road',[[60,1900],[300,1850],[300,1755]]],
    ['road',[[780,1870],[780,1775]]],
  ]:[
    ['road',[[510,560],[340,580],[60,600],[60,970],[60,1410],[530,1410],[920,1450],[1320,1420],[1660,1410],[1670,1050],[1690,730],[1620,460],[1260,480],[1190,550],[910,560]]],
    ['bridge',[[510,560],[910,560]]],
    ['road',[[340,580],[390,460],[330,395]]],
    ['road',[[910,560],[930,400],[800,345]]],
    ['road',[[1260,480],[1320,425]]],
    ['road',[[1670,1050],[1480,1040],[1480,955]]],
    ['road',[[1190,550],[1200,900],[1060,860],[1010,805]]],
    ['road',[[1200,900],[1200,1040],[1670,1050]]],
    ['road',[[1200,1040],[1320,1420]]],
    ['trail',[[510,560],[365,760],[345,1120],[500,1120]]],
    ['road',[[530,1410],[500,1120],[500,1055]]],
    ['trail',[[500,1120],[590,1220],[630,1220]]],
    ['bridge',[[630,1220],[910,1220]]],
    ['trail',[[910,1220],[900,1400],[920,1450]]],
    ['road',[[60,1410],[190,1380],[240,1355]]],
    ['road',[[1320,1420],[1100,1430],[1040,1305]]],
  ];
  for(const [kind,points] of lines)add(kind,points);
  // Private front walks meet the public network; their inner endpoint is a
  // leaf, so a shortest route cannot use somebody else's house as a shortcut.
  for(const b of [...sites,...homes,...buildings])add('drive',[[b.x,b.y+125],[b.x,b.road]]);
  if(homes[0])add('road',portrait?[[210,905],[270,970],[60,980]]:[[200,855],[230,940],[60,970]]);
  if(buildings[0])add('road',portrait?[[1080,1835],[1080,1900],[1240,1900]]:[[1480,1355],[1480,1410],[1660,1410]]);
  let east=portrait?[1240,1900]:[1660,1410], west=portrait?[60,1900]:[60,1410];
  // Side lanes and connected loops around each new neighborhood, with clear
  // front approaches even when its cottages are staggered at different heights.
  for(const district of [homes.slice(2),buildings.slice(1)])for(let i=0;i<district.length;i+=3){
    const group=district.slice(i,i+3),y=Math.max(...group.map(b=>b.road))+90;
    const left=[60,y],right=[portrait?1260:1690,y];
    add('road',[west,left,right,east]);west=left;east=right;
    for(const b of group)add('trail',[[b.x,b.road],[b.x,y]]);
  }
  const all=[...sites,...homes,...buildings];
  const height=Math.max(portrait?2000:1510,...all.map(b=>b.road+210),...paths.flatMap(p=>p.points.map(point=>point.y+100)));
  const lakes=portrait?[
    [[520,470],[620,450],[790,490],[860,560],[820,690],[650,720],[520,665],[490,570]],
    [[520,1330],[620,1300],[735,1340],[770,1420],[720,1510],[570,1500],[500,1440],[490,1370]],
  ]:[
    [[560,450],[680,430],[780,465],[850,505],[860,610],[800,670],[640,685],[550,640],[530,550]],
    [[690,1140],[770,1125],[835,1165],[860,1240],[815,1315],[710,1335],[665,1280],[650,1200]],
  ];
  const parks=portrait?[[500,220],[560,1040],[1100,850]]:[[1060,210],[780,910],[1510,570]];
  const graph=pathGraph(paths);
  return {width,height,sites,homes,teams:buildings,paths,lakes,parks,graph};
}

// Split crossings and T junctions into shared vertices, including extensions.
// A road drawn through another road must also be connected for navigation.
function pathGraph(paths){
  const segments=[];
  for(const path of paths)for(let i=1;i<path.points.length;i++)segments.push({a:path.points[i-1],b:path.points[i],kind:path.kind,cuts:[0,1]});
  const cross=(a,b)=>a.x*b.y-a.y*b.x,minus=(a,b)=>({x:a.x-b.x,y:a.y-b.y});
  const cut=(s,t)=>{if(t>=-1e-8&&t<=1+1e-8)s.cuts.push(Math.max(0,Math.min(1,t)));};
  for(let i=0;i<segments.length;i++)for(let j=i+1;j<segments.length;j++){
    const a=segments[i],b=segments[j],r=minus(a.b,a.a),s=minus(b.b,b.a),q=minus(b.a,a.a),den=cross(r,s);
    if(Math.abs(den)>1e-8){
      const t=cross(q,s)/den,u=cross(q,r)/den;
      if(t>=-1e-8&&t<=1+1e-8&&u>=-1e-8&&u<=1+1e-8){cut(a,t);cut(b,u);}
    }else if(Math.abs(cross(q,r))<1e-8){
      const rr=r.x*r.x+r.y*r.y,ss=s.x*s.x+s.y*s.y;
      for(const p of [b.a,b.b])if(rr)cut(a,((p.x-a.a.x)*r.x+(p.y-a.a.y)*r.y)/rr);
      for(const p of [a.a,a.b])if(ss)cut(b,((p.x-b.a.x)*s.x+(p.y-b.a.y)*s.y)/ss);
    }
  }
  const nodes=[],edges=[],ids=new Map(),edgeKeys=new Set();
  const node=point=>{
    const x=Math.round(point.x*1e3)/1e3,y=Math.round(point.y*1e3)/1e3,key=`${x},${y}`;
    if(!ids.has(key)){ids.set(key,nodes.length);nodes.push({x,y,id:nodes.length});}return ids.get(key);
  };
  for(const segment of segments){
    const cuts=[...new Set(segment.cuts.map(t=>Math.round(t*1e9)/1e9))].sort((a,b)=>a-b);
    const point=t=>({x:segment.a.x+(segment.b.x-segment.a.x)*t,y:segment.a.y+(segment.b.y-segment.a.y)*t});
    for(let i=1;i<cuts.length;i++){
      const a=node(point(cuts[i-1])),b=node(point(cuts[i])),key=[a,b].sort((a,b)=>a-b).join(':');
      if(a!==b&&!edgeKeys.has(key)){edges.push({a,b,kind:segment.kind});edgeKeys.add(key);}
    }
  }
  return {nodes,edges};
}

export function projectToSegment(point,a,b){
  const dx=b.x-a.x,dy=b.y-a.y,den=dx*dx+dy*dy;
  const t=den?Math.max(0,Math.min(1,((point.x-a.x)*dx+(point.y-a.y)*dy)/den)):0;
  return {x:a.x+t*dx,y:a.y+t*dy};
}
export function roadRoute(from,to,layout){
  const {nodes,edges}=layout.graph, length=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
  const nearest=point=>edges.reduce((best,edge)=>{
    const p=projectToSegment(point,nodes[edge.a],nodes[edge.b]),distance=length(point,p);
    return !best||distance<best.distance?{edge,p,distance}:best;
  },null);
  const start=nearest(from),end=nearest(to);if(!start||!end)return [from,to];
  const points=[...nodes,start.p,end.p],source=nodes.length,target=source+1;
  const adjacency=points.map(()=>[]),link=(a,b)=>{const weight=length(points[a],points[b]);adjacency[a].push([b,weight]);adjacency[b].push([a,weight]);};
  for(const edge of edges)link(edge.a,edge.b);
  for(const id of [start.edge.a,start.edge.b])link(source,id);
  for(const id of [end.edge.a,end.edge.b])link(target,id);
  if(start.edge===end.edge)link(source,target);
  const costs=points.map(()=>Infinity),previous=new Map(),pending=new Set(points.map((_,i)=>i));costs[source]=0;
  while(pending.size){
    let current=null;for(const id of pending)if(current===null||costs[id]<costs[current])current=id;
    if(!Number.isFinite(costs[current])||current===target)break;
    pending.delete(current);
    for(const [next,weight]of adjacency[current])if(costs[current]+weight<costs[next]){costs[next]=costs[current]+weight;previous.set(next,current);}
  }
  if(!Number.isFinite(costs[target]))throw new Error('The village road network is disconnected');
  const route=[];for(let id=target;id!==undefined;id=previous.get(id))route.unshift(points[id]);
  return [from,...route,to].filter((p,i,all)=>!i||length(p,all[i-1])>.01);
}
