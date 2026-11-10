(() => {
  'use strict';
  const DAYS = ['mon','tue','wed','thu','fri','sat'];
  const DAY_LONG = ['monday','tuesday','wednesday','thursday','friday','saturday'];
  const MONTHS = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
  const LOCAL_KEY = 'tenaweek.v2';

  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const pad = n => String(n).padStart(2,'0');
  const icon = (id, s='') => `<svg class="i" ${s?`style="${s}"`:''}><use href="#i-${id}"/></svg>`;
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random()*16|0; return (c==='x'?r:(r&3|8)).toString(16); }));
  const safeUrl = u => /^https?:\/\//i.test((u||'').trim()) ? u.trim() : '';

  /* ---------- dates ---------- */
  const startOfWeek = d => { const x = new Date(d); x.setHours(0,0,0,0); x.setDate(x.getDate() - (x.getDay()+6)%7); return x; };
  const ymd = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  const addDays = (d,n) => { const x = new Date(d); x.setDate(x.getDate()+n); return x; };
  const thisMonday = () => startOfWeek(new Date());
  let viewMonday = thisMonday();
  const dayKey = i => ymd(addDays(viewMonday, i));

  function weekPhase(){
    const cur = thisMonday().getTime(), v = viewMonday.getTime();
    if (v < cur) return { kind:'past', todayIdx:-1, daysIn:6 };
    if (v > cur) return { kind:'future', todayIdx:-1, daysIn:0 };
    const wd = (new Date().getDay()+6)%7;
    if (wd === 6) return { kind:'sunday', todayIdx:-1, daysIn:6 };
    return { kind:'current', todayIdx:wd, daysIn:wd+1 };
  }
  const isNow = ph => ph.kind==='current' || ph.kind==='sunday';

  /* ---------- data store: Supabase when configured, else this browser ---------- */
  const CFG = window.TEN_CONFIG || {};
  const remote = !!(CFG.supabaseUrl && CFG.supabaseAnonKey && window.supabase);
  const db = remote ? window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey) : null;

  // data.videos holds the viewed week (remote) or everything (local)
  let data = { target: 10, people: [], videos: [] };

  function loadLocal(){
    let s = null;
    try { s = JSON.parse(localStorage.getItem(LOCAL_KEY) || 'null'); } catch {}
    if (!s) { // migrate the first version (daily counts) if present
      try {
        const old = JSON.parse(localStorage.getItem('tenaweek.v1') || 'null');
        if (old && Array.isArray(old.people)) {
          s = { target: old.target || 10, people: old.people.map(p => ({ id:p.id, name:p.name, active:true, created_at:new Date().toISOString() })), videos: [] };
          for (const [wk, byPerson] of Object.entries(old.logs || {})) {
            const mon = new Date(wk + 'T00:00:00');
            for (const [pid, arr] of Object.entries(byPerson))
              arr.forEach((n, i) => { for (let k=0;k<n;k++) s.videos.push({ id:uuid(), person_id:pid, day:ymd(addDays(mon,i)), link:null, created_at:new Date().toISOString() }); });
          }
        }
      } catch {}
    }
    data = Object.assign({ target:10, people:[], videos:[] }, s || {});
  }
  const saveLocal = () => { if (!remote) try { localStorage.setItem(LOCAL_KEY, JSON.stringify(data)); } catch {} };

  async function loadRemote(){
    const from = dayKey(0), to = dayKey(5);
    const [p, s, v] = await Promise.all([
      db.from('people').select('*').eq('active', true).order('created_at'),
      db.from('settings').select('value').eq('key','target').maybeSingle(),
      db.from('videos').select('*').gte('day', from).lte('day', to).order('created_at'),
    ]);
    const err = p.error || s.error || v.error;
    if (err) throw err;
    data = { target: Number(s.data?.value) || 10, people: p.data, videos: v.data };
  }

  async function load(){
    if (!remote) { loadLocal(); setSync('local'); return; }
    try { await loadRemote(); setSync('live'); }
    catch (e) { console.error(e); setSync('err'); }
  }

  // apply a change on screen right away, then save it; reload if saving fails
  async function mutate(localFn, remoteFn){
    localFn(data);
    render();
    if (!remote) { saveLocal(); return; }
    const { error } = await remoteFn();
    if (error) { console.error(error); setSync('err'); toast('couldn’t save. check your internet and try again.'); await load(); render(); }
  }

  const people = () => data.people.filter(p => p.active !== false);
  const weekVideos = () => { const a = dayKey(0), b = dayKey(5); return data.videos.filter(v => v.day >= a && v.day <= b); };
  const videosOf = (pid, i) => data.videos.filter(v => v.person_id === pid && v.day === dayKey(i));
  const totalOf = pid => weekVideos().filter(v => v.person_id === pid).length;

  const ops = {
    addVideo(pid, i){
      const v = { id: uuid(), person_id: pid, day: dayKey(i), link: null, created_at: new Date().toISOString() };
      mutate(d => d.videos.push(v), () => db.from('videos').insert({ id:v.id, person_id:pid, day:v.day }));
      return v;
    },
    restoreVideo(v){ mutate(d => d.videos.push(v), () => db.from('videos').insert({ id:v.id, person_id:v.person_id, day:v.day, link:v.link })); },
    removeVideo(id){ mutate(d => { d.videos = d.videos.filter(v => v.id !== id); }, () => db.from('videos').delete().eq('id', id)); },
    setLink(id, link){
      mutate(d => { const v = d.videos.find(x => x.id === id); if (v) v.link = link || null; }, () => db.from('videos').update({ link: link || null }).eq('id', id));
    },
    addPerson(name){
      const p = { id: uuid(), name, active: true, created_at: new Date().toISOString() };
      mutate(d => d.people.push(p), () => db.from('people').insert({ id:p.id, name }));
    },
    renamePerson(id, name){ mutate(d => { const p = d.people.find(x=>x.id===id); if (p) p.name = name; }, () => db.from('people').update({ name }).eq('id', id)); },
    setActive(id, active){ mutate(d => { const p = d.people.find(x=>x.id===id); if (p) p.active = active; }, () => db.from('people').update({ active }).eq('id', id)); },
    setTarget(n){ mutate(d => { d.target = n; }, () => db.from('settings').upsert({ key:'target', value:n })); },
  };

  /* ---------- live updates ---------- */
  let reloadTimer;
  function scheduleReload(){
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(async () => {
      await load();
      if (document.activeElement && document.activeElement.matches('dialog input')) return; // don't disturb typing
      render();
      if ($('#dayDlg').open) renderDay();
      if ($('#teamDlg').open) renderMembers();
    }, 400);
  }
  if (remote) {
    db.channel('ten-a-week')
      .on('postgres_changes', { event:'*', schema:'public' }, scheduleReload)
      .subscribe(status => { if (status === 'SUBSCRIBED') setSync('live'); });
    window.addEventListener('focus', scheduleReload);
  }

  function setSync(mode){
    const el = $('#sync');
    el.className = 'sync ' + (mode==='live' ? 'live' : mode==='err' ? 'err' : '');
    el.querySelector('span').textContent = mode==='live' ? 'live, shared with the team' : mode==='err' ? 'offline, retrying' : 'saved in this browser only';
  }

  /* ---------- status logic ---------- */
  function statusFor(total){
    const T = data.target, ph = weekPhase();
    const left = Math.max(0, T-total);
    if (total >= T) return { g:'done', badge:'target hit', msg: total > T ? `${total-T} extra on top of the target. amazing.` : 'all done for this week. great job.' };
    if (ph.kind === 'future') return { g:'none', badge:'not started', msg:'this week hasn’t started yet.' };
    if (!isNow(ph) || ph.kind === 'sunday') return { g:'behind', badge:`missed by ${left}`, msg:`finished the week with ${total} of ${T} videos.` };
    const byToday = Math.floor(T * ph.daysIn / 6);
    const byYesterday = Math.floor(T * (ph.daysIn-1) / 6);
    const perDay = Math.ceil(left / (6 - ph.todayIdx));
    if (total >= byToday) return { g: total === 0 ? 'none':'track', badge:'on track', msg:`${left} more to go. keep this pace.` };
    if (total >= byYesterday) return { g: total === 0 ? 'none':'push', badge:`make ${byToday-total} today`, msg:`make ${byToday-total} today to stay on track.` };
    return { g:'behind', badge:`behind by ${byToday-total}`, msg:`needs about ${perDay} a day until saturday to catch up.` };
  }

  /* ---------- render ---------- */
  const weekRange = () => {
    const sat = addDays(viewMonday,5), m1 = MONTHS[viewMonday.getMonth()], m2 = MONTHS[sat.getMonth()];
    return m1 === m2 ? `${viewMonday.getDate()}–${sat.getDate()} ${m2}` : `${viewMonday.getDate()} ${m1} – ${sat.getDate()} ${m2}`;
  };
  const dotsHTML = () => { const ph = weekPhase(); return `<div class="dots" title="days of the week">${DAYS.map((d,i)=>`<i class="${i===ph.todayIdx?'now':i<ph.daysIn?'on':''}"></i>`).join('')}</div>`; };
  const barHTML = () => `<div class="bar"><svg class="logo"><use href="#i-logo"/></svg><div class="r">${dotsHTML()}<button class="menu" data-open-team aria-label="team">${icon('menu')}</button></div></div>`;
  const sideHTML = (txt, ic='user') => `<div class="side">${icon(ic)}<span>${txt}</span></div>`;
  const footHTML = txt => `<div class="foot">${txt}</div>`;

  function renderNav(){
    const ph = weekPhase();
    const tag = isNow(ph) ? 'this week' : ph.kind==='past' ? 'past week' : 'upcoming week';
    $('#weekLabel').innerHTML = `<b>${tag}</b>${weekRange()}`;
    $('#thisWeek').hidden = isNow(ph);
  }

  function introScreen(){
    return `<section class="screen intro">
      <div class="bg g-team"></div>
      <div class="body">
        ${barHTML()}
        <h2 class="title">let’s start</h2>
        <p class="sub">a simple way to see who made their videos this week.</p>
        <div class="center">
          <h2>who’s on<br>the team?</h2>
          <p>add each person’s name. you can add more later.</p>
          <div class="field"><input id="newName" placeholder="type a name" maxlength="40"><button id="addBtn">${icon('plus','width:15px;height:15px')}add</button></div>
          <div class="steps">
            <div><b>01</b>find your name.</div>
            <div><b>02</b>made a video? tap the black plus next to today.</div>
            <div><b>03</b>fill all ${data.target} boxes by saturday.</div>
          </div>
        </div>
      </div>
      ${footHTML('ten a week')}
    </section>`;
  }

  function teamScreen(totals){
    const T = data.target, n = totals.length;
    const team = totals.reduce((s,x)=>s+x.t,0), goal = T * n;
    const done = totals.filter(x=>x.t>=T).length;
    const behind = totals.filter(x=>statusFor(x.t).g==='behind').length;
    const ph = weekPhase();
    let line;
    if (team >= goal) line = 'the whole team hit the target. amazing.';
    else if (ph.kind==='future') line = 'a fresh week is coming up.';
    else if (behind === 0) line = 'everyone is on track. keep it up.';
    else line = behind === 1 ? '1 person needs a little push.' : `${behind} people need a little push.`;
    return `<section class="screen">
      <div class="bg g-team"></div>
      <div class="body">
        ${barHTML()}
        ${sideHTML('the whole team','team')}
        <h2 class="title">${isNow(ph) ? 'this week' : 'that week'}</h2>
        <p class="sub">${esc(line)}</p>
        <div class="bands">
          <div class="band"><span class="num">${team}</span><span class="lbl">videos made<br>out of ${goal}</span></div>
          <div class="band b2"><span class="num">${pad(done)}</span><span class="lbl">${done===1?'person':'people'} done<br>out of ${n}</span></div>
          <div class="band b3"><span class="num">${goal?Math.round(Math.min(1,team/goal)*100):0}</span><span class="lbl">percent of<br>the team goal</span></div>
        </div>
      </div>
      ${footHTML(weekRange())}
    </section>`;
  }

  function hitsScreen(totals){
    const ranked = totals.slice().sort((a,b)=>b.t-a.t).slice(0,3);
    return `<section class="screen">
      <div class="bg g-hits"></div>
      <div class="body">
        ${barHTML()}
        ${sideHTML('top makers','user')}
        <h2 class="title">top makers</h2>
        <p class="sub">the people with the most videos so far this week.</p>
        <div class="hits">
          ${ranked.map((x,i)=>`<div class="hit${i===1?' alt':''}"><span class="n">${pad(i+1)}</span><span class="ln"></span><span class="who">${esc(x.p.name)}<small>${x.t} ${x.t===1?'video':'videos'}</small></span></div>`).join('')}
        </div>
      </div>
      ${footHTML('ranked by videos made')}
    </section>`;
  }

  let lastPop = null;
  function personScreen(p){
    const T = data.target, total = totalOf(p.id), st = statusFor(total), ph = weekPhase();
    const n = Math.max(T, 1), cols = n > 10 ? Math.ceil(n/2) : n;
    const boxes = Array.from({length:n}, (_,i)=>{
      let cls = i < total ? 'f' : '';
      if (lastPop && lastPop.id===p.id && i===lastPop.total-1) cls += ' pop';
      return `<i class="${cls}"></i>`;
    }).join('');
    const days = DAYS.map((d,i)=>{
      const vids = videosOf(p.id, i), c = vids.length, links = vids.filter(v=>safeUrl(v.link)).length;
      const locked = ph.kind==='future' || (ph.kind==='current' && i>ph.todayIdx);
      const today = i===ph.todayIdx;
      return `<div class="day${today?' today':''}${locked?' locked':''}">
        <span class="dn">${today?'today':d}</span><span class="ln"></span>
        <button class="dv" data-act="open" data-id="${p.id}" data-day="${i}" aria-label="see ${d} videos and drive links" title="see videos and drive links">${links?icon('link'):''}${c}</button>
        <button class="b minus" data-act="minus" data-id="${p.id}" data-day="${i}" aria-label="remove one video on ${d}" ${c===0||locked?'disabled':''}>${icon('minus')}</button>
        <button class="b plus" data-act="plus" data-id="${p.id}" data-day="${i}" aria-label="add one video for ${esc(p.name)} on ${d}" ${locked?'disabled':''}>${icon('plus')}</button>
      </div>`;
    }).join('');
    const rings = st.g==='done' ? `<div class="rings"><i style="width:240px;height:240px;left:-60px;top:150px"></i><i style="width:200px;height:200px;right:-50px;top:250px"></i><i style="width:160px;height:160px;left:60px;top:380px"></i></div>` : '';
    return `<section class="screen">
      <div class="bg g-${st.g}"></div>${rings}
      <div class="body">
        ${barHTML()}
        ${sideHTML('videos this week','user')}
        <h2 class="title">${esc(p.name)}</h2>
        <p class="sub">${esc(st.msg)}</p>
        <div class="count"><span class="num">${pad(total)}</span><span class="lbl">of ${T}<br>videos</span></div>
        <div class="boxes" style="grid-template-columns:repeat(${cols},1fr)">${boxes}</div>
        <div class="hint-s">each dark box is one video made${total>n?`, plus ${total-n} extra`:''}. tap a number to add drive links.</div>
        <div class="days">${days}</div>
      </div>
      ${footHTML(`<span class="badge"><i></i>${esc(st.badge)}</span>`)}
    </section>`;
  }

  function render(){
    renderNav();
    const el = $('#screens'), ps = people();
    if (!ps.length){
      el.innerHTML = introScreen();
      const inp = $('#newName');
      const go = () => { const v = inp.value.trim(); if (v) ops.addPerson(v); };
      $('#addBtn').onclick = go;
      inp.onkeydown = e => { if (e.key==='Enter') go(); };
    } else {
      const totals = ps.map(p => ({ p, t: totalOf(p.id) }));
      el.innerHTML = teamScreen(totals) + hitsScreen(totals) + ps.map(personScreen).join('');
    }
    lastPop = null;
  }

  /* ---------- toast ---------- */
  let undoFn = null, linkFn = null, toastTimer;
  function toast(msg, undo, link){
    $('#toastMsg').textContent = msg;
    undoFn = undo || null; linkFn = link || null;
    $('#undoBtn').hidden = !undo;
    $('#linkBtn').hidden = !link;
    $('#toast').classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(()=>$('#toast').classList.remove('show'), link ? 6000 : 3500);
  }
  const hideToast = () => $('#toast').classList.remove('show');
  $('#undoBtn').onclick = () => { if (undoFn) undoFn(); undoFn = null; hideToast(); };
  $('#linkBtn').onclick = () => { if (linkFn) linkFn(); linkFn = null; hideToast(); };

  /* ---------- clicks on the screens ---------- */
  $('#screens').addEventListener('click', e => {
    if (e.target.closest('[data-open-team]')) return openTeam();
    const b = e.target.closest('button[data-act]');
    if (!b || b.disabled) return;
    const pid = b.dataset.id, day = +b.dataset.day;
    const p = data.people.find(x=>x.id===pid);
    if (!p) return;
    if (b.dataset.act === 'open') return openDay(pid, day);
    if (b.dataset.act === 'plus'){
      const v = ops.addVideo(pid, day);
      lastPop = { id: pid, total: totalOf(pid) }; render();
      toast(`one more video for ${p.name}`, () => ops.removeVideo(v.id), () => openDay(pid, day, v.id));
    } else {
      // remove the newest video without a link first
      const vids = videosOf(pid, day);
      const v = [...vids].reverse().find(x => !safeUrl(x.link)) || vids[vids.length-1];
      if (!v) return;
      if (safeUrl(v.link) && !confirm('this video has a google drive link. remove it anyway?')) return;
      ops.removeVideo(v.id);
      toast(`removed one video from ${p.name}`, () => ops.restoreVideo(v));
    }
  });

  $('#prevWeek').onclick = async () => { viewMonday = addDays(viewMonday,-7); await refreshWeek(); };
  $('#nextWeek').onclick = async () => { viewMonday = addDays(viewMonday, 7); await refreshWeek(); };
  $('#thisWeek').onclick = async () => { viewMonday = thisMonday(); await refreshWeek(); };
  async function refreshWeek(){ renderNav(); if (remote) await load(); render(); }

  /* ---------- day dialog: videos + drive links ---------- */
  const dayDlg = $('#dayDlg');
  let dayCtx = null;
  function openDay(pid, day, focusId){
    dayCtx = { pid, day };
    renderDay(focusId);
    dayDlg.showModal();
    if (focusId) setTimeout(() => dayDlg.querySelector(`input[data-vid="${focusId}"]`)?.focus(), 50);
  }
  function renderDay(){
    if (!dayCtx) return;
    const p = data.people.find(x=>x.id===dayCtx.pid);
    const date = addDays(viewMonday, dayCtx.day);
    $('#dayTitle').textContent = p ? p.name : '';
    $('#daySub').textContent = `${DAY_LONG[dayCtx.day]} ${date.getDate()} ${MONTHS[date.getMonth()]}`;
    const vids = videosOf(dayCtx.pid, dayCtx.day);
    $('#vidList').innerHTML = vids.length ? vids.map((v,i)=>{
      const url = safeUrl(v.link);
      return `<div class="vid">
        <span class="vn">${pad(i+1)}</span>
        <input data-vid="${v.id}" value="${esc(v.link||'')}" placeholder="paste google drive link" inputmode="url" autocomplete="off">
        ${url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer" aria-label="open video">${icon('open')}</a>` : ''}
        <button data-del="${v.id}" aria-label="remove this video">${icon('trash')}</button>
      </div>`;
    }).join('') : '<p class="sub" style="opacity:.7;margin:6px 0">no videos on this day yet.</p>';
  }
  dayDlg.addEventListener('click', e => { if (e.target===dayDlg || e.target.closest('[data-close]')) dayDlg.close(); });
  $('#vidList').addEventListener('change', e => {
    const id = e.target.dataset.vid; if (!id) return;
    const val = e.target.value.trim();
    if (val && !safeUrl(val)) { alert('that doesn’t look like a link. it should start with https://'); return; }
    ops.setLink(id, val);
    renderDay();
  });
  $('#vidList').addEventListener('click', e => {
    const btn = e.target.closest('[data-del]'); if (!btn) return;
    const v = data.videos.find(x=>x.id===btn.dataset.del); if (!v) return;
    if (!confirm('remove this video from the count?')) return;
    ops.removeVideo(v.id); renderDay();
    toast('video removed', () => { ops.restoreVideo(v); renderDay(); });
  });
  $('#addVid').onclick = () => {
    if (!dayCtx) return;
    const ph = weekPhase();
    if (ph.kind==='future' || (ph.kind==='current' && dayCtx.day>ph.todayIdx)) return;
    const v = ops.addVideo(dayCtx.pid, dayCtx.day);
    renderDay();
    setTimeout(() => dayDlg.querySelector(`input[data-vid="${v.id}"]`)?.focus(), 30);
  };

  /* ---------- team dialog ---------- */
  const teamDlg = $('#teamDlg');
  function renderMembers(){
    $('#tVal').textContent = data.target;
    $('#backupNote').textContent = remote ? 'backup. data is saved online; download a copy now and then.' : 'backup. everything is saved in this browser, so download a copy now and then.';
    const ps = people();
    $('#members').innerHTML = ps.length ? ps.map(p=>`
      <div class="member">
        <input value="${esc(p.name)}" data-rename="${p.id}" maxlength="40" aria-label="name">
        <button data-remove="${p.id}" aria-label="remove ${esc(p.name)}">${icon('trash','width:16px;height:16px')}</button>
      </div>`).join('') : '<p class="sub" style="opacity:.7">no one yet. add the first person below.</p>';
  }
  function openTeam(){ renderMembers(); teamDlg.showModal(); }
  $('#openTeam').onclick = openTeam;
  teamDlg.addEventListener('click', e => { if (e.target===teamDlg || e.target.closest('[data-close]')) teamDlg.close(); });
  $('#members').addEventListener('change', e => {
    const id = e.target.dataset.rename; if (!id) return;
    const name = e.target.value.trim();
    if (name) ops.renamePerson(id, name); else renderMembers();
  });
  $('#members').addEventListener('click', e => {
    const btn = e.target.closest('[data-remove]'); if (!btn) return;
    const p = data.people.find(x=>x.id===btn.dataset.remove);
    if (!p || !confirm(`remove ${p.name} from the team?\n\ntheir old videos stay saved.`)) return;
    ops.setActive(p.id, false); renderMembers();
    toast(`${p.name} removed`, () => { ops.setActive(p.id, true); renderMembers(); });
  });
  const add2 = () => { const i=$('#newName2'), v = i.value.trim(); if (v){ ops.addPerson(v); i.value=''; renderMembers(); i.focus(); } };
  $('#addBtn2').onclick = add2;
  $('#newName2').onkeydown = e => { if (e.key==='Enter') add2(); };
  $('#tMinus').onclick = () => { ops.setTarget(Math.max(1, data.target-1)); renderMembers(); };
  $('#tPlus').onclick  = () => { ops.setTarget(Math.min(30, data.target+1)); renderMembers(); };

  $('#exportBtn').onclick = async () => {
    let dump = data;
    if (remote) {
      const [p, v, s] = await Promise.all([db.from('people').select('*'), db.from('videos').select('*'), db.from('settings').select('*')]);
      dump = { people: p.data, videos: v.data, settings: s.data };
    }
    const blob = new Blob([JSON.stringify(dump,null,2)], {type:'application/json'});
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `ten-a-week-backup-${ymd(new Date())}.json` });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(()=>URL.revokeObjectURL(a.href), 1000);
  };

  /* ---------- start ---------- */
  setInterval(() => { if (!document.querySelector('dialog[open]')) render(); }, 5 * 60_000);
  load().then(render);
})();
