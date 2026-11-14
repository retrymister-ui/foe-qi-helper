// ==UserScript==
// @name         FoE ПБГ логгер
// @namespace    foe-gbg-logger
// @version      1.8
// @description  Записывает бои, усталость, награды, активность гильдий и изменения протокола на Полях битв гильдий. Сам ничего не нажимает.
// @match        https://*.forgeofempires.com/game
// @match        https://*.forgeofempires.com/game?*
// @match        https://*.forgeofempires.com/game/*
// @run-at       document-start
// @grant        none
// @updateURL    https://raw.githubusercontent.com/retrymister-ui/foe-qi-helper/main/foe-gbg-logger.meta.js
// @downloadURL  https://raw.githubusercontent.com/retrymister-ui/foe-qi-helper/main/foe-gbg-logger.user.js
// ==/UserScript==

(function () {
  'use strict';

  const IS_NODE = typeof window === 'undefined' && typeof module !== 'undefined';

  // ───────────────────────── настройки по умолчанию ─────────────────────────
  const DEFAULT_CFG = {
    rawLog: true,          // сохранять облегчённый сырой лог (совместим с форматом прошлых записей)
    rawLimit: 50000,       // максимум записей сырого лога
    activityLimit: 60000,  // максимум записей активности по провинциям
    warnLevel: 50,         // предупреждать об усталости с этого уровня
    alertSound: true,      // звук, когда бьют нашу провинцию
    alertNotify: false,    // системное уведомление браузера
    alertMinProgress: 0,   // тревога, только если прогресс врага >= N% от максимума
    alertCooldownSec: 60,  // не чаще одного раза в N сек на провинцию
    activityWindowMin: 5,  // окно для расчёта темпа ударов
    onlyGbg: true,         // значок и панель видны только на Полях битв
    capLevel: 150,         // с этого уровня усталости сложность больше не растёт
    timerSound: true,      // звук за 60 и 10 с до открытия соседней чужой провинции
    soonWindowMin: 30,     // окно списка «скоро откроются», мин
  };

  // Классы, ответы которых участвуют в поиске новых полей
  const SCHEMA_CLASS_RE = /Battleground|Battlefield|Reward|Negotiation/;
  // Шум, который не пишем в сырой лог
  const RAW_SKIP = new Set(['TimeService.updateTime', 'MessageService.newMessage', 'LogService.logPerformanceMetrics', 'RankingService.newRank']);

  // ═════════════════════════════ ЯДРО (без DOM) ═════════════════════════════
  function createCore(cfg, persist, hooks) {
    cfg = Object.assign({}, DEFAULT_CFG, cfg || {});
    persist = persist || {};
    persist.curve = persist.curve || {};          // уровень усталости -> {bonus, neg, n}
    persist.schema = persist.schema || {};        // "Class.method" -> {path: firstSeen}
    persist.meta = persist.meta || { maps: {}, buildings: {} };
    hooks = hooks || {};

    const S = {
      v: 1,
      session: { start: Date.now(), lastActive: Date.now(), host: null, playerId: null, playerName: null },
      bg: { mapId: null, league: null, endsAt: null, activeTrial: null, myPid: null, storeId: null, participants: {}, provinces: {}, signals: {} },
      state: null,           // getState (чемпионат, лига)
      attrition: null,       // {level, bonus, neg, t}
      fights: [],            // завершённые бои/переговоры
      rewards: [],           // все collectReward
      activity: [],          // приращения прогресса захвата (WS)
      captures: [],          // смены владельца провинций
      vpHistory: [],         // {t, vp:{pid:vp}}
      previews: {},          // provinceId -> последний превью армии врага
      actions: [],           // действия игрока/гильдии на ПБГ (не get*)
      negotiations: [],      // ответы переговоров
      discoveries: [],       // новые методы/поля протокола
      guild: { names: {}, snaps: [] }, // снимки таблицы игроков гильдии: {t, p:[[id, побед в боях, переговоров, усталость, место]]}
      dayResets: [],         // моменты, когда наша усталость сбросилась (так узнаём время смены дня ПБГ)
      unknown: [],           // образцы неразобранных ответов по теме ПБГ
      resources: { first: null, last: null },
      alerts: [],
      raw: [],
      counters: { batches: 0, ws: 0, xhr: 0 },
    };
    let curFight = null;
    let fightSeq = 0;
    let lastTemplate = null;
    let pendingNeg = null;
    let dirty = true;
    const alertCooldown = {};

    // ── утилиты ──
    const now = () => Date.now();
    const cut = (o, n) => { try { const s = JSON.stringify(o); return s.length > n ? s.slice(0, n) + '…' : s; } catch (e) { return String(o); } };
    const key = r => (r && r.requestClass) + '.' + (r && r.requestMethod);
    function pushCap(arr, item, cap) { arr.push(item); if (arr.length > cap) arr.splice(0, arr.length - cap); }

    // полное название из метаданных: «D3: Xiwait»
    function provFull(id) {
      const m = persist.meta.maps[S.bg.mapId];
      if (m && m.provinces) {
        const p = m.provinces.find(x => (x.id || 0) === id);
        if (p) return p.name;
      }
      return '#' + id;
    }
    // как подписано на игровой карте: код и первая буква названия — «D3: X»
    function provName(id) {
      const f = provFull(id);
      const g = /^([A-Z0-9]+):\s*(\S)/.exec(f);
      return g ? g[1] + ': ' + g[2].toUpperCase() : f;
    }
    function pName(pid) {
      const p = S.bg.participants[pid];
      return p ? p.name : (pid == null ? '—' : String(pid));
    }

    // ── метаданные ──
    function setMeta(kind, data) {
      if (!data) return;
      if (/guild_battleground_maps/.test(kind) && Array.isArray(data)) {
        for (const m of data) if (m && m.id) persist.meta.maps[m.id] = { id: m.id, provinces: (m.provinces || []).map(p => ({ id: p.id || 0, name: p.name, connections: p.connections })) };
      } else if (/battleground_buildings/.test(kind) && Array.isArray(data)) {
        for (const b of data) if (b && b.id) persist.meta.buildings[b.id] = { name: b.name, description: b.description, buildingTime: b.buildingTime, cost: b.instantFinishPremiumCost };
      } else if (/battleground_colour/.test(kind) && Array.isArray(data)) {
        persist.meta.colours = {};
        for (const c of data) if (c && c.id) persist.meta.colours[c.id] = c.mainColour || c.province;
      }
      dirty = true;
    }

    // ── поиск новых полей ──
    function collectPaths(o, p, depth, out) {
      if (out.size > 400 || depth > 6 || o == null) return;
      if (Array.isArray(o)) { for (let i = 0; i < Math.min(o.length, 6); i++) collectPaths(o[i], p + '[]', depth + 1, out); return; }
      if (typeof o !== 'object') return;
      for (const k of Object.keys(o)) {
        if (k === 'stepHistory' || k === 'unitsOrder' || k === 'pos' || k === 'startpos' || k === 'path') { out.add(p + '.' + k); continue; }
        if (k === '__class__') { out.add(p + '<' + o[k] + '>'); continue; }
        if (k === '__enum__') { out.add(p + '{' + o[k] + '}'); continue; }
        // ключи-числа (словари по id) схлопываем
        const kk = /^-?\d+$/.test(k) ? '#' : k;
        out.add(p + '.' + kk);
        collectPaths(o[k], p + '.' + kk, depth + 1, out);
      }
    }
    function trackSchema(r, t) {
      const k = key(r);
      if (!SCHEMA_CLASS_RE.test(k)) return;
      const out = new Set();
      collectPaths(r.responseData, '', 0, out);
      let known = persist.schema[k];
      const isNewMethod = !known;
      if (!known) known = persist.schema[k] = {};
      const fresh = [];
      for (const p of out) if (!(p in known)) { known[p] = t; fresh.push(p); }
      if (isNewMethod) {
        S.discoveries.push({ t, kind: 'метод', method: k, path: '', sample: cut(r.responseData, 600) });
        hooks.onDiscovery && hooks.onDiscovery(S.discoveries[S.discoveries.length - 1]);
      } else if (fresh.length) {
        for (const p of fresh.slice(0, 30)) S.discoveries.push({ t, kind: 'поле', method: k, path: p, sample: cut(r.responseData, 400) });
        hooks.onDiscovery && hooks.onDiscovery(S.discoveries[S.discoveries.length - 1]);
      }
      if (S.discoveries.length > 2000) S.discoveries.splice(0, S.discoveries.length - 2000);
    }

    // ── провинции ──
    function normProvince(p) {
      const prog = {};
      for (const c of (p.conquestProgress || [])) prog[c.participantId] = { p: c.progress, max: c.maxProgress };
      return {
        id: p.id || 0,
        owner: p.ownerId == null ? null : p.ownerId,
        vp: p.victoryPoints == null ? null : p.victoryPoints,
        vpBonus: p.victoryPointsBonus == null ? null : p.victoryPointsBonus,
        lockedUntil: p.lockedUntil || null,
        att: p.gainAttritionChance == null ? null : p.gainAttritionChance,
        slotsUsed: p.usedBuildingSlots || 0,
        slotsTotal: p.totalBuildingSlots || 0,
        atk: !!p.isAttackBattleType,
        spawn: !!p.isSpawnSpot,
        prog,
      };
    }
    function applyProvince(raw, t, source) {
      const np = normProvince(raw);
      const prev = S.bg.provinces[np.id];
      S.bg.provinces[np.id] = np;
      if (!prev) return;
      if (prev.owner !== np.owner) {
        const cap = { t, id: np.id, name: provName(np.id), from: prev.owner, to: np.owner, fromName: pName(prev.owner), toName: pName(np.owner), lockedUntil: np.lockedUntil };
        S.captures.push(cap);
        hooks.onCapture && hooks.onCapture(cap);
        return; // прогресс после захвата обнуляется — не считаем как удары
      }
      for (const pid of Object.keys(np.prog)) {
        const cur = np.prog[pid];
        const before = prev.prog[pid] ? prev.prog[pid].p : 0;
        const delta = cur.p - before;
        if (delta <= 0) continue;
        const ev = { t, id: np.id, pid: +pid, delta, p: cur.p, max: cur.max, owner: np.owner, src: source };
        pushCap(S.activity, ev, cfg.activityLimit);
        if (np.owner === S.bg.myPid && +pid !== S.bg.myPid) maybeAlert(ev);
      }
    }
    function maybeAlert(ev) {
      if (ev.max && ev.p / ev.max * 100 < cfg.alertMinProgress) return;
      const last = alertCooldown[ev.id] || 0;
      if (ev.t - last < cfg.alertCooldownSec * 1000) return;
      alertCooldown[ev.id] = ev.t;
      const a = { t: ev.t, id: ev.id, name: provName(ev.id), pid: ev.pid, who: pName(ev.pid), p: ev.p, max: ev.max };
      pushCap(S.alerts, a, 500);
      hooks.onAlert && hooks.onAlert(a);
    }

    function setBattleground(rd, t) {
      const bg = S.bg;
      if (rd.map && rd.map.id) bg.mapId = rd.map.id;
      if (rd.league) bg.league = { id: rd.league.id, name: rd.league.name, rating: rd.league.rating, beast: !!rd.league.isBattleOfTheBeast, extra: Object.keys(rd.league).filter(k => !['id', 'name', 'rating', 'isBattleOfTheBeast', '__class__'].includes(k)) };
      if (rd.endsAt) bg.endsAt = rd.endsAt;
      if (rd.activeTrial != null) bg.activeTrial = rd.activeTrial;
      if (rd.currentParticipantId != null) bg.myPid = rd.currentParticipantId;
      if (rd.storeId) bg.storeId = rd.storeId;
      if (rd.map && rd.map.pendingUpdate) bg.pendingUpdate = rd.map.pendingUpdate;
      const vp = {};
      for (const p of (rd.battlegroundParticipants || [])) {
        bg.participants[p.participantId] = { name: p.clan && p.clan.name, clanId: p.clan && p.clan.id, members: p.clan && p.clan.membersNum, colour: p.colour, vp: p.victoryPoints };
        vp[p.participantId] = p.victoryPoints;
        if (p.signals) bg.signals[p.participantId] = p.signals.map(s => ({ id: s.provinceId, s: s.signal }));
      }
      S.vpHistory.push({ t, vp });
      if (rd.currentPlayerParticipant) setParticipant(rd.currentPlayerParticipant, t);
      if (rd.map && rd.map.provinces) for (const p of rd.map.provinces) applyProvince(p, t, 'snapshot');
    }

    function setParticipant(rd, t) {
      if (rd.activeTrial != null) S.bg.activeTrial = rd.activeTrial;
      const a = rd.attrition;
      if (!a) return null;
      if (S.attrition && a.level < S.attrition.level && a.level <= 1) { S.dayResets = S.dayResets || []; S.dayResets.push(t); }
      S.attrition = { level: a.level, bonus: a.defendingArmyBonus, neg: a.negotiationMultiplier, t };
      const c = persist.curve[a.level] || (persist.curve[a.level] = { bonus: a.defendingArmyBonus, neg: a.negotiationMultiplier, n: 0 });
      if (c.bonus !== a.defendingArmyBonus || c.neg !== a.negotiationMultiplier) { c.conflict = (c.conflict || 0) + 1; c.lastBonus = a.defendingArmyBonus; c.lastNeg = a.negotiationMultiplier; }
      c.n++;
      const extra = Object.keys(a).filter(k => !['level', 'negotiationMultiplier', 'defendingArmyBonus', '__class__'].includes(k));
      if (extra.length) S.attrition.extra = extra.reduce((o, k) => (o[k] = a[k], o), {});
      return S.attrition;
    }

    // ── бой ──
    function parseWave(rd) {
      const bt = rd.battleType || {};
      const st = rd.state || {};
      const own = [], enemy = [];
      for (const u of (st.unitsOrder || [])) {
        const rec = { type: u.unitTypeId, hp0: u.startHitpoints, hp1: u.currentHitpoints || 0 };
        if (u.teamFlag === 1) own.push(rec); else enemy.push(rec);
      }
      let points = null, details = null, nextFight = null;
      const rk = st.ranking_data;
      if (rk) {
        const me = (rk.ranking || []).find(x => x.player && x.player.player_id === rd.attackerPlayerId);
        if (me) {
          points = me.points == null ? null : me.points;
          details = me.battle_result_details || null;
          if (me.player && me.player.name) S.session.playerName = me.player.name;
        }
        if (rk.nextArmy && rk.nextArmy.fightType) nextFight = rk.nextArmy.fightType.value;
      }
      if (rd.attackerPlayerId) S.session.playerId = rd.attackerPlayerId;
      return {
        wave: bt.currentWaveId || 0, total: bt.totalWaves || 1, win: st.winnerBit === 1, rounds: st.round,
        battleId: rd.battleId, auto: !!rd.isAutoBattle, era: bt.era, trial: bt.trial, battlesWon: bt.battlesWon,
        ownHpLost: own.reduce((s, u) => s + Math.max(0, (u.hp0 || 0) - u.hp1), 0),
        ownDead: own.filter(u => !u.hp1).length,
        own: own.map(u => u.type), enemy: enemy.map(u => u.type),
        points, details, nextFight, ais: rd.ais,
      };
    }

    function startFight(pid, t, type, att0) {
      const prov = S.bg.provinces[pid];
      att0 = att0 || S.attrition;
      return {
        id: ++fightSeq, type, tStart: t, tEnd: null, province: pid, name: provName(pid),
        owner: prov ? prov.owner : null, ownerName: prov ? pName(prov.owner) : null,
        attChance: prov ? prov.att : null, progBefore: prov && S.bg.myPid != null && prov.prog[S.bg.myPid] ? prov.prog[S.bg.myPid].p : null,
        progMax: prov && S.bg.myPid != null && prov.prog[S.bg.myPid] ? prov.prog[S.bg.myPid].max : null,
        attBefore: att0 ? att0.level : null, bonusBefore: att0 ? att0.bonus : null,
        template: lastTemplate, trial: S.bg.activeTrial, waves: [], result: null, rewards: [],
      };
    }

    // ── основной разбор пачки ──
    function ingest(kind, reqs, resps, t) {
      t = t || now();
      S.session.lastActive = t;
      S.counters.batches++;
      S.counters[kind] = (S.counters[kind] || 0) + 1;
      reqs = Array.isArray(reqs) ? reqs : (reqs ? [reqs] : []);
      resps = Array.isArray(resps) ? resps : (resps ? [resps] : []);
      const batch = { completed: null, participant: null, rewards: [], negDone: false };
      const att0 = S.attrition ? Object.assign({}, S.attrition) : null; // усталость до этой пачки

      // запросы
      for (const q of reqs) {
        if (!q || !q.requestClass) continue;
        const k = key(q);
        const d0 = (q.requestData || [])[0];
        if (k === 'ArmyUnitManagementService.saveTemplate' && d0) lastTemplate = d0.unitTypeIds || null;
        if (/Negotiation/.test(q.requestClass)) {
          const pid = findProvinceId(q.requestData);
          if (pid != null) pendingNeg = { province: pid, t };
          pushCap(S.actions, { t, k, data: cut(q.requestData, 300) }, 3000);
        } else if (/Battleground/.test(q.requestClass) && !/^get/.test(q.requestMethod)) {
          pushCap(S.actions, { t, k, data: cut(q.requestData, 500) }, 3000);
        }
      }

      // ответы
      for (const r of resps) {
        if (!r || !r.requestClass) continue;
        const k = key(r);
        const rd = r.responseData;
        try { trackSchema(r, t); } catch (e) { /* не мешаем игре */ }
        switch (k) {
          case 'TimeService.updateTime':
            if (rd && rd.time) {
              const off = rd.time * 1000 + 500 - t; // сервер отдаёт целые секунды
              S.timeOffset = S.timeOffset == null ? off : Math.round(S.timeOffset * 0.8 + off * 0.2);
            }
            break;
          case 'GuildBattlegroundStateService.getState':
            S.state = rd; break;
          case 'GuildBattlegroundService.getBattleground':
            setBattleground(rd, t); break;
          case 'GuildBattlegroundService.getProvinces':
            for (const p of (rd || [])) applyProvince(p, t, kind); break;
          case 'GuildBattlegroundService.getPlayerLeaderboard':
            addGuildSnap(rd, t); break;
          case 'GuildBattlegroundService.getPlayerParticipant':
            batch.participant = setParticipant(rd, t); break;
          case 'BattlefieldService.startByBattleType': {
            if (!rd || !rd.battleType || rd.battleType.type !== 'battleground') break;
            const w = parseWave(rd);
            const pid = rd.battleType.provinceId;
            if (!curFight || curFight.province !== pid || w.wave === 0 || curFight.type !== 'battle') curFight = startFight(pid, t, 'battle', att0);
            curFight.waves.push(w);
            curFight.auto = w.auto; curFight.era = w.era; curFight.trial = w.trial; curFight.totalWaves = w.total;
            if (!w.win || w.wave + 1 >= w.total) { curFight.result = w.win ? 'win' : 'loss'; batch.completed = curFight; curFight = null; }
            break;
          }
          case 'BattlefieldService.getArmyPreview': {
            const pid = findProvinceId(reqFor(reqs, r));
            if (pid == null || !Array.isArray(rd)) break;
            S.previews[pid] = { t, waves: rd.map(a => ({ id: a.id, units: countTypes((a.units || []).map(u => u.unitTypeId)), boost: ((a.units || [])[0] && (a.units[0].bonuses || []).reduce((s, b) => s + (b.type === 'military_boost' ? b.value : 0), 0)) || 0 })) };
            break;
          }
          case 'RewardService.collectReward': {
            let list = rd, ctx = null;
            if (Array.isArray(rd) && Array.isArray(rd[0])) { list = rd[0]; ctx = rd[1]; }
            for (const rw of (Array.isArray(list) ? list : [])) {
              const rec = { t, ctx, type: rw.type, subType: rw.subType, rid: rw.id, amount: rw.amount, name: rw.name, flags: rw.flags, fightId: null };
              if (rw.assembledReward) rec.assembled = rw.assembledReward.name, rec.required = rw.requiredAmount;
              S.rewards.push(rec); batch.rewards.push(rec);
            }
            break;
          }
          case 'ResourceService.getPlayerResourceBag': {
            const res = rd && rd.resources && rd.resources.resources;
            if (!res) break;
            const pick = {};
            for (const kk of Object.keys(res)) if (/^gbg_|battleground|strategy_points|guild_championship/.test(kk)) pick[kk] = res[kk];
            if (!S.resources.first) S.resources.first = { t, v: pick };
            S.resources.last = { t, v: pick };
            break;
          }
          default:
            if (/Negotiation/.test(r.requestClass)) {
              S.negotiations.push({ t, k, data: cut(rd, 1500) });
              const st = rd && (rd.state || rd.status || rd.result);
              if (st && /won|lost|win|loss|success|fail/i.test(JSON.stringify(st))) batch.negDone = /won|win|success/i.test(JSON.stringify(st)) ? 'win' : 'loss';
            } else if (/Battleground/.test(r.requestClass) && !['GuildBattlegroundService.getBattleground'].includes(k)) {
              pushCap(S.unknown, { t, k, data: cut(rd, 3000) }, 500);
            }
        }
      }

      // завершение боя/переговоров
      let f = batch.completed;
      if (!f && batch.participant && (batch.negDone || (pendingNeg && t - pendingNeg.t < 120000 && !reqs.some(q => q && q.requestMethod === 'startByBattleType')))) {
        if (pendingNeg) { f = startFight(pendingNeg.province, pendingNeg.t, 'negotiation', att0); f.result = batch.negDone || 'win?'; }
      }
      if (f) {
        f.tEnd = t;
        f.attAfter = batch.participant ? batch.participant.level : (S.attrition ? S.attrition.level : null);
        f.attGain = (f.attAfter != null && f.attBefore != null) ? f.attAfter - f.attBefore : null;
        f.bonusAfter = S.attrition ? S.attrition.bonus : null;
        f.rewards = batch.rewards.filter(x => !x.ctx || /battleground/i.test(x.ctx)).map(x => { x.fightId = f.id; return { subType: x.subType, amount: x.amount, name: x.name, ctx: x.ctx }; });
        S.fights.push(f);
        if (f.type === 'negotiation') pendingNeg = null;
        hooks.onFight && hooks.onFight(f);
      }

      // сырой лог
      if (cfg.rawLog) {
        const data = resps.filter(r => r && !RAW_SKIP.has(key(r))).map(leanResponse);
        const req = reqs.filter(q => q && !RAW_SKIP.has(key(q)));
        if (data.length || req.length) pushCap(S.raw, { t: new Date(t).toISOString(), kind, req: req.length ? req : undefined, data }, cfg.rawLimit);
      }
      dirty = true;
    }

    function reqFor(reqs, r) {
      const q = reqs.find(x => x && x.requestId === r.requestId && x.requestMethod === r.requestMethod);
      return q ? q.requestData : null;
    }
    function findProvinceId(o, depth) {
      depth = depth || 0;
      if (o == null || depth > 4) return null;
      if (Array.isArray(o)) { for (const x of o) { const v = findProvinceId(x, depth + 1); if (v != null) return v; } return null; }
      if (typeof o === 'object') {
        if (typeof o.provinceId === 'number') return o.provinceId;
        for (const k of Object.keys(o)) { const v = findProvinceId(o[k], depth + 1); if (v != null) return v; }
      }
      return null;
    }
    function countTypes(list) { const c = {}; for (const x of list) c[x] = (c[x] || 0) + 1; return c; }

    // облегчение сырых ответов: тяжёлые части заменяются сводками
    function leanResponse(r) {
      const k = key(r);
      const rd = r.responseData;
      const base = { requestClass: r.requestClass, requestMethod: r.requestMethod, requestId: r.requestId };
      if (k === 'ArmyUnitManagementService.getArmyInfo' && rd) {
        const units = rd.units || [];
        return Object.assign(base, { responseData: { __summary: true, units: units.length, wounded: units.filter(u => u.currentHitpoints != null && u.currentHitpoints < 10).length, counts: rd.counts, templates: rd.templates } });
      }
      if (k === 'ResourceService.getPlayerResourceBag' && rd) {
        const res = (rd.resources && rd.resources.resources) || {};
        const pick = {}; for (const kk of Object.keys(res)) if (/^gbg_|battleground|strategy_points|guild_championship/.test(kk)) pick[kk] = res[kk];
        return Object.assign(base, { responseData: { __summary: true, resources: pick } });
      }
      if (k === 'BattlefieldService.startByBattleType' && rd && rd.state) {
        const st = rd.state;
        const rk = st.ranking_data ? Object.assign({}, st.ranking_data, { nextArmy: st.ranking_data.nextArmy ? { fightType: st.ranking_data.nextArmy.fightType, units: (st.ranking_data.nextArmy.units || []).map(u => u.unitTypeId) } : undefined, ranking: (st.ranking_data.ranking || []).map(x => ({ place: x.place, player: x.player && { player_id: x.player.player_id, name: x.player.name }, total_points: x.total_points, points: x.points, fights: x.fights, battle_result_details: x.battle_result_details })) }) : undefined;
        return Object.assign(base, { responseData: Object.assign({}, rd, { state: { winnerBit: st.winnerBit, round: st.round, steps: (st.stepHistory || []).length, unitsOrder: (st.unitsOrder || []).map(u => ({ unitId: u.unitId, teamFlag: u.teamFlag, unitTypeId: u.unitTypeId, startHitpoints: u.startHitpoints, currentHitpoints: u.currentHitpoints })), ranking_data: rk } }) });
      }
      if (k === 'BattlefieldService.getArmyPreview' && Array.isArray(rd)) {
        return Object.assign(base, { responseData: rd.map(a => ({ id: a.id, units: (a.units || []).map(u => ({ unitTypeId: u.unitTypeId, bonuses: u.bonuses, abilities: (u.abilities || []).map(x => x.type) })) })) });
      }
      return r;
    }

    // ── статистика ──
    function stats() {
      const fights = S.fights;
      const out = { fights: fights.length, wins: 0, losses: 0, battles: 0, negs: 0, waves: {}, withReward: 0, coins: {}, rewardCount: {}, byProv: {}, byChance: {}, hpLost: 0, points: 0 };
      for (const f of fights) {
        if (f.result === 'loss') out.losses++; else out.wins++;
        if (f.type === 'battle') out.battles++; else out.negs++;
        if (f.totalWaves) out.waves[f.totalWaves] = (out.waves[f.totalWaves] || 0) + 1;
        if (f.rewards.length) out.withReward++;
        for (const w of f.waves) { out.hpLost += w.ownHpLost || 0; out.points += w.points || 0; }
        for (const r of f.rewards) {
          out.coins[r.subType] = (out.coins[r.subType] || 0) + (r.amount || 0);
          out.rewardCount[r.subType] = (out.rewardCount[r.subType] || 0) + 1;
        }
        const bp = out.byProv[f.province] || (out.byProv[f.province] = { id: f.province, name: f.name, n: 0, rew: 0, gain: 0, gainKnown: 0, chance: f.attChance, coins: {} });
        bp.n++; if (f.rewards.length) bp.rew++;
        if (f.attGain != null) { bp.gain += f.attGain; bp.gainKnown++; }
        for (const r of f.rewards) bp.coins[r.subType] = (bp.coins[r.subType] || 0) + r.amount;
        const ck = f.attChance == null ? 'нет данных' : f.attChance + '%';
        const bc = out.byChance[ck] || (out.byChance[ck] = { n: 0, gain: 0 });
        if (f.attGain != null) { bc.n++; bc.gain += f.attGain; }
      }
      const span = fights.length > 1 ? (fights[fights.length - 1].tEnd - fights[0].tStart) / 60000 : 0;
      out.perMin = span > 0 ? fights.length / span : null;
      out.dropRate = fights.length ? out.withReward / fights.length : null;
      return out;
    }

    // Темп ударов: по последней минуте (быстро реагирует на наплыв), если там мало данных — по всему окну.
    // Делим на время «до сейчас», поэтому если удары прекратились, темп сам снижается, а время до взятия растёт.
    function activitySummary(windowMin, at) {
      const nowT = at || now();
      const since = nowT - (windowMin || cfg.activityWindowMin) * 60000;
      const recentSince = nowT - 60000;
      const m = {};
      for (let i = S.activity.length - 1; i >= 0; i--) {
        const a = S.activity[i];
        if (a.t < since) break;
        const k = a.id + ':' + a.pid;
        const x = m[k] || (m[k] = { id: a.id, name: provName(a.id), pid: a.pid, who: pName(a.pid), hits: 0, recent: 0, rFirst: null, first: a.t, last: a.t, p: a.p, max: a.max, owner: a.owner });
        x.hits += a.delta; x.first = Math.min(x.first, a.t);
        if (a.t >= recentSince) { x.recent += a.delta; x.rFirst = x.rFirst == null ? a.t : Math.min(x.rFirst, a.t); }
      }
      const list = Object.values(m).map(x => {
        // актуальное состояние провинции важнее последнего события
        const prov = S.bg.provinces[x.id];
        const cur = prov && prov.prog[x.pid];
        if (prov) x.owner = prov.owner;
        if (cur) { x.p = cur.p; x.max = cur.max; }
        x.done = !!prov && (prov.owner === x.pid || !cur);
        let perSec;
        if (x.recent >= 3) perSec = x.recent / Math.max((nowT - x.rFirst) / 1000, 5);
        else perSec = x.hits / Math.max((nowT - x.first) / 1000, 30);
        x.rate = perSec * 60;
        x.etaSec = x.done || !x.max || perSec <= 0 ? null : Math.max(0, (x.max - x.p) / perSec);
        x.eta = x.etaSec == null ? null : x.etaSec / 60;
        x.idle = (nowT - x.last) / 1000;
        x.mine = x.owner === S.bg.myPid; x.own = x.pid === S.bg.myPid;
        return x;
      });
      return list.sort((a, b) => (a.done - b.done) || b.rate - a.rate);
    }

    function vpRates() {
      const h = S.vpHistory;
      if (h.length < 2) return {};
      const a = h[0], b = h[h.length - 1];
      const hrs = (b.t - a.t) / 3600000;
      const out = {};
      if (hrs <= 0) return out;
      for (const pid of Object.keys(b.vp)) if (a.vp[pid] != null) out[pid] = (b.vp[pid] - a.vp[pid]) / hrs;
      return out;
    }

    // ── гильдия: снимки таблицы игроков и разбивка по дням ПБГ ──
    function addGuildSnap(rd, t) {
      if (!Array.isArray(rd) || !rd.length) return;
      const g = S.guild || (S.guild = { names: {}, snaps: [] });
      const p = [];
      for (const e of rd) {
        const pl = e && e.player;
        if (!pl || pl.player_id == null) continue;
        g.names[pl.player_id] = pl.name;
        p.push([pl.player_id, e.battlesWon || 0, e.negotiationsWon || 0, e.attrition || 0, e.rank || null]);
      }
      if (!p.length) return;
      const last = g.snaps[g.snaps.length - 1];
      if (last && JSON.stringify(last.p) === JSON.stringify(p)) { last.t2 = t; return; } // без изменений — только время
      g.snaps.push({ t, p });
      if (g.snaps.length > 600) g.snaps.splice(1, g.snaps.length - 600); // первый снимок храним всегда
    }
    // время смены дня ПБГ (мс от начала суток UTC): по наблюдённому сбросу усталости, иначе по времени конца раунда
    function dayTod() {
      const r = S.dayResets && S.dayResets.length ? S.dayResets[S.dayResets.length - 1] : null;
      if (r) return Math.round((r % 86400000) / 1800000) * 1800000 % 86400000; // округляем до получаса
      if (S.bg.endsAt) return (S.bg.endsAt * 1000) % 86400000;
      return (86400000 - new Date().getTimezoneOffset() * -60000) % 86400000; // полночь по местному
    }
    function dayStart(t) { const tod = dayTod(); return Math.floor((t - tod) / 86400000) * 86400000 + tod; }
    // отчёт: по каждому игроку — всего за поле, по дням ПБГ и усталость
    function guildReport() {
      const g = S.guild || { names: {}, snaps: [] };
      const snaps = g.snaps.slice().sort((a, b) => a.t - b.t);
      if (!snaps.length) return null;
      const tEnd = x => x.t2 || x.t;
      const last = snaps[snaps.length - 1];
      const nowD = dayStart(serverNow());
      const firstD = dayStart(snaps[0].t);
      const days = [];
      for (let d = firstD; d <= nowD; d += 86400000) days.push(d);
      const byId = sn => { const m = {}; for (const r of sn.p) m[r[0]] = r; return m; };
      const maps = snaps.map(byId);
      const ids = new Set(); for (const sn of snaps) for (const r of sn.p) ids.add(r[0]);
      // охват каждого дня: от какого снимка до какого считаем.
      // Начало — последний снимок до смены дня (если он не старше 3 ч), иначе первый снимок внутри дня.
      const cover = {};
      for (const d of days) {
        let ref = -1, firstIn = -1, end = -1;
        for (let i = 0; i < snaps.length; i++) {
          if (tEnd(snaps[i]) <= d) ref = i;
          if (snaps[i].t >= d && snaps[i].t < d + 86400000) { if (firstIn < 0) firstIn = i; end = i; }
        }
        let from;
        if (ref >= 0 && d - tEnd(snaps[ref]) <= 3 * 3600000) from = ref;
        else if (firstIn >= 0) from = firstIn;
        else from = ref;
        const fromT = from < 0 ? null : from === ref ? tEnd(snaps[from]) : snaps[from].t;
        cover[d] = { from, end, fromT, endT: end >= 0 ? tEnd(snaps[end]) : null, approx: from < 0 || end < 0 || Math.abs(fromT - d) > 1800000 };
      }
      const players = [];
      for (const id of ids) {
        const cur = maps[maps.length - 1][id];
        const pl = { id, name: g.names[id] || String(id), rank: cur ? cur[4] : null, b: cur ? cur[1] : 0, n: cur ? cur[2] : 0, left: !cur, days: {} };
        // усталость: из последнего снимка, если он сегодняшний; иначе она уже сброшена
        pl.att = cur && tEnd(last) >= nowD ? cur[3] : 0;
        for (const d of days) {
          const c = cover[d];
          if (c.end < 0) continue;
          const e = maps[c.end][id];
          if (!e) continue;
          const single = c.from === c.end;
          const f = c.from >= 0 && !single ? maps[c.from][id] : null;
          let attMax = 0;
          for (let i = 0; i < snaps.length; i++) if (snaps[i].t >= d && snaps[i].t < d + 86400000 && maps[i][id]) attMax = Math.max(attMax, maps[i][id][3]);
          pl.days[d] = single ? { b: 0, n: 0, att: attMax, approx: true, single: true }
            : f ? { b: e[1] - f[1], n: e[2] - f[2], att: attMax, approx: c.approx }
            : { b: e[1], n: e[2], att: attMax, approx: true, joined: true };
        }
        players.push(pl);
      }
      return { days, cover, players, first: snaps[0].t, last: tEnd(last), count: snaps.length, today: nowD, tod: dayTod(), me: S.session.playerId };
    }
    function serverNow() { return Date.now() + (S.timeOffset || 0); }
    function neighbours(id) {
      const m = persist.meta.maps[S.bg.mapId];
      const p = m && m.provinces && m.provinces.find(x => x.id === id);
      return p && p.connections ? p.connections : null;
    }
    // можно ли напасть: чужая, не точка появления и граничит с нашей провинцией (null — карта неизвестна)
    function attackable(p) {
      if (!p || p.owner === S.bg.myPid || p.spawn) return false;
      const nb = neighbours(p.id);
      if (!nb) return null;
      return nb.some(id => S.bg.provinces[id] && S.bg.provinces[id].owner === S.bg.myPid);
    }
    // провинции, которые откроются в ближайшие windowMin минут (и только что открывшиеся — 30 с)
    function soonOpening(windowMin) {
      const now = serverNow() / 1000;
      const out = [];
      for (const p of Object.values(S.bg.provinces)) {
        if (!p.lockedUntil || p.spawn) continue;
        const rest = p.lockedUntil - now;
        if (rest < -30 || rest > windowMin * 60) continue;
        const mine = p.owner === S.bg.myPid;
        out.push({ p, rest, mine, atk: mine ? false : attackable(p) });
      }
      return out.sort((a, b) => a.rest - b.rest);
    }
    function setHost(h) { S.session.host = h; }
    function load(saved) { if (saved && saved.v === 1) { Object.assign(S, saved); fightSeq = S.fights.length ? S.fights[S.fights.length - 1].id : 0; } }
    function isDirty() { const d = dirty; dirty = false; return d; }
    function markDirty() { dirty = true; }
    function getCfg() { return cfg; }
    function setCfg(c) { Object.assign(cfg, c); dirty = true; }

    return { S, persist, ingest, setMeta, stats, activitySummary, vpRates, provName, provFull, pName, guildReport, dayStart, setHost, load, isDirty, markDirty, getCfg, setCfg, serverNow, attackable, soonOpening };
  }

  if (IS_NODE) { module.exports = { createCore, DEFAULT_CFG }; return; }

  // ═══════════════════════════ БРАУЗЕР: перехват ═══════════════════════════
  const W = window;
  if (W.__foeGbgLogger) return;
  const LS = 'foeGbgLogger.';
  const lsGet = (k, d) => { try { const v = localStorage.getItem(LS + k); return v ? JSON.parse(v) : d; } catch (e) { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(LS + k, JSON.stringify(v)); } catch (e) { /* переполнение — пропускаем */ } };

  const persist = { curve: lsGet('curve', {}), schema: lsGet('schema', null), meta: lsGet('meta', { maps: {}, buildings: {} }) };
  if (!persist.schema) persist.schema = BASELINE_SCHEMA();
  const ui = {};
  const core = createCore(lsGet('cfg', {}), persist, {
    onAlert: a => ui.alert && ui.alert(a),
    onCapture: c => ui.capture && ui.capture(c),
    onFight: f => ui.fight && ui.fight(f),
    onDiscovery: d => ui.discovery && ui.discovery(d),
  });
  core.setHost(location.host);
  W.__foeGbgLogger = core; // доступ из консоли: __foeGbgLogger.S

  const safe = fn => { try { fn(); } catch (e) { console.warn('[ПБГ логгер]', e); } };
  const META_RE = /(guild_battleground_maps|battleground_buildings|battleground_colour)/;

  function handleGameJson(bodyText, respText, kind) {
    let reqs = null, resps = null;
    try { reqs = bodyText ? JSON.parse(bodyText) : null; } catch (e) { reqs = null; }
    try { resps = typeof respText === 'string' ? JSON.parse(respText) : respText; } catch (e) { return; }
    if (!resps) return;
    // список метаданных → догружаем нужные, если их ещё нет
    for (const r of (Array.isArray(resps) ? resps : [resps])) {
      if (r && r.requestClass === 'StaticDataService' && Array.isArray(r.responseData)) {
        for (const m of r.responseData) {
          if (m && m.identifier && META_RE.test(m.identifier) && m.url) fetchMeta(m.identifier, m.url);
        }
      }
    }
    trackLocation(reqs);
    core.ingest(kind, reqs, resps, Date.now());
  }

  // ── где сейчас игрок: на ПБГ или нет ──
  // Игра сама шлёт LogService.logPerformanceMetrics с полем module ("BG" на Полях битв, "City" в городе и т.д.)
  // при входе в раздел и примерно раз в 30 с. Плюс явные признаки входа (открытие карты, бой ПБГ) и выхода.
  const LEAVE_RE = /^(CityMapService\.getCityMap|OtherPlayerService\.visitPlayer|GuildExpeditionService\.getOverview|PVPArenaService\.getOverview|CampaignService\.start)$/;
  let onGbg = false;
  function trackLocation(reqs) {
    for (const q of (Array.isArray(reqs) ? reqs : [])) {
      if (!q || !q.requestClass) continue;
      const k = q.requestClass + '.' + q.requestMethod;
      const d0 = (q.requestData || [])[0];
      if (k === 'LogService.logPerformanceMetrics' && d0 && d0.module) setOnGbg(d0.module === 'BG');
      else if (k === 'GuildBattlegroundService.getBattleground' || k === 'GuildBattlegroundStateService.getState') setOnGbg(true);
      else if (k === 'BattlefieldService.startByBattleType' && d0 && d0.type === 'battleground') setOnGbg(true);
      else if (LEAVE_RE.test(k)) setOnGbg(false);
    }
  }
  function setOnGbg(v) {
    if (onGbg === v) return;
    onGbg = v;
    if (!v) forceShow = false;
    ui.applyVis && ui.applyVis();
  }
  // игра шлёт тело запроса бинарным буфером (Uint8Array/ArrayBuffer), а не строкой
  const TD = new TextDecoder();
  function bodyToText(b) {
    try {
      if (typeof b === 'string') return b;
      if (b instanceof ArrayBuffer) return TD.decode(new Uint8Array(b));
      if (ArrayBuffer.isView(b)) return TD.decode(new Uint8Array(b.buffer, b.byteOffset, b.byteLength));
    } catch (e) { /* не текст */ }
    return null;
  }
  const metaFetched = {};
  function fetchMeta(id, url) {
    const kind = (id.match(META_RE) || [])[1];
    if (!kind || metaFetched[kind]) return;
    metaFetched[kind] = true;
    W.fetch(url).then(r => r.json()).then(d => { core.setMeta(kind, d); lsSet('meta', persist.meta); }).catch(() => { metaFetched[kind] = false; });
  }

  // XHR
  const XO = W.XMLHttpRequest.prototype.open, XS = W.XMLHttpRequest.prototype.send;
  W.XMLHttpRequest.prototype.open = function (m, url) { this.__gbgUrl = String(url || ''); return XO.apply(this, arguments); };
  W.XMLHttpRequest.prototype.send = function (body) {
    const url = this.__gbgUrl || '';
    if (/\/game\/json/.test(url)) {
      const bodyText = bodyToText(body); // декодируем сразу: буфер игра может переиспользовать
      this.addEventListener('load', () => safe(() => {
        const t = this.responseType;
        const resp = (t === '' || t === 'text') ? this.responseText : (t === 'json' ? this.response : null);
        if (resp) handleGameJson(bodyText, resp, 'xhr');
      }));
    } else if (META_RE.test(url)) {
      const kind = url.match(META_RE)[1];
      this.addEventListener('load', () => safe(() => {
        const t = this.responseType;
        const d = (t === '' || t === 'text') ? JSON.parse(this.responseText) : (t === 'json' ? this.response : null);
        if (d) { core.setMeta(kind, d); metaFetched[kind] = true; lsSet('meta', persist.meta); }
      }));
    }
    return XS.apply(this, arguments);
  };

  // fetch (на случай, если игра перейдёт на него)
  const FO = W.fetch;
  W.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const p = FO.apply(this, arguments);
    if (/\/game\/json/.test(url)) {
      const body = init ? bodyToText(init.body) : null;
      p.then(r => r.clone().text()).then(txt => safe(() => handleGameJson(body, txt, 'xhr'))).catch(() => {});
    }
    return p;
  };

  // WebSocket
  const NWS = W.WebSocket;
  function WrappedWS(url, protocols) {
    const ws = protocols === undefined ? new NWS(url) : new NWS(url, protocols);
    ws.addEventListener('message', ev => safe(() => {
      if (typeof ev.data !== 'string' || ev.data[0] !== '[' && ev.data[0] !== '{') return;
      handleGameJson(null, ev.data, 'ws');
    }));
    return ws;
  }
  WrappedWS.prototype = NWS.prototype;
  ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach(k => { WrappedWS[k] = NWS[k]; });
  W.WebSocket = WrappedWS;

  // ═══════════════════════════ хранение сессии ═══════════════════════════
  const DB = 'foeGbgLogger', STORE = 'sessions';
  function idb() {
    return new Promise((res, rej) => {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE);
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
  }
  async function idbPut(k, v) { const db = await idb(); return new Promise((res, rej) => { const tx = db.transaction(STORE, 'readwrite'); tx.objectStore(STORE).put(v, k); tx.oncomplete = res; tx.onerror = () => rej(tx.error); }); }
  async function idbGet(k) { const db = await idb(); return new Promise((res, rej) => { const tx = db.transaction(STORE, 'readonly'); const q = tx.objectStore(STORE).get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); }
  const SESSION_KEY = 'current:' + location.host;

  // продолжаем сессию после перезагрузки, если раунд ПБГ ещё идёт
  idbGet(SESSION_KEY).then(saved => {
    if (!saved || saved.v !== 1) return;
    const alive = saved.bg && saved.bg.endsAt ? saved.bg.endsAt * 1000 > Date.now() : (Date.now() - saved.session.lastActive < 6 * 3600000);
    if (!alive || core.S.counters.batches > 50) return;
    // объединяем: сохранённое + то, что успело прийти до загрузки
    const fresh = core.S;
    const merged = Object.assign({}, saved);
    merged.fights = saved.fights.concat(fresh.fights);
    merged.rewards = saved.rewards.concat(fresh.rewards);
    merged.activity = saved.activity.concat(fresh.activity);
    merged.raw = saved.raw.concat(fresh.raw);
    merged.captures = saved.captures.concat(fresh.captures);
    merged.vpHistory = saved.vpHistory.concat(fresh.vpHistory);
    if (fresh.bg.mapId) merged.bg = fresh.bg;
    if (fresh.attrition) merged.attrition = fresh.attrition;
    core.load(merged);
    core.markDirty();
  }).catch(() => {});

  let saving = false;
  setInterval(() => {
    if (saving) return;
    saving = true;
    lsSet('curve', persist.curve); lsSet('schema', persist.schema);
    idbPut(SESSION_KEY, core.S).catch(() => {}).finally(() => { saving = false; });
  }, 20000);

  // ═══════════════════════════════ ИНТЕРФЕЙС ═══════════════════════════════
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmt = n => n == null ? '—' : (typeof n === 'number' ? n.toLocaleString('ru-RU', { maximumFractionDigits: 1 }) : n);
  const pct = x => x == null ? '—' : (x * 100).toFixed(0) + '%';
  const hm = ts => { const d = new Date(ts); return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' }); };
  // до 1 минуты — посекундно «0:42», до 5 минут — «4:17», дальше — «1ч 12м»
  function timer(sec) {
    if (!sec) return { txt: '', cls: '', rest: null };
    const rest = sec - core.serverNow() / 1000;
    if (rest <= 0) return { txt: 'открыта', cls: 'good', rest };
    const r = Math.ceil(rest);
    if (r < 300) { const m = Math.floor(r / 60), ss = String(r % 60).padStart(2, '0'); return { txt: m + ':' + ss, cls: r < 60 ? 'bad blink' : 'warn', rest }; }
    const h = Math.floor(r / 3600), m = Math.floor(r % 3600 / 60);
    return { txt: (h ? h + 'ч ' : '') + m + 'м', cls: '', rest };
  }
  const left = sec => { const t = timer(sec); return t.txt ? `<span class="${t.cls}">${t.txt}</span>` : ''; };
  const capped = () => { const a = core.S.attrition; return !!(a && a.level >= core.getCfg().capLevel); };
  const COIN = { gbg_silver_coin: 'Серебро', gbg_gold_coin: 'Золото', gbg_platinum_coin: 'Платина' };
  const coinName = k => COIN[k] || k;

  const CSS = `
  #gbgL{position:fixed;z-index:2147483646;width:470px;max-height:72vh;display:flex;flex-direction:column;font:12px/1.35 system-ui,Segoe UI,Arial,sans-serif;color:#e8e6df;background:rgba(24,26,30,.96);border:1px solid #3a3f47;border-radius:8px;box-shadow:0 6px 24px rgba(0,0,0,.5)}
  #gbgI{position:fixed;z-index:2147483647;width:46px;height:46px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:radial-gradient(circle at 35% 30%,#3b4250,#1b1e23);border:2px solid #c9a227;box-shadow:0 3px 12px rgba(0,0,0,.55);cursor:grab;user-select:none;touch-action:none}
  #gbgI:hover{border-color:#f0c94a}
  #gbgI.drag{cursor:grabbing}
  #gbgI svg{width:26px;height:26px;pointer-events:none}
  #gbgI .bdg{position:absolute;right:-6px;bottom:-5px;min-width:18px;height:18px;padding:0 4px;box-sizing:border-box;border-radius:9px;background:#2d3239;border:1px solid #555d68;color:#e8e6df;font:700 11px/16px system-ui,Segoe UI,Arial,sans-serif;text-align:center}
  #gbgI .bdg.bad{background:#b3261e;border-color:#ff6b6b;color:#fff}
  #gbgI .bdg.soon{background:#8a5a00;border-color:#ffb454;color:#fff}
  #gbgI .bdg.max{background:#5c4a12;border-color:#c9a227;color:#f0c94a}
  #gbgI .bdg.tick{animation:gbgB 1s steps(2) infinite}
  @keyframes gbgB{50%{background:#ff6b6b}}
  #gbgL .blink{animation:gbgB2 1s steps(2) infinite;font-weight:700}
  @keyframes gbgB2{50%{opacity:.35}}
  #gbgL tr.hot td{background:rgba(255,107,107,.12)}
  #gbgL .mm{display:flex;flex-direction:column;align-items:center;margin:2px 0 6px}
  #gbgL .mm svg{width:100%;max-width:330px;height:auto;display:block}
  #gbgL .mm path{stroke:#15171a;stroke-width:.4;cursor:pointer}
  #gbgL .mm path.atk{stroke:#fff;stroke-width:.7;stroke-dasharray:1.6 1.2}
  #gbgL .mm path.soon{stroke:#ffb454;stroke-width:1.1;stroke-dasharray:none}
  #gbgL .mm path.near{stroke:#ffb454;stroke-width:1.8;stroke-dasharray:none}
  #gbgL .mm path.hot{stroke:#ff4d4d;stroke-width:2.2;stroke-dasharray:none;animation:gbgB2 1s steps(2) infinite}
  #gbgL .mm path.def{stroke:#6ec3ff;stroke-width:1.1;stroke-dasharray:none}
  #gbgL .mm path.sel{stroke:#fff;stroke-width:1.6;stroke-dasharray:none}
  #gbgL .mm text{pointer-events:none;font:700 5px system-ui,Arial,sans-serif;fill:#fff;paint-order:stroke;stroke:#000;stroke-width:1.2px;text-anchor:middle;dominant-baseline:central}
  #gbgL .mm text.lt{font-weight:600;font-size:4.6px;fill:#e8e6df;stroke-width:.9px}
  #gbgL .mm text.sec{font-size:8px;fill:#cfd4db;stroke-width:1.5px}
  #gbgL .mm .bar{display:flex;gap:4px;align-self:stretch;justify-content:space-between;align-items:center}
  #gbgL .mm .info{min-height:30px;align-self:stretch;margin-top:3px;color:#cfd4db}
  #gbgL .mm .lg{align-self:stretch;color:#8b929c;font-size:11px}
  #gbgL .mm .lg i{display:inline-block;width:12px;height:8px;margin:0 3px 0 6px;vertical-align:middle;border-radius:2px}
  #gbgL tr.near td{background:rgba(255,180,84,.08)}
  #gbgI .bdg:empty{display:none}
  #gbgI.flash{animation:gbgFI .5s 6}
  @keyframes gbgFI{50%{border-color:#ff6b6b;box-shadow:0 0 18px 4px #ff6b6b}}
  #gbgL .hd{display:flex;align-items:center;gap:6px;padding:6px 8px;border-bottom:1px solid #3a3f47;cursor:move;user-select:none;touch-action:none}
  #gbgL .hd b{flex:1;font-size:12px}
  #gbgL .hd .st{font-variant-numeric:tabular-nums;color:#a9b0bb}
  #gbgL button{font:inherit;color:#e8e6df;background:#2d3239;border:1px solid #444b55;border-radius:5px;padding:2px 7px;cursor:pointer}
  #gbgL button:hover{background:#3a414b}
  #gbgL .tabs{display:flex;flex-wrap:wrap;gap:2px;padding:4px 6px;border-bottom:1px solid #3a3f47}
  #gbgL .tabs button{border:none;background:transparent;color:#a9b0bb;padding:3px 6px}
  #gbgL .tabs button.on{background:#3a414b;color:#fff}
  #gbgL .bd{overflow:auto;padding:6px 8px}
  #gbgL table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums;font:inherit;color:inherit}
  #gbgL td,#gbgL th{font:inherit;color:inherit}
  #gbgL td.l,#gbgL th.l{text-align:left}
  #gbgL .nm{display:inline-block;max-width:120px;overflow:hidden;text-overflow:ellipsis;vertical-align:bottom}
  #gbgL .pn{display:inline-block;max-width:130px;overflow:hidden;text-overflow:ellipsis;vertical-align:bottom}
  #gbgL th,#gbgL td{padding:2px 4px;border-bottom:1px solid #30353c;text-align:right;white-space:nowrap}
  #gbgL th:first-child,#gbgL td:first-child{text-align:left}
  #gbgL th{color:#a9b0bb;font-weight:500;position:sticky;top:0;background:#1e2125}
  #gbgL .kpi{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-bottom:8px}
  #gbgL .kpi div{background:#22262b;border-radius:6px;padding:5px 7px}
  #gbgL .kpi small{display:block;color:#a9b0bb}
  #gbgL .kpi span{font-size:15px;font-weight:600}
  #gbgL h4{margin:8px 0 4px;font-size:12px;color:#cfd4db}
  #gbgL .warn{color:#ffb454}
  #gbgL .bad{color:#ff6b6b}
  #gbgL .good{color:#6bd38a}
  #gbgL .mut{color:#8b929c}
  #gbgL .dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:4px;vertical-align:middle}
  #gbgL .row{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:4px 0}
  #gbgL label{display:flex;gap:4px;align-items:center}
  #gbgL input[type=number]{width:56px;font:inherit;background:#22262b;color:#e8e6df;border:1px solid #444b55;border-radius:4px;padding:1px 3px}
  #gbgL pre{white-space:pre-wrap;word-break:break-all;font:11px/1.3 ui-monospace,Consolas,monospace;color:#bfc5ce;margin:2px 0 6px}
  #gbgL.flash{animation:gbgF 1s 3}
  @keyframes gbgF{50%{border-color:#ff6b6b;box-shadow:0 0 18px #ff6b6b}}`;

  const TABS = [['sum', 'Сводка'], ['map', 'Карта'], ['enemy', 'Враги'], ['guild', 'Гильдия'], ['att', 'Усталость'], ['rew', 'Награды'], ['fights', 'Бои'], ['new', 'Новое'], ['set', 'Экспорт']];
  let tab = lsGet('tab', 'sum');
  let panelOpen = lsGet('open', false);
  let forceShow = false; // Alt+G: показать панель и вне ПБГ (например, для экспорта)
  let root, body, statusEl, icon, badge;
  let mmCfg = lsGet('mm', { rot: 0, mirror: false, hide: false });
  let mmHover = null, mmSel = null;
  let pressing = false; // пока кнопка мыши зажата над панелью, не перерисовываем — иначе клик теряется

  function colourOf(pid) {
    const p = core.S.bg.participants[pid];
    if (!p) return '#777';
    if (+pid === core.S.bg.myPid) return '#e7e7e7';
    return (persist.meta.colours && persist.meta.colours[p.colour]) || ({ red: '#aa0401', green: '#54bb11', yellow: '#ffe360', teal: '#18efef', orange: '#df9700', blue: '#0549e6', purple: '#8d1ace', pink: '#d435cf' }[p.colour]) || '#777';
  }
  const who = pid => `<span class="dot" style="background:${colourOf(pid)}"></span><span class="nm" title="${esc(core.pName(pid))}">${esc(core.pName(pid))}</span>`;
  const pn = id => `<span class="pn" title="${esc(core.provFull(id))}">${esc(core.provName(id))}</span>`;

  const ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="#f0c94a" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 17.5 3 6V3h3l11.5 11.5"/><path d="m13 19 6-6"/><path d="m16 16 4 4"/><path d="m19 21 2-2"/><path d="M14.5 6.5 18 3h3v3l-3.5 3.5"/><path d="m5 14 4 4"/><path d="m7 17-3 3"/><path d="m3 19 2 2"/></svg>';

  function build() {
    const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    root = document.createElement('div'); root.id = 'gbgL';
    root.innerHTML = `<div class="hd"><b>ПБГ логгер</b><span class="st"></span><button data-a="close" title="Свернуть в значок">—</button></div><div class="tabs"></div><div class="bd"></div>`;
    document.body.appendChild(root);
    icon = document.createElement('div'); icon.id = 'gbgI'; icon.title = 'ПБГ логгер';
    icon.innerHTML = ICON_SVG + '<span class="bdg"></span>';
    document.body.appendChild(icon);
    badge = icon.querySelector('.bdg');
    statusEl = root.querySelector('.st'); body = root.querySelector('.bd');
    const tabs = root.querySelector('.tabs');
    tabs.innerHTML = TABS.map(([k, n]) => `<button data-t="${k}">${n}</button>`).join('');
    root.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.t) { tab = b.dataset.t; lsSet('tab', tab); render(true); }
      if (b.dataset.gm) { gMode = b.dataset.gm; lsSet('gMode', gMode); render(true); }
      if (b.dataset.a) action(b.dataset.a);
    });
    root.addEventListener('click', e => { const th = e.target.closest && e.target.closest('[data-gs]'); if (th) { gSort = th.dataset.gs; lsSet('gSort', gSort); render(true); } });
    root.addEventListener('pointerdown', () => { pressing = true; }, true);
    W.addEventListener('pointerup', () => { setTimeout(() => { pressing = false; }, 0); }, true);
    // наведение и выбор на схеме: слушаем на корне, он не перерисовывается
    root.addEventListener('mousemove', e => { const c = e.target.closest && e.target.closest('[data-pid]'); const v = c ? +c.dataset.pid : null; if (v !== mmHover) { mmHover = v; if (tab === 'map') render(true); } });
    root.addEventListener('mouseleave', () => { if (mmHover != null) { mmHover = null; if (tab === 'map') render(true); } });
    root.addEventListener('click', e => { const c = e.target.closest && e.target.closest('[data-pid]'); if (c) { mmSel = mmSel === +c.dataset.pid ? null : +c.dataset.pid; render(true); } });
    root.addEventListener('change', e => {
      const el = e.target; if (!el.dataset.c) return;
      const v = el.type === 'checkbox' ? el.checked : +el.value;
      core.setCfg({ [el.dataset.c]: v }); lsSet('cfg', core.getCfg());
      if (el.dataset.c === 'alertNotify' && v && W.Notification && Notification.permission === 'default') Notification.requestPermission();
      if (el.dataset.c === 'onlyGbg') applyVis();
    });
    // позиции: значок и панель запоминаются отдельно
    const ip = lsGet('iconPos', null);
    place(icon, ip ? ip.x : W.innerWidth - 70, ip ? ip.y : W.innerHeight - 140);
    draggable(icon, icon, 'iconPos', () => openPanel(true));
    draggable(root, root.querySelector('.hd'), null, null);
    W.addEventListener('resize', () => { clampEl(icon); clampEl(root); });
    W.addEventListener('keydown', e => {
      if (e.altKey && (e.code === 'KeyG')) {
        e.preventDefault();
        if (root.style.display !== 'none') { forceShow = false; openPanel(false); }
        else { forceShow = true; openPanel(true); }
      }
    }, true);
    ui.applyVis = applyVis;
    applyVis();
    setInterval(() => { safe(tick); render(false); }, 1000);
    render(true);
  }

  // ближайшая открывающаяся провинция, на которую можно напасть: отсчёт на значке и звук за 60 и 10 с
  const soundFired = {};
  let nextOpen = null;
  function tick() {
    const list = core.soonOpening(core.getCfg().soonWindowMin);
    nextOpen = list.find(x => x.atk !== false && !x.mine && x.rest > 0) || null;
    if (!core.getCfg().timerSound || !visible()) return;
    for (const x of list) {
      if (x.mine || x.atk === false || x.rest <= 0) continue;
      for (const thr of [60, 10]) {
        const k = x.p.id + ':' + x.p.lockedUntil + ':' + thr;
        if (soundFired[k] || x.rest > thr || x.rest < thr - 5) continue;
        soundFired[k] = 1;
        chime(thr === 10 ? 3 : 1);
      }
    }
  }
  function visible() { return forceShow || onGbg || !core.getCfg().onlyGbg; }
  function applyVis() {
    if (!root) return;
    const v = visible();
    const wasOpen = root.style.display !== 'none' && root.style.display !== '';
    const ir = lsGet('iconPos', null) || { x: parseFloat(icon.style.left) || 0, y: parseFloat(icon.style.top) || 0 };
    icon.style.display = v && !panelOpen ? 'flex' : 'none';
    root.style.display = v && panelOpen ? 'flex' : 'none';
    if (v && panelOpen) { render(true); if (!wasOpen) anchorToIcon(ir); clampEl(root); }
    if (v && !panelOpen) clampEl(icon);
  }
  function openPanel(open) {
    panelOpen = open; lsSet('open', open);
    applyVis();
  }
  // панель открывается рядом со значком: справа от него, а если не помещается — слева
  function anchorToIcon(ir) {
    const w = Math.min(470, W.innerWidth - 16);
    const h = Math.min(root.offsetHeight || W.innerHeight * 0.72, W.innerHeight * 0.72);
    const x = ir.x + 54 + w <= W.innerWidth ? ir.x + 54 : Math.max(0, ir.x - w - 8);
    const y = Math.max(8, Math.min(ir.y - h / 2 + 23, W.innerHeight - h - 8));
    place(root, x, y);
  }
  function place(el, x, y) {
    el.style.left = Math.round(x) + 'px'; el.style.top = Math.round(y) + 'px';
    el.style.right = 'auto'; el.style.bottom = 'auto';
    clampEl(el);
  }
  function clampEl(el) {
    if (!el || el.style.display === 'none' || !el.style.left) return;
    const r = el.getBoundingClientRect();
    const x = Math.min(Math.max(0, r.left), Math.max(0, W.innerWidth - Math.min(r.width, W.innerWidth)));
    const y = Math.min(Math.max(0, r.top), Math.max(0, W.innerHeight - Math.min(r.height, 60)));
    el.style.left = Math.round(x) + 'px'; el.style.top = Math.round(y) + 'px';
  }
  // перетаскивание мышью и пальцем; короткий клик без сдвига = onClick
  function draggable(el, handle, posKey, onClick) {
    let sx, sy, ox, oy, on = false, moved = false;
    handle.addEventListener('pointerdown', e => {
      if (e.button !== 0 || e.target.closest('button')) return;
      on = true; moved = false;
      const r = el.getBoundingClientRect(); sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
      try { handle.setPointerCapture(e.pointerId); } catch (x) { /* */ }
      e.preventDefault(); e.stopPropagation();
    });
    handle.addEventListener('pointermove', e => {
      if (!on) return;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (!moved && Math.abs(dx) + Math.abs(dy) < 5) return;
      moved = true; el.classList.add('drag');
      place(el, ox + dx, oy + dy);
    });
    const end = e => {
      if (!on) return; on = false; el.classList.remove('drag');
      try { handle.releasePointerCapture(e.pointerId); } catch (x) { /* */ }
      if (moved && posKey) { const r = el.getBoundingClientRect(); lsSet(posKey, { x: r.left, y: r.top }); }
      else if (onClick) onClick();
      e.stopPropagation();
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }

  function render(force) {
    if (!root) return;
    const S = core.S;
    const a = S.attrition;
    const warn = a && a.level >= core.getCfg().warnLevel;
    const cap = capped();
    const nt = nextOpen ? timer(nextOpen.p.lockedUntil) : null;
    statusEl.innerHTML = (nt && nt.rest < 300 ? `<span class="${nt.cls}">${esc(core.provName(nextOpen.p.id))} ${nt.txt}</span> · ` : '') + `${S.fights.length} боёв · усталость <span class="${cap ? 'warn' : warn ? 'bad' : ''}">${a ? a.level : '—'}${cap ? ' MAX' : ''}</span>`;
    badge.className = 'bdg';
    if (nt && nt.rest < 300) { badge.textContent = nt.txt; badge.classList.add(nt.rest < 60 ? 'bad' : 'soon'); if (nt.rest < 60) badge.classList.add('tick'); }
    else if (cap) { badge.textContent = 'MAX'; badge.classList.add('max'); }
    else { badge.textContent = a ? a.level : (S.fights.length || ''); if (warn) badge.classList.add('bad'); }
    icon.title = `ПБГ логгер — ${S.fights.length} боёв, усталость ${a ? a.level : '—'}${cap ? ' (потолок)' : ''}` + (nextOpen ? `. Ближайшая к открытию: ${core.provName(nextOpen.p.id)} через ${timer(nextOpen.p.lockedUntil).txt}` : '') + '. Клик — открыть, тянуть — переместить.';
    root.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.t === tab));
    if (root.style.display === 'none') return;
    if (pressing && !force) return;
    if (!core.isDirty() && !force && tab !== 'map' && tab !== 'enemy') return;
    const keepScroll = body.scrollTop;
    const prevH = root.offsetHeight;
    body.innerHTML = ({ sum: viewSum, map: viewMap, enemy: viewEnemy, guild: viewGuild, att: viewAtt, rew: viewRew, fights: viewFights, new: viewNew, set: viewSet }[tab] || viewSum)();
    body.scrollTop = keepScroll;
    // панель выросла — не даём ей уйти за нижний край экрана
    if (root.offsetHeight !== prevH) { const r = root.getBoundingClientRect(); if (r.bottom > W.innerHeight - 4) root.style.top = Math.max(0, W.innerHeight - r.height - 8) + 'px'; }
  }

  function viewSum() {
    const S = core.S, st = core.stats(), a = S.attrition, curve = persist.curve;
    const next = a && curve[a.level + 1] ? curve[a.level + 1].bonus - a.bonus : null;
    const cfg = core.getCfg();
    let h = `<div class="kpi">
      <div><small>Бои / победы</small><span>${st.fights}</span> <span class="mut">${st.wins}/${st.losses ? '<span class=bad>' + st.losses + '</span>' : 0}</span></div>
      <div><small>Темп, боёв/мин</small><span>${fmt(st.perMin)}</span></div>
      <div><small>Шанс награды</small><span>${pct(st.dropRate)}</span></div>
      <div><small>Усталость</small><span class="${capped() ? 'warn' : a && a.level >= cfg.warnLevel ? 'bad' : ''}">${a ? a.level : '—'}</span> <span class="mut">${a ? (capped() ? 'MAX' : 'до потолка ' + (cfg.capLevel - a.level)) : ''}</span></div>
      <div><small>Бонус врага</small><span>${a ? '+' + fmt(a.bonus) + '%' : '—'}</span>${next != null ? ` <span class="mut">след. +${next}</span>` : ''}</div>
      <div><small>Множ. переговоров</small><span>${a ? a.neg : '—'}</span></div></div>`;
    if (capped()) h += `<div class="warn">Потолок усталости (${cfg.capLevel}): сложность больше не растёт, шанс усталости провинции уже не важен.</div>`;
    else if (a && a.level >= cfg.warnLevel) h += `<div class="bad">⚠ Усталость ${a.level} — после 50 прирост бонуса врага за уровень почти удваивается; рост идёт до ${cfg.capLevel}.</div>`;
    h += `<h4>Монеты за сессию</h4><table><tr><th>Вид</th><th>Выпало</th><th>Сумма</th><th>На бой</th></tr>`;
    for (const k of Object.keys(st.coins)) h += `<tr><td>${esc(coinName(k))}</td><td>${st.rewardCount[k]}</td><td>${fmt(st.coins[k])}</td><td>${fmt(st.coins[k] / Math.max(1, st.fights))}</td></tr>`;
    h += `</table>`;
    const r0 = S.resources.first, r1 = S.resources.last;
    if (r0 && r1 && r0 !== r1) {
      h += `<h4>Баланс на складе</h4><table><tr><th>Ресурс</th><th>Было</th><th>Стало</th><th>Δ</th></tr>`;
      for (const k of Object.keys(r1.v)) if (r1.v[k] !== r0.v[k]) h += `<tr><td>${esc(coinName(k))}</td><td>${fmt(r0.v[k])}</td><td>${fmt(r1.v[k])}</td><td class="good">${fmt(r1.v[k] - (r0.v[k] || 0))}</td></tr>`;
      h += `</table>`;
    }
    h += `<h4>По провинциям (сессия)</h4><table><tr><th>Провинция</th><th>Боёв</th><th>Шанс</th><th>Получено</th><th>Факт</th><th>Награды</th></tr>`;
    for (const p of Object.values(st.byProv)) h += `<tr><td>${pn(p.id)}</td><td>${p.n}</td><td>${p.chance == null ? '—' : p.chance + '%'}</td><td>+${p.gain}</td><td>${p.gainKnown ? pct(p.gain / p.gainKnown) : '—'}</td><td>${pct(p.rew / p.n)}</td></tr>`;
    h += `</table>`;
    const wv = Object.entries(st.waves).map(([k, v]) => `${k} волн: ${v}`).join(' · ');
    h += `<h4>Прочее</h4><div class="mut">${wv || '—'} · свои потери HP: ${fmt(st.hpLost)} · очки PvP: ${fmt(st.points)}${S.bg.activeTrial != null ? ' · испытание: ' + S.bg.activeTrial : ''}${S.bg.league && S.bg.league.beast ? ' · режим Beast' : ''}</div>`;
    const vr = core.vpRates();
    if (Object.keys(S.bg.participants).length) {
      h += `<h4>Гильдии</h4><table><tr><th>Гильдия</th><th>ОП</th><th>ОП/час</th></tr>`;
      for (const [pid, p] of Object.entries(S.bg.participants).sort((x, y) => y[1].vp - x[1].vp)) h += `<tr><td>${who(pid)}</td><td>${fmt(p.vp)}</td><td>${vr[pid] != null ? fmt(vr[pid]) : '—'}</td></tr>`;
      h += `</table><div class="mut">Конец раунда: ${S.bg.endsAt ? new Date(S.bg.endsAt * 1000).toLocaleString('ru-RU') : '—'}</div>`;
    }
    return h;
  }

  // ── схема карты: кольца (цифра в коде провинции) и сектора, номера провинций идут по кругу ──
  const mmCache = {};
  function mmLayout(mapId) {
    if (mmCache[mapId]) return mmCache[mapId];
    const m = persist.meta.maps[mapId];
    if (!m || !m.provinces) return null;
    const rings = {};
    for (const p of m.provinces) {
      const g = /^([A-Z])(\d)/.exec(p.name || '');
      if (!g) return null;
      (rings[+g[2]] = rings[+g[2]] || []).push(p);
    }
    const nums = Object.keys(rings).map(Number).sort((a, b) => a - b);
    const K = nums.length, R = 92;
    const single = rings[nums[0]].length === 1;
    const inner = single ? 0 : R * 0.16;
    const w = (R - inner) / K;
    const cells = {}, centers = {};
    const angDist = (a, b) => { const d = Math.abs(((a - b) % 360 + 540) % 360 - 180); return d; };
    nums.forEach((rn, ri) => {
      const list = rings[rn].slice().sort((a, b) => a.id - b.id);
      const n = list.length, span = 360 / n;
      const rIn = single && ri === 0 ? 0 : inner + w * ri, rOut = inner + w * (ri + 1);
      // поворот кольца подбираем так, чтобы провинции стояли напротив своих соседей из внутреннего кольца
      let best = 0, bestScore = Infinity;
      if (ri > 0) for (const k of [0, -0.5, 0.5, -0.25, 0.25, -1, 1]) {
        let sc = 0;
        list.forEach((p, i) => { const c = (i + 0.5 + k) * span; for (const nb of (p.connections || [])) if (centers[nb] != null && cells[nb] && cells[nb].ring === ri - 1) sc += angDist(c, centers[nb]); });
        if (sc < bestScore - 1e-6) { bestScore = sc; best = k; }
      }
      list.forEach((p, i) => {
        const a0 = (i + best) * span, a1 = a0 + span;
        cells[p.id] = { id: p.id, ring: ri, a0, a1, rIn, rOut, code: (p.name || '').split(':')[0], sector: (p.name || '')[0], full: n === 1 };
        centers[p.id] = (a0 + a1) / 2;
      });
    });
    return (mmCache[mapId] = { cells, R });
  }
  function mmPt(r, a) { const t = (a * (mmCfg.mirror ? -1 : 1) + mmCfg.rot * 90) * Math.PI / 180; return [r * Math.sin(t), -r * Math.cos(t)]; }
  function mmPath(c) {
    const f = n => n.toFixed(2);
    if (c.full) return `M${f(-c.rOut)},0A${f(c.rOut)},${f(c.rOut)} 0 1,0 ${f(c.rOut)},0A${f(c.rOut)},${f(c.rOut)} 0 1,0 ${f(-c.rOut)},0Z`;
    const large = c.a1 - c.a0 > 180 ? 1 : 0, sw = mmCfg.mirror ? 0 : 1;
    const [x0, y0] = mmPt(c.rOut, c.a0), [x1, y1] = mmPt(c.rOut, c.a1);
    if (!c.rIn) return `M0,0L${f(x0)},${f(y0)}A${f(c.rOut)},${f(c.rOut)} 0 ${large},${sw} ${f(x1)},${f(y1)}Z`;
    const [x2, y2] = mmPt(c.rIn, c.a1), [x3, y3] = mmPt(c.rIn, c.a0);
    return `M${f(x0)},${f(y0)}A${f(c.rOut)},${f(c.rOut)} 0 ${large},${sw} ${f(x1)},${f(y1)}L${f(x2)},${f(y2)}A${f(c.rIn)},${f(c.rIn)} 0 ${large},${1 - sw} ${f(x3)},${f(y3)}Z`;
  }
  function mmInfo(id) {
    const S = core.S, p = S.bg.provinces[id];
    if (!p) return '';
    const t = timer(p.lockedUntil), atk = core.attackable(p), my = S.bg.myPid;
    const mp = p.prog[my];
    const parts = [`<b>${esc(core.provName(id))}</b> <span class="mut">${esc((core.provFull(id).split(':')[1] || '').trim())}</span>`, p.spawn ? 'точка появления ' + who(p.owner) : who(p.owner)];
    if (t.txt) parts.push(t.rest > 0 ? `откроется <span class="${t.cls}">${t.txt}</span>` : '<span class=good>открыта</span>');
    if (p.owner !== my && !p.spawn) parts.push(atk === true ? '<span class=good>⚔ можно атаковать</span>' : atk === false ? '<span class=mut>не граничит с нами</span>' : '');
    if (p.att != null && p.owner !== my) parts.push(`шанс усталости ${p.att}%`);
    if (mp) parts.push(`наш прогресс ${mp.p}/${mp.max}`);
    const others = Object.entries(p.prog).filter(([pid]) => +pid !== my);
    if (others.length) parts.push(others.map(([pid, x]) => `${who(pid)} ${x.p}/${x.max}`).join(', '));
    parts.push(`слоты ${p.slotsUsed}/${p.slotsTotal}`);
    return parts.filter(Boolean).join(' · ');
  }
  function viewMiniMap() {
    const S = core.S, lay = mmLayout(S.bg.mapId);
    const bar = `<div class="bar"><b>Схема карты</b><span><button data-a="mmRot" title="Повернуть на 90°">⟳</button> <button data-a="mmMir" title="Отразить">⇋</button> <button data-a="mmHide">${mmCfg.hide ? 'показать' : 'скрыть'}</button></span></div>`;
    if (mmCfg.hide) return `<div class="mm">${bar}</div>`;
    if (!lay) return `<div class="mm">${bar}<div class="mut">Нет метаданных карты — схема появится после перезагрузки игры с включённым логгером.</div></div>`;
    const my = S.bg.myPid, cfg = core.getCfg(), nowS = core.serverNow() / 1000;
    let paths = '', labels = '';
    for (const c of Object.values(lay.cells)) {
      const p = S.bg.provinces[c.id];
      const col = p ? colourOf(p.owner) : '#555';
      const rest = p && p.lockedUntil ? p.lockedUntil - nowS : null;
      const locked = rest != null && rest > 0;
      const mine = p && p.owner === my;
      const atk = p && !mine ? core.attackable(p) : false;
      let cls = '';
      if (locked && rest <= cfg.soonWindowMin * 60) cls = mine ? 'def' : atk !== false ? (rest < 60 ? 'hot' : rest < 300 ? 'near' : 'soon') : 'soon';
      else if (!locked && atk === true) cls = 'atk';
      if (mmSel === c.id) cls = 'sel';
      paths += `<path data-pid="${c.id}" class="${cls}" d="${mmPath(c)}" fill="${col}" fill-opacity="${locked ? 0.32 : p && p.spawn ? 0.55 : 0.9}"/>`;
      const [cx, cy] = c.full ? [0, 0] : mmPt((c.rIn + c.rOut) / 2, (c.a0 + c.a1) / 2);
      const short = core.provName(c.id);
      if (locked && rest < 300 && !mine) labels += `<text x="${cx.toFixed(1)}" y="${cy.toFixed(1)}">${timer(p.lockedUntil).txt}</text>`;
      else if (p && p.spawn) labels += `<text x="${cx.toFixed(1)}" y="${cy.toFixed(1)}">⌂</text>`;
      else labels += `<text class="${c.ring === 0 ? '' : 'lt'}" x="${cx.toFixed(1)}" y="${cy.toFixed(1)}">${esc(c.ring === 0 ? short.replace(' ', '') : short.split(': ')[1] || '')}</text>`;
    }
    // буквы секторов снаружи
    const secs = {};
    for (const c of Object.values(lay.cells)) if (c.ring === Math.max(...Object.values(lay.cells).map(x => x.ring))) (secs[c.sector] = secs[c.sector] || []).push((c.a0 + c.a1) / 2);
    for (const [k, a] of Object.entries(secs)) { const mid = a.reduce((s, x) => s + x, 0) / a.length; const [x, y] = mmPt(lay.R + 5, mid); labels += `<text class="sec" x="${x.toFixed(1)}" y="${y.toFixed(1)}">${esc(k)}</text>`; }
    const info = mmInfo(mmSel != null ? mmSel : mmHover) || '<span class="mut">Наведите на провинцию, клик — закрепить.</span>';
    const guilds = Object.entries(S.bg.participants).map(([pid, x]) => `<i style="background:${colourOf(pid)}"></i>${esc(x.name)}`).join('');
    return `<div class="mm">${bar}<svg viewBox="-102 -102 204 204">${paths}${labels}</svg><div class="info">${info}</div>
      <div class="lg">${guilds}<br>тусклая — закрыта · пунктир — открыта, граничит с нами · оранжевая рамка — откроется скоро · красная мигает — меньше минуты · голубая — наша скоро откроется</div></div>`;
  }

  function viewMap() {
    const S = core.S, my = S.bg.myPid;
    const provs = Object.values(S.bg.provinces);
    if (!provs.length) return '<div class="mut">Откройте карту ПБГ — данные придут с getBattleground.</div>';
    const cfg = core.getCfg(), cap = capped();
    let h0 = viewMiniMap();
    // скоро откроются
    const soon = core.soonOpening(cfg.soonWindowMin);
    let h = h0 + `<h4>Скоро откроются (${cfg.soonWindowMin} мин)</h4>`;
    if (soon.length) {
      h += `<table><tr><th>Провинция</th><th>Владелец</th><th>Откроется</th><th>Рядом</th><th>Шанс</th></tr>`;
      for (const x of soon) {
        const t = timer(x.p.lockedUntil);
        const row = !x.mine && x.atk !== false && t.rest < 60 ? 'hot' : !x.mine && x.atk !== false && t.rest < 300 ? 'near' : '';
        const near = x.mine ? '🛡 наша' : x.atk === true ? '<span class=good>⚔ да</span>' : x.atk === null ? '?' : '<span class=mut>нет</span>';
        h += `<tr class="${row}"><td>${pn(x.p.id)}</td><td>${who(x.p.owner)}</td><td class="${t.cls}">${t.txt}</td><td>${near}</td><td class="${cap ? 'mut' : ''}">${x.p.att == null ? '—' : x.p.att + '%'}</td></tr>`;
      }
      h += `</table>`;
    } else h += `<div class="mut">В ближайшие ${cfg.soonWindowMin} мин ничего не открывается.</div>`;
    // все чужие
    const byLock = (a, b) => (a.lockedUntil || 0) - (b.lockedUntil || 0);
    const targets = provs.filter(p => p.owner !== my && !p.spawn)
      .sort(cap ? byLock : (a, b) => (a.att ?? 999) - (b.att ?? 999) || byLock(a, b));
    h += `<h4>${cap ? 'Чужие провинции — по времени открытия (усталость на потолке, шанс не важен)' : 'Чужие провинции — сначала самые «дешёвые» по усталости'}</h4><table><tr><th>Провинция</th><th>Владелец</th><th>Шанс</th><th>Мы</th><th>Замок</th><th>Слоты</th></tr>`;
    for (const p of targets) {
      const mp = p.prog[my];
      const cls = cap ? 'mut' : p.att == null ? '' : p.att <= 20 ? 'good' : p.att <= 60 ? 'warn' : 'bad';
      h += `<tr><td>${pn(p.id)}</td><td>${who(p.owner)}</td><td class="${cls}">${p.att == null ? '—' : p.att + '%'}</td><td>${mp ? mp.p + '/' + mp.max : ''}</td><td>${left(p.lockedUntil)}</td><td>${p.slotsUsed}/${p.slotsTotal}</td></tr>`;
    }
    h += `</table>`;
    const mine = provs.filter(p => p.owner === my);
    const attacked = mine.filter(p => Object.keys(p.prog).length);
    h += `<h4>Наши провинции под атакой (${attacked.length} из ${mine.length})</h4><table><tr><th>Провинция</th><th>Кто</th><th>Прогресс</th><th>Замок</th></tr>`;
    for (const p of attacked) for (const [pid, x] of Object.entries(p.prog)) h += `<tr><td>${pn(p.id)}</td><td>${who(pid)}</td><td class="${x.p / x.max > 0.7 ? 'bad' : ''}">${x.p}/${x.max}</td><td>${left(p.lockedUntil)}</td></tr>`;
    h += `</table>`;
    const sig = S.bg.signals[my];
    if (sig && sig.length) h += `<div class="mut">Метки гильдии: ${sig.map(s => esc(core.provName(s.id)) + ' (' + esc(s.s) + ')').join(', ')}</div>`;
    return h;
  }

  // до минуты — «42 с», до часа — «4:17», дальше — «1ч 12м»
  function etaFmt(x) {
    if (x.done) return { txt: x.owner === x.pid ? 'взята' : 'сброс', cls: x.owner === x.pid ? (x.own ? 'good' : 'bad') : 'mut' };
    if (x.etaSec == null) return { txt: '—', cls: '' };
    const r = Math.ceil(x.etaSec);
    const danger = x.mine && !x.own;
    if (r < 60) return { txt: r + ' с', cls: (danger ? 'bad ' : 'warn ') + 'blink' };
    if (r < 3600) return { txt: Math.floor(r / 60) + ':' + String(r % 60).padStart(2, '0'), cls: danger ? 'bad' : '' };
    return { txt: Math.floor(r / 3600) + 'ч ' + Math.floor(r % 3600 / 60) + 'м', cls: '' };
  }
  function viewEnemy() {
    const S = core.S;
    const list = core.activitySummary();
    let h = `<h4>Активность за ${core.getCfg().activityWindowMin} мин</h4><table><tr><th>Провинция</th><th>Кто бьёт</th><th>Удар.</th><th>/мин</th><th>Прогр.</th><th>До взятия</th></tr>`;
    for (const x of list) {
      const e = etaFmt(x);
      const row = x.mine && !x.own && !x.done && x.etaSec != null && x.etaSec < 60 ? 'hot' : '';
      h += `<tr class="${row}"><td>${x.mine ? '🛡 ' : ''}${pn(x.id)}</td><td>${who(x.pid)}</td><td>${x.hits}</td><td class="${x.idle > 20 && !x.done ? 'mut' : ''}">${x.done ? '—' : fmt(x.rate)}</td><td>${x.p}/${x.max}</td><td class="${e.cls}">${e.txt}</td></tr>`;
    }
    h += `</table><div class="mut">Темп — по последней минуте; серый — ударов не было больше 20 с.</div>`;
    if (!list.length) h += '<div class="mut">Пока тихо (данные идут через websocket, пока открыта карта).</div>';
    h += `<h4>Захваты</h4><table><tr><th>Время</th><th>Провинция</th><th>Было</th><th>Стало</th></tr>`;
    for (const c of S.captures.slice(-30).reverse()) h += `<tr><td>${hm(c.t)}</td><td>${pn(c.id)}</td><td>${who(c.from)}</td><td>${who(c.to)}</td></tr>`;
    h += `</table><h4>Тревоги</h4><table><tr><th>Время</th><th>Наша провинция</th><th>Кто</th><th>Прогр.</th></tr>`;
    for (const a of S.alerts.slice(-30).reverse()) h += `<tr><td>${hm(a.t)}</td><td>${pn(a.id)}</td><td>${who(a.pid)}</td><td>${a.p}/${a.max}</td></tr>`;
    return h + '</table>';
  }

  // ── вкладка «Гильдия»: бои и усталость игроков за день и за всё поле ──
  let gMode = lsGet('gMode', 'today'), gSort = lsGet('gSort', 'b');
  const dLabel = d => new Date(d).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
  const hhmm = t => new Date(t).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  function viewGuild() {
    const R = core.guildReport();
    const howTo = '<div class="mut">Данные берутся из таблицы игроков гильдии на ПБГ: откройте её в игре — логгер запомнит снимок. Всего за поле считает сервер (точно). Для разбивки по дням логгер вычитает снимки, поэтому открывайте таблицу хотя бы раз в начале и в конце дня ПБГ.</div>';
    if (!R) return '<h4>Гильдия</h4>' + howTo;
    const modes = [['today', 'Сегодня'], ['yday', 'Вчера'], ['days', 'По дням'], ['all', 'Всё поле']];
    let h = `<div class="row">${modes.map(([k, n]) => `<button data-gm="${k}" style="${gMode === k ? 'background:#4a525e' : ''}">${n}</button>`).join('')}<span class="mut">снимков: ${R.count}, последний ${hhmm(R.last)}</span></div>`;
    const me = R.me;
    const nameCell = p => `<span class="nm" style="max-width:150px" title="${esc(p.name)}">${p.id === me ? '<b>' : ''}${esc(p.name)}${p.id === me ? '</b>' : ''}</span>${p.left ? ' <span class=mut>(нет в последнем)</span>' : ''}`;
    const sortBy = (list, key) => list.sort((a, b) => (b[key] || 0) - (a[key] || 0) || a.name.localeCompare(b.name));
    const th = (k, n) => `<th data-gs="${k}" style="cursor:pointer${gSort === k ? ';color:#fff' : ''}">${n}${gSort === k ? ' ▾' : ''}</th>`;
    if (gMode === 'today' || gMode === 'yday') {
      const d = gMode === 'today' ? R.today : R.today - 86400000;
      const c = R.cover[d];
      if (!c || c.end < 0) return h + `<div class="mut">За ${gMode === 'today' ? 'сегодня' : 'вчера'} снимков нет.</div>` + howTo;
      const rows = R.players.filter(p => p.days[d]).map(p => ({ id: p.id, name: p.name, left: p.left, b: p.days[d].b, n: p.days[d].n, att: gMode === 'today' ? p.att : p.days[d].att, tot: p.b + p.n, single: p.days[d].single }));
      for (const r of rows) r.eff = r.att > 0 ? r.b / r.att : null;
      sortBy(rows, gSort === 'name' ? 'b' : gSort);
      const sumB = rows.reduce((s, r) => s + r.b, 0), sumN = rows.reduce((s, r) => s + r.n, 0), active = rows.filter(r => r.b + r.n > 0).length;
      h += `<div class="mut">День ПБГ с ${dLabel(d)} ${hhmm(d)}. Охват: ${c.fromT ? hhmm(c.fromT) : '—'} → ${hhmm(c.endT)}${c.approx ? ' <span class=warn>(приблизительно: снимка на начало дня нет)</span>' : ''}${c.from === c.end ? ' <span class=warn>— один снимок, бои за день появятся после следующего открытия таблицы</span>' : ''}</div>`;
      h += `<div class="kpi"><div><small>Боёв гильдии</small><span>${fmt(sumB)}</span></div><div><small>Переговоров</small><span>${fmt(sumN)}</span></div><div><small>Активных</small><span>${active}</span> <span class="mut">из ${rows.length}</span></div></div>`;
      h += `<table><tr><th>#</th><th class="l">Игрок</th>${th('b', 'Боёв')}${th('n', 'Перег.')}${th('att', gMode === 'today' ? 'Уст. сейчас' : 'Уст. макс')}${th('eff', 'Боёв/уст.')}${th('tot', 'Всего')}</tr>`;
      rows.forEach((r, i) => { h += `<tr${r.b + r.n === 0 ? ' class="mut"' : ''}><td>${i + 1}</td><td class="l">${nameCell(r)}</td><td>${fmt(r.b)}</td><td>${r.n || ''}</td><td class="${r.att >= core.getCfg().capLevel ? 'warn' : ''}">${r.att || ''}</td><td>${r.eff == null ? '' : fmt(r.eff)}</td><td class="mut">${fmt(r.tot)}</td></tr>`; });
      return h + `</table><div class="mut">Боёв/уст. — сколько боёв на одну единицу усталости: чем выше, тем «дешевле» по усталости бьёт игрок. Усталость сбрасывается в начале дня ПБГ (${hhmm(R.today)}).</div>`;
    }
    if (gMode === 'all') {
      const rows = R.players.map(p => ({ id: p.id, name: p.name, left: p.left, b: p.b, n: p.n, tot: p.b + p.n, att: p.att }));
      const total = rows.reduce((s, r) => s + r.tot, 0);
      sortBy(rows, gSort === 'eff' ? 'b' : gSort);
      h += `<div class="mut">Всё поле — по данным сервера на ${dLabel(R.last)} ${hhmm(R.last)}.</div><div class="kpi"><div><small>Побед в боях</small><span>${fmt(rows.reduce((s, r) => s + r.b, 0))}</span></div><div><small>Переговоров</small><span>${fmt(rows.reduce((s, r) => s + r.n, 0))}</span></div><div><small>Игроков с боями</small><span>${rows.filter(r => r.tot > 0).length}</span> <span class="mut">из ${rows.length}</span></div></div>`;
      h += `<table><tr><th>#</th><th class="l">Игрок</th>${th('b', 'Бои')}${th('n', 'Перег.')}${th('tot', 'Всего')}<th>Доля</th>${th('att', 'Уст. сейчас')}</tr>`;
      rows.forEach((r, i) => { h += `<tr${r.tot === 0 ? ' class="mut"' : ''}><td>${i + 1}</td><td class="l">${nameCell(r)}</td><td>${fmt(r.b)}</td><td>${r.n || ''}</td><td>${fmt(r.tot)}</td><td>${total ? (r.tot / total * 100).toFixed(1) + '%' : ''}</td><td>${r.att || ''}</td></tr>`; });
      return h + '</table>';
    }
    // по дням: последние 7 дней ПБГ
    const days = R.days.filter(d => R.players.some(p => p.days[d] && !p.days[d].single)).slice(-7);
    if (!days.length) return h + '<div class="mut">Пока нет ни одного дня с двумя снимками — откройте таблицу игроков ещё раз позже.</div>' + howTo;
    const rows = R.players.map(p => { const r = { id: p.id, name: p.name, left: p.left, sum: 0 }; days.forEach(d => { const x = p.days[d] && !p.days[d].single ? p.days[d] : null; r[d] = x ? x.b + x.n : null; r.sum += x ? x.b + x.n : 0; }); return r; });
    rows.sort((a, b) => b.sum - a.sum || a.name.localeCompare(b.name));
    h += `<div class="mut">Бои + переговоры по дням ПБГ (день начинается в ${hhmm(R.today)}). ≈ — для дня нет снимка на его начало.</div><table><tr><th>Игрок</th>${days.map(d => `<th>${dLabel(d)}${R.cover[d] && R.cover[d].approx ? '≈' : ''}</th>`).join('')}<th>Σ</th></tr>`;
    for (const r of rows) h += `<tr${r.sum === 0 ? ' class="mut"' : ''}><td>${nameCell(r)}</td>${days.map(d => `<td>${r[d] == null ? '<span class=mut>·</span>' : r[d] ? fmt(r[d]) : '<span class=mut>0</span>'}</td>`).join('')}<td><b>${fmt(r.sum)}</b></td></tr>`;
    return h + '</table>';
  }

  function viewAtt() {
    const c = persist.curve;
    const lv = Object.keys(c).map(Number).sort((a, b) => a - b);
    const st = core.stats();
    let h = `<h4>Фактическая частота усталости по шансу провинции</h4><table><tr><th>Шанс провинции</th><th>Боёв</th><th>Получено</th><th>Факт</th></tr>`;
    for (const [k, v] of Object.entries(st.byChance)) h += `<tr><td>${esc(k)}</td><td>${v.n}</td><td>${v.gain}</td><td>${v.n ? pct(v.gain / v.n) : '—'}</td></tr>`;
    h += `</table><h4>Кривая усталости (копится между сессиями)</h4><table><tr><th>Ур.</th><th>Бонус врага</th><th>Δ</th><th>Перег.</th><th>Замеров</th></tr>`;
    let prevD = null;
    for (const l of lv) {
      const x = c[l], p = c[l - 1];
      const d = p ? x.bonus - p.bonus : null;
      const jump = d != null && prevD != null && d > prevD * 1.3;
      h += `<tr><td>${l}</td><td>+${fmt(x.bonus)}%</td><td class="${jump ? 'warn' : ''}">${d == null ? '' : '+' + d}${jump ? ' ↑' : ''}</td><td>${x.neg}</td><td>${x.n}${x.conflict ? ' <span class=bad>≠' + x.conflict + '</span>' : ''}</td></tr>`;
      if (d != null) prevD = d;
    }
    const capL = core.getCfg().capLevel;
    const maxB = lv.length ? Math.max(...lv.map(l => c[l].bonus)) : null;
    const atMax = lv.filter(l => c[l].bonus === maxB);
    const obs = atMax.length >= 2 ? atMax[0] : null;
    return h + `</table><div class="mut">↑ — скачок прироста больше чем на 30%. ≠ — на этом уровне встречались разные значения (значит, бонус зависит не только от уровня).</div>
      <div class="mut">Потолок в настройках: ${capL}. По замерам бонус +${fmt(maxB)}% не растёт ${obs != null ? 'начиная не позже уровня ' + obs : '— пока мало данных'}${obs != null && obs < capL ? ' <span class=warn>(раньше настройки — проверьте)</span>' : ''}.</div>`;
  }

  function viewRew() {
    const S = core.S;
    const byCtx = {};
    for (const r of S.rewards) { const k = (r.ctx || '—') + ' · ' + (r.name || r.subType); const x = byCtx[k] || (byCtx[k] = { n: 0, sum: 0 }); x.n++; x.sum += r.amount || 0; }
    let h = `<h4>Все награды по источнику</h4><table><tr><th>Источник · награда</th><th>Раз</th><th>Сумма</th></tr>`;
    for (const [k, v] of Object.entries(byCtx).sort((a, b) => b[1].n - a[1].n)) h += `<tr><td style="white-space:normal">${esc(k)}</td><td>${v.n}</td><td>${fmt(v.sum)}</td></tr>`;
    h += `</table><h4>Последние</h4><table><tr><th>Время</th><th>Награда</th><th>Бой</th></tr>`;
    for (const r of S.rewards.slice(-40).reverse()) h += `<tr><td>${hm(r.t)}</td><td style="white-space:normal">${esc(r.name || r.subType)}${r.ctx && r.ctx !== 'battlegrounds_conquest' ? ' <span class=warn>[' + esc(r.ctx) + ']</span>' : ''}</td><td>${r.fightId || '—'}</td></tr>`;
    return h + '</table>';
  }

  function viewFights() {
    const S = core.S;
    let h = `<table><tr><th>#</th><th>Время</th><th>Провинция</th><th>Тип</th><th>Волн</th><th>Уст.</th><th>HP−</th><th>Награда</th></tr>`;
    for (const f of S.fights.slice(-80).reverse()) {
      const hp = f.waves.reduce((s, w) => s + (w.ownHpLost || 0), 0);
      const rw = f.rewards.map(r => (COIN[r.subType] || r.name) + ' ' + r.amount).join(', ');
      h += `<tr><td>${f.id}</td><td>${hm(f.tStart)}</td><td>${pn(f.province)}</td><td class="${f.result === 'loss' ? 'bad' : ''}">${f.type === 'battle' ? (f.auto ? 'авто' : 'бой') : 'перег.'}${f.result === 'loss' ? ' ✗' : ''}</td><td>${f.totalWaves || '—'}</td><td>${f.attBefore ?? '—'}${f.attGain ? '<span class=warn>+' + f.attGain + '</span>' : f.attGain === 0 ? '<span class=good>+0</span>' : ''}</td><td>${hp}</td><td>${esc(rw || '—')}</td></tr>`;
    }
    h += '</table>';
    const prev = Object.entries(S.previews).slice(-5);
    if (prev.length) {
      h += `<h4>Последние превью армий врага</h4>`;
      for (const [pid, p] of prev) h += `<div><b>${esc(core.provName(+pid))}</b> <span class="mut">${hm(p.t)}</span>: ${p.waves.map((w, i) => `волна ${i + 1} (+${w.boost}%): ${Object.entries(w.units).map(([u, n]) => esc(u.replace(/^[A-Za-z]+Age[A-Za-z]*_/, '')) + '×' + n).join(', ')}`).join(' | ')}</div>`;
    }
    return h;
  }

  function viewNew() {
    const S = core.S;
    let h = `<div class="mut">Здесь появляются методы и поля протокола, которых не было в базовой записи. Так ловятся новые механики (как trial / Beast).</div>`;
    h += `<h4>Новые методы и поля (${S.discoveries.length})</h4>`;
    for (const d of S.discoveries.slice(-40).reverse()) h += `<div><span class="mut">${hm(d.t)}</span> <b class="warn">${esc(d.kind)}</b> ${esc(d.method)} <code>${esc(d.path)}</code></div><pre>${esc(d.sample)}</pre>`;
    h += `<h4>Действия на ПБГ (запросы не get*)</h4>`;
    for (const x of S.actions.slice(-30).reverse()) h += `<div><span class="mut">${hm(x.t)}</span> ${esc(x.k)}</div><pre>${esc(x.data)}</pre>`;
    h += `<h4>Неразобранные ответы ПБГ</h4>`;
    for (const x of S.unknown.slice(-20).reverse()) h += `<div><span class="mut">${hm(x.t)}</span> ${esc(x.k)}</div><pre>${esc(x.data.slice(0, 800))}</pre>`;
    if (S.negotiations.length) { h += `<h4>Переговоры</h4>`; for (const x of S.negotiations.slice(-10).reverse()) h += `<div><span class="mut">${hm(x.t)}</span> ${esc(x.k)}</div><pre>${esc(x.data.slice(0, 600))}</pre>`; }
    return h;
  }

  function viewSet() {
    const c = core.getCfg(), S = core.S;
    const chk = (k, t) => `<label><input type="checkbox" data-c="${k}" ${c[k] ? 'checked' : ''}>${t}</label>`;
    const num = (k, t) => `<label>${t}<input type="number" data-c="${k}" value="${c[k]}"></label>`;
    return `<h4>Экспорт</h4><div class="row">
      <button data-a="json">Всё в JSON</button><button data-a="raw">Сырой лог</button>
      <button data-a="csvF">Бои CSV</button><button data-a="csvR">Награды CSV</button>
      <button data-a="csvA">Активность CSV</button><button data-a="csvC">Кривая усталости CSV</button><button data-a="csvG">Гильдия по дням CSV</button></div>
      <div class="mut">Сырой лог в том же формате, что и прошлые записи (items: t/kind/req/data), только без тяжёлых частей. Сейчас: ${S.raw.length} записей, ${S.activity.length} событий активности.</div>
      <h4>Настройки</h4>
      <div class="row">${chk('onlyGbg', 'Значок только на ПБГ')}${chk('rawLog', 'Писать сырой лог')}${chk('alertSound', 'Звук тревоги')}${chk('alertNotify', 'Уведомления')}</div>
      <div class="row">${chk('timerSound', 'Звук перед открытием (за 60 и 10 с)')}${num('soonWindowMin', 'Окно «скоро откроются», мин')}${num('capLevel', 'Потолок усталости')}</div>
      <div class="row">${num('warnLevel', 'Предупреждать с уровня')}${num('alertMinProgress', 'Тревога от %')}${num('alertCooldownSec', 'Пауза тревоги, с')}${num('activityWindowMin', 'Окно активности, мин')}</div>
      <h4>Сессия</h4><div class="row"><button data-a="new">Новая сессия (очистить)</button><button data-a="test">Проверить тревогу</button><button data-a="testT">Проверить звук открытия</button></div>
      <div class="mut">Пачек: ${S.counters.batches} (xhr ${S.counters.xhr || 0}, ws ${S.counters.ws || 0}). Игрок: ${esc(S.session.playerName || '—')}. Метаданные карт: ${Object.keys(persist.meta.maps).length ? 'есть' : 'нет (названия провинций будут как #id, соседство неизвестно)'}. Поправка часов по серверу: ${S.timeOffset == null ? '—' : (S.timeOffset / 1000).toFixed(1) + ' с'}. Консоль: <code>__foeGbgLogger.S</code></div>
      <div class="mut">Alt+G — открыть или закрыть панель где угодно (например, чтобы сделать экспорт уже в городе). Сейчас: ${onGbg ? 'на ПБГ' : 'не на ПБГ'}.</div>`;
  }

  function download(name, text, type) {
    const blob = new Blob([text], { type: type || 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const csv = (rows, cols) => '﻿' + [cols.join(';')].concat(rows.map(r => cols.map(c => { const v = r[c]; const s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v); return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(';'))).join('\n');

  function action(a) {
    const S = core.S, host = (location.host.split('.')[0]);
    if (a === 'close') { forceShow = false; openPanel(false); return; }
    if (a === 'json') { const o = Object.assign({}, S, { raw: undefined, curve: persist.curve, meta: persist.meta, stats: core.stats() }); download(`gbg-log-${host}-${stamp()}.json`, JSON.stringify(o)); }
    if (a === 'raw') download(`foe-capture-${host}-${stamp()}.json`, JSON.stringify({ host: location.host, exported: new Date().toISOString(), items: [{ t: new Date().toISOString(), kind: 'meta:guild_battleground_maps', data: Object.values(persist.meta.maps) }].concat(S.raw) }));
    if (a === 'csvF') download(`gbg-fights-${host}-${stamp()}.csv`, csv(S.fights.map(f => Object.assign({}, f, { name: core.provName(f.province), nameFull: core.provFull(f.province), start: new Date(f.tStart).toISOString(), waves: f.waves.length, hpLost: f.waves.reduce((s, w) => s + (w.ownHpLost || 0), 0), points: f.waves.reduce((s, w) => s + (w.points || 0), 0), rewards: f.rewards.map(r => r.subType + ':' + r.amount).join(' '), enemy: f.waves.map(w => w.enemy.join(',')).join(' | ') })), ['id', 'start', 'type', 'result', 'province', 'name', 'nameFull', 'ownerName', 'attChance', 'attBefore', 'attAfter', 'attGain', 'bonusBefore', 'totalWaves', 'auto', 'trial', 'era', 'progBefore', 'progMax', 'hpLost', 'points', 'rewards', 'template', 'enemy']), 'text/csv');
    if (a === 'csvR') download(`gbg-rewards-${host}-${stamp()}.csv`, csv(S.rewards.map(r => Object.assign({}, r, { time: new Date(r.t).toISOString() })), ['time', 'ctx', 'type', 'subType', 'amount', 'name', 'fightId', 'assembled', 'required']), 'text/csv');
    if (a === 'csvA') download(`gbg-activity-${host}-${stamp()}.csv`, csv(S.activity.map(x => Object.assign({}, x, { time: new Date(x.t).toISOString(), province: core.provName(x.id), provinceFull: core.provFull(x.id), guild: core.pName(x.pid), ownerName: core.pName(x.owner) })), ['time', 'id', 'province', 'provinceFull', 'guild', 'delta', 'p', 'max', 'ownerName', 'src']), 'text/csv');
    if (a === 'csvG') {
      const R = core.guildReport();
      if (!R) { alert('Нет снимков таблицы игроков: откройте её в игре.'); return; }
      const rows = [];
      for (const p of R.players) for (const d of R.days) { const x = p.days[d]; if (x) rows.push({ day: new Date(d).toISOString().slice(0, 16), player: p.name, playerId: p.id, battles: x.b, negotiations: x.n, attritionMax: x.att, approx: x.approx ? 1 : 0, totalBattles: p.b, totalNegotiations: p.n }); }
      download(`gbg-guild-${host}-${stamp()}.csv`, csv(rows, ['day', 'player', 'playerId', 'battles', 'negotiations', 'attritionMax', 'approx', 'totalBattles', 'totalNegotiations']), 'text/csv');
    }
    if (a === 'csvC') download(`gbg-attrition-curve.csv`, csv(Object.entries(persist.curve).map(([l, x]) => Object.assign({ level: +l }, x)).sort((x, y) => x.level - y.level), ['level', 'bonus', 'neg', 'n', 'conflict']), 'text/csv');
    if (a === 'new') {
      if (!confirm('Очистить текущую сессию? Кривая усталости и схема сохранятся. Сначала лучше сделать экспорт.')) return;
      idbPut(SESSION_KEY, null).finally(() => location.reload());
    }
    if (a === 'test') ui.alert({ name: 'Тестовая провинция', who: 'Тест', p: 50, max: 100 });
    if (a === 'testT') chime(3);
    if (a === 'mmRot') { mmCfg.rot = (mmCfg.rot + 1) % 4; lsSet('mm', mmCfg); render(true); }
    if (a === 'mmMir') { mmCfg.mirror = !mmCfg.mirror; lsSet('mm', mmCfg); render(true); }
    if (a === 'mmHide') { mmCfg.hide = !mmCfg.hide; lsSet('mm', mmCfg); render(true); }
  }

  // тревоги
  let actx = null;
  function beep() {
    try {
      actx = actx || new (W.AudioContext || W.webkitAudioContext)();
      [0, 0.25].forEach(d => { const o = actx.createOscillator(), g = actx.createGain(); o.frequency.value = 880; g.gain.value = 0.08; o.connect(g); g.connect(actx.destination); o.start(actx.currentTime + d); o.stop(actx.currentTime + d + 0.15); });
    } catch (e) { /* звук недоступен */ }
  }
  function chime(n) {
    try {
      actx = actx || new (W.AudioContext || W.webkitAudioContext)();
      for (let i = 0; i < n; i++) [660, 990].forEach((f, j) => { const o = actx.createOscillator(), g = actx.createGain(); o.frequency.value = f; g.gain.value = 0.07; o.connect(g); g.connect(actx.destination); const t0 = actx.currentTime + i * 0.35 + j * 0.12; o.start(t0); o.stop(t0 + 0.1); });
    } catch (e) { /* звук недоступен */ }
  }
  ui.alert = a => {
    const c = core.getCfg();
    if (c.alertSound) beep();
    if (c.alertNotify && W.Notification && Notification.permission === 'granted') try { new Notification('ПБГ: бьют нашу провинцию', { body: `${a.name}: ${a.who} ${a.p}/${a.max}` }); } catch (e) { /* */ }
    for (const el of [root, icon]) if (el) { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }
  };
  ui.capture = () => core.markDirty();
  ui.fight = () => core.markDirty();
  ui.discovery = () => core.markDirty();

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build); else build();

  // ── базовая схема из записи ru16 от 01.11.2026: то, что уже известно ──
  function BASELINE_SCHEMA() { const b = {"GuildBattlegroundStateService.getState":[".championship",".championship.diamondLeagueTopRankReward",".championship.diamondLeagueTopRankReward.guildReward",".championship.diamondLeagueTopRankReward.guildReward.guildPower",".championship.diamondLeagueTopRankReward.guildReward<GuildBattlegroundLeaderboardGuildReward>",".championship.diamondLeagueTopRankReward.playerRewards",".championship.diamondLeagueTopRankReward.playerRewards[].amount",".championship.diamondLeagueTopRankReward.playerRewards[].assembledReward",".championship.diamondLeagueTopRankReward.playerRewards[].assembledReward.amount",".championship.diamondLeagueTopRankReward.playerRewards[].assembledReward.boostValue",".championship.diamondLeagueTopRankReward.playerRewards[].assembledReward.description",".championship.diamondLeagueTopRankReward.playerRewards[].assembledReward.flags",".championship.diamondLeagueTopRankReward.playerRewards[].assembledReward.iconAssetName",".championship.diamondLeagueTopRankReward.playerRewards[].assembledReward.id",".championship.diamondLeagueTopRankReward.playerRewards[].assembledReward.name",".championship.diamondLeagueTopRankReward.playerRewards[].assembledReward.subType",".championship.diamondLeagueTopRankReward.playerRewards[].assembledReward.type",".championship.diamondLeagueTopRankReward.playerRewards[].assembledReward<GenericReward>",".championship.diamondLeagueTopRankReward.playerRewards[].boostValue",".championship.diamondLeagueTopRankReward.playerRewards[].description",".championship.diamondLeagueTopRankReward.playerRewards[].flags",".championship.diamondLeagueTopRankReward.playerRewards[].iconAssetName",".championship.diamondLeagueTopRankReward.playerRewards[].id",".championship.diamondLeagueTopRankReward.playerRewards[].name",".championship.diamondLeagueTopRankReward.playerRewards[].requiredAmount",".championship.diamondLeagueTopRankReward.playerRewards[].subType",".championship.diamondLeagueTopRankReward.playerRewards[].type",".championship.diamondLeagueTopRankReward.playerRewards[]<FragmentReward>",".championship.diamondLeagueTopRankReward.playerRewards[]<GenericReward>",".championship.diamondLeagueTopRankReward<GuildBattlegroundLeaderboardReward>",".championship.endsAt",".championship.name",".championship.startsAt",".championship<BattlegroundChampionship>",".stateId","<GuildBattlegroundState>"],"GuildBattlegroundService.getBattleground":[".activeTrial",".battlegroundParticipants",".battlegroundParticipants[].clan",".battlegroundParticipants[].clan.flag",".battlegroundParticipants[].clan.id",".battlegroundParticipants[].clan.membersNum",".battlegroundParticipants[].clan.name",".battlegroundParticipants[].clan<BaseClan>",".battlegroundParticipants[].colour",".battlegroundParticipants[].participantId",".battlegroundParticipants[].signals",".battlegroundParticipants[].signals[].provinceId",".battlegroundParticipants[].signals[].signal",".battlegroundParticipants[].signals[]<GuildBattlegroundProvinceSignal>",".battlegroundParticipants[].victoryPoints",".battlegroundParticipants[]<GuildBattlegroundParticipant>",".currentParticipantId",".currentPlayerParticipant",".currentPlayerParticipant.activeTrial",".currentPlayerParticipant.attrition",".currentPlayerParticipant.attrition.defendingArmyBonus",".currentPlayerParticipant.attrition.level",".currentPlayerParticipant.attrition.negotiationMultiplier",".currentPlayerParticipant.attrition<GuildBattlegroundAttrition>",".currentPlayerParticipant<GuildBattlegroundPlayerParticipant>",".endsAt",".league",".league.id",".league.isBattleOfTheBeast",".league.name",".league.rating",".league<GuildBattlegroundLeague>",".map",".map.id",".map.pendingUpdate",".map.pendingUpdate.provinceIds",".map.pendingUpdate.updateAt",".map.pendingUpdate<GuildBattlegroundPendingUpdate>",".map.provinces",".map.provinces[].conquestProgress",".map.provinces[].gainAttritionChance",".map.provinces[].id",".map.provinces[].isAttackBattleType",".map.provinces[].lockedUntil",".map.provinces[].ownerId",".map.provinces[].totalBuildingSlots",".map.provinces[].usedBuildingSlots",".map.provinces[].victoryPoints",".map.provinces[].victoryPointsBonus",".map.provinces[]<GuildBattlegroundProvince>",".map<GuildBattlegroundMap>",".storeId","<GuildBattleground>"],"BattlefieldService.getArmyPreview":["[].fightType","[].fightType.value","[].fightType{FightType}","[].id","[].units","[].units[].abilities","[].units[].abilities[].description","[].units[].abilities[].icon","[].units[].abilities[].name","[].units[].abilities[].terrains","[].units[].abilities[].type","[].units[].abilities[].value","[].units[].abilities[]<BattleContactAbility>","[].units[].abilities[]<BattleFlyingAbility>","[].units[].abilities[]<BattleForceFieldAbility>","[].units[].abilities[]<BattleFrenzyAbility>","[].units[].abilities[]<BattleMirvAbility>","[].units[].abilities[]<BattlePowerShotAbility>","[].units[].abilities[]<BattleReactiveArmorAbility>","[].units[].abilities[]<BattleRechargeAbility>","[].units[].abilities[]<BattleStealthAbility>","[].units[].bonuses","[].units[].bonuses[].type","[].units[].bonuses[].value","[].units[].bonuses[]<CampaignUnitBonus>","[].units[].currentHitpoints","[].units[].entity_id","[].units[].unitTypeId","[].units[]<ArmyUnit>","[]<Army>"],"BattlefieldService.startByBattleType":[".ais",".ais.#",".armyId",".attackerPlayerId",".battleId",".battleType",".battleType.battlesWon",".battleType.currentWaveId",".battleType.era",".battleType.provinceId",".battleType.totalWaves",".battleType.trial",".battleType.type",".battleType<BattlegroundBattleType>",".isAutoBattle",".startTime",".state",".state._w",".state._z",".state.activeUnitId",".state.distance_scale_factor",".state.ranking_data",".state.ranking_data.details",".state.ranking_data.details.damageDealt",".state.ranking_data.details.damageRecieved",".state.ranking_data.details.happinessModifier",".state.ranking_data.details.sum",".state.ranking_data.details.waveModifier",".state.ranking_data.details<BattleResultDetails>",".state.ranking_data.mood_factor",".state.ranking_data.nextArmy",".state.ranking_data.nextArmy.fightType",".state.ranking_data.nextArmy.fightType.value",".state.ranking_data.nextArmy.fightType{FightType}",".state.ranking_data.nextArmy.id",".state.ranking_data.nextArmy.units",".state.ranking_data.nextArmy.units[].abilities",".state.ranking_data.nextArmy.units[].bonuses",".state.ranking_data.nextArmy.units[].currentHitpoints",".state.ranking_data.nextArmy.units[].entity_id",".state.ranking_data.nextArmy.units[].unitTypeId",".state.ranking_data.nextArmy.units[]<ArmyUnit>",".state.ranking_data.nextArmy<Army>",".state.ranking_data.ranking",".state.ranking_data.ranking[].battle_result_details",".state.ranking_data.ranking[].battle_result_details.damageDealt",".state.ranking_data.ranking[].battle_result_details.damageRecieved",".state.ranking_data.ranking[].battle_result_details.happinessModifier",".state.ranking_data.ranking[].battle_result_details.sum",".state.ranking_data.ranking[].battle_result_details.waveModifier",".state.ranking_data.ranking[].battle_result_details<BattleResultDetails>",".state.ranking_data.ranking[].era",".state.ranking_data.ranking[].fights",".state.ranking_data.ranking[].place",".state.ranking_data.ranking[].player",".state.ranking_data.ranking[].player.avatar",".state.ranking_data.ranking[].player.era",".state.ranking_data.ranking[].player.name",".state.ranking_data.ranking[].player.player_id",".state.ranking_data.ranking[].player<Player>",".state.ranking_data.ranking[].points",".state.ranking_data.ranking[].total_points",".state.ranking_data.ranking[]<CampaignPvpRanking>",".state.ranking_data.winner",".state.ranking_data<BattleResult>",".state.retiredUnits",".state.round",".state.stepHistory",".state.unitsOrder",".state.winnerBit",".state<BattleRealmState>","<BattleRealm>"],"GuildBattlegroundService.getProvinces":["[].conquestProgress","[].conquestProgress[].maxProgress","[].conquestProgress[].participantId","[].conquestProgress[].progress","[].conquestProgress[]<GuildBattlegroundConquestProgress>","[].gainAttritionChance","[].id","[].isAttackBattleType","[].ownerId","[].totalBuildingSlots","[].usedBuildingSlots","[].victoryPoints","[].victoryPointsBonus","[]<GuildBattlegroundProvince>"],"GuildBattlegroundService.getPlayerParticipant":[".activeTrial",".attrition",".attrition.defendingArmyBonus",".attrition.level",".attrition.negotiationMultiplier",".attrition<GuildBattlegroundAttrition>","<GuildBattlegroundPlayerParticipant>"],"RewardService.collectReward":["[][].amount","[][].boostValue","[][].description","[][].flags","[][].iconAssetName","[][].id","[][].name","[][].subType","[][].type","[][]<GenericReward>"]}; const o = {}; for (const k of Object.keys(b)) { o[k] = {}; for (const x of b[k]) o[k][x] = 0; } return o; }
})();
