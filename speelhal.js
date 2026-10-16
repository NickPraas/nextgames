/*
  Speelhal: gedeelde code voor alle spellen.
  Regelt de koppeling met Supabase, de spelerskeuze, de Elo-ranglijst en het statistiekenvenster.
  Een spel maakt één keer `Speelhal.create({...})` aan met wat specifiek is voor dat spel.
*/
(function () {
  'use strict';

  // ---------- instellingen ----------
  // Supabase-project (Project Settings > API Keys). Laat leeg om alleen in de browser op te slaan.
  const CONFIG = {
    supabaseUrl: 'https://wyqhmnzykmmasuncbdmp.supabase.co',
    supabaseKey: 'sb_publishable_jGT0Zoe1bCNHQ_DffHhmDw_z7ehX-Zk'
  };

  // Alleen als reserve: de echte spelerslijst staat in Supabase (tabel players).
  // Deze lijst wordt gebruikt als de database nog nooit bereikt is op dit apparaat,
  // of als het spel niet aan Supabase gekoppeld is.
  const FALLBACK_PLAYERS = [
    'Albrecht', 'Coen', 'Didi', 'Gerwin', 'Hannah', 'Jacco', 'Jeroen', 'Lars', 'Marit', 'Milan',
    'Niek', 'Nick', 'Nikos', 'Numan', 'Sam', 'Stefan', 'Stephan', 'Steven', 'Thijs'
  ];

  const REMOTE = !!(CONFIG.supabaseUrl && CONFIG.supabaseKey);
  const NEW = '__new__';
  const LIST_PAGE = 15;
  const ELO_START = 1000;
  const PROVISIONAL = 3;

  // ---------- hulpfuncties ----------
  const $ = (id) => document.getElementById(id);
  const keyOf = (n) => String(n).trim().toLowerCase();
  const cleanName = (v) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, 14);
  const esc = (t) => String(t).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
  const lsGet = (k, fallback) => {
    try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? fallback : v; }
    catch (e) { return fallback; }
  };
  const lsSet = (k, v) => {
    try { localStorage.setItem(k, JSON.stringify(v)); return true; }
    catch (e) { return false; }
  };
  const uuid = () => (window.crypto && crypto.randomUUID) ? crypto.randomUUID() :
    'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });

  async function rest(path, opts = {}) {
    const res = await fetch(`${CONFIG.supabaseUrl.replace(/\/+$/, '')}/rest/v1/${path}`, {
      ...opts,
      headers: { apikey: CONFIG.supabaseKey, 'Content-Type': 'application/json', ...(opts.headers || {}) }
    });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  // Fouten waarbij opnieuw proberen zin heeft (geen verbinding, server, configuratie).
  const retryable = (e) => !e.status || e.status >= 500 || [401, 403, 404, 408, 429].includes(e.status);

  const fmtDate = new Intl.DateTimeFormat('nl-NL', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

  /*
    opts:
      prefix, version      sleutels voor de browseropslag, bv. 'ns-bg' en 'v1'
      resultName           naam van de uitslagen in de browseropslag ('games' of 'matches')
      table, query         Supabase-tabel en extra filter, bv. 'matches' en 'game=eq.backgammon'
      toRow, fromRow       omzetten tussen uitslag in het spel en een rij in de database
      units                { one: 'match', many: 'matches', this: 'Deze match' }
      labelOf(e, side)     naam in de ranglijst (optioneel; standaard p1/p2)
      weightOf(e)          zwaarte van een uitslag voor de Elo-rating (optioneel; standaard 1)
      filters              { sleutel: e => true/false } voor de filterknoppen in het statistiekenvenster
      emptyText(filter)    tekst als er (in dit filter) nog niets gespeeld is
      itemMeta(e)          tweede regel bij een uitslag in de lijst (HTML, zelf escapen)
      reserved             { names: ['claude'], message: '...' } (optioneel)
      slots                aantal spelerskeuzes p1select..pNselect (optioneel; standaard 2)
      pickerExtra          extra keuzes bovenaan elk lijstje, bv. [{ value: '__claude__', label: 'Claude' }]
      multi                true voor potjes met 2 tot 4 spelers en een eindvolgorde. Een uitslag is dan
                           { id, t, players: [...], places: [1, 2, ...], ai: [false, true, ...], ... }.
                           Elo telt elk paar spelers als een onderling duel; twee keer Claude telt niet.
  */
  function create(opts) {
    const k = (name) => `${opts.prefix}:${name}:${opts.version}`;
    const LS = {
      results: k(opts.resultName),
      pendingResults: k(`pending-${opts.resultName}`),
      players: k('players'),
      pendingPlayers: k('pending-players'),
      playersCache: k('players-cache'),
      last: k('last-choice')
    };
    const units = opts.units;
    const labelOf = opts.labelOf || ((e, side) => side === 1 ? e.p1 : e.p2);
    const weightOf = opts.weightOf || (() => 1);
    const reserved = opts.reserved || { names: ['claude'], message: 'De naam Claude is gereserveerd. Kies een andere naam.' };
    const MULTI = !!opts.multi;
    const SLOTS = Array.from({ length: opts.slots || 2 }, (_, i) => i + 1);
    const extras = opts.pickerExtra || [];
    const isExtra = (v) => extras.some(x => x.value === v);
    const AI_LABEL = opts.aiLabel || 'Claude';
    const isValid = MULTI
      ? (e) => e && typeof e.id === 'string' && Number.isFinite(e.t) && Array.isArray(e.players) &&
          Array.isArray(e.places) && e.players.length >= 2 && e.players.length === e.places.length
      : (e) => e && typeof e.id === 'string' && typeof e.p1 === 'string' && typeof e.p2 === 'string' &&
          Number.isFinite(e.s1) && Number.isFinite(e.s2) && Number.isFinite(e.t);
    const labelAt = (e, i) => (e.ai && e.ai[i]) ? AI_LABEL : e.players[i];

    // ---------- opslag van uitslagen ----------
    function insertResult(e) {
      return rest(opts.table, {
        method: 'POST',
        headers: { Prefer: 'return=minimal,resolution=ignore-duplicates' },
        body: JSON.stringify(opts.toRow(e))
      });
    }

    async function insertPlayer(name) {
      try {
        await rest('players', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ name }) });
        return true;
      } catch (e) {
        if (e.status === 409) return true;   // bestaat al
        if (retryable(e)) throw e;
        return false;                        // ongeldige naam: niet opnieuw proberen
      }
    }

    async function flushPending() {
      if (!REMOTE) return;
      const results = lsGet(LS.pendingResults, []);
      if (results.length) {
        const left = [];
        for (const e of results) {
          try { await insertResult(e); } catch (err) { if (retryable(err)) left.push(e); }
        }
        lsSet(LS.pendingResults, left);
      }
      const names = lsGet(LS.pendingPlayers, []);
      if (names.length) {
        const left = [];
        for (const n of names) {
          try { await insertPlayer(n); } catch (err) { left.push(n); }
        }
        lsSet(LS.pendingPlayers, left);
      }
    }

    async function allResults() {
      if (!REMOTE) return lsGet(LS.results, []).filter(isValid);
      await flushPending();
      const out = [];
      const page = 1000;
      const q = opts.query ? `&${opts.query}` : '';
      for (let off = 0; ; off += page) {
        const rows = await rest(`${opts.table}?select=*${q}&order=played_at.asc&limit=${page}&offset=${off}`);
        out.push(...rows.map(opts.fromRow));
        if (rows.length < page) break;
      }
      const ids = new Set(out.map(e => e.id));
      const pending = lsGet(LS.pendingResults, []).filter(e => !ids.has(e.id)).map(e => ({ ...e, pending: true }));
      return out.concat(pending);
    }

    async function addResult(e) {
      if (!REMOTE) {
        const all = lsGet(LS.results, []);
        all.push(e);
        return { saved: lsSet(LS.results, all) };
      }
      try {
        await insertResult(e);
        return { saved: true };
      } catch (err) {
        if (!retryable(err)) return { saved: false };
        const pending = lsGet(LS.pendingResults, []);
        pending.push(e);
        lsSet(LS.pendingResults, pending);
        return { saved: false, queued: true };
      }
    }

    // ---------- spelers ----------
    // De database is de bron. Lukt ophalen niet, dan de laatst bekende lijst op dit apparaat,
    // en anders de reservelijst.
    async function fetchPlayers() {
      if (!REMOTE) return FALLBACK_PLAYERS.concat(lsGet(LS.players, []));
      const pending = lsGet(LS.pendingPlayers, []);
      try {
        const rows = await rest('players?select=name');
        const names = rows.map(r => r.name);
        lsSet(LS.playersCache, names);
        return names.concat(pending);
      } catch (e) {
        const cache = lsGet(LS.playersCache, null);
        return (cache && cache.length ? cache : FALLBACK_PLAYERS).concat(pending);
      }
    }

    async function addPlayer(name) {
      if (!REMOTE) {
        const list = lsGet(LS.players, []);
        if (!list.some(n => keyOf(n) === keyOf(name))) { list.push(name); lsSet(LS.players, list); }
        return;
      }
      try {
        await insertPlayer(name);
      } catch (e) {
        const pending = lsGet(LS.pendingPlayers, []);
        if (!pending.some(n => keyOf(n) === keyOf(name))) { pending.push(name); lsSet(LS.pendingPlayers, pending); }
      }
    }

    let knownPlayers = (() => {
      if (!REMOTE) return FALLBACK_PLAYERS.concat(lsGet(LS.players, []));
      const cache = lsGet(LS.playersCache, null);
      return (cache && cache.length ? cache : FALLBACK_PLAYERS).concat(lsGet(LS.pendingPlayers, []));
    })();
    const sessionNames = new Map();   // getypt in deze sessie, nog niet opgeslagen
    let playerNames = [];

    function sortedNames(list) {
      const m = new Map();
      list.forEach(n => {
        const c = cleanName(n);
        const kk = keyOf(c);
        if (c && !reserved.names.includes(kk) && !m.has(kk)) m.set(kk, c);
      });
      return [...m.values()].sort((a, b) => a.localeCompare(b, 'nl', { sensitivity: 'base' }));
    }

    const picker = {
      render() {
        playerNames = sortedNames(knownPlayers.concat([...sessionNames.values()]));
        SLOTS.forEach(n => {
          const sel = $(`p${n}select`);
          if (!sel) return;
          const keep = sel.value;
          sel.innerHTML = '<option value="">Kies een speler</option>' +
            extras.map(x => `<option value="${esc(x.value)}">${esc(x.label)}</option>`).join('') +
            playerNames.map(x => `<option value="${esc(x)}">${esc(x)}</option>`).join('') +
            `<option value="${NEW}">+ Andere naam typen</option>`;
          if (keep === NEW || isExtra(keep) || playerNames.includes(keep)) sel.value = keep;
        });
      },
      select(n, name) {
        const sel = $(`p${n}select`), inp = $(`p${n}name`);
        if (sel && name && (playerNames.includes(name) || isExtra(name))) {
          sel.value = name;
          inp.hidden = true;
          inp.value = '';
        }
      },
      chosen(n) {
        const sel = $(`p${n}select`);
        if (sel.value !== NEW) return sel.value;   // ook een extra keuze, bv. '__claude__'
        const typed = cleanName($(`p${n}name`).value);
        return playerNames.find(x => keyOf(x) === keyOf(typed)) || typed;
      },
      // solo: alleen speler 1 kiezen (bv. tegen Claude)
      validate(p1, p2, solo) {
        const typing = (n) => $(`p${n}select`).value === NEW;
        if (!p1) return typing(1) ? 'Typ een naam voor speler 1.' : 'Kies speler 1, of typ een andere naam.';
        if (!solo) {
          if (!p2) return typing(2) ? 'Typ een naam voor speler 2.' : 'Kies speler 2, of typ een andere naam.';
          if (keyOf(p1) === keyOf(p2)) return 'Kies twee verschillende spelers.';
        }
        if (reserved.names.includes(keyOf(p1)) || (!solo && reserved.names.includes(keyOf(p2)))) return reserved.message;
        return '';
      },
      // Voor meer dan twee spelers. values: gekozen waarde per plek (naam of extra keuze).
      validateMany(values) {
        const typing = (n) => $(`p${n}select`).value === NEW;
        const seen = new Set();
        for (let i = 0; i < values.length; i++) {
          const v = values[i];
          if (isExtra(v)) continue;
          if (!v) return typing(i + 1) ? `Typ een naam voor speler ${i + 1}.` : `Kies speler ${i + 1}, of typ een andere naam.`;
          if (reserved.names.includes(keyOf(v))) return reserved.message;
          if (seen.has(keyOf(v))) return `${v} staat er twee keer in. Kies verschillende spelers.`;
          seen.add(keyOf(v));
        }
        return '';
      },
      // Getypte namen direct in de lijst zetten; ze worden centraal opgeslagen na een afgeronde uitslag.
      adopt(names) {
        names.forEach(n => {
          if (!n || isExtra(n)) return;
          if (!playerNames.some(x => keyOf(x) === keyOf(n))) sessionNames.set(keyOf(n), n);
        });
        picker.render();
        names.forEach((n, i) => picker.select(i + 1, n));
      },
      async load() {
        knownPlayers = await fetchPlayers();
        picker.render();
      }
    };

    SLOTS.forEach(n => {
      const sel = $(`p${n}select`), inp = $(`p${n}name`);
      if (!sel) return;
      sel.addEventListener('change', () => {
        const isNew = sel.value === NEW;
        inp.hidden = !isNew;
        if (isNew) inp.focus();
        $('setupError').textContent = '';
      });
      inp.addEventListener('input', () => { $('setupError').textContent = ''; });
    });

    const last = {
      get: () => lsGet(LS.last, {}),
      set: (v) => lsSet(LS.last, v)
    };

    // ---------- Elo ----------
    // Iedereen start op 1000. Nieuwe spelers bewegen sneller (hogere K), zodat ze na een paar
    // uitslagen op hun niveau zitten. weightOf laat bv. een lange match zwaarder tellen.
    const kFactor = (p) => p.played < 10 ? 40 : 24;

    function computeStats(list) {
      if (MULTI) return computeStatsMulti(list);
      const map = new Map();
      const get = (name) => {
        const kk = keyOf(name);
        if (!map.has(kk)) map.set(kk, { name, played: 0, won: 0, lost: 0, tied: 0, rating: ELO_START, delta: 0 });
        const p = map.get(kk);
        p.name = name; // meest recente schrijfwijze
        return p;
      };
      list.slice().sort((a, b) => a.t - b.t).forEach(e => {
        const a = get(labelOf(e, 1)), b = get(labelOf(e, 2));
        const sa = e.s1 > e.s2 ? 1 : e.s1 < e.s2 ? 0 : 0.5;
        const ea = 1 / (1 + Math.pow(10, (b.rating - a.rating) / 400));
        const w = weightOf(e);
        const da = kFactor(a) * w * (sa - ea);
        const db = kFactor(b) * w * ((1 - sa) - (1 - ea));
        a.rating += da; b.rating += db;
        a.delta = da; b.delta = db;
        a.played++; b.played++;
        if (sa === 1) { a.won++; b.lost++; }
        else if (sa === 0) { b.won++; a.lost++; }
        else { a.tied++; b.tied++; }
      });
      const byRating = (x, y) => y.rating - x.rating || y.played - x.played || x.name.localeCompare(y.name, 'nl');
      const all = [...map.values()];
      return all.filter(p => p.played >= PROVISIONAL).sort(byRating)
        .concat(all.filter(p => p.played < PROVISIONAL).sort(byRating));
    }

    // Meer spelers: elk paar is een duel (hogere plek wint, gelijke plek is half). De K-factor
    // wordt verdeeld over het aantal tegenstanders, zodat een potje met vier niet vier keer zo zwaar telt.
    function computeStatsMulti(list) {
      const map = new Map();
      const get = (name) => {
        const kk = keyOf(name);
        if (!map.has(kk)) map.set(kk, { name, played: 0, won: 0, lost: 0, tied: 0, firsts: 0, placeSum: 0, rating: ELO_START, delta: 0 });
        const p = map.get(kk);
        p.name = name;
        return p;
      };
      list.slice().sort((a, b) => a.t - b.t).forEach(e => {
        const seats = e.players.map((_, i) => ({ p: get(labelAt(e, i)), place: e.places[i], ai: !!(e.ai && e.ai[i]) }));
        const n = seats.length;
        const delta = new Map();
        for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
          const A = seats[i], B = seats[j];
          if (A.p === B.p) continue;            // Claude tegen Claude telt niet
          const sa = A.place < B.place ? 1 : A.place > B.place ? 0 : 0.5;
          const ea = 1 / (1 + Math.pow(10, (B.p.rating - A.p.rating) / 400));
          const w = weightOf(e) / (n - 1);
          delta.set(A.p, (delta.get(A.p) || 0) + kFactor(A.p) * w * (sa - ea));
          delta.set(B.p, (delta.get(B.p) || 0) + kFactor(B.p) * w * ((1 - sa) - (1 - ea)));
        }
        const counted = new Set();
        seats.forEach(st => {
          if (counted.has(st.p)) {
            if (st.place < st.p._best) st.p._best = st.place;
            return;
          }
          counted.add(st.p);
          st.p._best = st.place;
        });
        counted.forEach(p => {
          const d = delta.get(p) || 0;
          p.rating += d; p.delta = d;
          p.played++;
          p.placeSum += p._best;
          if (p._best === 1) { p.firsts++; p.won++; }
        });
      });
      const byRating = (x, y) => y.rating - x.rating || y.played - x.played || x.name.localeCompare(y.name, 'nl');
      const all = [...map.values()];
      return all.filter(p => p.played >= PROVISIONAL).sort(byRating)
        .concat(all.filter(p => p.played < PROVISIONAL).sort(byRating));
    }

    function headToHead(list, n1, n2) {
      const k1 = keyOf(n1), k2 = keyOf(n2);
      let w1 = 0, w2 = 0, t = 0;
      for (const e of list) {
        const a = keyOf(labelOf(e, 1)), b = keyOf(labelOf(e, 2));
        let x, y;
        if (a === k1 && b === k2) { x = e.s1; y = e.s2; }
        else if (a === k2 && b === k1) { x = e.s2; y = e.s1; }
        else continue;
        if (x > y) w1++; else if (y > x) w2++; else t++;
      }
      return { w1, w2, t };
    }

    // ---------- uitslag vastleggen ----------
    let recordToken = 0;
    function resetRecord() {
      recordToken++;
      const rec = $('winnerRecord');
      if (rec) rec.textContent = '';
    }

    async function record(e) {
      const token = ++recordToken;
      const rec = $('winnerRecord');
      rec.textContent = 'Opslaan...';
      const res = await addResult(e);

      // Nieuwe namen pas na een afgeronde uitslag opslaan, zo blijven tikfouten uit de lijst.
      const humans = MULTI ? e.players.filter((_, i) => !(e.ai && e.ai[i])) : [e.p1, e.p2];
      for (const n of humans) {
        const kk = keyOf(n);
        if (sessionNames.has(kk)) {
          await addPlayer(n);
          sessionNames.delete(kk);
          if (!knownPlayers.some(x => keyOf(x) === kk)) knownPlayers.push(n);
        }
      }

      let all = null;
      if (res.saved) { try { all = await allResults(); } catch (err) { all = null; } }
      if (token !== recordToken) return;

      if (res.queued) {
        rec.textContent = `Geen verbinding met de ranglijst. ${units.this} wordt verstuurd zodra de verbinding terug is.`;
      } else if (!res.saved) {
        rec.textContent = `${units.this} kon niet worden opgeslagen.`;
      } else if (!all) {
        rec.textContent = 'Opgeslagen in de ranglijst.';
      } else if (MULTI) {
        const stats = computeStats(all);
        const names = [...new Set(e.players.map((_, i) => labelAt(e, i)))];
        const fmt = (name) => {
          const p = stats.find(x => keyOf(x.name) === keyOf(name));
          if (!p) return name;
          const d = Math.round(p.delta);
          return `${name} ${Math.round(p.rating)} (${d >= 0 ? '+' : '−'}${Math.abs(d)})`;
        };
        rec.textContent = `Opgeslagen in de ranglijst.\nRating: ${names.map(fmt).join(', ')}`;
      } else {
        const n1 = labelOf(e, 1), n2 = labelOf(e, 2);
        const h = headToHead(all, n1, n2);
        const total = h.w1 + h.w2 + h.t;
        const line1 = total <= 1
          ? `Eerste ${units.one} tussen jullie, opgeslagen in de ranglijst.`
          : `Onderling na ${total} ${units.many}: ${n1} ${h.w1} – ${h.w2} ${n2}` + (h.t ? ` (${h.t}× gelijk)` : '');
        const stats = computeStats(all);
        const fmt = (name) => {
          const p = stats.find(x => keyOf(x.name) === keyOf(name));
          if (!p) return '';
          const d = Math.round(p.delta);
          return `${name} ${Math.round(p.rating)} (${d >= 0 ? '+' : '−'}${Math.abs(d)})`;
        };
        rec.textContent = `${line1}\nRating: ${fmt(n1)}, ${fmt(n2)}`;
      }
    }

    // ---------- statistiekenvenster ----------
    let statsFilter = 'all';
    let showAll = false;
    let lastList = [];
    let loadFailed = false;

    async function loadStats() {
      $('rankList').innerHTML = '<li class="stats-empty">Ranglijst laden...</li>';
      $('gameList').innerHTML = '';
      $('gamesMore').style.display = 'none';
      try {
        lastList = await allResults();
        loadFailed = false;
      } catch (err) {
        lastList = REMOTE ? lsGet(LS.pendingResults, []).map(e => ({ ...e, pending: true })) : [];
        loadFailed = true;
      }
      renderStats();
    }

    function renderSource() {
      const pending = REMOTE ? lsGet(LS.pendingResults, []).length : 0;
      let html;
      if (!REMOTE) {
        html = `<span class="live off"></span>Niet gekoppeld aan de centrale ranglijst. ${cap(units.many)} worden alleen in deze browser bewaard.`;
      } else if (loadFailed) {
        html = '<span class="live off"></span>Geen verbinding met de centrale ranglijst. Probeer het straks opnieuw.';
      } else {
        html = `<span class="live"></span>Centrale ranglijst, voor iedereen hetzelfde. ${cap(units.many)} verwijderen kan alleen via het beheer in Supabase.`;
      }
      if (pending) html += ` ${pending} ${pending === 1 ? `${units.one} wacht` : `${units.many} wachten`} nog op verzending.`;
      $('statsSource').innerHTML = html;
    }

    function renderStats() {
      renderSource();
      const filter = (opts.filters && opts.filters[statsFilter]) || (() => true);
      const list = lastList.filter(filter);
      const players = computeStats(list);
      const rankList = $('rankList'), gameList = $('gameList');

      $('rankSummary').textContent = players.length ? `${players.length} ${players.length === 1 ? 'speler' : 'spelers'}` : '';
      $('gamesSummary').textContent = list.length ? `${list.length} ${list.length === 1 ? units.one : units.many}` : '';

      if (!list.length) {
        const msg = loadFailed
          ? 'De ranglijst kon niet worden geladen. Controleer de verbinding en klik op Vernieuwen.'
          : opts.emptyText(statsFilter);
        rankList.innerHTML = `<li class="stats-empty">${msg}</li>`;
        gameList.innerHTML = '';
        $('gamesMore').style.display = 'none';
        return;
      }

      const row = (p, pos) => {
        const provisional = p.played < PROVISIONAL;
        const parts = [`${p.won} gewonnen`, `${p.lost} verloren`];
        if (p.tied) parts.push(`${p.tied} gelijk`);
        const d = Math.round(p.delta);
        const delta = d > 0 ? `<span class="up">▲ ${d}</span>` : d < 0 ? `<span class="down">▼ ${-d}</span>` : '±0';
        return `<li class="rank-row${pos === 1 ? ' top' : ''}${provisional ? ' provisional' : ''}">
          <div class="rank-pos">${provisional ? '' : pos}</div>
          <div>
            <div class="rank-name">${esc(p.name)}</div>
            <div class="rank-meta">${p.played} ${p.played === 1 ? units.one : units.many}: ${MULTI
            ? `${p.firsts}× eerste, gemiddeld plek ${(p.placeSum / p.played).toFixed(1).replace('.', ',')}`
            : parts.join(', ')}</div>
          </div>
          <div class="rank-wins"><span class="num">${Math.round(p.rating)}</span><span class="lbl" title="Verschil door de laatste uitslag">${delta}</span></div>
        </li>`;
      };
      const established = players.filter(p => p.played >= PROVISIONAL);
      const provisional = players.filter(p => p.played < PROVISIONAL);
      rankList.innerHTML = established.map((p, i) => row(p, i + 1)).join('') +
        (provisional.length
          ? `<li class="rank-divider">Voorlopig, nog geen ${PROVISIONAL} ${units.many}</li>` + provisional.map(p => row(p, 0)).join('')
          : '');

      const sorted = list.slice().sort((a, b) => b.t - a.t);
      const shown = showAll ? sorted : sorted.slice(0, LIST_PAGE);
      gameList.innerHTML = shown.map(e => {
        if (MULTI) {
          const order = e.players.map((_, i) => i).sort((a, b) => e.places[a] - e.places[b]);
          const line = order.map(i => {
            const nm = esc(labelAt(e, i));
            return `${e.places[i]}. ${e.places[i] === 1 ? `<strong>${nm}</strong>` : nm}`;
          }).join(' · ');
          return `<li class="game-row">
          <div>
            <div class="game-match">${line}</div>
            <div class="game-meta">${esc(fmtDate.format(new Date(e.t)))}, ${opts.itemMeta(e)}${e.pending ? ', wacht op verzending' : ''}</div>
          </div>
        </li>`;
        }
        const n1 = e.s1 > e.s2 ? `<strong>${esc(e.p1)}</strong>` : esc(e.p1);
        const n2 = e.s2 > e.s1 ? `<strong>${esc(e.p2)}</strong>` : esc(e.p2);
        const meta = opts.itemMeta(e) + (e.pending ? ', wacht op verzending' : '');
        return `<li class="game-row">
          <div>
            <div class="game-match">${n1}<span class="score">${e.s1} – ${e.s2}</span>${n2}</div>
            <div class="game-meta">${esc(fmtDate.format(new Date(e.t)))}, ${meta}</div>
          </div>
        </li>`;
      }).join('');

      const more = $('gamesMore');
      if (sorted.length > LIST_PAGE) {
        more.style.display = '';
        more.textContent = showAll ? 'Toon minder' : `Toon alle ${sorted.length} ${units.many}`;
      } else {
        more.style.display = 'none';
      }
    }

    const statsOverlay = $('statsOverlay');
    function openStats() {
      showAll = false;
      $('statsStatus').textContent = '';
      statsOverlay.classList.add('open');
      loadStats();
    }
    function closeStats() { statsOverlay.classList.remove('open'); }

    $('btnStats').addEventListener('click', openStats);
    $('winnerStatsBtn').addEventListener('click', openStats);
    $('statsClose').addEventListener('click', closeStats);
    $('btnRefresh').addEventListener('click', () => { $('statsStatus').textContent = ''; loadStats(); });
    statsOverlay.addEventListener('click', (ev) => { if (ev.target === statsOverlay) closeStats(); });
    document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') closeStats(); });
    $('statsFilter').addEventListener('click', (ev) => {
      const btn = ev.target.closest('button');
      if (!btn) return;
      $('statsFilter').querySelectorAll('button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      statsFilter = btn.dataset.filter;
      showAll = false;
      renderStats();
    });
    $('gamesMore').addEventListener('click', () => { showAll = !showAll; renderStats(); });

    // ---------- start ----------
    function init(lastChoice) {
      const vals = Array.isArray(lastChoice.players) ? lastChoice.players : [lastChoice.p1, lastChoice.p2];
      const restore = () => SLOTS.forEach((n, i) => {
        const sel = $(`p${n}select`);
        if (sel && !sel.value) picker.select(n, vals[i]);
      });
      picker.render();
      restore();
      picker.load().then(restore);
      flushPending().catch(() => {});
    }

    return { picker, last, record, resetRecord, openStats, init, uuid, esc, keyOf };
  }

  window.Speelhal = { create, REMOTE, esc, keyOf, uuid };
})();
