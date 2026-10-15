/* Original Kairos artwork shared by the motion film and illustrated lessons. */
(function(){'use strict';let g;
const C={paper:'#F3EADB',light:'#FBF6EE',ink:'#3A2A20',night:'#251E18',gold:'#B8893B',goldLight:'#D9B260',dim:'#796653',line:'#D8C9B3',sage:'#5C765B',blue:'#527B91',coral:'#D9876C',white:'#FFFDF8',pale:'#E8DBC5',red:'#A85A4C'};
const clamp=(x,a=0,b=1)=>Math.max(a,Math.min(b,x)),mix=(a,b,t)=>a+(b-a)*t,out=x=>1-(1-clamp(x))**3,smooth=x=>{x=clamp(x);return x*x*(3-2*x)},expo=x=>x<=0?0:1-2**(-10*clamp(x));
function setContext(ctx){g=ctx}function withState(fn){g.save();fn();g.restore()}function alpha(a,fn){withState(()=>{g.globalAlpha*=clamp(a);fn()})}function pose(x,y,s,fn,r=0){withState(()=>{g.translate(x,y);g.rotate(r);g.scale(s,s);fn()})}
function rect(x,y,w,h,r=18,fill=C.light,stroke=null,lw=1.5){if(w<=0||h<=0)return;g.beginPath();g.roundRect(x,y,w,h,Math.min(r,w/2,h/2));if(fill){g.fillStyle=fill;g.fill()}if(stroke){g.strokeStyle=stroke;g.lineWidth=lw;g.stroke()}}
function card(x,y,w,h,r=24,fill=C.light,shadow=true){withState(()=>{if(shadow){g.shadowColor='#3A2A201A';g.shadowBlur=38;g.shadowOffsetY=15}rect(x,y,w,h,r,fill)});rect(x,y,w,h,r,null,C.line,1.5)}
function line(x,y,x2,y2,color=C.line,width=2){g.beginPath();g.moveTo(x,y);g.lineTo(x2,y2);g.strokeStyle=color;g.lineWidth=width;g.lineCap='round';g.stroke()}
function circle(x,y,r,fill,stroke=null,lw=2){if(r<=0)return;g.beginPath();g.arc(x,y,r,0,Math.PI*2);if(fill){g.fillStyle=fill;g.fill()}if(stroke){g.strokeStyle=stroke;g.lineWidth=lw;g.stroke()}}
function text(s,x,y,size=40,color=C.ink,weight=400,align='left',serif=false,maxWidth=0){g.save();g.font=`${serif?'italic ':''}${weight} ${size}px ${serif?'"Cormorant Garamond"':'Jost'},sans-serif`;if(maxWidth&&g.measureText(s).width>maxWidth){const ratio=maxWidth/g.measureText(s).width;g.font=`${serif?'italic ':''}${weight} ${size*ratio}px ${serif?'"Cormorant Garamond"':'Jost'},sans-serif`}g.fillStyle=color;g.textAlign=align;g.textBaseline='middle';g.fillText(s,x,y);g.restore()}
function wrap(s,x,y,maxWidth,size=34,color=C.ink,lineHeight=1.35,weight=400){g.save();g.font=`${weight} ${size}px Jost,sans-serif`;let row='',rows=[];for(const word of s.split(' ')){const test=row?row+' '+word:word;if(g.measureText(test).width>maxWidth&&row){rows.push(row);row=word}else row=test}if(row)rows.push(row);rows.forEach((s,i)=>text(s,x,y+i*size*lineHeight,size,color,weight));g.restore();return rows.length*size*lineHeight}
function pill(label,x,y,w,fill=C.light,color=C.ink,size=28,h=52){rect(x,y,w,h,h/2,fill,C.line);text(label,x+w/2,y+h/2,size,color,450,'center')}
function button(label,x,y,w,active=true,size=26,h=52){rect(x,y,w,h,h/2,active?C.ink:C.light,active?null:C.line);text(label,x+w/2,y+h/2,size,active?C.light:C.ink,500,'center')}
function icon(name,x,y,s=38,col=C.ink){withState(()=>{g.translate(x,y);g.scale(s/32,s/32);g.strokeStyle=col;g.fillStyle=col;g.lineWidth=1.8;g.lineCap='round';g.lineJoin='round';const path=p=>{g.beginPath();p.forEach((v,i)=>i?g.lineTo(...v):g.moveTo(...v));g.stroke()};switch(name){
case'check':path([[4,17],[12,25],[28,6]]);break;case'plus':path([[16,3],[16,29]]);path([[3,16],[29,16]]);break;case'arrow':path([[3,16],[29,16],[20,7]]);path([[29,16],[20,25]]);break;case'chevron':path([[11,5],[22,16],[11,27]]);break;
case'file':path([[6,2],[21,2],[27,9],[27,30],[6,30],[6,2]]);path([[20,2],[20,10],[27,10]]);path([[11,17],[22,17]]);path([[11,23],[20,23]]);break;
case'folder':path([[2,8],[13,8],[16,12],[30,12],[28,28],[3,28],[2,8]]);break;
case'calendar':rect(2,5,28,25,4,null,col,1.8);path([[2,13],[30,13]]);path([[9,1],[9,9]]);path([[23,1],[23,9]]);break;
case'mail':rect(1,5,30,23,4,null,col,1.8);path([[2,7],[16,18],[30,7]]);break;
case'chat':rect(2,3,28,23,7,null,col,1.8);path([[9,26],[8,31],[17,26]]);path([[9,12],[24,12]]);path([[9,18],[20,18]]);break;
case'clock':circle(16,16,14,null,col,1.8);path([[16,6],[16,17],[23,21]]);break;
case'code':path([[11,7],[2,16],[11,25]]);path([[21,7],[30,16],[21,25]]);path([[19,2],[13,30]]);break;
case'branch':circle(8,5,3,null,col,1.8);circle(8,27,3,null,col,1.8);circle(25,8,3,null,col,1.8);path([[8,8],[8,24]]);path([[8,19],[24,19],[25,11]]);break;
case'shield':path([[16,1],[29,6],[27,22],[16,31],[5,22],[3,6],[16,1]]);path([[9,16],[14,21],[23,11]]);break;
case'phone':rect(7,1,18,30,4,null,col,1.8);path([[12,5],[20,5]]);circle(16,27,1,col);break;
case'grid':for(let i=0;i<4;i++)rect(2+(i%2)*16,2+Math.floor(i/2)*16,12,12,3,null,col,1.8);break;
case'plug':path([[9,1],[9,9]]);path([[23,1],[23,9]]);path([[5,9],[27,9],[25,20],[16,24],[16,31]]);path([[7,20],[25,20]]);break;
case'mic':rect(10,1,12,20,6,null,col,1.8);path([[5,14],[5,19],[9,25],[16,27],[23,25],[27,19],[27,14]]);path([[16,27],[16,32]]);break;
case'search':circle(13,13,10,null,col,1.8);path([[21,21],[30,30]]);break;
case'play':g.beginPath();g.moveTo(9,4);g.lineTo(28,16);g.lineTo(9,28);g.closePath();g.fill();break;
case'gear':for(let i=0;i<8;i++){const a=i*Math.PI/4;line(16+Math.cos(a)*11,16+Math.sin(a)*11,16+Math.cos(a)*15,16+Math.sin(a)*15,col,3)}circle(16,16,10,null,col,1.8);circle(16,16,4,null,col,1.8);break;
default:circle(16,16,12,null,col,1.8);circle(16,16,4,col);
}})}
function check(x,y,p=1,col=C.sage){circle(x,y,23,col);alpha(p,()=>icon('check',x-13,y-13,26,C.light))}
function cursor(x,y,click=0,dark=false){withState(()=>{g.translate(x,y);g.shadowColor='#251E1833';g.shadowBlur=7;g.shadowOffsetY=4;g.beginPath();g.moveTo(0,0);g.lineTo(0,37);g.lineTo(11,28);g.lineTo(20,48);g.lineTo(29,44);g.lineTo(20,24);g.lineTo(35,23);g.closePath();g.fillStyle=dark?C.light:C.ink;g.fill();g.strokeStyle=dark?C.ink:C.light;g.lineWidth=2;g.stroke()});if(click>0)alpha(1-click,()=>circle(x,y,15+55*click,null,C.gold,4))}
function file(label,x,y,w=240,h=130,kind='MD',color=C.gold){card(x,y,w,h,20);rect(x+22,y+25,58,75,10,C.paper);icon('file',x+35,y+40,30,color);text(kind,x+51,y+90,15,color,500,'center');wrap(label,x+98,y+49,w-120,25,C.ink,1.2,500)}
function connector(x1,y1,x2,y2,p=1,col=C.gold,bend=60){g.save();g.lineWidth=2;g.strokeStyle=col;g.globalAlpha*=.45;g.beginPath();g.moveTo(x1,y1);g.bezierCurveTo(x1+bend,y1,x2-bend,y2,x2,y2);g.stroke();g.restore();const q=clamp(p),a=1-q;circle(a*a*a*x1+3*a*a*q*(x1+bend)+3*a*q*q*(x2-bend)+q*q*q*x2,a*a*a*y1+3*a*a*q*y1+3*a*q*q*y2+q*q*q*y2,6,col)}
function bot(x,y,r=65,t=0,kind=0){withState(()=>{g.translate(x,y);g.rotate(Math.sin(t*1.9+kind)*.035);g.shadowColor='#3A2A2025';g.shadowBlur=20;g.shadowOffsetY=13;g.fillStyle=[C.coral,C.goldLight,'#9EAD88'][kind%3];g.beginPath();for(let i=0;i<=100;i++){const a=i/100*Math.PI*2,v=kind===1?1+.09*Math.cos(a*7):1+.035*Math.sin(a*3+t*.5),px=Math.cos(a)*r*v,py=Math.sin(a)*r*v*(kind===0?.88:1);i?g.lineTo(px,py):g.moveTo(px,py)}g.closePath();g.fill();g.shadowColor='transparent';const blink=Math.cos(t*1.4+kind)>.992?.2:1;g.fillStyle=C.ink;for(const ex of[-r*.23,r*.23]){g.beginPath();g.ellipse(ex,-r*.03,r*.045,r*.07*blink,0,0,Math.PI*2);g.fill()}g.beginPath();g.arc(0,r*.27,r*.105,0,Math.PI);g.strokeStyle=C.ink;g.lineWidth=2.3;g.stroke()})}
function mark(x,y,r=55,t=0,col=C.ink){withState(()=>{g.translate(x,y);g.rotate(t);g.beginPath();g.arc(0,0,r,-.45,Math.PI*2-.7);g.strokeStyle=col;g.lineWidth=r*.105;g.lineCap='round';g.stroke();circle(r*.86,-r*.5,r*.14,C.gold)})}
function lineReveal(s,x,y,size,p,col=C.ink,weight=500){withState(()=>{g.beginPath();g.rect(x,y-size*.7,1600,size*1.35);g.clip();text(s,x,y+size*(1-expo(p)),size,col,weight)})}
function app(x,y,w,h,label='Kairos',dark=false){card(x,y,w,h,24,dark?'#302720':C.light);line(x,y+53,x+w,y+53,dark?'#66533D':C.line,1.5);for(let i=0;i<3;i++)circle(x+25+i*20,y+27,4,[C.coral,C.gold,C.sage][i]);text(label,x+96,y+27,22,dark?C.light:C.ink,450);return {x:x+25,y:y+75,w:w-50,h:h-100}}
function bodyLines(x,y,w,n=4,p=1,col=C.line,gap=22){for(let i=0;i<n;i++){const q=out(p*n-i);rect(x,y+i*gap,w*(i===n-1?.65:1)*q,6,3,col)}}
function sparkle(x,y,r,t,color=C.gold){withState(()=>{g.translate(x,y);g.rotate(t*.4);line(-r,0,r,0,color,2);line(0,-r,0,r,color,2)})}
function ringArc(x,y,r,p,color=C.gold,width=4){if(r<=0)return;g.beginPath();g.arc(x,y,r,-Math.PI/2,-Math.PI/2+Math.PI*2*clamp(p));g.strokeStyle=color;g.lineWidth=width;g.lineCap='round';g.stroke()}
function backdrop(t,dark=false){g.resetTransform();g.globalAlpha=1;g.globalCompositeOperation='source-over';g.fillStyle=dark?C.night:C.paper;g.fillRect(0,0,1920,1080);const grad=g.createRadialGradient(1400+Math.sin(t*.2)*100,420,10,1300,500,1000);grad.addColorStop(0,dark?'#B8893B16':'#FFFDF899');grad.addColorStop(1,'#F3EADB00');g.fillStyle=grad;g.fillRect(0,0,1920,1080)}
window.KairosArt={setContext,withState,alpha,pose,rect,card,line,circle,text,wrap,pill,button,icon,check,cursor,file,connector,bot,mark,lineReveal,app,bodyLines,sparkle,ringArc,backdrop,C,clamp,mix,out,smooth,expo};
})();
