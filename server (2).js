// TON Duel: авторитетный сервер. Баланс в сотых долях TON (целые числа).
// Игры: Duel (Ice vs Fire), Ракетка (crash), UpGift (апгрейд подарков). Всё считается только на сервере.
const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto');
const {WebSocketServer}=require('ws');
const ENV=process.env;
const TOKEN=ENV.BOT_TOKEN||'',DEV=ENV.DEV==='1',PORT=ENV.PORT||3000;
const WALLET=ENV.TON_WALLET||'';      // адрес кошелька для пополнений
const BOT=ENV.BOT_USERNAME||'';       // username бота без @ — для реферальных ссылок
const APP=ENV.APP_SHORT||'';          // short name мини-приложения (если оно не «главное»)
const ADMIN=ENV.ADMIN_ID||'';         // Telegram ID менеджера: ему приходят заявки на вывод
const BOTS=ENV.BOTS!=='0';            // боты-игроки; BOTS=0 выключает их полностью

const START=10000,RAKE=0.05,BET_MS=20000,R=156,BR=11; // START = 100.00 TON
const MIN_WD=100,HIST_MAX=50,ROUNDS_MAX=30,LIVE_MAX=40;
const REF_PCT=0.10;                   // доля от комиссии (RAKE), которую получает пригласивший
const TEAM_COUNT=5,TEAM_REWARD=500;   // промокоды Team: 5 кодов по 5 TON, каждый одноразовый
const PB_MIN=3;                       // PLAYBONUS можно забрать с ранга Silver (индекс в RANKS)
const RK_BET=8000,RK_CRASH=3500,RK_K=0.11; // Ракетка: окно ставок, пауза после краша, рост множителя e^(K*сек)
const UP_FEE=0.05,UP_MS=4600;         // UpGift: комиссия сайта и длительность анимации
const T=n=>n*100;

// ---------- каталог подарков для UpGift (цена в сотых долях TON)
const CATALOG=[
  {id:'candy',ico:'🍬',name:'Candy',val:T(0.5)},{id:'rose',ico:'🌹',name:'Rose',val:T(1)},
  {id:'cake',ico:'🎂',name:'Cake',val:T(2)},{id:'bear',ico:'🧸',name:'Teddy Bear',val:T(3.5)},
  {id:'bouquet',ico:'💐',name:'Bouquet',val:T(5)},{id:'ring',ico:'💍',name:'Gold Ring',val:T(10)},
  {id:'cap',ico:'🧢',name:'Cap',val:T(15)},{id:'book',ico:'📕',name:'Spell Book',val:T(25)},
  {id:'heart',ico:'💝',name:'Heart Locket',val:T(50)},{id:'crown',ico:'👑',name:'Crown',val:T(100)},
  {id:'diamond',ico:'💎',name:'Diamond',val:T(250)}
];

// ---------- VIP-ранги (по обороту ставок). rate — доля PLAYBONUS от ставки, в интерфейсе не показывается
const RANKS=[
  {id:'start',   name:'Start',   min:0,          rate:.0005,bonus:0,        perks:[]},
  {id:'iron',    name:'Iron',    min:T(1000),    rate:.0005,bonus:0,        gift:true,perks:['nft','promo']},
  {id:'bronze',  name:'Bronze',  min:T(5000),    rate:.0006,bonus:T(10),    perks:['promo','drops','vip']},
  {id:'silver',  name:'Silver',  min:T(10000),   rate:.0007,bonus:T(25),    perks:['promo','drops','vip','pb']},
  {id:'gold',    name:'Gold',    min:T(25000),   rate:.0008,bonus:T(50),    perks:['promo','drops','vip','pb','mgr']},
  {id:'platinum',name:'Platinum',min:T(50000),   rate:.0010,bonus:T(100),   perks:['promo','drops','vip','pb','mgr','mgrb']},
  {id:'diamond', name:'Diamond', min:T(250000),  rate:.0012,bonus:T(500),   perks:['promo','drops','vip','pb','mgr','mgrb']},
  {id:'obsidian',name:'Obsidian',min:T(1000000), rate:.0015,bonus:T(2500),  perks:['promo','drops','vip','pb','mgr','mgrb']}
];
const RANKS_PUB=RANKS.map(r=>({id:r.id,name:r.name,min:r.min,bonus:r.bonus,perks:r.perks}));

// ---------- квесты: награда в сотых долях TON
const QUESTS=[
  {id:'q1',title:'q_first',goal:1,reward:10,stat:'played'},
  {id:'q2',title:'q_play5',goal:5,reward:20,stat:'played'},
  {id:'q3',title:'q_win3',goal:3,reward:50,stat:'won'},
  {id:'q4',title:'q_promo',goal:1,reward:10,stat:'promos'},
  {id:'q5',title:'q_invite',goal:1,reward:50,stat:'refs'}
];

// ---------- хранилище (JSON-файлы, запись с задержкой)
const load=(f,d)=>{try{return JSON.parse(fs.readFileSync(path.join(__dirname,f)))}catch{return d}};
const pend={};
const dump=(f,get)=>{if(pend[f])return;pend[f]=setTimeout(()=>{pend[f]=0;try{fs.writeFileSync(path.join(__dirname,f),JSON.stringify(get()))}catch(e){console.error('save',f,e.message)}},100)};
function saveNow(){for(const [f,o] of [['users.json',users],['promos.json',used],['rounds.json',rounds],['requests.json',reqs]])try{fs.writeFileSync(path.join(__dirname,f),JSON.stringify(o))}catch{}}
let users=load('users.json',{}),used=load('promos.json',{}),rounds=load('rounds.json',{n:0,rk:0,list:[]}),reqs=load('requests.json',[]),team=load('team_codes.json',null);
const saveU=()=>dump('users.json',()=>users),saveP=()=>dump('promos.json',()=>used),saveRd=()=>dump('rounds.json',()=>rounds),saveR=()=>dump('requests.json',()=>reqs);
['SIGINT','SIGTERM'].forEach(s=>process.on(s,()=>{saveNow();process.exit(0)}));
for(const k in used)if(typeof used[k]==='string')used[k]=[used[k]]; // миграция: код -> список uid

// ---------- промокоды. r — награда (100 = 1 TON), max — сколько всего раз код можно активировать (0 = без лимита).
// Один игрок может активировать каждый код только один раз. Свои коды добавляйте сюда.
const PROMOS={
  WELCOME:{r:T(1),max:500},    // 1 TON, первым 500 игрокам
  ROCKET:{r:T(0.5),max:300},   // 0.5 TON
  UPGIFT:{r:T(1.5),max:200},   // 1.5 TON
  TONDUEL:{r:T(1),max:1}       // 1 TON, строго одноразовый
};
if(!team){team=Array.from({length:TEAM_COUNT},()=>'TEAM-'+crypto.randomBytes(3).toString('hex').toUpperCase());fs.writeFileSync(path.join(__dirname,'team_codes.json'),JSON.stringify(team))}
team.forEach(c=>PROMOS[c]={r:TEAM_REWARD,max:1});
console.log('Промокоды: '+Object.entries(PROMOS).map(([c,p])=>c+' ('+p.r/100+' TON, '+(used[c]?used[c].length:0)+'/'+(p.max||'∞')+')').join(', '));
const ptry={}; // защита от перебора: uid -> {n,t}

// ---------- игроки
const AD=['Silent','Sly','Swift','Frosty','Blazing','Shadow','Golden','Brave','Night','Lunar'],
      AN=['Fox','Wolf','Raven','Tiger','Falcon','Bear','Dragon','Panther','Whale','Raccoon'],
      AV=['🦊','🐺','🐦‍⬛','🐯','🦅','🐻','🐲','🐆','🐋','🦝'];
const rnd=(a,b)=>a+Math.floor(Math.random()*(b-a+1)),pick=a=>a[Math.floor(Math.random()*a.length)];
function mkAlias(){const n=crypto.randomInt(AN.length);return{name:AD[crypto.randomInt(AD.length)]+' '+AN[n]+' #'+(100+crypto.randomInt(900)),av:AV[n]}}
function user(uid,name){
  const u=users[uid]=users[uid]||{bal:START,created:Date.now()};
  if(name)u.name=name;
  for(const [k,v] of Object.entries({hist:[],inv:[],tx:[],promos:[],claimed:[],refs:[],played:0,won:0,profit:0,turnover:0,rank:0,pb:0,refEarn:0,refAcc:0,anonOn:false,anon:null,h:rnd(0,359)}))
    if(u[k]===undefined)u[k]=Array.isArray(v)?[]:v;
  return u;
}
const disp=u=>u.anonOn&&u.anon?{n:u.anon.name,av:u.anon.av,h:u.h}:{n:u.name||'Player',av:'',h:u.h};
const addTx=(u,e)=>{u.tx.push({ts:Date.now(),st:'ok',...e});if(u.tx.length>100)u.tx.splice(0,u.tx.length-100)};
const addHist=(uid,e)=>{const u=user(uid);u.hist.unshift({g:'duel',ts:Date.now(),...e});if(u.hist.length>HIST_MAX)u.hist.length=HIST_MAX};
const mkGift=(name,ico,val)=>({id:crypto.randomBytes(4).toString('hex'),name,ico,val,ts:Date.now()});
const stat=(u,k)=>k==='promos'?u.promos.length:k==='refs'?u.refs.length:u[k];

function verify(init){ // проверка подписи Telegram initData
  try{
    const p=new URLSearchParams(init),hash=p.get('hash');p.delete('hash');
    const s=[...p.entries()].map(([k,v])=>k+'='+v).sort().join('\n');
    const key=crypto.createHmac('sha256','WebAppData').update(TOKEN).digest();
    if(crypto.createHmac('sha256',key).update(s).digest('hex')!==hash)return null;
    if(Date.now()/1000-Number(p.get('auth_date'))>86400)return null;
    const u=JSON.parse(p.get('user'));u.start_param=p.get('start_param')||'';return u;
  }catch{return null}
}

// ---------- учёт сыгранной ставки (любая игра): оборот, PLAYBONUS, ранг, реферальный процент с комиссии
function play(uid,a,pay,win,rake){
  const u=user(uid);u.played++;u.turnover+=a;u.profit+=pay-a;u.pb+=a*RANKS[u.rank].rate;if(win)u.won++;
  const rf=u.ref&&users[u.ref];
  if(rf){rf.refAcc+=rake*REF_PCT;const w=Math.floor(rf.refAcc);if(w>0){rf.refAcc-=w;rf.bal+=w;rf.refEarn+=w}}
  rankUp(uid);
}
function rankUp(uid){
  const u=user(uid);
  while(u.rank<RANKS.length-1&&u.turnover>=RANKS[u.rank+1].min){
    const r=RANKS[++u.rank];
    if(r.bonus){u.bal+=r.bonus;addTx(u,{k:'rank',a:r.bonus,note:r.name})}
    if(r.gift)u.inv.push(mkGift('NFT Gift · '+r.name,'🎁',300));
    toUser(uid,{t:'notice',k:'rank_up',p:{r:r.name}});
  }
}

// ---------- боты: у каждой ставки новая личность (ник + аватар)
const NAMES=['Саша','Макс','Дима','Аня','Катя','Влад','Ярик','Оля','Тёма','Никита','Алекс','Лёха','Мила','Рома','Данил','Ксюша','Артём','Витя','Кирилл','Соня'];
const HANDLES=['gdeloka','tonlord','cryptoK','luckyjack','mr_gift','ShadowFox','bigwin777','dark_horse','hamster_pro','ice_king','fire_ball','nft_hunter','moon_boy','rich_tg','gift_dealer','UpMaster','rocket_man','to_the_moon','zero_fear','pixel','vortex','nova','kraken','stalker','rainbow','tonic','blitz','orbit','lucky_7','wolfie'];
const WORDS=['Ton','Gift','Up','Win','Boss','King','Pro','Fox','Max','Lord'];
const EMO=['🦊','🐼','🐸','🦁','🐯','🐵','🐙','🦄','🐲','🦅','🐺','🐧','🦉','🐢','🐬','🦈','🐝','🦋','🍀','⚡','🔥','❄️','🌙','⭐','🎯','🎲','👾','🤖','👽','💀','🎃','🌵','🍄','🍉','🚀','🛸','⚽','🏀','🎸','🧊'];
function botIdent(){
  const k=rnd(0,5);let n;
  if(k==0)n=pick(NAMES);else if(k==1)n=pick(NAMES)+rnd(1,99);else if(k==2)n=pick(HANDLES);
  else if(k==3)n=pick(HANDLES)+'_'+rnd(1,999);else if(k==4)n=pick(WORDS)+pick(WORDS)+rnd(10,99);else n=pick(NAMES)+' '+pick(['K.','S.','M.','D.','A.']);
  return{n,av:Math.random()<.7?pick(EMO):'',h:rnd(0,359)};
}
const botAmt=()=>pick([10,10,20,20,30,50,50,100,100,100,150,200,250,300,500,1000]);
const botId=()=>'bot'+crypto.randomBytes(4).toString('hex');

// ---------- Live: лента выигрышей (игроки и боты)
let live=[],liveId=0;
function pushLive(e){e.id=++liveId;e.ts=Date.now();live.unshift(e);if(live.length>LIVE_MAX)live.length=LIVE_MAX;bc({t:'live_add',e})}
const liveTon=(game,p,pay)=>pushLive({g:game,n:p.n,av:p.av,h:p.h,ico:'💎',amt:pay});

// ---------- Telegram Bot API (уведомления менеджеру и кнопки одобрения)
const h=s=>String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
async function tgApi(method,body,ms=15000){
  if(!TOKEN)return null;
  try{const r=await fetch('https://api.telegram.org/bot'+TOKEN+'/'+method,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(ms)});return await r.json()}catch{return null}
}
function adminNotify(q){
  if(!TOKEN||!ADMIN)return console.log('[заявка на вывод]',JSON.stringify(q));
  const who='Игрок: '+h(q.name)+' (<code>'+q.uid+'</code>)\n';
  const text=q.type==='gift'
    ?'🎁 <b>Вывод подарка</b> #'+q.id+'\n'+who+'Подарок: '+h(q.item.ico+' '+q.item.name)+'\nСообщение менеджеру: '+h(q.msg)
    :'💸 <b>Вывод TON</b> #'+q.id+'\n'+who+'Сумма: '+(q.a/100).toFixed(2)+' TON\nАдрес: <code>'+h(q.addr)+'</code>';
  tgApi('sendMessage',{chat_id:ADMIN,text,parse_mode:'HTML',reply_markup:{inline_keyboard:[[{text:'✅ Одобрить',callback_data:'ok:'+q.id},{text:'❌ Отклонить',callback_data:'no:'+q.id}]]}});
}
function resolve(id,ok){
  const q=reqs.find(x=>x.id===id);if(!q||q.st!=='pending')return null;
  q.st=ok?'done':'rejected';const u=users[q.uid];
  if(u){const tx=u.tx.find(x=>x.rid===id);if(tx)tx.st=q.st;if(!ok){if(q.type==='ton')u.bal+=q.a;else u.inv.push(q.item)}}
  saveU();saveR();
  toUser(q.uid,{t:'notice',k:ok?'req_ok':'req_no'});pushProfile(q.uid);
  tgApi('sendMessage',{chat_id:q.uid,text:(ok?'✅ Заявка #'+q.id+' одобрена / Request approved':'❌ Заявка #'+q.id+' отклонена, средства возвращены / Request rejected, refunded')});
  return q;
}
async function pollAdmin(){
  if(!TOKEN||!ADMIN)return;
  let off=0;
  for(;;){
    const r=await tgApi('getUpdates',{offset:off,timeout:25,allowed_updates:['callback_query']},40000);
    if(!r||!r.ok){await new Promise(s=>setTimeout(s,5000));continue}
    for(const up of r.result){
      off=up.update_id+1;const cq=up.callback_query;
      if(!cq||String(cq.from.id)!==String(ADMIN))continue;
      const [act,id]=String(cq.data||'').split(':'),q=(act==='ok'||act==='no')?resolve(id,act==='ok'):null;
      tgApi('answerCallbackQuery',{callback_query_id:cq.id,text:q?(act==='ok'?'Одобрено':'Отклонено'):'Уже обработана'});
      if(q&&cq.message)tgApi('editMessageReplyMarkup',{chat_id:cq.message.chat.id,message_id:cq.message.message_id,reply_markup:{inline_keyboard:[[{text:act==='ok'?'✅ Одобрено':'❌ Отклонено',callback_data:'x'}]]}});
    }
  }
}

// ---------- сеть
const srv=http.createServer((q,r)=>{
  r.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
  r.end(fs.readFileSync(path.join(__dirname,'public','index.html')));
});
const wss=new WebSocketServer({server:srv,maxPayload:4096});
const send=(c,m)=>c.readyState===1&&c.send(JSON.stringify(m));
const bc=m=>{const s=JSON.stringify(m);wss.clients.forEach(c=>c.readyState===1&&c.send(s))};
const toUser=(uid,m)=>wss.clients.forEach(c=>c.uid===uid&&send(c,m));
const err=(ws,k,p)=>send(ws,{t:'err',k,p}),note=(ws,k,p)=>send(ws,{t:'notice',k,p});
const sendBalTo=uid=>toUser(uid,{t:'bal',bal:users[uid].bal});

// ---------- Duel (Ice vs Fire)
let g={round:rounds.n,phase:'bet',endsAt:0,bets:[]};
const pools=()=>{let i=0,f=0;g.bets.forEach(b=>b.s==='i'?i+=b.a:f+=b.a);return{i,f}};
// uid других игроков клиентам не отправляется (иначе анонимность бессмысленна): только флаг m = «это вы»
const viewFor=ws=>({t:'state',round:g.round,phase:g.phase,endsAt:g.endsAt,bets:g.bets.map(b=>({m:b.uid===ws.uid,n:b.n,av:b.av,h:b.h,s:b.s,a:b.a}))});
const bcState=()=>wss.clients.forEach(c=>send(c,viewFor(c)));
const roundsFor=ws=>({t:'rounds',list:rounds.list.map(r=>({...r,players:r.players.map(({uid,...x})=>({...x,m:uid===ws.uid}))}))});

function profile(ws){
  const u=user(ws.uid),rf=BOT?'https://t.me/'+BOT+(APP?'/'+APP:'')+'?startapp=ref_'+ws.uid:'';
  return{t:'profile',name:u.name||ws.name,uid:ws.uid,h:u.h,bal:u.bal,played:u.played,won:u.won,profit:u.profit,turnover:u.turnover,
    rank:u.rank,ranks:RANKS_PUB,pb:u.pb,pbOk:u.rank>=PB_MIN,anonOn:u.anonOn,anon:u.anon,
    hist:u.hist,inv:u.inv,tx:u.tx.slice(-15).reverse(),wallet:WALLET,minWd:MIN_WD,
    ref:{link:rf,code:'ref_'+ws.uid,count:u.refs.length,earn:u.refEarn,pct:REF_PCT*100},
    quests:QUESTS.map(q=>({id:q.id,title:q.title,goal:q.goal,reward:q.reward,prog:Math.min(stat(u,q.stat),q.goal),claimed:u.claimed.includes(q.id)}))};
}
function pushProfile(uid){wss.clients.forEach(c=>{if(c.uid===uid){send(c,{t:'bal',bal:user(uid).bal});send(c,profile(c))}})}
function sendBal(){wss.clients.forEach(c=>c.uid&&send(c,{t:'bal',bal:users[c.uid].bal}))}
function sendTop(ws){
  const list=Object.entries(users).filter(([,u])=>u.profit>0).sort((a,b)=>b[1].profit-a[1].profit).slice(0,10)
    .map(([id,u])=>({...disp(u),v:u.profit,m:id===ws.uid}));
  send(ws,{t:'top',list});
}

function sim(bx){ // физика шарика считается один раз, на сервере
  const a=Math.random()*6.283,sp=13+Math.random()*3;
  let x=160,y=160,vx=Math.cos(a)*sp,vy=Math.sin(a)*sp;const path=[[x,y]];
  while(Math.hypot(vx,vy)>.12&&path.length<1800){
    x+=vx;y+=vy;const dx=x-160,dy=y-160,d=Math.hypot(dx,dy);
    if(d>R-BR){
      const nx=dx/d,ny=dy/d,dot=vx*nx+vy*ny;vx-=2*dot*nx;vy-=2*dot*ny;
      const k=(Math.random()-.5)*.4,c=Math.cos(k),s=Math.sin(k);[vx,vy]=[vx*c-vy*s,vx*s+vy*c];
      x=160+nx*(R-BR);y=160+ny*(R-BR);
    }
    vx*=.992;vy*=.992;path.push([+x.toFixed(1),+y.toFixed(1)]);
  }
  return{path,win:x<bx?'i':'f'};
}
function duelBots(){ // 2–6 ботов в течение окна ставок; первые два всегда на разных командах
  const n=rnd(2,6),round=g.round;
  for(let i=0;i<n;i++)setTimeout(()=>{
    if(g.round!==round||g.phase!=='bet')return;
    const id=botIdent();g.bets.push({bot:1,uid:botId(),n:id.n,av:id.av,h:id.h,s:i==0?'i':i==1?'f':pick(['i','f']),a:botAmt()});bcState();
  },600+Math.random()*(BET_MS-3500));
}
function startRound(){
  g={round:++rounds.n,phase:'bet',endsAt:Date.now()+BET_MS,bets:[]};saveRd();
  bcState();if(BOTS)duelBots();setTimeout(lock,BET_MS);
}
function lock(){
  const p=pools();
  if(!g.bets.length)return startRound();
  if(!p.i||!p.f){ // нет соперника: возврат ставок
    const seen={};
    g.bets.forEach(b=>{if(b.bot)return;users[b.uid].bal+=b.a;seen[b.uid]=seen[b.uid]||{s:b.s,a:0};seen[b.uid].a+=b.a});
    Object.entries(seen).forEach(([uid,x])=>addHist(uid,{r:g.round,s:x.s,a:x.a,pay:x.a,res:'refund'}));
    saveU();bc({t:'notice',k:'refund'});sendBal();return startRound();
  }
  const bx=160-R+2*R*p.i/(p.i+p.f),r=sim(bx);g.phase='spin';
  bc({t:'spin',path:r.path,win:r.win,bx});
  setTimeout(()=>settle(r.win),r.path.length*1000/60+1500);
}
function settle(win){
  const p=pools(),pool=p.i+p.f,wp=p[win],prize=Math.floor(pool*(1-RAKE)),rake=pool-prize,pl={};
  g.bets.forEach(b=>{const x=pl[b.uid]=pl[b.uid]||{uid:b.uid,bot:b.bot,n:b.n,av:b.av,h:b.h,s:b.s,a:0,pay:0};x.a+=b.a});
  g.bets.filter(b=>b.s===win).forEach(b=>{const x=Math.floor(prize*b.a/wp);pl[b.uid].pay+=x;if(!b.bot)users[b.uid].bal+=x});
  const list=Object.values(pl);
  list.forEach(x=>{
    if(x.pay>0)liveTon('duel',x,x.pay); // в Live попадают выигрыши и игроков, и ботов
    if(x.bot)return;
    addHist(x.uid,{r:g.round,s:x.s,a:x.a,pay:x.pay,res:x.pay>0?'win':'lose',win});
    play(x.uid,x.a,x.pay,x.pay>0,rake*x.a/pool);
  });
  rounds.list.unshift({r:g.round,ts:Date.now(),win,pool,prize,ci:p.i/pool,cf:p.f/pool,gifts:0,players:list.map(({bot,...x})=>x)});
  if(rounds.list.length>ROUNDS_MAX)rounds.list.length=ROUNDS_MAX;
  saveU();saveRd();g.phase='res';
  wss.clients.forEach(c=>{if(!c.uid)return;send(c,{t:'result',win,pay:pl[c.uid]?pl[c.uid].pay:0,bal:users[c.uid].bal});send(c,roundsFor(c))});
  bcState();setTimeout(startRound,5000);
}

// ---------- Ракетка (crash)
let rk={phase:'bet',id:rounds.rk||0,endsAt:0,start:0,crash:0,bets:[]},rkHist=[],rkTimer=null;
const mAt=ms=>Math.floor(Math.exp(RK_K*Math.max(0,ms)/1000)*100)/100;
const genCrash=()=>Math.min(1000,Math.max(1,Math.floor(95/(1-Math.random()))/100)); // шанс дожить до x: 0.95/x
const rkView=ws=>({t:'rk',phase:rk.phase,id:rk.id,endsAt:rk.endsAt,start:rk.start,k:RK_K,now:Date.now(),crash:rk.phase==='crash'?rk.crash:0,hist:rkHist,
  bets:rk.bets.map(b=>({m:b.uid===ws.uid,n:b.n,av:b.av,h:b.h,a:b.a,x:b.cash,pay:b.pay,auto:b.uid===ws.uid?b.auto:0}))});
const bcRk=()=>wss.clients.forEach(c=>send(c,rkView(c)));
function rkStart(){
  rk={phase:'bet',id:++rounds.rk,endsAt:Date.now()+RK_BET,start:0,crash:0,bets:[]};saveRd();
  bcRk();
  if(BOTS){const n=rnd(3,8),id=rk.id;for(let i=0;i<n;i++)setTimeout(()=>{
    if(rk.id!==id||rk.phase!=='bet')return;
    const r=Math.random(),tgt=r<.4?rnd(110,180)/100:r<.7?rnd(180,300)/100:r<.9?rnd(300,800)/100:rnd(800,3000)/100,ident=botIdent();
    rk.bets.push({bot:1,uid:botId(),n:ident.n,av:ident.av,h:ident.h,a:botAmt(),auto:0,tgt,cash:0,pay:0});bcRk();
  },300+Math.random()*(RK_BET-1800))}
  setTimeout(rkFly,RK_BET);
}
function rkFly(){
  if(!rk.bets.length)return rkStart();
  rk.crash=genCrash();rk.phase='fly';rk.start=Date.now();bcRk();
  rkTimer=setInterval(rkTick,50);
}
function rkCash(b,x){ // x — множитель, по которому забрана ставка
  b.cash=x;b.pay=Math.floor(b.a*x);
  if(!b.bot){
    const u=user(b.uid);u.bal+=b.pay;
    addHist(b.uid,{g:'rk',r:rk.id,a:b.a,pay:b.pay,res:'win',x});
    play(b.uid,b.a,b.pay,b.pay>b.a,b.a*RAKE);saveU();sendBalTo(b.uid);
  }
  liveTon('rk',b,b.pay);bcRk();
}
function rkTick(){
  const x=mAt(Date.now()-rk.start);
  for(const b of rk.bets){const lim=b.bot?b.tgt:b.auto;if(!b.cash&&lim&&lim<=x&&lim<rk.crash)rkCash(b,lim)}
  if(x>=rk.crash)rkCrash();
}
function rkCrash(){
  clearInterval(rkTimer);rk.phase='crash';
  rk.bets.forEach(b=>{if(b.cash||b.bot)return;
    addHist(b.uid,{g:'rk',r:rk.id,a:b.a,pay:0,res:'lose',x:rk.crash});play(b.uid,b.a,0,false,b.a*RAKE)});
  rkHist.unshift(rk.crash);if(rkHist.length>14)rkHist.length=14;
  saveU();bcRk();setTimeout(rkStart,RK_CRASH);
}

// ---------- UpGift: донор(ы) + цель, шанс = цена доноров / цена цели × (1 − комиссия)
const upBusy=new Set();
const upChance=(val,tg)=>val/tg.val*(1-UP_FEE);
function botUpgrade(){ // бот делает апгрейд с теми же шансами; в Live попадают только успехи
  const tg=pick(CATALOG.slice(1)),val=Math.max(10,Math.floor(tg.val*(rnd(15,70)/100))),id=botIdent();
  if(Math.random()<upChance(val,tg))pushLive({g:'up',n:id.n,av:id.av,h:id.h,ico:tg.ico,name:tg.name});
}
function upRun(ws,u,m){
  if(upBusy.has(ws.uid))return err(ws,'up_busy');
  const ids=Array.isArray(m.donors)?[...new Set(m.donors.map(String))].slice(0,30):[],items=ids.map(id=>u.inv.find(x=>x.id===id));
  if(items.some(x=>!x))return err(ws,'no_item');
  const ton=Math.round(Number(m.ton||0)*100);
  if(!Number.isFinite(ton)||ton<0)return err(ws,'min_bet');
  if(ton>u.bal)return err(ws,'no_funds');
  const val=items.reduce((s,x)=>s+x.val,0)+ton;
  if(val<10)return err(ws,'up_min');
  const tg=CATALOG.find(x=>x.id===m.target);if(!tg)return err(ws,'no_item');
  if(tg.val<=val)return err(ws,'up_target_low');
  const chance=upChance(val,tg);if(chance<.01)return err(ws,'up_chance_low');
  const roll=Math.random(),ok=roll<chance,d=disp(u),uid=ws.uid;
  u.inv=u.inv.filter(x=>!ids.includes(x.id));u.bal-=ton;upBusy.add(uid);saveU();
  send(ws,{t:'bal',bal:u.bal});send(ws,{t:'up_start',ok,roll,chance,target:tg,ms:UP_MS});
  setTimeout(()=>{ // результат зачисляется после анимации
    upBusy.delete(uid);
    if(ok){u.inv.push(mkGift(tg.name,tg.ico,tg.val));pushLive({g:'up',n:d.n,av:d.av,h:d.h,ico:tg.ico,name:tg.name})}
    addHist(uid,{g:'up',r:0,a:val,pay:ok?tg.val:0,res:ok?'win':'lose',item:tg.ico+' '+tg.name,chance});
    play(uid,val,ok?tg.val:0,ok,val*UP_FEE);saveU();
    toUser(uid,{t:'up_end',ok,target:tg});pushProfile(uid);
  },UP_MS);
}

// ---------- сообщения клиентов
wss.on('connection',ws=>{
  ws.on('message',raw=>{
    let m;try{m=JSON.parse(raw)}catch{return}
    if(!m||typeof m!=='object')return;
    if(m.t==='auth'){
      let u=null;
      if(m.init&&TOKEN)u=verify(m.init);
      else if(DEV&&m.dev){u={id:'dev'+String(m.dev).slice(0,20),first_name:String(m.dev).slice(0,12),start_param:String(m.ref||'')}}
      if(!u)return err(ws,'auth');
      ws.uid=String(u.id);ws.name=String(u.first_name||'Player').slice(0,32);
      const isNew=!users[ws.uid],usr=user(ws.uid,ws.name);
      const rid=String(u.start_param||'').startsWith('ref_')?String(u.start_param).slice(4):'';
      if(isNew&&rid&&rid!==ws.uid&&users[rid]){ // реферальная привязка только для нового игрока
        usr.ref=rid;users[rid].refs.push(ws.uid);toUser(rid,{t:'notice',k:'friend_joined'});
      }
      saveU();
      send(ws,{t:'cfg',catalog:CATALOG,upFee:UP_FEE});
      send(ws,{t:'me',uid:ws.uid,bal:usr.bal});send(ws,{t:'live',list:live});
      send(ws,viewFor(ws));send(ws,rkView(ws));return send(ws,roundsFor(ws));
    }
    if(!ws.uid)return;
    const u=user(ws.uid);
    switch(m.t){
    case 'bet':{
      const a=Math.round(Number(m.a)*100),s=m.s;
      if(g.phase!=='bet')return err(ws,'closed');
      if(!(s==='i'||s==='f')||!Number.isFinite(a)||a<10)return err(ws,'min_bet');
      if(a>u.bal)return err(ws,'no_funds');
      if(g.bets.some(b=>b.uid===ws.uid&&b.s!==s))return err(ws,'other_team');
      const d=disp(u);u.bal-=a;saveU();g.bets.push({uid:ws.uid,n:d.n,av:d.av,h:d.h,s,a});
      send(ws,{t:'bal',bal:u.bal});bcState();break}
    case 'rk_bet':{
      const a=Math.round(Number(m.a)*100);let auto=Number(m.auto)||0;
      if(rk.phase!=='bet')return err(ws,'rk_closed');
      if(!Number.isFinite(a)||a<10)return err(ws,'min_bet');
      if(a>u.bal)return err(ws,'no_funds');
      if(rk.bets.some(b=>b.uid===ws.uid))return err(ws,'rk_already');
      auto=auto>=1.01?Math.min(1000,Math.floor(auto*100)/100):0;
      const d=disp(u);u.bal-=a;saveU();rk.bets.push({uid:ws.uid,n:d.n,av:d.av,h:d.h,a,auto,cash:0,pay:0});
      send(ws,{t:'bal',bal:u.bal});bcRk();break}
    case 'rk_cash':{
      const b=rk.bets.find(x=>x.uid===ws.uid&&!x.cash);
      if(!b||rk.phase!=='fly')return err(ws,'rk_late');
      const x=mAt(Date.now()-rk.start);
      if(x>=rk.crash)return err(ws,'rk_late'); // ракета уже улетела
      rkCash(b,x);break}
    case 'up':upRun(ws,u,m);break;
    case 'profile':send(ws,profile(ws));break;
    case 'rounds':send(ws,roundsFor(ws));break;
    case 'top':sendTop(ws);break;
    case 'promo':{
      const code=String(m.code||'').trim().toUpperCase().slice(0,32);
      if(!code)return err(ws,'promo_empty');
      const pt=ptry[ws.uid]=ptry[ws.uid]&&Date.now()-ptry[ws.uid].t<3600e3?ptry[ws.uid]:{n:0,t:Date.now()};
      if(pt.n>=10)return err(ws,'promo_many');
      const pr=Object.prototype.hasOwnProperty.call(PROMOS,code)?PROMOS[code]:null;
      if(!pr){pt.n++;return err(ws,'promo_bad')}
      const list=used[code]=used[code]||[];
      if(list.includes(ws.uid))return err(ws,'promo_used');
      if(pr.max&&list.length>=pr.max)return err(ws,'promo_gone');
      list.push(ws.uid);saveP();u.promos.push(code);u.bal+=pr.r;addTx(u,{k:'promo',a:pr.r,note:code});saveU();
      note(ws,'promo_ok',{a:pr.r});pushProfile(ws.uid);break}
    case 'claim':{
      const q=QUESTS.find(x=>x.id===m.id);if(!q)return;
      if(u.claimed.includes(q.id))return err(ws,'quest_claimed');
      if(stat(u,q.stat)<q.goal)return err(ws,'quest_not_done');
      u.claimed.push(q.id);u.bal+=q.reward;addTx(u,{k:'quest',a:q.reward,note:q.title});saveU();
      note(ws,'reward',{a:q.reward});pushProfile(ws.uid);break}
    case 'pbclaim':{
      if(u.rank<PB_MIN)return err(ws,'pb_locked');
      const a=Math.floor(u.pb);if(a<1)return err(ws,'pb_empty');
      u.pb-=a;u.bal+=a;addTx(u,{k:'pb',a});saveU();note(ws,'pb_ok',{a});pushProfile(ws.uid);break}
    case 'anon':{
      if(g.phase!=='bet'||g.bets.some(b=>b.uid===ws.uid)||rk.bets.some(b=>b.uid===ws.uid))return err(ws,'anon_locked');
      u.anonOn=!!m.on;if(u.anonOn&&!u.anon)u.anon=mkAlias(); // псевдоним создаётся один раз и не меняется
      saveU();note(ws,u.anonOn?'anon_on':'anon_off');send(ws,profile(ws));break}
    case 'withdraw':{
      const a=Math.round(Number(m.a)*100),addr=String(m.addr||'').trim();
      if(!/^[A-Za-z0-9_-]{48}$/.test(addr))return err(ws,'addr_bad');
      if(!Number.isFinite(a)||a<MIN_WD)return err(ws,'min_wd',{a:MIN_WD});
      if((g.phase!=='res'&&g.bets.some(b=>b.uid===ws.uid))||rk.bets.some(b=>b.uid===ws.uid&&rk.phase!=='crash'))return err(ws,'wait_round');
      if(a>u.bal)return err(ws,'no_funds');
      u.bal-=a;const q={id:crypto.randomBytes(4).toString('hex'),uid:ws.uid,name:u.name||'',ts:Date.now(),st:'pending',type:'ton',a,addr};
      reqs.push(q);addTx(u,{k:'withdraw',a,note:addr,st:'pending',rid:q.id});saveU();saveR();adminNotify(q);
      note(ws,'wd_created');pushProfile(ws.uid);break}
    case 'sell':{
      const i=u.inv.findIndex(x=>x.id===m.id);if(i<0)return err(ws,'no_item');
      const it=u.inv.splice(i,1)[0];u.bal+=it.val;addTx(u,{k:'sell',a:it.val,note:it.name});saveU();
      note(ws,'gift_sold',{a:it.val});pushProfile(ws.uid);break}
    case 'giftwd':{
      const msg=String(m.msg||'').trim().slice(0,300);
      if(msg.length<2)return err(ws,'msg_short');
      const i=u.inv.findIndex(x=>x.id===m.id);if(i<0)return err(ws,'no_item');
      const it=u.inv.splice(i,1)[0],q={id:crypto.randomBytes(4).toString('hex'),uid:ws.uid,name:u.name||'',ts:Date.now(),st:'pending',type:'gift',item:it,msg};
      reqs.push(q);addTx(u,{k:'giftwd',a:0,note:it.name,st:'pending',rid:q.id});saveU();saveR();adminNotify(q);
      note(ws,'gift_req');pushProfile(ws.uid);break}
    }
  });
});
srv.listen(PORT,()=>{
  console.log('TON Duel on :'+PORT+(BOTS?' (боты включены)':' (боты выключены)'));
  startRound();rkStart();pollAdmin();
  if(BOTS)(function loop(){setTimeout(()=>{botUpgrade();loop()},rnd(12,35)*1000)})();
});
