(() => {
  'use strict';
  const STORE = 'minuteur-argentique';
  const BASE_TITLE = document.title;
  // agit : initial = secondes de remuage continu au début, every = période, burst = durée du remuage
  const BURST = { initial: 30, every: 30, burst: 5 };
  const steps = [
    { name: 'Développement', sec: 420, agit: BURST },
    { name: 'Stop', sec: 60, agit: { continuous: true } },
    { name: 'Fixateur', sec: 240, agit: BURST }
  ];
  try {
    const saved = JSON.parse(localStorage.getItem(STORE));
    if (Array.isArray(saved) && saved.length === 3) {
      saved.forEach((v, i) => { if (Number.isInteger(v) && v >= 1 && v <= 5999) steps[i].sec = v; });
    }
  } catch (e) {}

  const $ = id => document.getElementById(id);
  const tabs = [0, 1, 2].map(i => $('tab-' + i));
  const el = {
    panel: $('panel'), dial: $('dial'), ring: $('ring'), time: $('time'),
    label: $('label'), hand: $('hand'), status: $('status'), live: $('live'),
    min: $('min'), sec: $('sec'), duration: $('duration'),
    start: $('startBtn'), reset: $('resetBtn'), next: $('nextBtn'),
    beep: $('optBeep'), auto: $('optAuto'), wake: $('optWake')
  };

  const CIRC = 2 * Math.PI * 92;
  el.ring.style.strokeDasharray = CIRC;

  // Graduations du cadran (60 secondes)
  const NS = 'http://www.w3.org/2000/svg';
  const pt = (r, deg) => [100 + r * Math.sin(deg * Math.PI / 180), 100 - r * Math.cos(deg * Math.PI / 180)];
  for (let i = 0; i < 60; i++) {
    const major = i % 5 === 0, a = pt(86, i * 6), b = pt(major ? 77 : 82, i * 6);
    const l = document.createElementNS(NS, 'line');
    l.setAttribute('class', major ? 'tick major' : 'tick');
    l.setAttribute('x1', a[0]); l.setAttribute('y1', a[1]); l.setAttribute('x2', b[0]); l.setAttribute('y2', b[1]);
    $('ticks').appendChild(l);
  }
  for (let i = 0; i < 60; i += 10) {
    const p = pt(63, i * 6), t = document.createElementNS(NS, 'text');
    t.setAttribute('class', 'num'); t.setAttribute('x', p[0]); t.setAttribute('y', p[1]);
    t.textContent = i === 0 ? '60' : i;
    $('nums').appendChild(t);
  }

  let current = 0;
  let state = 'idle';          // idle | running | paused | done
  let remaining = steps[0].sec * 1000;
  let endAt = 0, nextBeep = 0, timerId = null, note = '', wakeLock = null, wasAgit = false;

  /* ---------- Utilitaires ---------- */
  const pad = n => String(n).padStart(2, '0');
  const fmt = s => pad(Math.floor(s / 60)) + ':' + pad(s % 60);
  const spoken = ms => {
    const s = Math.round(ms / 1000), m = Math.floor(s / 60), r = s % 60, p = [];
    if (m) p.push(m + (m > 1 ? ' minutes' : ' minute'));
    if (r) p.push(r + (r > 1 ? ' secondes' : ' seconde'));
    return p.join(' ') || '0 seconde';
  };
  const total = () => steps[current].sec * 1000;
  const elapsedMs = () => total() - remaining;
  function agitNow() {
    if (state !== 'running') return false;
    const a = steps[current].agit, e = elapsedMs() / 1000;
    if (a.continuous || e < a.initial) return true;
    return e >= a.initial + a.every && (e - a.initial) % a.every < a.burst;
  }
  const announce = msg => { el.live.textContent = ''; setTimeout(() => { el.live.textContent = msg; }, 50); };
  const save = () => { try { localStorage.setItem(STORE, JSON.stringify(steps.map(s => s.sec))); } catch (e) {} };

  /* ---------- Son ---------- */
  let ac = null;
  function audio() {
    if (!ac) { const C = window.AudioContext || window.webkitAudioContext; if (C) ac = new C(); }
    if (ac && ac.state === 'suspended') ac.resume();
    return ac;
  }
  function tone(freq, t0, len) {
    const o = ac.createOscillator(), g = ac.createGain();
    o.type = 'sine'; o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.4, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + len);
    o.connect(g); g.connect(ac.destination);
    o.start(t0); o.stop(t0 + len + 0.05);
  }
  function beep() { const a = audio(); if (a) tone(880, a.currentTime, 0.18); }
  function endBeep() {
    const a = audio(); if (!a) return;
    const t = a.currentTime;
    tone(1175, t, 0.22); tone(1175, t + 0.35, 0.22); tone(1175, t + 0.7, 0.22); tone(1568, t + 1.05, 0.8);
  }
  function flash() {
    el.dial.classList.add('flash');
    setTimeout(() => el.dial.classList.remove('flash'), 350);
  }

  /* ---------- Écran allumé ---------- */
  async function lock() {
    try { if (el.wake.checked && 'wakeLock' in navigator && !wakeLock) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) {}
  }
  function unlock() { if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; } }

  /* ---------- Affichage ---------- */
  function render() {
    const secs = Math.max(0, Math.ceil(remaining / 1000));
    el.time.textContent = fmt(secs);
    el.ring.style.strokeDashoffset = CIRC * (1 - Math.max(0, Math.min(1, remaining / total())));
    el.hand.style.transform = 'rotate(' + (elapsedMs() / 60000 * 360) + 'deg)';
    const ag = agitNow();
    el.dial.classList.toggle('live', state === 'running');
    el.dial.classList.toggle('agitate', ag);
    el.label.textContent = ag ? 'Remuez' : steps[current].name;
    document.title = state === 'running' ? fmt(secs) + ' · ' + steps[current].name : BASE_TITLE;

    tabs.forEach((t, i) => {
      t.innerHTML = '';
      const n = document.createElement('span'); n.textContent = steps[i].name;
      const d = document.createElement('span'); d.className = 'tab-time'; d.textContent = fmt(steps[i].sec);
      t.append(n, d);
      t.setAttribute('aria-selected', i === current ? 'true' : 'false');
      t.tabIndex = i === current ? 0 : -1;
    });
    el.panel.setAttribute('aria-labelledby', 'tab-' + current);

    const labels = { idle: 'Démarrer', running: 'Pause', paused: 'Reprendre', done: 'Relancer' };
    el.start.textContent = labels[state];
    el.next.disabled = current === 2;
    const editable = state === 'idle' || state === 'done';
    el.min.disabled = el.sec.disabled = !editable;
    el.duration.disabled = !editable;

    const msgs = { idle: 'Prêt', running: 'En cours', paused: 'En pause', done: 'Terminé' };
    el.status.textContent = note && state === 'idle' ? note : msgs[state];
  }
  function fillInputs() {
    const s = steps[current].sec;
    el.min.value = Math.floor(s / 60);
    el.sec.value = s % 60;
  }

  /* ---------- Minuteur ---------- */
  function start() {
    audio();
    if (state === 'done') remaining = total();
    endAt = Date.now() + remaining;
    nextBeep = (Math.floor(elapsedMs() / 30000) + 1) * 30000;
    state = 'running'; note = '';
    clearInterval(timerId);
    timerId = setInterval(tick, 200);
    lock();
    wasAgit = agitNow();
    announce(steps[current].name + ' : départ, ' + spoken(remaining) + (wasAgit ? '. Remuez.' : ''));
    render();
  }
  function pause() {
    clearInterval(timerId);
    remaining = Math.max(0, endAt - Date.now());
    state = 'paused';
    unlock();
    announce('Pause, ' + spoken(remaining) + ' restantes');
    render();
  }
  function tick() {
    remaining = endAt - Date.now();
    if (remaining <= 0) { finish(); return; }
    const elapsed = elapsedMs();
    let msg = '';
    while (nextBeep < total() && elapsed >= nextBeep) {
      if (el.beep.checked) beep();
      flash();
      msg = spoken(total() - nextBeep) + ' restantes';
      nextBeep += 30000;
    }
    const a = agitNow();
    if (a !== wasAgit) { wasAgit = a; msg = (a ? 'Remuez' : 'Arrêtez de remuer') + (msg ? '. ' + msg : ''); }
    if (msg) announce(msg);
    render();
  }
  function finish() {
    clearInterval(timerId);
    remaining = 0;
    unlock();
    endBeep(); flash();
    const done = steps[current].name;
    if (current < 2) {
      const auto = el.auto.checked;
      goTo(current + 1);
      if (auto) { announce(done + ' terminé. ' + steps[current].name + ' démarre.'); start(); return; }
      note = done + ' terminé. Prochaine étape prête.';
      announce(note + ' ' + steps[current].name + ', ' + spoken(total()));
    } else {
      state = 'done';
      announce(done + ' terminé. Toutes les étapes sont finies.');
    }
    render();
  }
  function goTo(i) {
    clearInterval(timerId);
    unlock();
    current = i; state = 'idle'; note = '';
    remaining = total();
    fillInputs();
    render();
  }

  /* ---------- Événements ---------- */
  el.start.addEventListener('click', () => {
    if (state === 'running') pause(); else start();
  });
  el.reset.addEventListener('click', () => { goTo(current); announce('Minuteur réinitialisé'); });
  el.next.addEventListener('click', () => { if (current < 2) goTo(current + 1); });

  tabs.forEach((t, i) => {
    t.addEventListener('click', () => { if (i !== current) goTo(i); });
    t.addEventListener('keydown', e => {
      let n = null;
      if (e.key === 'ArrowRight') n = (i + 1) % 3;
      else if (e.key === 'ArrowLeft') n = (i + 2) % 3;
      else if (e.key === 'Home') n = 0;
      else if (e.key === 'End') n = 2;
      if (n !== null) { e.preventDefault(); goTo(n); tabs[n].focus(); }
    });
  });

  function readInputs() {
    const m = Math.min(99, Math.max(0, parseInt(el.min.value, 10) || 0));
    const s = Math.min(59, Math.max(0, parseInt(el.sec.value, 10) || 0));
    steps[current].sec = Math.max(1, m * 60 + s);
    remaining = total();
    save(); render();
  }
  el.min.addEventListener('input', readInputs);
  el.sec.addEventListener('input', readInputs);
  el.min.addEventListener('change', fillInputs);
  el.sec.addEventListener('change', fillInputs);

  el.wake.addEventListener('change', () => { if (!el.wake.checked) unlock(); else if (state === 'running') lock(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state === 'running') { lock(); tick(); }
  });

  fillInputs();
  render();
})();
