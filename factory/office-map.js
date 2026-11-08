// Fixed logical geometry: resizing scales the entire map, never walls or routes independently.
import { SPRITES } from './sprite-atlas.js';
export const MAP = Object.freeze({ width: 768, height: 500 });
const area = (id,label,stages,x,y,w,h) => ({id,label,stages,rect:{x,y,w,h}});
export const AREAS = [
  area('research','Intake',['intake'],8,8,230,134),
  area('engineering','Spec / Build',['spec','build'],266,8,276,134),
  area('gate','Gate · checks',['gate'],570,8,190,134),
  area('needs-info','Needs Info',['needs-info','spec-review'],8,174,180,144),
  area('lounge','Lounge · available agents',[],216,174,326,144),
  area('escalation','Needs Human',['needs-human'],570,174,190,144),
  area('review','Review',['review'],8,350,318,142),
  area('release','Release',['approve','merging','awaiting-merge'],354,350,250,142),
  area('archive','Archive',['merged','rejected'],632,350,128,142),
];
export const SHORT = Object.freeze({intake:'Intake','spec-writer':'Spec',builder:'Build','review-security':'Sec','review-ux':'UX','review-ui':'UI','review-code':'Code',approver:'Appr.'});
export const COLORS = Object.freeze({intake:'#36a7ff','spec-writer':'#ab65f4',builder:'#f59b25','review-security':'#ec4565','review-ux':'#f368b7','review-ui':'#8d76ff','review-code':'#368cff',approver:'#55c779'});
export const SEATS = {intake:'seat_intake','spec-writer':'seat_spec',builder:'seat_builder','review-security':'seat_sec','review-ux':'seat_ux','review-ui':'seat_ui','review-code':'seat_code',approver:'seat_approver'};
export const LOUNGE_SPOTS = Object.fromEntries(Object.keys(SHORT).map((a,i)=>[a,`lounge_${i+1}`]));
export const MEETING_SEATS = {'review-security':'meet_sec','review-ux':'meet_ux','review-ui':'meet_ui','review-code':'meet_code'};
export const DOORS = [
  {id:'research',x:112,y:138,w:32,h:8}, {id:'engineering',x:384,y:138,w:32,h:8},
  {id:'gate',x:650,y:138,w:32,h:8}, {id:'needs-info',x:80,y:170,w:32,h:12},
  {id:'lounge',x:364,y:170,w:32,h:12}, {id:'escalation',x:650,y:170,w:32,h:12},
  {id:'review',x:150,y:346,w:32,h:12}, {id:'release',x:462,y:346,w:32,h:12},
  {id:'archive',x:680,y:346,w:32,h:12},
];
export const WALL_H = 24, PARTITION = 6, DOOR_W = 32;
// The top visual wall has depth, but its ground footprint is a narrow strip.
const walls = [];
for (const a of AREAS) {
  const {x,y,w,h}=a.rect, d=DOORS.find(d=>d.id===a.id), top=d.y<y+10;
  walls.push({x,y,w:6,h},{x:x+w-6,y,w:6,h});
  for (const [wy,split] of [[y,top],[y+h-6,!top]]) {
    if(split) walls.push({x,y:wy,w:d.x-x,h:6},{x:d.x+d.w,y:wy,w:x+w-d.x-d.w,h:6});
    else walls.push({x,y:wy,w,h:6});
  }
}
const prop=(sprite,x,y,scale=1)=>({sprite,x,y,scale,w:SPRITES[sprite].w*scale,h:SPRITES[sprite].h*scale});
export const FURNITURE = [
  // Larger workstations make the office read like occupied cubicles at dashboard scale.
  prop('deskDual',79,57,1.02),prop('plantTall',17,53,.92),prop('board',174,58,.88),
  prop('plant',207,82,.78),
  prop('deskPlant',279,57,.98),prop('deskDual',423,57,.98),prop('board',354,62,.78),prop('cabinet',500,88,.58),prop('plantTall',506,58,.84),
  prop('server',582,54,.92),prop('server',723,54,.92),prop('cabinet',662,83,.68),
  prop('sofaBlue',19,205,1.02),prop('table',109,205,1.02),prop('plantTall',158,202,.76),
  prop('sofaBlue',228,198,.98),prop('sofaGreen',477,198,.98),
  prop('table',358,274,1.0),prop('vending',223,255,.82),prop('cooler',511,257,.82),
  prop('plantTall',237,193,.58),prop('plant',488,193,.54),
  // Lounge decor sits in the gaps between home slots, clear of aisles, points and labels.
  prop('armchairOrange',301,212,.8),prop('plantSmall',318,206,.8),prop('armchairBlue',438,204),
  prop('sofaBlue',577,205,.9),prop('table',692,205,.92),prop('plantTall',720,267,.8),
  ...[22,97,172,247].map(x=>prop('deskDual',x,381,.78)),
  prop('meetingTable',137,451,.82),prop('plantTall',15,441,.72),prop('plantTall',292,441,.72),
  prop('deskPlant',366,386,.98),prop('printer',567,437,.85),prop('cabinet',553,373,.54),
  prop('shelf',638,386,.98),prop('shelf',708,386,.9),
];
// Screens are drawn in the foreground and must also block agents on the ground plane.
export const MONITORS = [{x:463,y:403,w:127,h:37},{x:463,y:449,w:127,h:36}];
export const COLLISIONS = [
  ...walls.map(r=>({...r,kind:'wall'})),
  // Review agents sit in front of their monitors. Keep the desk surface
  // collidable, but leave the lower chair/leg space open for the foot anchor.
  ...FURNITURE.map(f=>({x:f.x,y:f.y,w:f.w,h:f.y===381&&f.sprite==='deskDual'?34:f.h,kind:'furniture'})),
  ...MONITORS.map(r=>({...r,kind:'monitor'})),
];
const nodes={}, edges=[];
const node=(id,x,y)=>{nodes[id]={x,y};return id;};
const edge=(a,b)=>edges.push([a,b]);
const chain=(ids)=>ids.slice(1).forEach((n,i)=>edge(ids[i],n));
const xs=[96,128,166,202,380,400,478,556,666,696];
for(const [row,y] of [['top',158],['bottom',334]]) chain(xs.map(x=>node(`cor_${row}_${x}`,x,y)));
for(const x of [202,556]) edge(`cor_top_${x}`,`cor_bottom_${x}`);
for(const d of DOORS) {
  const x=d.x+d.w/2,y=d.id==='research'||d.id==='engineering'||d.id==='gate'?138:d.y+4;
  node(`door_${d.id}`,x,y);
  const bottom=['review','release','archive'].includes(d.id);
  edge(`door_${d.id}`,`cor_${bottom?'bottom':'top'}_${x}`);
  node(`in_${d.id}`,x,y+(y===138?-12:32)); edge(`door_${d.id}`,`in_${d.id}`);
}
// Work seats are in front of the desks, never inside their floor footprints.
for(const [id,x,y,room] of [['seat_intake',114,126,'research'],['seat_spec',314,126,'engineering'],['seat_builder',462,126,'engineering'],['seat_approver',395,451,'release']]) {
  node(id,x,y); const inn=`in_${room}`;
  if(id==='seat_approver') {
    const turn=node('turn_seat_approver',440,451),entry=node('entry_seat_approver',440,nodes[inn].y);
    edge(inn,entry);edge(entry,turn);edge(turn,id);
  } else if(nodes[inn].y===y) edge(id,inn); else { const turn=node(`turn_${id}`,nodes[inn].x,y);edge(inn,turn);edge(turn,id); }
}
// Clear center aisle, with separate upper/lower lounge rows.
node('lounge_spine',380,264);edge('in_lounge','lounge_spine');
for(let i=0;i<8;i++) {
  const x=[286,346,414,474][i%4],y=i<4?242:296;
  const turn=`lounge_turn_${i%4}`; if(!nodes[turn]) {node(turn,x,264);edge(turn,'lounge_spine');}
  node(`lounge_${i+1}`,x,y);edge(`lounge_${i+1}`,turn);
}
// Lounge points of interest: leaf nodes in front of the furniture, used only by idle wandering.
// Sofas are sat on from the front edge; the renderer lifts the sprite while dwelling there.
export const LOUNGE_POINTS = [
  {id:'water',node:'lounge_poi_water',x:498,y:276,pose:'stand',turn:'lounge_turn_3'},
  {id:'snacks',node:'lounge_poi_snacks',x:262,y:280,pose:'stand',turn:'lounge_turn_0'},
  {id:'sofa-blue',node:'lounge_poi_sofa_blue',x:253,y:242,pose:'sit',turn:'lounge_turn_0'},
  {id:'sofa-green',node:'lounge_poi_sofa_green',x:503,y:242,pose:'sit',turn:'lounge_turn_3'},
  {id:'table',node:'lounge_poi_table',x:320,y:282,pose:'stand',turn:'lounge_turn_1'},
];
for(const p of LOUNGE_POINTS){node(p.node,p.x,p.y);edge(p.turn,p.node);}
// Review's lower aisle connects all four desks and a separate meeting table.
node('review_aisle',166,441);edge('in_review','review_aisle');
for(const [i,role] of ['sec','ux','ui','code'].entries()) {
  const x=[51,122,193,264][i]; node(`seat_${role}`,x,425);edge(`seat_${role}`,'review_aisle');
  const mx=[75,111,210,253][i];node(`meet_${role}`,mx,475);node(`meet_turn_${role}`,mx,441);edge(`meet_turn_${role}`,'review_aisle');edge(`meet_turn_${role}`,`meet_${role}`);
}
// Room work points: leaf nodes in front of furniture, used only by agents working at their seat.
// Keyed by area id; each node hangs off one existing node of the same room so no shortcuts appear.
export const ROOM_POINTS = {
  research: [
    {id:'board',node:'work_research_board',x:182,y:126,link:'in_research'},
    {id:'plant',node:'work_research_plant',x:40,y:126,link:'seat_intake'},
  ],
  engineering: [
    {id:'board',node:'work_engineering_board',x:376,y:116,link:'in_engineering'},
    {id:'cabinet',node:'work_engineering_cabinet',x:504,y:126,link:'seat_builder'},
  ],
  review: [
    {id:'meeting-table',node:'work_review_meeting_table',x:150,y:441,link:'review_aisle'},
    {id:'plant',node:'work_review_plant',x:272,y:452,link:'meet_turn_code'},
  ],
  release: [
    {id:'desk-front',node:'work_release_desk_front',x:424,y:443,link:'turn_seat_approver'},
    {id:'desk-plant',node:'work_release_desk_plant',x:448,y:416,link:'entry_seat_approver'},
  ],
};
for(const pts of Object.values(ROOM_POINTS)) for(const p of pts){node(p.node,p.x,p.y);edge(p.link,p.node);}
export const WAYPOINTS = {nodes,edges};
export const STAGE_REGIONS = {
  intake:{x:22,y:46,w:70,h:83}, spec:{x:280,y:45,w:108,h:86},build:{x:421,y:45,w:108,h:86},
  gate:{x:611,y:47,w:107,h:83},'needs-info':{x:24,y:212,w:138,h:38}, review:{x:24,y:372,w:286,h:111},
  approve:{x:366,y:378,w:84,h:104},merging:{x:461,y:390,w:127,h:42},'awaiting-merge':{x:461,y:440,w:127,h:39},
  'needs-human':{x:588,y:211,w:145,h:41},
};
export function layoutOffice(width,height=0) {
  const w=Number.isFinite(width)&&width>0?width:MAP.width,h=Number.isFinite(height)&&height>0?height:Infinity;
  return {scale:Math.min(w/MAP.width,h/MAP.height),map:MAP,areas:AREAS,nodes:WAYPOINTS.nodes,furniture:FURNITURE};
}
export function viewportOffice(width,height) {
  const w=Number.isFinite(width)&&width>0?width:MAP.width;
  const h=Number.isFinite(height)&&height>0?height:MAP.height;
  const scale=Math.min(w/MAP.width,h/MAP.height),drawWidth=MAP.width*scale,drawHeight=MAP.height*scale;
  return {scale,offsetX:(w-drawWidth)/2,offsetY:(h-drawHeight)/2,width:drawWidth,height:drawHeight};
}
export function officeBackdrop(layout) {
  if(!layout?.areas) return {corridor:null,doors:[],floors:[],walls:[],wallProps:[],partitions:[]};
  return {corridor:{x:0,y:0,w:MAP.width,h:MAP.height},doors:DOORS,floors:AREAS.map(a=>({...a.rect,id:a.id,kind:['gate','archive'].includes(a.id)?'tile':'wood'})),walls,wallProps:[],partitions:[]};
}
