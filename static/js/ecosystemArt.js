import { projectToSegment } from './ecosystemModel.js';
const hues = ['#825aa7', '#bd6359', '#347b80', '#86713b', '#516ba5'];
const svg = (body, width, height) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" aria-hidden="true" shape-rendering="crispEdges">${body}</svg>`;
export function cottage(index, grand = false) {
  const roof = hues[index % hues.length];
  const windows = [38, 70, 130, 162].map(x => `<rect x="${x}" y="83" width="18" height="27" fill="#354c64"/><rect x="${x + 3}" y="86" width="12" height="20" fill="#bce2db"/><path d="M${x + 9} 86v20m-6-10h12" stroke="#527c82" stroke-width="2"/>`).join('');
  return svg(`<path d="M18 145h184v12H18z" fill="#254e40" opacity=".3"/>
    <path d="M28 70h164v74H28z" fill="#5e4145"/><path d="M32 74h156v65H32z" fill="#ead0a1"/>
    <path d="M20 70l27-51h124l30 51z" fill="#443d51"/><path d="M25 65l26-43h117l26 43z" fill="${roof}"/>
    <path d="M46 30h129M39 42h143M32 54h157" stroke="#fff" opacity=".16" stroke-width="3"/>
    <path d="M145 8h15v36h-15z" fill="#68545b"/><path d="M142 7h21v6h-21z" fill="#e6c7a0"/>
    <path d="M32 116h156M32 137h156M60 74v65m100-65v65" stroke="#ad7c63" stroke-width="4"/>
    ${windows}<path d="M85 143V71l25-25 25 25v72z" fill="#b87d62"/>
    <path d="M80 72l30-34 30 34h-9l-21-23-21 23z" fill="#493a4c"/>
    <path d="M99 142v-31q11-17 22 0v31" fill="#473b50"/><rect x="107" y="78" width="9" height="16" fill="#c5e5dc"/>
    <rect x="115" y="124" width="3" height="3" fill="#e9ba68"/><path d="M91 144h38v6H91zM85 150h50v5H85z" fill="#ebcda4"/>
    <path d="M24 130h26v12H24zm147 0h26v12h-26z" fill="#447353"/><path d="M27 130v-7m9 7v-9m9 9v-7m130 7v-7m10 7v-9m8 9v-7" stroke="#dca0ad" stroke-width="5"/>
    ${grand ? '<path d="M106 7h8v34h-8z" fill="#e4bf8a"/><path d="M114 8h30v17h-30z" fill="#c4a0df"/><path d="M117 11h5v10h-5z" fill="#f7ecd7"/>' : ''}`, 220, 164);
}

export function buildingArt(kind, index = 0) {
  if (['home', 'team', 'commons'].includes(kind)) return cottage(index, kind === 'commons');
  const window = (x, y, w = 18, h = 24) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#354c64"/><rect x="${x + 3}" y="${y + 3}" width="${w - 6}" height="${h - 6}" fill="#b7ded9"/><path d="M${x + w / 2} ${y + 3}v${h - 6}" stroke="#527c82" stroke-width="2"/>`;
  const common = '<path d="M15 149h190v10H15z" fill="#244d40" opacity=".3"/>';
  if (kind === 'school') return svg(common + `<path d="M24 69h172v75H24z" fill="#ba6d58"/><path d="M20 69l20-30h140l20 30z" fill="#4a576f"/><path d="M30 85h160m-160 28h160m-160 25h160" stroke="#d79b78" stroke-width="3"/>${[36,66,137,167].map(x => window(x,83)).join('')}<path d="M91 143V53h38v90z" fill="#e1b78a"/><path d="M84 54l26-29 26 29z" fill="#765167"/><rect x="99" y="65" width="22" height="22" fill="#fff0ce"/><path d="M110 69v9h7" fill="none" stroke="#594b50" stroke-width="3"/><path d="M101 144v-28h18v28" fill="#484656"/><path d="M110 25V9h28v13h-25" fill="#c9a3dc" stroke="#765d49" stroke-width="2"/><path d="M95 144h30v8H95z" fill="#f0d5ad"/>`,220,164);
  if (kind === 'lab') return svg(common + `<path d="M25 55h170v89H25z" fill="#637e83"/><path d="M20 49h180v10H20z" fill="#d1d6c2"/><path d="M35 66h145v58H35z" fill="#9ad0c9"/><path d="M38 70h135v12H38z" fill="#d2e3cc"/><path d="M61 66v58m30-58v58m30-58v58m30-58v58M35 96h145" stroke="#43677a" stroke-width="5"/><path d="M100 145v-34h23v34" fill="#3f576b"/><path d="M108 111v34" stroke="#b9d8ce" stroke-width="2"/><path d="M151 50V16m-16 8h32m-27-9l22 22m-22 0l22-22" stroke="#c0cdbb" stroke-width="4"/><path d="M44 138h35v7H44z" fill="#a4b88c"/><path d="M51 125v12m15-15v15" stroke="#c9a3dc" stroke-width="6"/>`,220,164);
  if (kind === 'datacenter') return svg(common + `<path d="M22 47h176v97H22z" fill="#617187"/><path d="M16 41h188v12H16z" fill="#aab8b8"/><path d="M30 61h110v68H30z" fill="#34455c"/>${[40,72,104].map(x=>`<path d="M${x} 68h21v52h-21z" fill="#222e40"/>${[76,88,100,112].map(y=>`<path d="M${x+3} ${y}h15" stroke="#708692" stroke-width="3"/><rect x="${x+14}" y="${y-1}" width="3" height="3" fill="#9bdbc6"/>`).join('')}`).join('')}<rect x="151" y="94" width="28" height="50" fill="#364458"/><path d="M165 97v47" stroke="#b2c7c7" stroke-width="2"/><path d="M47 40V20h42v20m38 0V20h42v20" fill="#84949b"/><path d="M53 26h30m-30 7h30m50-7h30m-30 7h30" stroke="#455e6b" stroke-width="3"/>`,220,164);
  if (kind === 'library') return svg(common + `<path d="M24 71h172v73H24z" fill="#c3a987"/><path d="M16 68l94-47 94 47z" fill="#6b5868"/><path d="M34 64l76-34 76 34z" fill="#ddc39c"/><path d="M96 45h12v17H96zm16 0h12v17h-12z" fill="#765c51"/>${[37,72,132,167].map(x=>`<path d="M${x} 78h16v60h-16z" fill="#eeddb8"/><path d="M${x-3} 75h22v6h-22zm0 62h22v7h-22z" fill="#a28472"/>`).join('')}<path d="M98 143V95q12-18 24 0v48" fill="#4c465a"/><path d="M17 145h186v7H17zM11 153h198v5H11z" fill="#dbc39e"/>`,220,164);
  if (kind === 'studio') return svg(common + `<path d="M29 72h162v71H29z" fill="#d2a977"/><path d="M20 72l38-43h104l38 43z" fill="#9e6382"/><path d="M41 53h137M29 65h161" stroke="#c18da3" stroke-width="3"/>${window(39,84,43,40)}${window(138,84,43,40)}<path d="M99 143V91h23v52" fill="#5d5167"/><path d="M63 142l13-29 13 29m-18-27h15v17H71z" fill="#e3d6ae" stroke="#755747" stroke-width="3"/><path d="M74 118h5v6h-5zm6 5h4v6h-4z" fill="#bd735e"/><path d="M142 22h23v21h-23z" fill="#6d5e70"/><path d="M146 26h15v9h-15z" fill="#9bbcc5"/>`,220,164);
  return svg(common + `<path d="M31 47h158v98H31z" fill="#b48e74"/><path d="M25 41h170v12H25z" fill="#5b5366"/>${[42,77,126,161].map(x=>window(x,64)+window(x,104)).join('')}<path d="M99 145v-41h23v41z" fill="#4f495c"/><path d="M30 95h160" stroke="#e2c49c" stroke-width="5"/><path d="M91 146h38v8H91z" fill="#e2c49c"/>`,220,164);
}

// Decorative landscape only. All routes are drawn from the same graph the
// characters use; lakes, trees and park furniture never create agent work.
export function villageGround(layout) {
  const all=[...layout.sites,...layout.homes,...layout.teams];
  let randomState=0x51a7e;
  const random=()=>{randomState=(Math.imul(randomState,1664525)+1013904223)>>>0;return randomState/4294967296;};
  const pathData=points=>points.map((p,i)=>`${i?'L':'M'}${p.x} ${p.y}`).join(' ');
  const lakeBounds=layout.lakes.map(points=>({left:Math.min(...points.map(p=>p[0]))-28,right:Math.max(...points.map(p=>p[0]))+28,top:Math.min(...points.map(p=>p[1]))-28,bottom:Math.max(...points.map(p=>p[1]))+28}));
  const nearRoad=(x,y,gap)=>layout.graph.edges.some(edge=>{
    const p=projectToSegment({x,y},layout.graph.nodes[edge.a],layout.graph.nodes[edge.b]);return Math.hypot(p.x-x,p.y-y)<gap;
  });
  const clear=(x,y,radius=24,roadGap=48)=> x>30+radius&&x<layout.width-30-radius&&y>35+radius&&y<layout.height-35-radius&&
    !all.some(b=>x>b.x-124-radius&&x<b.x+124+radius&&y>b.y-16-radius&&y<b.y+220+radius)&&
    !lakeBounds.some(b=>x>b.left-radius&&x<b.right+radius&&y>b.top-radius&&y<b.bottom+radius)&&!nearRoad(x,y,roadGap);
  const lakePoints=points=>points.map(p=>p.join(',')).join(' ');
  const lakes=layout.lakes.map((points,i)=>{
    const [x,y]=points[2];
    return `<g data-eco-decor="lake"><polygon points="${lakePoints(points)}" fill="#54806a" stroke="#b2b580" stroke-width="18" stroke-linejoin="round"/><polygon points="${lakePoints(points)}" fill="#64a2a7" stroke="#3f7b7c" stroke-width="6"/><polygon points="${lakePoints(points)}" fill="url(#eco-water)"/><g clip-path="url(#eco-lake-${i})"><path d="M${x-80} ${y+25}h26m-46 59h30m80 6h28m-142 42h18" stroke="#a9d0c6" stroke-width="3"/><g fill="#89ac68"><rect x="${x-52}" y="${y+86}" width="18" height="8"/><rect x="${x-28}" y="${y+100}" width="12" height="8"/></g><path d="M${x-16} ${y+58}h13v7h-13zM${x-5} ${y+54}h6v7h-6z" fill="#f6e8bf"/><path d="M${x+1} ${y+57}h4v3h-4z" fill="#d3a16c"/></g></g>`;
  }).join('');
  // Paint all borders before any paving. Per-path border/fill pairs cut a
  // dark cap across the preceding road at every T junction. The normalized
  // graph is also the walking network, so drawing and travel cannot diverge.
  const roadLayers=['road','drive','trail'].map(kind=>({kind,width:kind==='road'?32:kind==='drive'?23:17,
    d:layout.graph.edges.filter(edge=>edge.kind===kind).map(edge=>pathData([layout.graph.nodes[edge.a],layout.graph.nodes[edge.b]])).join(' ')}));
  const borders=roadLayers.map(({width,d})=>`<path d="${d}" fill="none" stroke="#426e48" stroke-width="${width+8}" stroke-linejoin="round" stroke-linecap="round"/>`).join('');
  const paving=roadLayers.map(({kind,width,d})=>`<path data-eco-decor="${kind==='trail'?'footpath':'road'}" d="${d}" fill="none" stroke="${kind==='trail'?'#c4b48b':'url(#eco-stone)'}" stroke-width="${width}" stroke-linejoin="round" stroke-linecap="round"/>`).join('');
  const roads=`<g data-eco-road-layer="borders">${borders}</g><g data-eco-road-layer="paving">${paving}</g>`;
  const bridges=layout.paths.filter(p=>p.kind==='bridge').map(p=>{
    const a=p.points[0],b=p.points.at(-1),planks=[];
    for(let x=a.x;x<=b.x;x+=12)planks.push(`<path d="M${x} ${a.y-21}v42" stroke="#d6b07a" stroke-width="3"/>`);
    return `<g data-eco-decor="bridge"><path d="${pathData(p.points)}" fill="none" stroke="#604d42" stroke-width="49"/><path d="${pathData(p.points)}" fill="none" stroke="#9d7656" stroke-width="39"/>${planks.join('')}<path d="M${a.x-3} ${a.y-24}H${b.x+3}M${a.x-3} ${a.y+24}H${b.x+3}" stroke="#775440" stroke-width="5"/></g>`;
  }).join('');
  const aprons=all.map(b=>`<rect x="${b.x-73}" y="${b.road-24}" width="146" height="43" rx="8" fill="${b.kind==='home'?'#c9b48a':'url(#eco-stone)'}"/>`).join('');
  const tree=(x,y,type)=>{
    if(type===1)return `<g data-eco-decor="tree" transform="translate(${x} ${y})"><path d="M15 30h7v28h-7z" fill="#7e654b"/><path d="M18 0L5 18h7L0 35h10L3 46h31l-8-11h10L24 18h7z" fill="#346451"/><path d="M18 4l-9 13h7L7 30h11z" fill="#568568"/></g>`;
    const colors=type===2?['#a88846','#cfad59','#e4c878']:['#386c4f','#69995e','#94b778'];
    return `<g data-eco-decor="tree" transform="translate(${x} ${y})"><path d="M15 32h8v27h-8z" fill="#82654a"/><path d="M6 12h25v7h7v22h-7v6H5v-6H0V19h6z" fill="${colors[0]}"/><path d="M10 5h18v7h6v20H5V17h5z" fill="${colors[1]}"/><path d="M11 7h13v8H11zM6 21h8v7H6z" fill="${colors[2]}"/></g>`;
  };
  const trees=[];
  const target=Math.min(420,Math.round(layout.width*layout.height/11500));
  for(let tries=0;tries<9000&&trees.length<target;tries++){
    const x=40+random()*(layout.width-80),y=40+random()*(layout.height-100);
    if(clear(x+18,y+28,24,54))trees.push(tree(Math.round(x),Math.round(y),Math.floor(random()*3)));
  }
  const bench=(x,y)=>`<g data-eco-decor="bench" transform="translate(${x} ${y})"><path d="M-24-8h48v6h-48zm0 8h48v8h-48z" fill="#b18a60"/><path d="M-19 8v9m38-9v9M-24-2h48" stroke="#655348" stroke-width="4"/></g>`;
  const picnic=(x,y)=>`<g data-eco-decor="picnic" transform="translate(${x} ${y})"><path d="M-30-15h60v24h-60z" fill="#d1ab74"/><path d="M-20 9l-9 15m49-15l9 15M-39 15h78" stroke="#7f634d" stroke-width="5"/><path d="M-11-14h23V8h-23z" fill="#d79088"/><path d="M-5-14V8m12-22V8m-18-17h23m-23 10h23" stroke="#f2d7b5" stroke-width="3"/></g>`;
  const garden=(x,y)=>`<g data-eco-decor="garden" transform="translate(${x} ${y})"><path d="M-32-18h64v38h-64z" fill="#a18a64" stroke="#d3bc8c" stroke-width="5"/><g fill="#a8bf78">${Array.from({length:12},(_,i)=>`<path d="M${-25+(i%4)*15} ${-10+Math.floor(i/4)*12}h6v6h-6z"/>`).join('')}</g><path d="M-19-9h4v4h-4zm30 12h4v4h-4zm-15 11h4v4h-4z" fill="#e8b6a9"/></g>`;
  const parkProps=[];
  for(const [x,y]of layout.parks){
    if(clear(x,y,32,48))parkProps.push(picnic(x,y));
    if(clear(x+70,y+65,32,48))parkProps.push(garden(x+70,y+65));
    if(clear(x-55,y+70,24,40))parkProps.push(bench(x-55,y+70));
  }
  for(const edge of layout.graph.edges){
    if(edge.kind!=='road')continue;
    const a=layout.graph.nodes[edge.a],b=layout.graph.nodes[edge.b],length=Math.hypot(b.x-a.x,b.y-a.y);if(length<140)continue;
    const x=(a.x+b.x)/2-(b.y-a.y)/length*64,y=(a.y+b.y)/2+(b.x-a.x)/length*64;
    if(clear(x,y,24,45))parkProps.push(bench(Math.round(x),Math.round(y)));
  }
  const flowers=[];
  for(let i=0;i<500;i++){
    const x=Math.round(random()*layout.width),y=Math.round(random()*layout.height);
    if(clear(x,y,5,30))flowers.push(`<path d="M${x} ${y}h4v4h-4zm-3 7h2v4h-2z" fill="${i%3===0?'#e5c5a4':i%3===1?'#a7bb79':'#b3c691'}"/>`);
  }
  const meadows=layout.parks.map(([x,y])=>`<path d="M${x-100} ${y-65}l90-25 105 28 30 75-70 65-130-18-40-65z" fill="#779b5f" opacity=".6"/>`).join('');
  return svg(`<defs><pattern id="eco-grass" width="32" height="32" patternUnits="userSpaceOnUse"><rect width="32" height="32" fill="#5d8b55"/><path d="M3 8h3v3H3zm18 15h2v2h-2z" fill="#6a975c"/></pattern><pattern id="eco-stone" width="32" height="16" patternUnits="userSpaceOnUse"><rect width="32" height="16" fill="#dec49a"/><path d="M0 0h32m-32 8h32m-32 8h32M16 0v8M4 8v8M28 8v8" stroke="#c1a078" stroke-width="1"/></pattern><pattern id="eco-water" width="60" height="40" patternUnits="userSpaceOnUse"><path d="M4 10h18m17 18h14" stroke="#b8d8c7" stroke-opacity=".45" stroke-width="2"/></pattern>${layout.lakes.map((points,i)=>`<clipPath id="eco-lake-${i}"><polygon points="${lakePoints(points)}"/></clipPath>`).join('')}</defs><rect width="${layout.width}" height="${layout.height}" fill="url(#eco-grass)"/>${meadows}${lakes}${roads}${aprons}${bridges}${flowers.join('')}${parkProps.join('')}${trees.join('')}`,layout.width,layout.height);
}
