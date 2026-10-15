(function(){'use strict';
const $=id=>document.getElementById(id),A=window.KairosArt,C=A.C,g=$('art').getContext('2d');A.setContext(g);
let index=Math.max(0,Math.min(45,Number(location.hash.slice(1))||0)),t=0,playing=true,last=0,step=-1,ready=false;
const reduce=matchMedia('(prefers-reduced-motion: reduce)').matches;
const examples={
0:['Model','Practice project','Meeting agenda'],1:['Chats + Library','Agents + Tasks','Store + Forge'],2:['Public release: 2.1.0','Guide snapshot: 5563c2b','Forge Preview'],3:['Windows 10 / 11','Apple Silicon Mac','Practice notes'],4:['Claude Code','Codex','API / local endpoint'],5:['Hardware requirements','Model download','Engine running'],6:['Model selected','Draft an agenda from these notes.','Agenda: decisions, discussion, next steps'],7:['brief.md','meeting-notes.pdf','Workspace: Practice'],8:['Product launch','Audience: independent builders','tone.md'],9:['@brief.md','/help  /setup  /find','Summary grounded in brief.md'],10:['Find in conversation','Fork from this message','Second approach'],11:['Launch brief','Make this sentence more direct.','Updated draft'],12:['Source page','Reference beside the conversation','Open in browser'],13:['Project brief','Research','Decisions'],14:['Prepare review','Priority: High','Due: Thursday'],15:['Documents & files','Vault','Google Drive'],16:['Project review','Thursday, 2:00 PM','Week view'],17:['IMAP: incoming','SMTP: outgoing','Draft: Thanks for the update.'],18:['Scout','Archivist','Launch reviewer'],19:['Launch reviewer','Review briefs for missing decisions.','Workspace: Practice'],20:['Launch reviewer','Check this brief for missing decisions.','Two decisions still need owners.'],21:['Review complete','Question: Who owns launch day?','Result: review.md'],22:['Audience: independent builders','Correction: small teams','Change recorded; Undo available'],23:['Weekdays, 9:00 AM','Review practice notes','Receipt: review ready'],24:['Lead','Researcher','Reviewer'],25:['Daily summary','9:00 AM · selected model','Delivery: in-app'],26:['Repository event','Filter: selected project','Action: create a review'],27:['Tool: read practice.md','Result: summary.md','Delivery: completed'],28:['Skill / tool / tab / automation','Scan findings','Install reviewed item'],29:['Writing skill','Make this sample brief clearer.','Clearer brief for review'],30:['MCP server address','Connection and sign-in','New tools pending approval'],31:['School','CRM','Source review'],32:['Canvas connection','Upcoming assignment','Your work: draft'],33:['Selected message sources','Evidence: client requested Thursday','Follow-up task; reply draft'],34:['Practice repository','Separate Git worktree','Plan / Build'],35:['Changes: agenda.txt','+ Add decision owners','Review before Undo'],36:['Run app','Project command approval','App Preview'],37:['Contained browser','Take over','Hand back'],38:['Choose a connector','Allowed senders','Private test response'],39:['Tailscale address','HTTPS + login','Phone browser connected'],40:['Requested tool','Practice folder only','Review this request'],41:['App-data archive','Credentials: optional','Vault: separate backup'],42:['Home cards','Visible tabs','Shortcuts'],43:['Model / sign-in','Tools / workspace / approvals','Run / channel delivery'],44:['brief.md','Agenda + revision comment','Launch reviewer receipt'],45:['Your model','Your context','Your result']};
Object.assign(examples,{3:['Download: Windows or Apple Silicon','Vault folder: Practice notes','Workspace opened'],4:['Provider: Claude Code','Sign-in: account connected','Composer: chosen model'],19:['Name: Launch reviewer','Workspace: Practice · narrow tools','Model selected · bot saved'],30:['Server: reviewed MCP endpoint','Connection and sign-in complete','New tools awaiting approval'],38:['Connector: selected service','Allowed senders: practice account','Private test response received'],40:['Tool request: read a file','Scope: Practice folder only','Allow the reviewed request']});
function resize(){const s=Math.min(innerWidth/1920,innerHeight/1080);$('stage').style.transform=`scale(${s})`;}
function clippedText(text,x,y,w,size=28,color=C.ink){A.text(text,x,y,size,color,400,'left',false,w)}
function row(label,x,y,w,selected=false,icon='file'){A.rect(x,y,w,66,12,selected?C.paper:C.light,selected?C.gold:C.line);A.icon(icon,x+18,y+20,25,selected?C.gold:C.dim);clippedText(label,x+62,y+33,w-85,25);if(selected)A.check(x+w-28,y+33,1)}
function label(text,x,y){A.text(text,x,y,20,C.dim,450)}
function type(text,p){return text.slice(0,Math.max(0,Math.floor(A.clamp(p)*text.length)))}
function draw(local=t){
 if(!ready)return;A.setContext(g);const s=LESSONS[index],items=examples[index],k=Math.min(2,Math.floor(local/4)),p=A.clamp((local-k*4)/1.4),q=A.out(p);
 A.backdrop(local*.3);A.line(800,230,800,940,C.line,1);
 A.pose(850,250,1,()=>{
 const dy=(1-A.out(Math.min(local,1)))*20;A.pose(0,dy,1,()=>{
 A.app(0,0,960,640,s.where);const x=30,y=88,w=900;
 // Every lesson has a specific object, input and visible outcome. No screenshot assets.
 const kind=({17:'email',22:'botMemory',33:'crm',34:'forgeStart',36:'forgeRun',41:'backup'})[index]||s.kind;
 switch(kind){
 case'email':{
 if(k===0){A.text('Connect an email account',x,y+35,36,C.ink,500);row('IMAP · incoming mail',x,y+110,885,true,'mail');row('SMTP · outgoing mail',x,y+215,885,false,'plug');A.pill('Use your provider’s connection settings',x+100,y+365,680,C.paper,C.dim,25,60);}
 else{A.rect(x,y,280,460,12,C.paper);row('Inbox',x+15,y+25,250,true,'mail');A.wrap('Project check-in',x+25,y+130,230,29,C.ink,1.3);A.text('Sample sender',x+25,y+222,22,C.dim);A.card(x+305,y,580,460,12,C.white,false);A.text(k===1?'Message':'Reply draft',x+332,y+44,32,C.ink,500);A.wrap(k===1?'Can we review the launch brief on Thursday?':'Thanks for the update. Thursday works for the review.',x+332,y+125,520,31,C.ink,1.4);if(k===2)A.button('Review draft before sending',x+332,y+356,520,true,25,64);}
 break;}
 case'botMemory':{
 A.text('Launch reviewer · Memory',x,y+30,36,C.ink,500);A.card(x,y+95,885,230,16);label('REMEMBERED CONTEXT',x+25,y+132);A.text(k<2?'Audience: independent builders':'Audience: small teams',x+25,y+192,33,C.ink,400,'left',false,820);if(k>=1){A.rect(x+25,y+236,830,62,12,C.paper,C.gold);A.text(type('Correction: the audience is small teams.',p),x+42,y+267,28,C.ink,400,'left',false,785)}if(k===2){A.check(x+28,y+405);A.text('Change recorded',x+70,y+405,29,C.ink);A.button('Undo',x+670,y+375,210,false,26,60)}break;}
 case'crm':{
 A.pill(k===0?'Sources':k===1?'Source evidence':'Follow-up task',x,y,300,C.paper,C.ink,27,54);
 if(k===0){row('Selected email account',x,y+100,885,true,'mail');row('Selected message connection',x,y+210,885,true,'chat');A.button('Scan now',x+565,y+350,320,true,28,64)}
 if(k===1){A.card(x,y+100,885,330,16);label('QUOTED EVIDENCE · SAMPLE MESSAGE',x+25,y+145);A.wrap('“Please send the revised launch brief by Thursday.”',x+25,y+230,820,38,C.ink,1.3);A.button('Open source',x+25,y+330,300,false,26,60)}
 if(k===2){row('Revise the launch brief',x,y+95,885,true,'file');A.pill('Due Thursday · review inference',x,y+190,570,C.paper,C.dim,25,56);A.button('Draft reply',x,y+290,400,true,26,60);A.button('Open task chat',x+435,y+290,450,false,26,60);A.wrap('Inspect the evidence before acting on an extracted task.',x,y+415,830,29,C.dim,1.3)}break;}
 case'forgeStart':{
 A.text('Forge Preview · new session',x,y+25,36,C.ink,500);row('Practice repository',x,y+90,885,k===0,'folder');A.line(x+95,y+227,x+95,y+326,C.gold,3);A.line(x+95,y+253,x+300,y+310,C.gold,3);A.circle(x+95,y+227,9,C.gold);A.circle(x+300,y+310,9,C.gold);A.text('main',x+120,y+227,27,C.ink);A.text('Separate worktree',x+330,y+310,30,C.ink);A.button('Plan · read only',x,y+395,415,k===2,27,72);A.button('Build · edit files',x+450,y+395,435,false,27,72);break;}
 case'forgeRun':{
 A.text('Run app',x,y+25,36,C.ink,500);A.rect(x,y+85,885,150,14,C.night);A.text('Project command',x+25,y+123,23,C.goldLight);A.text('npm run dev',x+25,y+182,34,C.light);if(k<2){A.card(x,y+275,885,180,16);A.wrap('Read and approve the project command before it runs.',x+25,y+323,810,31,C.ink,1.3);A.button(k===0?'Review command':'Approve reviewed command',x+400,y+377,450,k===1,25,56)}else{A.app(x,y+275,885,250,'App Preview');A.text('Hello, Kairos.',x+442,y+430,40,C.ink,500,'center');A.check(x+815,y+319)}break;}
 case'backup':{
 A.text('Back up both places',x,y+25,36,C.ink,500);A.card(x,y+92,420,290,16);A.icon('gear',x+28,y+120,42,C.gold);A.text('App data',x+28,y+202,34,C.ink,500);A.wrap('Chats, agents and settings',x+28,y+260,355,28,C.dim,1.3);A.card(x+455,y+92,430,290,16);A.icon('folder',x+483,y+120,42,C.gold);A.text('Vault folder',x+483,y+202,34,C.ink,500);A.wrap('Back up your Markdown files separately',x+483,y+260,370,28,C.dim,1.3);A.rect(x,y+420,885,78,14,C.paper,C.line);A.rect(x+22,y+445,26,26,4,C.light,C.dim);A.text(k===1?'Include credentials? Opt in only if intended.':'App archive and vault backup are separate.',x+70,y+459,27,C.ink,400,'left',false,790);if(k===2){A.check(x+390,y+118);A.check(x+850,y+118)}break;}
 case'chat':{
 A.pill(items[0],x,y,Math.min(690,items[0].length*14+50),C.paper,C.dim,24);
 if(k>=1)A.alpha(k===1?q:1,()=>{A.rect(x+130,y+100,740,112,18,C.ink);A.wrap(type(items[1],k===1?p:1),x+158,y+134,680,28,C.light,1.35)});
 if(k>=2)A.alpha(q,()=>{A.circle(x+22,y+280,20,C.gold);A.rect(x+65,y+242,805,150,18,C.paper);A.wrap(type(items[2],p),x+92,y+281,745,29,C.ink,1.3)});
 A.rect(x,y+444,w,68,30,C.paper,C.line);A.text(k===0?'Write a request…':k===1?'Add a clear outcome and context':'Continue the conversation',x+25,y+478,25,C.dim);A.button('↑',x+w-65,y+452,50,true,28,50);break;}
 case'files':{
 A.rect(x,y,245,460,15,C.paper);label('CONTEXT',x+22,y+28);
 ['Project','Instructions','Documents'].forEach((a,i)=>row(a,x+12,y+58+i*82,221,k===i,['folder','file','file'][i]));
 A.text(items[0],x+285,y+30,30,C.ink,500,'left',false,560);
 A.file(items[0],x+285+(k===1?60*(1-q):0),y+88,570,130,'FILE');
 if(k>=1)A.alpha(q,()=>A.file(items[1],x+285,y+242,570,130,'MD'));
 if(k>=2){A.button(items[2],x+285,y+406,570,true,25,64);A.check(x+825,y+438,1)}break;}
 case'document':{
 A.card(x,y,540,460,12,C.white,false);A.text(items[0],x+28,y+40,31,C.ink,500,'left',false,480);A.bodyLines(x+28,y+86,470,4,1,C.line,27);
 if(k>=1)A.alpha(q,()=>{A.rect(x+25,y+214,488,70,5,'#D9B26066');A.text('The draft sentence to review.',x+40,y+250,26,C.ink,400,'left',false,450)});
 A.bodyLines(x+28,y+319,450,4,1,C.line,27);
 if(k>=1){A.card(x+570,y+85,320,235);label('COMMENT / DRAFT',x+592,y+118);A.wrap(type(items[1],k===1?p:1),x+592,y+167,276,27,C.ink,1.3);A.button(k===2?'Reviewed':'Review',x+592,y+250,270,k===2,25)}
 if(k>=2)A.alpha(q,()=>{A.check(x+600,y+390);A.wrap(items[2],x+640,y+378,250,27,C.ink,1.25)});break;}
 case'graph':{
 const pts=[[450,240],[205,115],[715,125],[180,380],[720,390]];
 pts.slice(1).forEach((b,i)=>A.connector(450,240,b[0],b[1],(local*.25+i*.21)%1,C.gold,20));
 pts.forEach((b,i)=>{A.circle(b[0],b[1],i===0?66:42,C.light,C.gold,2);A.icon('file',b[0]-17,b[1]-17,34,C.ink);A.pill(i===0?'Practice vault':items[(i-1+3)%3],b[0]-110,b[1]+65,220,C.light,C.ink,21,44)});
 if(k>=1)A.ringArc(pts[k][0],pts[k][1],56,q,C.gold,5);
 A.text(k===2?'Inspect the note before changing it.':'Readable Markdown. Linked context.',450,566,26,C.dim,400,'center');break;}
 case'bots':{
 for(let i=0;i<3;i++){const bx=150+i*300;A.bot(bx,195,68,local,i);A.text(items[i],bx,300,29,C.ink,500,'center',false,260);A.pill(i===0?'Lead':i===1?'Research':'Review',bx-95,345,190,C.paper,C.dim,23);if(k===i)A.ringArc(bx,195,89,q,C.gold,4);if(k===2)A.connector(150+i*290,440,400+i*170,510,(local*.4+i*.2)%1)}
 A.button(k===0?'Choose a role':k===1?'Give it a focused job':'Inspect the result',190,505,520,true,27,64);break;}
 case'flow':{
 for(let i=0;i<3;i++){const bx=20+i*306;A.card(bx,160,270,200,18,k===i?C.paper:C.light);A.icon(['clock','chat','file'][i],bx+108,194,46,k>=i?C.gold:C.dim);A.wrap(items[i],bx+22,270,226,27,C.ink,1.25);if(i<2)A.connector(bx+270,260,bx+305,260,(local*.45)%1,C.gold,5);if(k>i)A.check(bx+245,155)}
 A.pill(k===2?'Check the receipt and outcome':'Review each stage before relying on it',130,440,640,C.light,C.dim,25,60);break;}
 case'calendar':{
 if(index===32){A.text('School · Practice course',x,y+20,33,C.ink,500);row('Canvas connection · Save · Sync Now',x,y+70,885,k===0,'plug');row('Assignment: Project outline · due Thursday',x,y+166,885,k===1,'calendar');A.card(x,y+267,885,220,14);A.text('Your work',x+25,y+310,29,C.ink,500);A.text(k===2?'Draft: Project outline':'Open a course to inspect its assignments',x+25,y+368,28,C.dim);if(k===2){A.bodyLines(x+25,y+407,800,2,q);A.pill('Draft saved · not submitted',x+420,y+430,435,C.paper,C.dim,22,40)}break;}
 A.text('Week view',x,y+20,31,C.ink,500);const top=y+75;['MON','TUE','WED','THU','FRI'].forEach((d,i)=>{A.text(d,x+80+i*177,top,20,C.dim,400,'center');A.line(x+i*177,top+30,x+i*177,top+315,C.line,1)});for(let i=0;i<4;i++)A.line(x,top+40+i*89,x+885,top+40+i*89,C.line,1);
 A.alpha(k===0?.65:1,()=>{A.rect(x+535,top+135,165,110,10,C.paper,C.gold);A.wrap('Project review · 2 PM',x+550,top+165,135,23,C.ink,1.25)});
 A.card(x,top+355,885,100,12);A.icon(k===2?'check':'calendar',x+24,top+388,32,C.gold);A.text(items[k],x+82,top+403,28,C.ink,400,'left',false,770);break;}
 case'code':{
 A.rect(x,y,210,447,10,C.paper);['Explorer','Changes','Git','Terminal'].forEach((a,i)=>A.text(a,x+20,y+40+i*65,25,k===i?C.gold:C.dim));
 A.rect(x+235,y,650,300,10,C.night);A.text(items[0],x+260,y+37,25,C.goldLight,400,'left',false,595);
 ['  function buildAgenda() {','-   return draft;','+   return reviewedDraft;','  }'].forEach((a,i)=>A.text(type(a,k===0?.35:1),x+260,y+100+i*42,25,i===1?C.coral:i===2?'#A5BE96':C.light));
 if(k>=1)A.alpha(q,()=>{A.rect(x+235,y+325,650,123,12,C.light,C.gold);A.wrap(items[k],x+260,y+361,595,28,C.ink,1.3)});A.pill('PREVIEW · review commands and changes',250,565,620,C.paper,C.dim,23);break;}
 case'browser':{
 A.rect(x,y,885,54,25,C.paper,C.line);A.icon('shield',x+18,y+15,25,C.sage);A.text(index===37?'Contained browser · sample page':'Reference page · sample content',x+62,y+27,24,C.dim);
 A.card(x,y+80,560,340,14,C.white,false);A.text('Practice page',x+30,y+124,36,C.ink,500);A.bodyLines(x+30,y+173,490,6,1,C.line,31);A.button(index===12?(k===2?'Open in browser':'Read source'):(k===0?'Stop':k===1?'Take over':'Hand back'),x+30,y+337,480,k===2,26,58);
 A.card(x+590,y+80,295,340,14);A.icon(k===2?'check':'chat',x+615,y+110,40,C.gold);A.wrap(items[k],x+615,y+190,245,28,C.ink,1.3);break;}
 case'phone':{
 A.rect(80,25,295,530,42,C.night);A.rect(92,38,271,502,32,C.light);A.rect(165,50,124,13,8,C.night);A.text('Kairos',120,111,32,C.ink,500);A.line(115,145,340,145,C.line);
 A.bot(227,220,43,local,1);A.wrap(k===2?'Your host, on your phone.':'Private remote workspace',120,310,210,29,C.ink,1.3);A.pill('Chat',120,440,215,C.paper,C.ink,25);
 ['Tailscale','HTTPS + sign-in','Phone browser'].forEach((a,i)=>{row(a,425,130+i*110,435,k>=i,['plug','shield','phone'][i])});break;}
 case'home':{
 A.text('Your workspace',x,y+27,40,C.ink,500);items.forEach((a,i)=>{const bx=x+(i%2)*450,by=y+85+Math.floor(i/2)*195;A.card(bx,by,425,165,20,k===i?C.paper:C.light);A.icon(['chat','folder','check'][i],bx+25,by+25,38,k===i?C.gold:C.dim);A.wrap(a,bx+25,by+100,375,30,C.ink,1.2)});A.pill('Start small. Inspect the result.',250,545,570,C.light,C.dim,25);break;}
 case'form':{
 label('SETUP / CONFIGURATION',x,y+20);items.forEach((a,i)=>{label(['CHOOSE','CONFIGURE','VERIFY'][i],x,y+73+i*130);A.rect(x,y+92+i*130,885,77,13,k===i?C.paper:C.light,k===i?C.gold:C.line);A.text(type(a,k===i?p:k>i?1:.55),x+24,y+130+i*130,29,C.ink,400,'left',false,810);if(k>i)A.check(x+840,y+130+i*130)});break;}
 default:{
 items.forEach((a,i)=>row(a,x,y+22+i*113,885,k===i,['file','search','check'][i]));
 if(k>=1){A.rect(x,y+395,885,118,14,C.paper);label(k===2?'OUTCOME TO CHECK':'INSPECT THE DETAILS',x+25,y+425);A.text(k===2?'Review the resulting state before continuing.':'Open the item, source or run to see the evidence.',x+25,y+473,26,C.ink,400,'left',false,830)}
 }
 }
 // Cursor moves to the relevant illustrated control in each four-second step.
 const targets={chat:[[270,110],[820,568],[780,400]],files:[[190,200],[770,420],[790,526]],document:[[280,160],[380,490],[810,610]],graph:[[450,240],[205,115],[715,125]],bots:[[150,195],[450,195],[750,195]],flow:[[150,260],[455,260],[760,260]],calendar:[[750,145],[640,385],[790,580]],phone:[[700,180],[700,290],[700,400]]};
 const [tx,ty]=(targets[kind]||[[850,150],[850,280],[850,410]])[k];A.cursor(A.mix(760,tx,q),A.mix(510,ty,q),p>.7&&p<.95?(p-.7)/.25:0);
 });
 });
 const newStep=Math.min(2,Math.floor(local/4));if(newStep!==step){step=newStep;[...$('steps').querySelectorAll('button')].forEach((b,i)=>{b.classList.toggle('active',i===step);b.setAttribute('aria-current',i===step?'step':'false')});$('demoState').textContent=`Step ${step+1} of 3`;window.dispatchEvent(new CustomEvent('guide:step',{detail:{index,step}}));}
}
function setLesson(n){index=Math.max(0,Math.min(LESSONS.length-1,n));const s=LESSONS[index];t=0;step=-1;playing=!reduce;location.replace('#'+index);$('title').textContent=s.title;$('location').textContent=s.where;$('chapter').textContent=s.section.toUpperCase();$('tryit').textContent=s.tryit.replace(/[“”]/g,'"');$('count').textContent=`${String(index+1).padStart(2,'0')} / 46`;$('prev').disabled=index===0;$('next').disabled=index===45;$('steps').replaceChildren(...s.steps.map((text,i)=>{const li=document.createElement('li'),b=document.createElement('button'),num=document.createElement('span'),txt=document.createElement('span');num.className='num';num.textContent=i+1;txt.textContent=text;b.append(num,txt);b.onclick=()=>seek(i*4+1.5);li.append(b);return li}));$('noteTitle').textContent=s.title;$('noteBody').textContent=s.notes;syncPause();draw();}
function seek(v){t=Math.max(0,Math.min(11.99,v));playing=false;step=-1;syncPause();draw();}
function syncPause(){$('pause').textContent=playing?'Pause':'Play';$('pause').setAttribute('aria-pressed',String(!playing));}
function toggle(){playing=!playing;if(playing&&t>=11.98)t=0;syncPause();}
$('prev').onclick=()=>setLesson(index-1);$('next').onclick=()=>setLesson(index+1);$('replay').onclick=()=>{t=0;step=-1;playing=true;syncPause();};$('pause').onclick=toggle;$('contents').onclick=()=>$('toc').showModal();$('notes').onclick=()=>$('notePanel').showModal();$('full').onclick=()=>document.fullscreenElement?document.exitFullscreen():$('viewport').requestFullscreen();
document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>$(b.dataset.close).close());
LESSONS.forEach((s,i)=>{const b=document.createElement('button');b.textContent=`${String(i+1).padStart(2,'0')} · ${s.title}`;b.onclick=()=>{setLesson(i);$('toc').close()};$('lessonList').append(b)});
addEventListener('keydown',e=>{if(document.querySelector('dialog[open]'))return;if(e.key==='ArrowRight'){e.preventDefault();setLesson(index+1)}if(e.key==='ArrowLeft'){e.preventDefault();setLesson(index-1)}if(['1','2','3'].includes(e.key))seek((Number(e.key)-1)*4+1.5);if(e.key===' '){e.preventDefault();toggle()}if(e.key.toLowerCase()==='r')$('replay').click();if(e.key.toLowerCase()==='n'||e.key.toLowerCase()==='p')$('notes').click();if(e.key.toLowerCase()==='t')$('contents').click();if(e.key.toLowerCase()==='f')$('full').click()});
let touchX=0;addEventListener('touchstart',e=>{touchX=e.changedTouches[0].clientX},{passive:true});addEventListener('touchend',e=>{if(document.querySelector('dialog[open]'))return;const d=e.changedTouches[0].clientX-touchX;if(Math.abs(d)>70)setLesson(index+(d<0?1:-1))},{passive:true});addEventListener('resize',resize);
function tick(now){if(last&&playing){t=Math.min(11.99,t+Math.min((now-last)/1000,.1));if(t>=11.99){playing=false;syncPause()}}last=now;draw();requestAnimationFrame(tick)}
window.guide={setLesson,seek,pause(){playing=false;syncPause()},get index(){return index},get time(){return t},get count(){return LESSONS.length}};
window.guideReady=(async()=>{await document.fonts.load('400 30px Jost');await document.fonts.load('italic 400 70px Cormorant');await document.fonts.ready;await Promise.all([...document.images].map(i=>i.decode().catch(()=>{})));ready=true;resize();setLesson(index);requestAnimationFrame(tick);return true})();
})();
