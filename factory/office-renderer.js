// Canvas scenery, animation, and accessible keyed hotspots. Board data is only text.
import { officeState, hitTargets, describeOffice } from './office.js';
import { MAP, AREAS, DOORS, FURNITURE, WAYPOINTS, STAGE_REGIONS, SHORT, COLORS, viewportOffice } from './office-map.js';
import { ATLAS_URL, SPRITES, CHARACTER_FOR } from './sprite-atlas.js';
import { retargetWalker, advanceWalker } from './office-navigation.js';
import { createWanderDirector, sofaLift, planWake } from './office-wander.js';
import { createWorkDirector } from './office-work.js';
import { BUBBLES, createBubbleDirector } from './office-bubbles.js';

export function createOffice({ stage, canvas, hits, live, status, openJob }) {
  const reduced=window.matchMedia('(prefers-reduced-motion: reduce)');
  const atlas=new Image(), backdrop=document.createElement('canvas');
  const ctx=canvas.getContext('2d'), bg=backdrop.getContext('2d');
  canvas.width=backdrop.width=MAP.width;canvas.height=backdrop.height=MAP.height;
  let ready=false,state=officeState([]),jobs=[],raf=0,last=0,scale=1,scaleX=1,scaleY=1,liveKey='',visibleJobIds=new Set();
  const walkers=new Map(),buttons=new Map(),director=createWanderDirector(Math.random),work=createWorkDirector(Math.random),bubbles=createBubbleDirector(Math.random);
  let wakeTimer=0;
  const rect=(c,x,y,w,h,color)=>{c.fillStyle=color;c.fillRect(x,y,w,h);};
  const text=(c,value,x,y,color='#edf4ff',size=12,align='left')=>{
    c.font=`600 ${size}px system-ui, sans-serif`;c.fillStyle=color;c.textAlign=align;c.textBaseline='middle';c.fillText(value,x,y);
  };
  function sprite(c,name,x,y,size=1) {
    if(!ready)return;const s=SPRITES[name];c.imageSmoothingEnabled=false;
    c.drawImage(atlas,s.x,s.y,s.w,s.h,Math.round(x),Math.round(y),Math.round(s.w*size),Math.round(s.h*size));
  }
  function tile(c,name,r) {
    const s=SPRITES[name];c.save();c.beginPath();c.rect(r.x,r.y,r.w,r.h);c.clip();
    for(let y=r.y;y<r.y+r.h;y+=s.h)for(let x=r.x;x<r.x+r.w;x+=s.w)sprite(c,name,x,y);
    c.restore();
  }
  function plaque(c,label,x,y,w,color='#7e9ac0',size=13) {
    rect(c,x+2,y+3,w,24,'#08101e');rect(c,x,y,w,24,'#71849c');rect(c,x+1,y+1,w-2,22,'#101f36');
    rect(c,x+3,y+3,w-6,1,'#253d5b');rect(c,x+7,y+8,3,8,color);text(c,label,x+w/2+3,y+12,'#f5f7ff',size,'center');
  }
  function roomSign(c,label,x,y,w,color='#82baff') {
    const compact=scale<.65,height=compact?25:22,size=compact?17:12;
    rect(c,x+3,y+3,w,height,'#08101e');rect(c,x,y,w,height,'#8797ad');
    rect(c,x+1,y+1,w-2,height-2,'#0b1729');rect(c,x+4,y+4,w-8,height-8,'#142944');
    rect(c,x+7,y+(height-9)/2,4,9,color);rect(c,x+12,y+(height-9)/2,1,9,'#526987');
    text(c,label,x+18,y+height/2,'#f5f7ff',size);
  }
  function paintBackdrop() {
    rect(bg,0,0,768,500,'#101c2d');
    // Blue-grey atlas tiles make the shared circulation read as a separate hallway.
    tile(bg,'floorCorridor',{x:5,y:5,w:758,h:490});
    // Keep the shared circulation visibly tiled instead of flattening it to a
    // solid fill; room floors below still override the tile with their own
    // material, leaving the blue-grey texture only in corridors and thresholds.
    tile(bg,'floorCorridor',{x:4,y:4,w:760,h:492});
    // Continuous tiled corridors connect every doorway. Fixtures never occupy them.
    for(const a of AREAS) {
      const {x,y,w,h}=a.rect;
      rect(bg,x+2,y+3,w,h,'#172237');rect(bg,x+6,y+6,w-12,h-12,'#b8895c');
      // Warm wood marks work/lounge rooms; Gate and Archive keep the cool technical tile.
      const technical=a.id==='gate'||a.id==='archive';
      tile(bg,technical?'floorTile':'floorWood',{x:x+6,y:y+30,w:w-12,h:h-36});
      // Quiet, hand-drawn plank joints keep the supplied wood texture from reading as noise.
      let plank=0;
      if(!technical) for(let py=y+22;py<y+h-6;py+=18,plank++) {
        rect(bg,x+6,py,w-12,1,'#a77c52');
        const seam=x+24+(plank%2)*39;
        rect(bg,seam,py-17,1,17,'#a77c52');
      }
      rect(bg,x+6,y+6,w-12,22,'#65758a');rect(bg,x+7,y+7,w-14,8,'#a3adbd');
      rect(bg,x+6,y+27,w-12,3,'#72532f');
      // Outer navy frame with a pixel bevel, then a genuine doorway cutout.
      rect(bg,x,y,w,6,'#17283d');rect(bg,x,y,6,h,'#17283d');rect(bg,x+w-6,y,6,h,'#17283d');rect(bg,x,y+h-6,w,6,'#17283d');
      rect(bg,x+1,y+1,w-2,1,'#a5b3c4');rect(bg,x+1,y+1,1,h-2,'#8295ae');
      rect(bg,x+5,y+5,w-10,2,'#0a1526');rect(bg,x+5,y+h-9,w-10,3,'#315471');
      // Amber inner sill and corner bolts make the dark cubicle frames deliberate, not wireframe-thin.
      rect(bg,x+7,y+h-12,w-14,1,'#9a704b');
      for(const bx of [x+4,x+w-7]){rect(bg,bx,y+7,2,2,'#90a4bc');rect(bg,bx,y+h-9,2,2,'#90a4bc');}
      // Windows and warm ceiling lamps tie the interior to the supplied reference.
      sprite(bg,'window',x+w-59,y+4,.83);
      const lampX=x+Math.min(42,w/2-8);
      rect(bg,lampX,y+11,17,7,'#253951');rect(bg,lampX+2,y+12,13,4,'#f7efcf');
    }
    for(const d of DOORS){rect(bg,d.x,d.y,d.w,d.h,'#d69b58');rect(bg,d.x+3,d.y,d.w-6,d.h,'#e7b874');
      rect(bg,d.x-2,d.y,3,d.h,'#70431f');rect(bg,d.x+d.w-1,d.y,3,d.h,'#70431f');rect(bg,d.x+3,d.y+3,d.w-6,2,'#ffe1a0');}
    for(const f of [...FURNITURE].sort((a,b)=>a.y+a.h-b.y-b.h))sprite(bg,f.sprite,f.x,f.y,f.scale);
    for(const a of AREAS) {
      const {x,y,w}=a.rect;
      const label=a.id==='engineering'?'Spec / Build':a.id==='gate'?'Gate':a.id==='needs-info'?'Needs Info':a.id==='escalation'?'Needs Human':a.label;
      const pw=Math.min(w-20,label.length*(scale<.65?9.5:6.2)+24);
      roomSign(bg,label,x+8,y+9,pw,a.id==='escalation'?'#ff6a79':a.id==='lounge'?'#70d0ad':'#82baff');
    }
    text(bg,'LIVE BOARD',20,158,'#e7efff',9);
    text(bg,'CONNECTED WORKSPACE',742,334,'#e7efff',9,'right');
  }
  function monitor(x,y,w,h,label,value,color,now,animate) {
    rect(ctx,x-3,y-3,w+6,h+6,'#20334e');rect(ctx,x-1,y-1,w+2,h+2,'#7a9bb7');rect(ctx,x,y,w,h,'#091b32');
    rect(ctx,x+3,y+3,w-6,h-6,'#0d2947');text(ctx,label,x+8,y+10,'#a5c7e8',9);
    text(ctx,value,x+w/2,y+h/2+7,color,Math.min(14,w/7),'center');
    if(animate&&!reduced.matches){const p=(now/1200)%1;rect(ctx,x+4,y+h-5,w-8,2,'#234d70');rect(ctx,x+4+(w-30)*p,y+h-5,22,2,color);}
  }
  function fit() {
    // Logical geometry stays constant even when resized mid-walk.
    const w=stage.clientWidth,h=stage.clientHeight||MAP.height*(w/MAP.width);
    // Contain the 768×500 artwork as one proportional scene. The unused stage area
    // remains navy instead of stretching sprites and making labels look smeared.
    const viewport=viewportOffice(w,h);scale=scaleX=scaleY=viewport.scale;
    canvas.style.position='absolute';canvas.style.left=`${viewport.offsetX}px`;canvas.style.top=`${viewport.offsetY}px`;
    canvas.style.width=`${viewport.width}px`;canvas.style.height=`${viewport.height}px`;
    hits.style.left='0px';hits.style.top='0px';hits.style.width=`${w}px`;hits.style.height=`${h}px`;
    return viewport;
  }
  function draw(now=performance.now()) {
    const viewport=fit();ctx.imageSmoothingEnabled=false;ctx.drawImage(backdrop,0,0);
    const boxes=new Map(AREAS.map(a=>[`area:${a.id}`,a.rect]));
    for(const [s,r] of Object.entries(STAGE_REGIONS))boxes.set(`stage:${s}`,r);
    const gate=state.gate.status;
    monitor(615,72,100,44,'AUTOMATIC CHECKS',gate,gate==='FAIL'?'#ff7d87':gate==='PASS'?'#67e4a3':'#80c8ff',now,gate==='running');
    monitor(466,406,121,31,'MERGING',state.merging.status==='merging'?'Merging…':'idle','#78d7b3',now,state.merging.status==='merging');
    monitor(466,452,121,30,'AWAITING MERGE',`${state.merging.waiting} waiting`,'#8dc4ff',now,false);
    plaque(ctx,`Merged  ${state.archive.merged}`,641,450,110,'#55ce91',10);
    plaque(ctx,`Rejected  ${state.archive.rejected}`,641,477,110,'#ed7484',10);
    const lists=[...Object.values(state.tokens),state.escalation].flat();
    const counts=new Map(),overflowCounts=new Map();
    visibleJobIds=new Set();
    const slots={intake:[[22,76],[92,76],[22,98]],spec:[[280,48],[350,48],[280,72]],build:[[421,48],[491,48],[421,72]],gate:[[612,110],[676,110],[612,132]],review:[[20,423],[114,423],[208,423]],approve:[[366,458],[414,458],[366,480]],merging:[[468,389],[520,389]],'awaiting-merge':[[468,438],[520,438]],'needs-info':[[24,228],[96,228],[24,250],[96,250]],'needs-human':[[588,228],[660,228],[588,250],[660,250]]};
    for(const tok of lists) {
      // A job parked for its spec review waits on the needs-info shelf: both wait for a person's reply.
      const t=tok.stage==='spec-review'?{...tok,stage:'needs-info'}:tok;
      const i=counts.get(t.stage)||0;counts.set(t.stage,i+1);
      const r=STAGE_REGIONS[t.stage];if(!r)continue;
      // Separate shelves for each pipeline stage; each ID is painted only once.
      let x=r.x,y=r.y+14;
      if(slots[t.stage]?.[i]) [x,y]=slots[t.stage][i];
      else if(t.stage==='intake'){x=21;y=77+i*17;}
      else if(t.stage==='spec'){x=280;y=48+i*16;}
      else if(t.stage==='build'){x=421;y=48+i*16;}
      else if(t.stage==='gate'){x=612;y=120+i*16;}
      else if(t.stage==='review'){x=20+(i%3)*94;y=423+Math.floor(i/3)*17;}
      else if(t.stage==='approve'){x=366;y=474+i*17;}
      else if(t.stage==='merging'){x=468;y=389+i*16;}
      else if(t.stage==='awaiting-merge'){x=468;y=438+i*16;}
      else if(t.stage==='needs-info'||t.stage==='needs-human'){
        x=r.x+4+(i%2)*84;y=r.y+54+Math.floor(i/2)*18;
      }
      else {x=r.x+(i%2)*72;y=r.y+Math.floor(i/2)*17;}
      // Unbounded parked jobs remain individually keyboard/click accessible in the status list.
      const overflow=Boolean(slots[t.stage])&&!slots[t.stage][i];
      if(overflow){overflowCounts.set(t.stage,(overflowCounts.get(t.stage)||0)+1);continue;}
      visibleJobIds.add(t.jobId);
      const label=t.label.length>17?t.label.slice(0,15)+'…':t.label;
      ctx.font='600 10px system-ui';const maxWidth=t.stage==='needs-info'||t.stage==='needs-human'?72:110;
      const w=Math.min(maxWidth,Math.max(55,ctx.measureText(label).width+17));
      rect(ctx,x+2,y+3,w,18,'#56473e');rect(ctx,x,y,w,18,'#f9edcf');
      rect(ctx,x,y,w,1,'#fff9eb');rect(ctx,x,y,2,18,t.stage==='needs-human'?'#ed5d78':'#e6a528');
      rect(ctx,x+5,y+5,7,8,t.stage==='needs-human'?'#ef5874':'#4d91db');
      text(ctx,label,x+16,y+9,'#17273d',11);boxes.set(`token:${t.jobId}`,{x,y,w,h:19});
    }
    for(const [stage,count] of overflowCounts) {
      const r=STAGE_REGIONS[stage],x=r.x+4,y=r.y+90;
      rect(ctx,x,y,76,15,'#fff3d7');rect(ctx,x+3,y+4,5,7,stage==='needs-human'?'#ee6281':'#519ddc');
      text(ctx,`+${count} more`,x+12,y+8,'#17273d',10);
    }
    for(const a of Object.keys(state.agents).sort((a,b)=>walkers.get(a).y-walkers.get(b).y)) {
      const w=walkers.get(a),s=SPRITES[CHARACTER_FOR[a]],bob=w.queue.length?(reduced.matches?0:Math.floor(now/150)%2):work.bob(a,w,now);
      // Seated on a sofa: lift the sprite over the cushion; the name label stays at ground level.
      const lift=sofaLift(w);
      const x=Math.round(w.x-s.w/2),y=Math.round(w.y-s.h-bob-lift);
      rect(ctx,x+1,w.y-1,s.w-2,3,'#674d3f');
      if(ready)sprite(ctx,CHARACTER_FOR[a],x,y);else rect(ctx,x+4,y+4,s.w-8,s.h-4,COLORS[a]);
      // Thought bubble above the head, clear of the name label (below the feet) and room signs.
      const kind=bubbles.get(a,w);
      if(kind&&ready){const b=SPRITES[BUBBLES[kind].sprite];sprite(ctx,BUBBLES[kind].sprite,Math.round(w.x-b.w/2),Math.max(2,y-b.h-1));}
      const label=SHORT[a],labelSize=scale<.65?16:13;ctx.font=`700 ${labelSize}px system-ui`;const tw=Math.max(30,ctx.measureText(label).width+12);
      const tx=Math.min(MAP.width-tw-2,Math.max(2,w.x-tw/2)),ty=w.y-4;
      // Place nameplates beneath feet, not over faces; the fixed lounge rows have a safe gap.
      const labelY=Math.min(MAP.height-15,w.y+2);
      rect(ctx,tx+1,labelY+1,tw,14,'#081323');rect(ctx,tx,labelY,tw,13,COLORS[a]);rect(ctx,tx+1,labelY+1,tw-2,11,'#13243b');
      text(ctx,label,tx+tw/2,labelY+7,'#fff',labelSize,'center');
      boxes.set(`agent:${a}`,{x:Math.min(x,tx),y,w:Math.max(s.w,tw),h:s.h+18});
    }
    for(const [key,btn] of buttons) {
      const b=boxes.get(key);btn.hidden=!b;if(!b)continue;
      Object.assign(btn.style,{left:`${viewport.offsetX+b.x*scaleX}px`,top:`${viewport.offsetY+b.y*scaleY}px`,width:`${b.w*scaleX}px`,height:`${b.h*scaleY}px`});
    }
  }
  const moving=()=>[...walkers.values()].some(w=>w.queue.length);
  const agentsNow=()=>state.agents;
  // Rest/dwell periods need no frames: one timer wakes the loop when the next decision is due.
  const wake=(now=performance.now())=>Math.min(director.nextWake(walkers),work.nextWake(walkers,now),bubbles.nextWake());
  const plan=(now=performance.now())=>planWake({reduced:reduced.matches,hidden:document.hidden,moving:moving()||state.gate.status==='running'||state.merging.status==='merging',busy:false,wake:wake(now),now});
  const isAnimated=now=>plan(now).frame;
  function schedule() {
    clearTimeout(wakeTimer);wakeTimer=0;
    const {timerMs}=plan();
    if(timerMs!==null)wakeTimer=setTimeout(()=>{wakeTimer=0;kick();},timerMs);
  }
  function frame(now){
    const dt=last?Math.min(.1,(now-last)/1000):0;last=now;
    work.tick(now,agentsNow(),walkers);director.tick(now,agentsNow(),walkers);bubbles.tick(now,id=>walkers.get(id).queue.length>0);
    for(const [a,w] of walkers)advanceWalker(w,dt,work.speed(a,w)??director.speed(a,w));
    draw(now);raf=isAnimated(now)?requestAnimationFrame(frame):0;
    if(!raf)schedule();
  }
  function kick(){if(raf)return;if(isAnimated()){last=performance.now();raf=requestAnimationFrame(frame);}else schedule();}
  function update(nextJobs) {
    jobs=Array.isArray(nextJobs)?nextJobs:[];state=officeState(jobs);
    for(const [agent,a] of Object.entries(state.agents)) {
      if(!walkers.has(agent))walkers.set(agent,{...WAYPOINTS.nodes[a.node],node:a.node,target:a.node,queue:[]});
    }
    work.sync(state.agents,walkers,reduced.matches);director.sync(state.agents,walkers,reduced.matches,(id)=>work.owns(id));bubbles.sync(state.agents,reduced.matches);
    const keep=new Set();
    for(const t of hitTargets(state,jobs)) {
      const key=`${t.kind}:${t.key}`;keep.add(key);let btn=buttons.get(key);
      if(!btn){btn=document.createElement('button');btn.type='button';btn.dataset.box=key;buttons.set(key,btn);hits.appendChild(btn);}
      btn.className=`hit hit-${t.kind}`;btn.dataset.id=t.jobId;btn.setAttribute('aria-label',t.label);btn.title=t.kind==='agent'?state.agents[t.key].bubble:t.label;
    }
    for(const [key,btn] of buttons)if(!keep.has(key)){btn.remove();buttons.delete(key);}
    const lines=describeOffice(state),key=lines.join('\n');
    if(key!==liveKey){liveKey=key;live.replaceChildren(...lines.map(line=>{const li=document.createElement('li');li.textContent=line;return li;}));}
    // Readable full work labels are outside the art, not piled on other people's faces.
    const entries=Object.entries(state.agents).filter(([,s])=>s.work.length);
    const desired=new Map(entries.map(([a,s])=>[`agent:${a}`,{label:s.bubble,id:s.work[0].jobId,color:COLORS[a]}]));
    for(const t of [...Object.values(state.tokens).flat(),...state.escalation]) if(!visibleJobIds.has(t.jobId)) desired.set(`job:${t.jobId}`,{label:`${t.stage} · ${t.label}`,id:t.jobId,color:'#a9b9cc'});
    // Keep status buttons keyed too, so keyboard focus survives a polling update.
    const existing=new Map([...status.children].map(e=>[e.dataset.key,e]));
    for(const [k,t] of desired){let b=existing.get(k);if(!b){b=document.createElement(t.id?'button':'span');b.dataset.key=k;if(t.id)b.type='button';status.appendChild(b);}b.textContent=t.label;b.style.setProperty('--role-color',t.color||'#7a94b3');if(t.id)b.dataset.id=t.id;}
    for(const [k,b] of existing)if(!desired.has(k))b.remove();
    draw();kick();schedule();
  }
  hits.addEventListener('click',e=>{const btn=e.target.closest('.hit');if(btn)openJob(btn.dataset.id);});
  status.addEventListener('click',e=>{const btn=e.target.closest('button[data-id]');if(btn)openJob(btn.dataset.id);});
  reduced.addEventListener('change',()=>{
    if(reduced.matches){cancelAnimationFrame(raf);raf=0;clearTimeout(wakeTimer);wakeTimer=0;work.sync(state.agents,walkers,true);director.sync(state.agents,walkers,true,(id)=>work.owns(id));bubbles.sync(state.agents,true);draw();}
    else update(jobs);
  });
  document.addEventListener('visibilitychange',()=>{
    if(document.hidden){cancelAnimationFrame(raf);raf=0;clearTimeout(wakeTimer);wakeTimer=0;}
    else{last=0;kick();schedule();}
  });
  if(typeof ResizeObserver==='function')new ResizeObserver(()=>draw()).observe(stage);else window.addEventListener('resize',()=>draw());
  atlas.onload=()=>{ready=true;paintBackdrop();draw();};
  atlas.onerror=()=>{status.textContent='Office atlas unavailable; job details remain available.';};
  atlas.src=ATLAS_URL;paintBackdrop();update([]);
  return {update};
}
