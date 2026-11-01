// ==UserScript==
// @name         FoE ПБГ логгер
// @namespace    foe-gbg-logger
// @version      1.0
// @description  Записывает бои, усталость, награды, активность гильдий и изменения протокола на Полях битв гильдий. Сам ничего не нажимает.
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

    function provName(id) {
      const m = persist.meta.maps[S.bg.mapId];
      if (m && m.provinces) {
        const p = m.provinces.find(x => (x.id || 0) === id);
        if (p) return p.name;
      }
      return '#' + id;
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
          case 'GuildBattlegroundStateService.getState':
            S.state = rd; break;
          case 'GuildBattlegroundService.getBattleground':
            setBattleground(rd, t); break;
          case 'GuildBattlegroundService.getProvinces':
            for (const p of (rd || [])) applyProvince(p, t, kind); break;
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

    function activitySummary(windowMin) {
      const since = now() - (windowMin || cfg.activityWindowMin) * 60000;
      const m = {};
      for (let i = S.activity.length - 1; i >= 0; i--) {
        const a = S.activity[i];
        if (a.t < since) break;
        const k = a.id + ':' + a.pid;
        const x = m[k] || (m[k] = { id: a.id, name: provName(a.id), pid: a.pid, who: pName(a.pid), hits: 0, first: a.t, last: a.t, p: a.p, max: a.max, owner: a.owner });
        x.hits += a.delta; x.first = Math.min(x.first, a.t);
      }
      const list = Object.values(m).map(x => {
        const mins = Math.max((x.last - x.first) / 60000, 0.25);
        x.rate = x.hits / mins;
        x.eta = x.max && x.rate > 0 ? (x.max - x.p) / x.rate : null;
        x.mine = x.owner === S.bg.myPid; x.own = x.pid === S.bg.myPid;
        return x;
      });
      return list.sort((a, b) => b.rate - a.rate);
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

    function setHost(h) { S.session.host = h; }
    function load(saved) { if (saved && saved.v === 1) { Object.assign(S, saved); fightSeq = S.fights.length ? S.fights[S.fights.length - 1].id : 0; } }
    function isDirty() { const d = dirty; dirty = false; return d; }
    function markDirty() { dirty = true; }
    function getCfg() { return cfg; }
    function setCfg(c) { Object.assign(cfg, c); dirty = true; }

    return { S, persist, ingest, setMeta, stats, activitySummary, vpRates, provName, pName, setHost, load, isDirty, markDirty, getCfg, setCfg };
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
    core.ingest(kind, reqs, resps, Date.now());
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
      const bodyText = typeof body === 'string' ? body : null;
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
      const body = init && typeof init.body === 'string' ? init.body : null;
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
  const left = sec => { if (!sec) return ''; const s = sec - Date.now() / 1000; if (s <= 0) return 'открыта'; const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60); return (h ? h + 'ч ' : '') + m + 'м'; };
  const COIN = { gbg_silver_coin: 'Серебро', gbg_gold_coin: 'Золото', gbg_platinum_coin: 'Платина' };
  const coinName = k => COIN[k] || k;

  const CSS = `
  #gbgL{position:fixed;right:8px;bottom:8px;z-index:2147483647;width:470px;max-height:72vh;display:flex;flex-direction:column;font:12px/1.35 system-ui,Segoe UI,Arial,sans-serif;color:#e8e6df;background:rgba(24,26,30,.96);border:1px solid #3a3f47;border-radius:8px;box-shadow:0 6px 24px rgba(0,0,0,.5)}
  #gbgL.min{width:auto;max-height:none}
  #gbgL .hd{display:flex;align-items:center;gap:6px;padding:6px 8px;border-bottom:1px solid #3a3f47;cursor:move;user-select:none}
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

  const TABS = [['sum', 'Сводка'], ['map', 'Карта'], ['enemy', 'Враги'], ['att', 'Усталость'], ['rew', 'Награды'], ['fights', 'Бои'], ['new', 'Новое'], ['set', 'Экспорт']];
  let tab = lsGet('tab', 'sum');
  let minimized = lsGet('min', false);
  let root, body, statusEl;

  function colourOf(pid) {
    const p = core.S.bg.participants[pid];
    if (!p) return '#777';
    if (+pid === core.S.bg.myPid) return '#e7e7e7';
    return (persist.meta.colours && persist.meta.colours[p.colour]) || ({ red: '#aa0401', green: '#54bb11', yellow: '#ffe360', teal: '#18efef', orange: '#df9700', blue: '#0549e6', purple: '#8d1ace', pink: '#d435cf' }[p.colour]) || '#777';
  }
  const who = pid => `<span class="dot" style="background:${colourOf(pid)}"></span><span class="nm" title="${esc(core.pName(pid))}">${esc(core.pName(pid))}</span>`;
  const pn = id => `<span class="pn" title="${esc(core.provName(id))}">${esc(core.provName(id))}</span>`;

  function build() {
    const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    root = document.createElement('div'); root.id = 'gbgL';
    root.innerHTML = `<div class="hd"><b>ПБГ логгер</b><span class="st"></span><button data-a="min">${minimized ? '▢' : '—'}</button></div><div class="tabs"></div><div class="bd"></div>`;
    document.body.appendChild(root);
    statusEl = root.querySelector('.st'); body = root.querySelector('.bd');
    const tabs = root.querySelector('.tabs');
    tabs.innerHTML = TABS.map(([k, n]) => `<button data-t="${k}">${n}</button>`).join('');
    root.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.t) { tab = b.dataset.t; lsSet('tab', tab); render(true); }
      if (b.dataset.a) action(b.dataset.a);
    });
    root.addEventListener('change', e => {
      const el = e.target; if (!el.dataset.c) return;
      const v = el.type === 'checkbox' ? el.checked : +el.value;
      core.setCfg({ [el.dataset.c]: v }); lsSet('cfg', core.getCfg());
      if (el.dataset.c === 'alertNotify' && v && W.Notification && Notification.permission === 'default') Notification.requestPermission();
    });
    drag(root, root.querySelector('.hd'));
    const pos = lsGet('pos', null);
    if (pos) { root.style.left = pos.x + 'px'; root.style.top = pos.y + 'px'; root.style.right = 'auto'; root.style.bottom = 'auto'; }
    applyMin();
    setInterval(() => render(false), 1000);
    render(true);
  }
  function applyMin() {
    root.classList.toggle('min', minimized);
    root.querySelector('.tabs').style.display = minimized ? 'none' : '';
    body.style.display = minimized ? 'none' : '';
    root.querySelector('[data-a=min]').textContent = minimized ? '▢' : '—';
  }
  function drag(el, handle) {
    let sx, sy, ox, oy, on = false;
    handle.addEventListener('mousedown', e => { if (e.target.closest('button')) return; on = true; const r = el.getBoundingClientRect(); sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top; e.preventDefault(); });
    W.addEventListener('mousemove', e => { if (!on) return; el.style.left = Math.max(0, ox + e.clientX - sx) + 'px'; el.style.top = Math.max(0, oy + e.clientY - sy) + 'px'; el.style.right = 'auto'; el.style.bottom = 'auto'; });
    W.addEventListener('mouseup', () => { if (!on) return; on = false; const r = el.getBoundingClientRect(); lsSet('pos', { x: r.left, y: r.top }); });
  }

  function render(force) {
    if (!root) return;
    const S = core.S;
    const a = S.attrition;
    const warn = a && a.level >= core.getCfg().warnLevel;
    statusEl.innerHTML = `${S.fights.length} боёв · усталость <span class="${warn ? 'bad' : ''}">${a ? a.level : '—'}</span>`;
    root.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.t === tab));
    if (minimized) return;
    if (!core.isDirty() && !force && tab !== 'map' && tab !== 'enemy') return;
    const keepScroll = body.scrollTop;
    body.innerHTML = ({ sum: viewSum, map: viewMap, enemy: viewEnemy, att: viewAtt, rew: viewRew, fights: viewFights, new: viewNew, set: viewSet }[tab] || viewSum)();
    body.scrollTop = keepScroll;
  }

  function viewSum() {
    const S = core.S, st = core.stats(), a = S.attrition, curve = persist.curve;
    const next = a && curve[a.level + 1] ? curve[a.level + 1].bonus - a.bonus : null;
    const cfg = core.getCfg();
    let h = `<div class="kpi">
      <div><small>Бои / победы</small><span>${st.fights}</span> <span class="mut">${st.wins}/${st.losses ? '<span class=bad>' + st.losses + '</span>' : 0}</span></div>
      <div><small>Темп, боёв/мин</small><span>${fmt(st.perMin)}</span></div>
      <div><small>Шанс награды</small><span>${pct(st.dropRate)}</span></div>
      <div><small>Усталость</small><span class="${a && a.level >= cfg.warnLevel ? 'bad' : ''}">${a ? a.level : '—'}</span></div>
      <div><small>Бонус врага</small><span>${a ? '+' + fmt(a.bonus) + '%' : '—'}</span>${next != null ? ` <span class="mut">след. +${next}</span>` : ''}</div>
      <div><small>Множ. переговоров</small><span>${a ? a.neg : '—'}</span></div></div>`;
    if (a && a.level >= cfg.warnLevel) h += `<div class="bad">⚠ Усталость ${a.level} — после 50 прирост бонуса врага за уровень почти удваивается.</div>`;
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
    for (const p of Object.values(st.byProv)) h += `<tr><td>${esc(p.name)}</td><td>${p.n}</td><td>${p.chance == null ? '—' : p.chance + '%'}</td><td>+${p.gain}</td><td>${p.gainKnown ? pct(p.gain / p.gainKnown) : '—'}</td><td>${pct(p.rew / p.n)}</td></tr>`;
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

  function viewMap() {
    const S = core.S, my = S.bg.myPid;
    const provs = Object.values(S.bg.provinces);
    if (!provs.length) return '<div class="mut">Откройте карту ПБГ — данные придут с getBattleground.</div>';
    const targets = provs.filter(p => p.owner !== my && !p.spawn).sort((a, b) => (a.att ?? 999) - (b.att ?? 999) || (a.lockedUntil || 0) - (b.lockedUntil || 0));
    let h = `<h4>Чужие провинции — сначала самые «дешёвые» по усталости</h4><table><tr><th>Провинция</th><th>Владелец</th><th>Шанс</th><th>Мы</th><th>Замок</th><th>Слоты</th></tr>`;
    for (const p of targets) {
      const mp = p.prog[my];
      const cls = p.att == null ? '' : p.att <= 20 ? 'good' : p.att <= 60 ? 'warn' : 'bad';
      h += `<tr><td>${pn(p.id)}</td><td>${who(p.owner)}</td><td class="${cls}">${p.att == null ? '—' : p.att + '%'}</td><td>${mp ? mp.p + '/' + mp.max : ''}</td><td>${left(p.lockedUntil)}</td><td>${p.slotsUsed}/${p.slotsTotal}</td></tr>`;
    }
    h += `</table>`;
    const mine = provs.filter(p => p.owner === my);
    const attacked = mine.filter(p => Object.keys(p.prog).length);
    h += `<h4>Наши провинции под атакой (${attacked.length} из ${mine.length})</h4><table><tr><th>Провинция</th><th>Кто</th><th>Прогресс</th><th>Замок</th></tr>`;
    for (const p of attacked) for (const [pid, x] of Object.entries(p.prog)) h += `<tr><td>${esc(core.provName(p.id))}</td><td>${who(pid)}</td><td class="${x.p / x.max > 0.7 ? 'bad' : ''}">${x.p}/${x.max}</td><td>${left(p.lockedUntil)}</td></tr>`;
    h += `</table>`;
    const sig = S.bg.signals[my];
    if (sig && sig.length) h += `<div class="mut">Метки гильдии: ${sig.map(s => esc(core.provName(s.id)) + ' (' + esc(s.s) + ')').join(', ')}</div>`;
    return h;
  }

  function viewEnemy() {
    const S = core.S;
    const list = core.activitySummary();
    let h = `<h4>Активность за ${core.getCfg().activityWindowMin} мин</h4><table><tr><th>Провинция</th><th>Кто бьёт</th><th>Удар.</th><th>/мин</th><th>Прогр.</th><th>До взятия</th></tr>`;
    for (const x of list) h += `<tr><td>${x.mine ? '🛡 ' : ''}${pn(x.id)}</td><td>${who(x.pid)}</td><td>${x.hits}</td><td>${fmt(x.rate)}</td><td>${x.p}/${x.max}</td><td class="${x.mine && !x.own ? 'bad' : ''}">${x.eta == null ? '—' : fmt(x.eta) + ' мин'}</td></tr>`;
    h += `</table>`;
    if (!list.length) h += '<div class="mut">Пока тихо (данные идут через websocket, пока открыта карта).</div>';
    h += `<h4>Захваты</h4><table><tr><th>Время</th><th>Провинция</th><th>Было</th><th>Стало</th></tr>`;
    for (const c of S.captures.slice(-30).reverse()) h += `<tr><td>${hm(c.t)}</td><td>${esc(c.name)}</td><td>${who(c.from)}</td><td>${who(c.to)}</td></tr>`;
    h += `</table><h4>Тревоги</h4><table><tr><th>Время</th><th>Наша провинция</th><th>Кто</th><th>Прогр.</th></tr>`;
    for (const a of S.alerts.slice(-30).reverse()) h += `<tr><td>${hm(a.t)}</td><td>${esc(a.name)}</td><td>${who(a.pid)}</td><td>${a.p}/${a.max}</td></tr>`;
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
    return h + '</table><div class="mut">↑ — скачок прироста больше чем на 30%. ≠ — на этом уровне встречались разные значения (значит, бонус зависит не только от уровня).</div>';
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
      h += `<tr><td>${f.id}</td><td>${hm(f.tStart)}</td><td>${esc(f.name)}</td><td class="${f.result === 'loss' ? 'bad' : ''}">${f.type === 'battle' ? (f.auto ? 'авто' : 'бой') : 'перег.'}${f.result === 'loss' ? ' ✗' : ''}</td><td>${f.totalWaves || '—'}</td><td>${f.attBefore ?? '—'}${f.attGain ? '<span class=warn>+' + f.attGain + '</span>' : f.attGain === 0 ? '<span class=good>+0</span>' : ''}</td><td>${hp}</td><td>${esc(rw || '—')}</td></tr>`;
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
      <button data-a="csvA">Активность CSV</button><button data-a="csvC">Кривая усталости CSV</button></div>
      <div class="mut">Сырой лог в том же формате, что и прошлые записи (items: t/kind/req/data), только без тяжёлых частей. Сейчас: ${S.raw.length} записей, ${S.activity.length} событий активности.</div>
      <h4>Настройки</h4>
      <div class="row">${chk('rawLog', 'Писать сырой лог')}${chk('alertSound', 'Звук тревоги')}${chk('alertNotify', 'Уведомления')}</div>
      <div class="row">${num('warnLevel', 'Предупреждать с уровня')}${num('alertMinProgress', 'Тревога от %')}${num('alertCooldownSec', 'Пауза тревоги, с')}${num('activityWindowMin', 'Окно активности, мин')}</div>
      <h4>Сессия</h4><div class="row"><button data-a="new">Новая сессия (очистить)</button><button data-a="test">Проверить тревогу</button></div>
      <div class="mut">Пачек: ${S.counters.batches} (xhr ${S.counters.xhr || 0}, ws ${S.counters.ws || 0}). Игрок: ${esc(S.session.playerName || '—')}. Метаданные карт: ${Object.keys(persist.meta.maps).length ? 'есть' : 'нет (названия провинций будут как #id)'}. Консоль: <code>__foeGbgLogger.S</code></div>`;
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
    if (a === 'min') { minimized = !minimized; lsSet('min', minimized); applyMin(); render(true); return; }
    if (a === 'json') { const o = Object.assign({}, S, { raw: undefined, curve: persist.curve, meta: persist.meta, stats: core.stats() }); download(`gbg-log-${host}-${stamp()}.json`, JSON.stringify(o)); }
    if (a === 'raw') download(`foe-capture-${host}-${stamp()}.json`, JSON.stringify({ host: location.host, exported: new Date().toISOString(), items: [{ t: new Date().toISOString(), kind: 'meta:guild_battleground_maps', data: Object.values(persist.meta.maps) }].concat(S.raw) }));
    if (a === 'csvF') download(`gbg-fights-${host}-${stamp()}.csv`, csv(S.fights.map(f => Object.assign({}, f, { start: new Date(f.tStart).toISOString(), waves: f.waves.length, hpLost: f.waves.reduce((s, w) => s + (w.ownHpLost || 0), 0), points: f.waves.reduce((s, w) => s + (w.points || 0), 0), rewards: f.rewards.map(r => r.subType + ':' + r.amount).join(' '), enemy: f.waves.map(w => w.enemy.join(',')).join(' | ') })), ['id', 'start', 'type', 'result', 'province', 'name', 'ownerName', 'attChance', 'attBefore', 'attAfter', 'attGain', 'bonusBefore', 'totalWaves', 'auto', 'trial', 'era', 'progBefore', 'progMax', 'hpLost', 'points', 'rewards', 'template', 'enemy']), 'text/csv');
    if (a === 'csvR') download(`gbg-rewards-${host}-${stamp()}.csv`, csv(S.rewards.map(r => Object.assign({}, r, { time: new Date(r.t).toISOString() })), ['time', 'ctx', 'type', 'subType', 'amount', 'name', 'fightId', 'assembled', 'required']), 'text/csv');
    if (a === 'csvA') download(`gbg-activity-${host}-${stamp()}.csv`, csv(S.activity.map(x => Object.assign({}, x, { time: new Date(x.t).toISOString(), province: core.provName(x.id), guild: core.pName(x.pid), ownerName: core.pName(x.owner) })), ['time', 'id', 'province', 'guild', 'delta', 'p', 'max', 'ownerName', 'src']), 'text/csv');
    if (a === 'csvC') download(`gbg-attrition-curve.csv`, csv(Object.entries(persist.curve).map(([l, x]) => Object.assign({ level: +l }, x)).sort((x, y) => x.level - y.level), ['level', 'bonus', 'neg', 'n', 'conflict']), 'text/csv');
    if (a === 'new') {
      if (!confirm('Очистить текущую сессию? Кривая усталости и схема сохранятся. Сначала лучше сделать экспорт.')) return;
      idbPut(SESSION_KEY, null).finally(() => location.reload());
    }
    if (a === 'test') ui.alert({ name: 'Тестовая провинция', who: 'Тест', p: 50, max: 100 });
  }

  // тревоги
  let actx = null;
  function beep() {
    try {
      actx = actx || new (W.AudioContext || W.webkitAudioContext)();
      [0, 0.25].forEach(d => { const o = actx.createOscillator(), g = actx.createGain(); o.frequency.value = 880; g.gain.value = 0.08; o.connect(g); g.connect(actx.destination); o.start(actx.currentTime + d); o.stop(actx.currentTime + d + 0.15); });
    } catch (e) { /* звук недоступен */ }
  }
  ui.alert = a => {
    const c = core.getCfg();
    if (c.alertSound) beep();
    if (c.alertNotify && W.Notification && Notification.permission === 'granted') try { new Notification('ПБГ: бьют нашу провинцию', { body: `${a.name}: ${a.who} ${a.p}/${a.max}` }); } catch (e) { /* */ }
    if (root) { root.classList.remove('flash'); void root.offsetWidth; root.classList.add('flash'); }
  };
  ui.capture = () => core.markDirty();
  ui.fight = () => core.markDirty();
  ui.discovery = () => core.markDirty();

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build); else build();

  // ── базовая схема из записи ru16 от 01.11.2026: то, что уже известно ──
  function BASELINE_SCHEMA() { const b = {"GuildBattlegroundStateService.getState":[".championship",".championship.diamondLeagueTopRankReward",".championship.diamondLeagueTopRankReward.guildReward",".championship.diamondLeagueTopRankReward.guildReward.guildPower",".championship.diamondLeagueTopRankReward.guildReward<GuildBattlegroundLeaderboardGuildReward>",".championship.diamondLeagueTopRankReward.playerRewards",".championship.diamondLeagueTopRankReward.playerRewards[].amount",".championship.diamondLeagueTopRankReward.playerRewards[].assembledReward",".championship.diamondLeagueTopRankReward.playerRewards[].assembledReward.amount",".championship.diamondLeagueTopRankReward.playerRewards[].assembledReward.boostValue",".championship.diamondLeagueTopRankReward.playerRewards[].assembledReward.description",".championship.diamondLeagueTopRankReward.playerRewards[].assembledReward.flags",".championship.diamondLeagueTopRankReward.playerRewards[].assembledReward.iconAssetName",".championship.diamondLeagueTopRankReward.playerRewards[].assembledReward.id",".championship.diamondLeagueTopRankReward.playerRewards[].assembledReward.name",".championship.diamondLeagueTopRankReward.playerRewards[].assembledReward.subType",".championship.diamondLeagueTopRankReward.playerRewards[].assembledReward.type",".championship.diamondLeagueTopRankReward.playerRewards[].assembledReward<GenericReward>",".championship.diamondLeagueTopRankReward.playerRewards[].boostValue",".championship.diamondLeagueTopRankReward.playerRewards[].description",".championship.diamondLeagueTopRankReward.playerRewards[].flags",".championship.diamondLeagueTopRankReward.playerRewards[].iconAssetName",".championship.diamondLeagueTopRankReward.playerRewards[].id",".championship.diamondLeagueTopRankReward.playerRewards[].name",".championship.diamondLeagueTopRankReward.playerRewards[].requiredAmount",".championship.diamondLeagueTopRankReward.playerRewards[].subType",".championship.diamondLeagueTopRankReward.playerRewards[].type",".championship.diamondLeagueTopRankReward.playerRewards[]<FragmentReward>",".championship.diamondLeagueTopRankReward.playerRewards[]<GenericReward>",".championship.diamondLeagueTopRankReward<GuildBattlegroundLeaderboardReward>",".championship.endsAt",".championship.name",".championship.startsAt",".championship<BattlegroundChampionship>",".stateId","<GuildBattlegroundState>"],"GuildBattlegroundService.getBattleground":[".activeTrial",".battlegroundParticipants",".battlegroundParticipants[].clan",".battlegroundParticipants[].clan.flag",".battlegroundParticipants[].clan.id",".battlegroundParticipants[].clan.membersNum",".battlegroundParticipants[].clan.name",".battlegroundParticipants[].clan<BaseClan>",".battlegroundParticipants[].colour",".battlegroundParticipants[].participantId",".battlegroundParticipants[].signals",".battlegroundParticipants[].signals[].provinceId",".battlegroundParticipants[].signals[].signal",".battlegroundParticipants[].signals[]<GuildBattlegroundProvinceSignal>",".battlegroundParticipants[].victoryPoints",".battlegroundParticipants[]<GuildBattlegroundParticipant>",".currentParticipantId",".currentPlayerParticipant",".currentPlayerParticipant.activeTrial",".currentPlayerParticipant.attrition",".currentPlayerParticipant.attrition.defendingArmyBonus",".currentPlayerParticipant.attrition.level",".currentPlayerParticipant.attrition.negotiationMultiplier",".currentPlayerParticipant.attrition<GuildBattlegroundAttrition>",".currentPlayerParticipant<GuildBattlegroundPlayerParticipant>",".endsAt",".league",".league.id",".league.isBattleOfTheBeast",".league.name",".league.rating",".league<GuildBattlegroundLeague>",".map",".map.id",".map.pendingUpdate",".map.pendingUpdate.provinceIds",".map.pendingUpdate.updateAt",".map.pendingUpdate<GuildBattlegroundPendingUpdate>",".map.provinces",".map.provinces[].conquestProgress",".map.provinces[].gainAttritionChance",".map.provinces[].id",".map.provinces[].isAttackBattleType",".map.provinces[].lockedUntil",".map.provinces[].ownerId",".map.provinces[].totalBuildingSlots",".map.provinces[].usedBuildingSlots",".map.provinces[].victoryPoints",".map.provinces[].victoryPointsBonus",".map.provinces[]<GuildBattlegroundProvince>",".map<GuildBattlegroundMap>",".storeId","<GuildBattleground>"],"BattlefieldService.getArmyPreview":["[].fightType","[].fightType.value","[].fightType{FightType}","[].id","[].units","[].units[].abilities","[].units[].abilities[].description","[].units[].abilities[].icon","[].units[].abilities[].name","[].units[].abilities[].terrains","[].units[].abilities[].type","[].units[].abilities[].value","[].units[].abilities[]<BattleContactAbility>","[].units[].abilities[]<BattleFlyingAbility>","[].units[].abilities[]<BattleForceFieldAbility>","[].units[].abilities[]<BattleFrenzyAbility>","[].units[].abilities[]<BattleMirvAbility>","[].units[].abilities[]<BattlePowerShotAbility>","[].units[].abilities[]<BattleReactiveArmorAbility>","[].units[].abilities[]<BattleRechargeAbility>","[].units[].abilities[]<BattleStealthAbility>","[].units[].bonuses","[].units[].bonuses[].type","[].units[].bonuses[].value","[].units[].bonuses[]<CampaignUnitBonus>","[].units[].currentHitpoints","[].units[].entity_id","[].units[].unitTypeId","[].units[]<ArmyUnit>","[]<Army>"],"BattlefieldService.startByBattleType":[".ais",".ais.#",".armyId",".attackerPlayerId",".battleId",".battleType",".battleType.battlesWon",".battleType.currentWaveId",".battleType.era",".battleType.provinceId",".battleType.totalWaves",".battleType.trial",".battleType.type",".battleType<BattlegroundBattleType>",".isAutoBattle",".startTime",".state",".state._w",".state._z",".state.activeUnitId",".state.distance_scale_factor",".state.ranking_data",".state.ranking_data.details",".state.ranking_data.details.damageDealt",".state.ranking_data.details.damageRecieved",".state.ranking_data.details.happinessModifier",".state.ranking_data.details.sum",".state.ranking_data.details.waveModifier",".state.ranking_data.details<BattleResultDetails>",".state.ranking_data.mood_factor",".state.ranking_data.nextArmy",".state.ranking_data.nextArmy.fightType",".state.ranking_data.nextArmy.fightType.value",".state.ranking_data.nextArmy.fightType{FightType}",".state.ranking_data.nextArmy.id",".state.ranking_data.nextArmy.units",".state.ranking_data.nextArmy.units[].abilities",".state.ranking_data.nextArmy.units[].bonuses",".state.ranking_data.nextArmy.units[].currentHitpoints",".state.ranking_data.nextArmy.units[].entity_id",".state.ranking_data.nextArmy.units[].unitTypeId",".state.ranking_data.nextArmy.units[]<ArmyUnit>",".state.ranking_data.nextArmy<Army>",".state.ranking_data.ranking",".state.ranking_data.ranking[].battle_result_details",".state.ranking_data.ranking[].battle_result_details.damageDealt",".state.ranking_data.ranking[].battle_result_details.damageRecieved",".state.ranking_data.ranking[].battle_result_details.happinessModifier",".state.ranking_data.ranking[].battle_result_details.sum",".state.ranking_data.ranking[].battle_result_details.waveModifier",".state.ranking_data.ranking[].battle_result_details<BattleResultDetails>",".state.ranking_data.ranking[].era",".state.ranking_data.ranking[].fights",".state.ranking_data.ranking[].place",".state.ranking_data.ranking[].player",".state.ranking_data.ranking[].player.avatar",".state.ranking_data.ranking[].player.era",".state.ranking_data.ranking[].player.name",".state.ranking_data.ranking[].player.player_id",".state.ranking_data.ranking[].player<Player>",".state.ranking_data.ranking[].points",".state.ranking_data.ranking[].total_points",".state.ranking_data.ranking[]<CampaignPvpRanking>",".state.ranking_data.winner",".state.ranking_data<BattleResult>",".state.retiredUnits",".state.round",".state.stepHistory",".state.unitsOrder",".state.winnerBit",".state<BattleRealmState>","<BattleRealm>"],"GuildBattlegroundService.getProvinces":["[].conquestProgress","[].conquestProgress[].maxProgress","[].conquestProgress[].participantId","[].conquestProgress[].progress","[].conquestProgress[]<GuildBattlegroundConquestProgress>","[].gainAttritionChance","[].id","[].isAttackBattleType","[].ownerId","[].totalBuildingSlots","[].usedBuildingSlots","[].victoryPoints","[].victoryPointsBonus","[]<GuildBattlegroundProvince>"],"GuildBattlegroundService.getPlayerParticipant":[".activeTrial",".attrition",".attrition.defendingArmyBonus",".attrition.level",".attrition.negotiationMultiplier",".attrition<GuildBattlegroundAttrition>","<GuildBattlegroundPlayerParticipant>"],"RewardService.collectReward":["[][].amount","[][].boostValue","[][].description","[][].flags","[][].iconAssetName","[][].id","[][].name","[][].subType","[][].type","[][]<GenericReward>"]}; const o = {}; for (const k of Object.keys(b)) { o[k] = {}; for (const x of b[k]) o[k][x] = 0; } return o; }
})();
