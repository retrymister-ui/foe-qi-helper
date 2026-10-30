// ==UserScript==
// @name         FoE КВ помощник
// @namespace    foe-qi-helper
// @version      0.1
// @description  Помощник для Квантовых вторжений: следит за поселением по данным игры и подсказывает шаги сбора (церкви, снос). Сам ничего не нажимает.
// @match        https://*.forgeofempires.com/game/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';
  const DEFS = {"H_GuildRaidsEarlyMiddleAge_Townhall":{"n":"Ратуша","w":6,"h":7,"cat":"main_building"},"I_GuildRaidsEarlyMiddleAge_Impediment1":{"n":"Препятствие","w":1,"h":2,"cat":"impediment"},"I_GuildRaidsEarlyMiddleAge_Impediment2":{"n":"Препятствие","w":2,"h":1,"cat":"impediment"},"W_GuildRaidsEarlyMiddleAge_Residential1":{"n":"Многоэтажный дом","w":2,"h":2,"pop":70,"m":12500,"c":10,"cm":10000,"cs":0,"cc":0,"rm":2500,"t":5,"cat":"residential"},"W_GuildRaidsEarlyMiddleAge_Residential2":{"n":"Каркасный дом","w":2,"h":2,"pop":110,"m":25000,"c":75,"cm":30000,"cs":50000,"cc":200,"rm":7500,"t":3600,"cat":"residential"},"W_GuildRaidsEarlyMiddleAge_Residential3":{"n":"Дом с гонтовой кровлей","w":2,"h":2,"pop":150,"m":130000,"c":250,"cm":210000,"cs":200000,"cc":1000,"rm":52500,"t":36000,"cat":"residential"},"W_GuildRaidsHighMiddleAge_Residential1":{"n":"Особняк","w":2,"h":2,"pop":60,"m":7500,"c":10,"bm":0.1,"cm":14000,"cs":0,"cc":0,"rm":3500,"t":5,"cat":"residential"},"W_GuildRaidsHighMiddleAge_Residential2":{"n":"Дом из песчаника","w":2,"h":2,"pop":90,"m":15000,"c":75,"bm":0.1,"cm":42000,"cs":60000,"cc":200,"rm":10500,"t":3600,"cat":"residential"},"W_GuildRaidsHighMiddleAge_Residential3":{"n":"Городской особняк","w":2,"h":2,"pop":130,"m":78000,"c":250,"bm":0.1,"cm":294000,"cs":240000,"cc":1000,"rm":73500,"t":36000,"cat":"residential"},"W_GuildRaidsLateMiddleAge_Residential1":{"n":"Усадьба","w":2,"h":2,"pop":50,"m":3750,"c":10,"bm":0.2,"cm":16000,"cs":0,"cc":0,"rm":4000,"t":5,"cat":"residential"},"W_GuildRaidsLateMiddleAge_Residential2":{"n":"Многоквартирный дом","w":2,"h":2,"pop":80,"m":7500,"c":75,"bm":0.2,"cm":48000,"cs":70000,"cc":200,"rm":12000,"t":3600,"cat":"residential"},"W_GuildRaidsLateMiddleAge_Residential3":{"n":"Манор","w":2,"h":2,"pop":110,"m":39000,"c":250,"bm":0.2,"cm":336000,"cs":280000,"cc":1000,"rm":84000,"t":36000,"cat":"residential"},"W_GuildRaidsEarlyMiddleAge_Bakery":{"n":"Пекарня","w":3,"h":4,"pop":-120,"s":60000,"c":250,"cm":84000,"cs":100000,"cc":1000,"rm":21000,"t":36000,"cat":"production"},"W_GuildRaidsEarlyMiddleAge_Shoemaker":{"n":"Обувная мастерская","w":3,"h":3,"pop":-60,"s":24000,"c":75,"cm":36000,"cs":50000,"cc":200,"rm":9000,"t":3600,"cat":"production"},"W_GuildRaidsEarlyMiddleAge_Tannery":{"n":"Кожевня","w":3,"h":3,"pop":-30,"s":12000,"c":10,"cm":12000,"cs":0,"cc":0,"rm":3000,"t":5,"cat":"production"},"W_GuildRaidsHighMiddleAge_Alchimist":{"n":"Лаборатория алхимика","w":2,"h":3,"pop":-60,"s":14400,"c":75,"bs":0.1,"cm":50400,"cs":60000,"cc":200,"rm":12600,"t":3600,"cat":"production"},"W_GuildRaidsHighMiddleAge_Brickworks":{"n":"Кирпичный цех","w":3,"h":4,"pop":-100,"cm":45000,"cs":22500,"cc":200,"rm":11250,"t":3600,"cat":"goods"},"W_GuildRaidsHighMiddleAge_Ropery":{"n":"Канатная мастерская","w":2,"h":3,"pop":-100,"cm":45000,"cs":22500,"cc":200,"rm":11250,"t":3600,"cat":"goods"},"W_GuildRaidsLateMiddleAge_Gunpowder":{"n":"Пороховая фабрика","w":3,"h":3,"pop":-100,"cm":45000,"cs":22500,"cc":200,"rm":11250,"t":3600,"cat":"goods"},"W_GuildRaidsEarlyMiddleAge_Galgen":{"n":"Виселица","w":2,"h":2,"eu":250,"cm":36000,"cs":36000,"cc":100,"rm":9000,"t":3600,"cat":"culture"},"W_GuildRaidsEarlyMiddleAge_Marketplace":{"n":"Торговая площадь","w":3,"h":3,"eu":125,"cm":12000,"cs":0,"cc":0,"rm":3000,"t":5,"cat":"culture"},"W_GuildRaidsEarlyMiddleAge_Pranger":{"n":"Позорный столб","w":2,"h":2,"eu":750,"cm":120000,"cs":120000,"cc":500,"rm":30000,"t":36000,"cat":"culture"},"W_GuildRaidsHighMiddleAge_Church":{"n":"Церковь","w":3,"h":3,"eu":160,"cm":16800,"cs":0,"cc":0,"rm":4200,"t":5,"cat":"culture"},"W_GuildRaidsEarlyMiddleAge_Cypress":{"n":"Кипарис","w":1,"h":1,"eu":-25,"cm":50000,"cs":50000,"cc":200,"rm":12500,"t":5,"cat":"decoration"},"W_GuildRaidsEarlyMiddleAge_Hedgewithflowers":{"n":"Цветочная изгородь","w":1,"h":1,"eu":-25,"cm":50000,"cs":50000,"cc":200,"rm":12500,"t":5,"cat":"decoration"},"W_GuildRaidsEarlyMiddleAge_Pond":{"n":"Пруд","w":2,"h":2,"eu":-75,"cm":200000,"cs":200000,"cc":750,"rm":50000,"t":5,"cat":"decoration"},"W_GuildRaidsHighMiddleAge_Flag":{"n":"Флаг","w":1,"h":1,"eu":-75,"cm":300000,"cs":250000,"cc":750,"rm":75000,"t":5,"cat":"decoration"},"W_GuildRaidsHighMiddleAge_Doctor":{"n":"Дом лекаря","w":3,"h":3,"eu":1125,"cm":168000,"cs":144000,"cc":500,"rm":42000,"t":36000,"cat":"culture"},"W_GuildRaidsHighMiddleAge_Printshop":{"n":"Типография","w":3,"h":3,"eu":375,"cm":50400,"cs":43200,"cc":100,"rm":12600,"t":3600,"cat":"culture"},"W_GuildRaidsLateMiddleAge_Cartographer":{"n":"Дом картографа","w":2,"h":3,"eu":900,"cm":192000,"cs":168000,"cc":500,"rm":48000,"t":36000,"cat":"culture"},"W_GuildRaidsLateMiddleAge_Library":{"n":"Библиотека","w":4,"h":4,"eu":500,"cm":57600,"cs":50400,"cc":100,"rm":14400,"t":3600,"cat":"culture"},"W_GuildRaidsLateMiddleAge_Palace":{"n":"Дворец","w":4,"h":4,"eu":225,"cm":19200,"cs":0,"cc":0,"rm":4800,"t":5,"cat":"culture"},"W_GuildRaidsHighMiddleAge_Gargoyle":{"n":"Горгулья","w":1,"h":1,"eu":-25,"cm":75000,"cs":62500,"cc":200,"rm":18750,"t":5,"cat":"decoration"},"W_GuildRaidsLateMiddleAge_Decayedtower":{"n":"Разрушенная башня","w":2,"h":2,"eu":-25,"cm":100000,"cs":75000,"cc":200,"rm":25000,"t":5,"cat":"decoration"},"W_GuildRaidsLateMiddleAge_Sailorstatue":{"n":"Морская скульптура","w":1,"h":1,"eu":-75,"cm":400000,"cs":300000,"cc":750,"rm":100000,"t":5,"cat":"decoration"},"W_GuildRaidsHighMiddleAge_Signpost":{"n":"Указательный столб","w":1,"h":1,"eu":-25,"cm":75000,"cs":62500,"cc":200,"rm":18750,"t":5,"cat":"decoration"},"W_GuildRaidsLateMiddleAge_Treegroup":{"n":"Группа деревьев","w":2,"h":2,"eu":-25,"cm":100000,"cs":75000,"cc":200,"rm":25000,"t":5,"cat":"decoration"},"W_GuildRaidsEarlyMiddleAge_Armoredswordsmsanbarracks":{"n":"Казармы бронированной пехоты","w":3,"h":3,"pop":-100,"cm":15000,"cs":7500,"cc":0,"rm":3750,"t":5,"cat":"military"},"W_GuildRaidsEarlyMiddleAge_Siegecamp":{"n":"Мастерская катапульт","w":3,"h":3,"pop":-100,"cm":15000,"cs":7500,"cc":0,"rm":3750,"t":5,"cat":"military"},"W_GuildRaidsEarlyMiddleAge_Stablecataphract":{"n":"Конюшня для тяжелой кавалерии","w":4,"h":3,"pop":-100,"cm":15000,"cs":7500,"cc":0,"rm":3750,"t":5,"cat":"military"},"W_GuildRaidsHighMiddleAge_Dismountedknight":{"n":"Казармы тяжелой пехоты","w":3,"h":3,"pop":-100,"cm":45000,"cs":22500,"cc":200,"rm":11250,"t":3600,"cat":"military"},"W_GuildRaidsHighMiddleAge_Siege":{"n":"Мастерская требушетов","w":3,"h":3,"pop":-100,"cm":45000,"cs":22500,"cc":200,"rm":11250,"t":3600,"cat":"military"},"W_GuildRaidsHighMiddleAge_Stable":{"n":"Конюшня рыцарей","w":4,"h":3,"pop":-100,"cm":45000,"cs":22500,"cc":200,"rm":11250,"t":3600,"cat":"military"},"W_GuildRaidsLateMiddleAge_Pikemanbarracks":{"n":"Казармы королевских стражников","w":4,"h":3,"pop":-100,"cm":75000,"cs":37500,"cc":1000,"rm":18750,"t":36000,"cat":"military"},"W_GuildRaidsLateMiddleAge_Siegecamp":{"n":"Литейная пушек","w":4,"h":3,"pop":-100,"cm":75000,"cs":37500,"cc":1000,"rm":18750,"t":36000,"cat":"military"},"W_GuildRaidsLateMiddleAge_Stable":{"n":"Конюшня тяжеловооруженных рыцарей","w":4,"h":4,"pop":-100,"cm":75000,"cs":37500,"cc":1000,"rm":18750,"t":36000,"cat":"military"},"W_GuildRaidsEarlyMiddleAge_BronzeFoundry":{"n":"Литейная меди","w":3,"h":4,"pop":-100,"cm":45000,"cs":22500,"cc":200,"rm":11250,"t":3600,"cat":"goods"},"W_GuildRaidsEarlyMiddleAge_Beekeeper":{"n":"Пасека","w":3,"h":3,"pop":-100,"cm":45000,"cs":22500,"cc":200,"rm":11250,"t":3600,"cat":"goods"},"W_GuildRaidsLateMiddleAge_BidenhnderMercenaryBarracks":{"n":"Казармы воинов с двуручным мечом","w":3,"h":3,"pop":-100,"cm":75000,"cs":37500,"cc":1000,"rm":18750,"t":36000,"cat":"military"},"W_GuildRaidsLateMiddleAge_Archeryrange":{"n":"Стрельбище длиннолучников","w":3,"h":3,"pop":-100,"cm":75000,"cs":37500,"cc":1000,"rm":18750,"t":36000,"cat":"military"},"W_GuildRaidsHighMiddleAge_Axehammer":{"n":"Казармы берсерков","w":3,"h":3,"pop":-100,"cm":45000,"cs":22500,"cc":200,"rm":11250,"t":3600,"cat":"military"},"W_GuildRaidsHighMiddleAge_Archery":{"n":"Стрельбище арбалетчиков","w":3,"h":3,"pop":-100,"cm":45000,"cs":22500,"cc":200,"rm":11250,"t":3600,"cat":"military"},"W_GuildRaidsEarlyMiddleAge_Spearmanbarracks":{"n":"Казармы наемников","w":3,"h":3,"pop":-100,"cm":15000,"cs":7500,"cc":0,"rm":3750,"t":5,"cat":"military"},"W_GuildRaidsEarlyMiddleAge_Archeryrange":{"n":"Стрельбище конных лучников","w":4,"h":3,"pop":-100,"cm":15000,"cs":7500,"cc":0,"rm":3750,"t":5,"cat":"military"},"H_GuildRaidsIronAge_Townhall":{"n":"Ратуша","w":6,"h":7,"cat":"main_building"},"W_GuildRaidsHighMiddleAge_Wheatfarm":{"n":"Ферма","w":5,"h":4,"pop":-30,"s":7200,"c":10,"bs":0.1,"cm":16800,"cs":0,"cc":0,"rm":4200,"t":5,"cat":"production"},"W_GuildRaidsHighMiddleAge_Windmill":{"n":"Ветряная мельница","w":4,"h":3,"pop":-120,"s":36000,"c":250,"bs":0.1,"cm":117600,"cs":120000,"cc":1000,"rm":29400,"t":36000,"cat":"production"},"W_GuildRaidsLateMiddleAge_Barrelproducer":{"n":"Бондарня","w":4,"h":3,"pop":-120,"s":24000,"c":250,"bs":0.2,"cm":134400,"cs":140000,"cc":1000,"rm":33600,"t":36000,"cat":"production"},"W_GuildRaidsLateMiddleAge_Brewery":{"n":"Пивоварня","w":3,"h":3,"pop":-30,"s":4800,"c":10,"bs":0.2,"cm":19200,"cs":0,"cc":0,"rm":4800,"t":5,"cat":"production"},"W_GuildRaidsLateMiddleAge_Spicefarm":{"n":"Лавка специй","w":3,"h":3,"pop":-60,"s":9600,"c":75,"bs":0.2,"cm":57600,"cs":70000,"cc":200,"rm":14400,"t":3600,"cat":"production"}};
  // Ядро калькулятора сбора (Квантовые вторжения). Работает и в браузере, и в node (для тестов).
(function (root) {
  const MOOD = [[0, 0.2, 'Восстание'], [0.21, 0.6, 'Непокорный'], [0.61, 0.8, 'Несчастный'], [0.81, 1.0, 'Нейтральный'],
    [1.21, 1.1, 'Содержание'], [1.41, 1.2, 'Счастье'], [2.0, 1.5, 'Энтузиаст']];

  function moodFactor(sup, dem) {
    if (dem <= 0) return 1.5;
    const r = sup / dem;
    let f = 0.2;
    for (const [t, v] of MOOD) if (r >= t - 1e-9) f = v;
    return f;
  }

  /**
   * p.houses: до 3 типов [{name, count, base, chrono, pop, boost, cost, refund}]
   * p.church: {euph, cost, refund, cells}
   * p.freeCells, p.houseCells (4), p.cityBoost (доля), p.formula 'add'|'mul'
   * p.minRatio — минимальное отношение эйфории к спросу перед финальным сбором (1.5 = 150%)
   * p.maxFactor — не подниматься выше этого множителя (1.2 = не идти в «Энтузиаст»)
   * p.rebuild — вычитать стоимость пересборки снесённых домов (цена − возврат)
   * p.chronoValue — сколько монет стоит 1 хроно (для выбора лучшего плана)
   * p.supply0 — эйфория, которая уже есть (культура, декор), p.fixed — дома, которые не трогаем: {pop, boost, base, chrono}
   */
  function plan(p) {
    const H = p.houses.filter((h) => h.count > 0).map((h) => ({ ...h }));
    if (H.length > 3) throw new Error('Можно до 3 типов домов одновременно');
    while (H.length < 3) H.push({ name: '-', count: 0, base: 0, chrono: 0, pop: 0, boost: 0, cost: 0, refund: 0 });
    const ch = p.church;
    const W = p.chronoValue || 0;
    const F = p.fixed || { pop: 0, boost: 0, base: 0, chrono: 0 };
    const S0 = p.supply0 || 0;
    const n = H.map((h) => h.count);
    const N0 = n[0] + 1, N1 = n[1] + 1, N2 = n[2] + 1;
    const maxC = Math.floor((p.freeCells + p.houseCells * (n[0] + n[1] + n[2])) / ch.cells);
    const NC = maxC + 1;
    const size = N0 * N1 * N2 * NC;
    const idx = (a, b, d, c) => ((a * N1 + b) * N2 + d) * NC + c;

    const coins = new Float64Array(size), chrono = new Float64Array(size), spent = new Float64Array(size),
      refund = new Float64Array(size), score = new Float64Array(size).fill(-Infinity);
    const prev = new Int32Array(size).fill(-1), act = new Int8Array(size).fill(-1); // act: 3=церковь, 0..2=снос типа
    score[idx(0, 0, 0, 0)] = 0;

    function state(a, b, d, c) {
      const left = [n[0] - a, n[1] - b, n[2] - d];
      const dem = F.pop + left[0] * H[0].pop + left[1] * H[1].pop + left[2] * H[2].pop;
      const mf = moodFactor(S0 + c * ch.euph, dem);
      const boost = (p.cityBoost || 0) + F.boost + left[0] * H[0].boost + left[1] * H[1].boost + left[2] * H[2].boost;
      const coinMul = p.formula === 'mul' ? mf * (1 + boost) : mf + boost;
      return { left, dem, mf, coinMul, ratio: dem > 0 ? (S0 + c * ch.euph) / dem : Infinity };
    }

    let ans = null;
    for (let c = 0; c < NC; c++) for (let a = 0; a < N0; a++) for (let b = 0; b < N1; b++) for (let d = 0; d < N2; d++) {
      const k = idx(a, b, d, c);
      if (score[k] === -Infinity) continue;
      const s = state(a, b, d, c);
      const free = p.freeCells + p.houseCells * (a + b + d) - c * ch.cells;

      if (s.ratio >= p.minRatio - 1e-9 && s.mf <= p.maxFactor + 1e-9) {
        let fc = coins[k] + F.base * s.coinMul, fch = chrono[k] + F.chrono * s.mf, rebuild = 0;
        for (let i = 0; i < 3; i++) { fc += s.left[i] * H[i].base * s.coinMul; fch += s.left[i] * H[i].chrono * s.mf; }
        if (p.rebuild) rebuild = a * (H[0].cost - H[0].refund) + b * (H[1].cost - H[1].refund) + d * (H[2].cost - H[2].refund);
        // церкви после сбора сносятся: возврат их цены
        const net = fc + refund[k] - spent[k] + c * ch.refund - (p.rebuild ? a * H[0].refund + b * H[1].refund + d * H[2].refund : 0) - rebuild;
        const value = net + W * fch;
        if (!ans || value > ans.value + 1e-6) ans = { value, net, coins: fc, chrono: fch, spent: spent[k], refund: refund[k], rebuild, k, D: [a, b, d], c, s };
      }

      const go = (k2, cc, chh, sp, rf, code) => {
        const sc = cc + rf - sp + W * chh;
        if (sc > score[k2] + 1e-6) { score[k2] = sc; coins[k2] = cc; chrono[k2] = chh; spent[k2] = sp; refund[k2] = rf; prev[k2] = k; act[k2] = code; }
      };
      if (c + 1 < NC && free >= ch.cells) go(idx(a, b, d, c + 1), coins[k], chrono[k], spent[k] + ch.cost, refund[k], 3);
      const D = [a, b, d];
      for (let i = 0; i < 3; i++) {
        if (D[i] >= n[i]) continue;
        const D2 = D.slice(); D2[i]++;
        go(idx(D2[0], D2[1], D2[2], c), coins[k] + H[i].base * s.coinMul + c * 1e-3, // тай-брейк: при равенстве сначала церкви
           chrono[k] + H[i].chrono * s.mf, spent[k], refund[k] + H[i].refund, i);
      }
    }
    if (!ans) return null;

    // восстановление шагов
    const raw = [];
    for (let k = ans.k; prev[k] >= 0; k = prev[k]) raw.push({ k, code: act[k], from: prev[k] });
    raw.reverse();
    const decode = (k) => { const c = k % NC; let r = (k - c) / NC; const d = r % N2; r = (r - d) / N2; const b = r % N1; const a = (r - b) / N1; return [a, b, d, c]; };
    const steps = raw.map(({ k, code, from }) => {
      const [a, b, d, c] = decode(from);
      const sBefore = state(a, b, d, c);
      const [a2, b2, d2, c2] = decode(k);
      const sAfter = state(a2, b2, d2, c2);
      if (code === 3) return { type: 'church', ratio: sAfter.ratio, mf: sAfter.mf };
      return { type: 'demolish', house: H[code].name, houseId: H[code].id, got: H[code].base * sBefore.coinMul, gotChrono: H[code].chrono * sBefore.mf, mf: sBefore.mf, ratioAfter: sAfter.ratio };
    });
    const groups = [];
    for (const s of steps) {
      const g = groups[groups.length - 1];
      if (s.type === 'demolish' && g && g.type === 'demolish') g.items.push(s);
      else groups.push(s.type === 'demolish' ? { type: 'demolish', items: [s] } : s);
    }
    const s0 = state(0, 0, 0, 0);
    const noAction = F.base * s0.coinMul + H.reduce((sum, h) => sum + h.count * h.base * s0.coinMul, 0);
    const noActionChrono = F.chrono * s0.mf + H.reduce((sum, h) => sum + h.count * h.chrono * s0.mf, 0);
    return { ...ans, steps, groups, noAction, noActionChrono, houses: H };
  }

  root.QIPlanner = { plan, moodFactor, MOOD };
  if (typeof module !== 'undefined') module.exports = root.QIPlanner;
})(typeof window !== 'undefined' ? window : globalThis);

  const P = window.QIPlanner;
  const CHURCH_ID = 'W_GuildRaidsHighMiddleAge_Church';
  const BREWERY_ID = 'W_GuildRaidsLateMiddleAge_Brewery';
  const CH = DEFS[CHURCH_ID];
  const CFG_KEY = 'foeQiHelperCfg';

  const S = { inQI: false, ents: new Map(), areas: [], res: {}, ready: false };
  let cfg = { minRatio: 150, rebuild: true, collapsed: false, left: null, top: 60 };
  try { Object.assign(cfg, JSON.parse(localStorage.getItem(CFG_KEY) || '{}')); } catch (e) { /* ignore */ }
  const saveCfg = () => { try { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); } catch (e) { /* ignore */ } };

  // ---------- перехват ответов игры (только чтение) ----------
  function bodyText(b) {
    try {
      if (typeof b === 'string') return b;
      if (b instanceof ArrayBuffer || ArrayBuffer.isView(b)) return new TextDecoder().decode(b);
    } catch (e) { /* ignore */ }
    return null;
  }
  const oOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (m, u) { this.__qiu = String(u || ''); return oOpen.apply(this, arguments); };
  const oSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (body) {
    if (this.__qiu.indexOf('game/json') !== -1) {
      const req = bodyText(body);
      this.addEventListener('load', () => {
        try {
          if (this.responseType !== '' && this.responseType !== 'text') return;
          handle(req ? JSON.parse(req) : [], JSON.parse(this.responseText));
        } catch (e) { console.warn('[КВ помощник]', e); }
      });
    }
    return oSend.apply(this, arguments);
  };

  const isQIEnt = (e) => e && typeof e.cityentity_id === 'string' && /GuildRaids/.test(e.cityentity_id);
  function upsert(list) { (list || []).forEach((e) => { if (isQIEnt(e) || S.ents.has(e.id)) S.ents.set(e.id, e); }); }

  function handle(reqs, resps) {
    if (!Array.isArray(resps)) return;
    let changed = false;
    const reqList = Array.isArray(reqs) ? reqs : [];
    for (const r of resps) {
      if (!r || typeof r !== 'object') continue;
      const k = r.requestClass + '.' + r.requestMethod, d = r.responseData;
      if (k === 'CityMapService.getCityMap') {
        if (d && d.gridId === 'guild_raids') {
          S.inQI = true; S.ents = new Map(); (d.entities || []).forEach((e) => S.ents.set(e.id, e));
          S.areas = (d.unlocked_areas || []).map((a) => ({ x: a.x || 0, y: a.y || 0, w: a.width, h: a.length }));
          S.ready = true;
        } else if (d && d.gridId) S.inQI = false;
        changed = true;
      } else if (k === 'CityMapService.placeBuilding' || k === 'CityMapService.updateEntity' || k === 'CityMapService.moveEntities') {
        upsert(Array.isArray(d) ? d : [d]); changed = true;
      } else if (k === 'CityProductionService.pickupProduction') {
        upsert(d && d.updatedEntities); changed = true;
      } else if (k === 'CityProductionService.completeProduction') {
        upsert([d]); changed = true;
      } else if (k === 'CityMapService.removeBuilding') {
        reqList.filter((q) => q && q.requestMethod === 'removeBuilding').forEach((q) => (q.requestData || []).forEach((id) => S.ents.delete(id)));
        changed = true;
      } else if (k === 'CityMapService.placeExpansion' && S.inQI) {
        reqList.filter((q) => q && q.requestMethod === 'placeExpansion').forEach((q) => {
          const a = q.requestData && q.requestData[0] && q.requestData[0].expansion;
          if (a) S.areas.push({ x: a.x || 0, y: a.y || 0, w: a.width, h: a.length });
        });
        changed = true;
      } else if (k === 'ResourceService.getPlayerResourceBag') {
        const rr = d && d.resources && d.resources.resources;
        if (rr) { for (const key in rr) if (key.indexOf('guild_raids_') === 0) S.res[key] = rr[key]; changed = true; }
      }
    }
    if (changed) schedule();
  }

  // ---------- модель поселения ----------
  const now = () => Date.now() / 1000;
  const def = (e) => DEFS[e.cityentity_id] || { n: e.cityentity_id, w: 1, h: 1 };
  const built = (e) => !(e.state && e.state.__class__ === 'ConstructionState' && e.state.next_state_transition_at > now());
  function isReady(e) {
    const st = e.state || {};
    if (st.__class__ === 'ProductionFinishedState') return true;
    return st.__class__ === 'ProducingState' && st.next_state_transition_at && st.next_state_transition_at <= now();
  }
  const isHouse = (d) => d.pop > 0 && d.m > 0;

  function cellsUnlocked() {
    const set = new Set();
    S.areas.forEach((a) => { for (let x = a.x; x < a.x + a.w; x++) for (let y = a.y; y < a.y + a.h; y++) set.add(x + ',' + y); });
    return set;
  }
  function occupancy(skipIds) {
    const occ = new Map();
    S.ents.forEach((e) => {
      if (skipIds && skipIds.has(e.id)) return;
      const d = def(e);
      for (let x = e.x || 0; x < (e.x || 0) + (d.w || 1); x++) for (let y = e.y || 0; y < (e.y || 0) + (d.h || 1); y++) occ.set(x + ',' + y, e.id);
    });
    return occ;
  }
  // жадно расставить квадраты w×h на свободных клетках, вернуть найденные места
  function spots(unl, occ, w, h) {
    const taken = new Set(occ.keys()), res = [];
    const cells = [...unl].map((s) => s.split(',').map(Number)).sort((a, b) => (a[1] - b[1]) || (a[0] - b[0]));
    for (const [x0, y0] of cells) {
      let ok = true;
      for (let x = x0; x < x0 + w && ok; x++) for (let y = y0; y < y0 + h && ok; y++) {
        const k = x + ',' + y;
        if (!unl.has(k) || taken.has(k)) ok = false;
      }
      if (!ok) continue;
      res.push({ x: x0, y: y0 });
      for (let x = x0; x < x0 + w; x++) for (let y = y0; y < y0 + h; y++) taken.add(x + ',' + y);
    }
    return res;
  }

  // насколько снос дома e приближает появление места 3×3: среди окон, задевающих дом,
  // ищем то, где после сноса останется меньше всего других домов-помех (и нет неподвижных помех)
  function windowScore(unl, occ, e, w, h) {
    const d = def(e);
    let best = -1e9;
    for (let x0 = (e.x || 0) - w + 1; x0 < (e.x || 0) + d.w; x0++) for (let y0 = (e.y || 0) - h + 1; y0 < (e.y || 0) + d.h; y0++) {
      const blockers = new Set(); let free = 0, ok = true;
      for (let x = x0; x < x0 + w && ok; x++) for (let y = y0; y < y0 + h && ok; y++) {
        const k = x + ',' + y;
        if (!unl.has(k)) { ok = false; break; }
        const id = occ.get(k);
        if (id == null) { free++; continue; }
        const o = S.ents.get(id);
        if (!o || !isHouse(def(o))) { ok = false; break; }
        blockers.add(id);
      }
      if (!ok) continue;
      const sc = -blockers.size * 100 + free;
      if (sc > best) best = sc;
    }
    return best;
  }

  function stats() {
    let dem = 0, sup = 0, popFree = 0, bm = 0, bs = 0, pending = 0;
    S.ents.forEach((e) => {
      const d = def(e);
      if (!built(e)) { if (d.eu > 0) pending++; return; }
      if (d.pop > 0) dem += d.pop;
      popFree += d.pop || 0;
      sup += d.eu || 0;
      bm += d.bm || 0; bs += d.bs || 0;
    });
    const ratio = dem > 0 ? sup / dem : Infinity;
    const mf = P.moodFactor(sup, dem);
    return { dem, sup, ratio, mf, coinMul: mf + bm, supMul: mf + bs, popFree, pending, bm, bs };
  }

  // ---------- расчёт следующего шага ----------
  function compute() {
    const st = stats();
    const unl = cellsUnlocked(), occ = occupancy();
    const free = spots(unl, occ, CH.w, CH.h);
    const houses = [...S.ents.values()].filter((e) => built(e) && isHouse(def(e)));
    const readyHouses = houses.filter(isReady);
    const preview = readyHouses.length === 0;
    const pool = preview ? houses : readyHouses;
    const fixed = { pop: 0, boost: 0, base: 0, chrono: 0 };
    if (!preview) houses.filter((e) => !isReady(e)).forEach((e) => { const d = def(e); fixed.pop += d.pop; fixed.boost += d.bm || 0; });

    // группы по типу; до 3 типов можно сносить, остальные — фиксированные
    const groups = {};
    pool.forEach((e) => { (groups[e.cityentity_id] = groups[e.cityentity_id] || []).push(e); });
    const types = Object.keys(groups).sort((a, b) => groups[b].length * (DEFS[b].m || 0) - groups[a].length * (DEFS[a].m || 0));
    const H = [];
    types.forEach((t, i) => {
      const d = DEFS[t], n = groups[t].length;
      if (i < 3) H.push({ id: t, name: d.n, count: n, base: d.m || 0, chrono: d.c || 0, pop: d.pop, boost: d.bm || 0, cost: d.cm || 0, refund: d.rm || 0 });
      else { fixed.pop += d.pop * n; fixed.boost += (d.bm || 0) * n; fixed.base += (d.m || 0) * n; fixed.chrono += (d.c || 0) * n; }
    });
    const supply0 = st.sup;
    let plan = null;
    if (H.length) {
      try {
        plan = P.plan({
          houses: H, church: { euph: CH.eu, cost: CH.cm, refund: CH.rm, cells: 9 }, houseCells: 4,
          freeCells: free.length * 9, formula: 'add', minRatio: cfg.minRatio / 100, maxFactor: 1.2,
          rebuild: cfg.rebuild, chronoValue: 1000, supply0, fixed,
        });
      } catch (e) { console.warn('[КВ помощник] plan', e); }
    }

    // первый шаг → конкретное место
    let next = null;
    if (st.pending) next = { kind: 'wait', text: 'Дождитесь окончания постройки (' + st.pending + ' шт.)' };
    else if (readyHouses.length === 0 && houses.length && st.ratio >= cfg.minRatio / 100 - 1e-9) {
      const t = Math.min(...houses.map((e) => (e.state && e.state.next_state_transition_at) || Infinity)) - now();
      next = { kind: 'wait', text: 'Сбор сделан. Дома будут готовы через ' + (isFinite(t) ? Math.floor(t / 3600) + ' ч ' + Math.floor((t % 3600) / 60) + ' мин' : '—') };
    }
    else if (st.ratio >= cfg.minRatio / 100 - 1e-9 && readyHouses.length) next = { kind: 'collect', text: 'Эйфория ' + pct(st.ratio) + ' — собирайте дома: монеты ×' + num2(st.coinMul) };
    else if (plan && plan.steps.length) {
      const s = plan.steps[0];
      if (s.type === 'church') {
        const money = S.res.guild_raids_money;
        if (free.length) next = { kind: 'church', spot: free[0], text: 'Поставьте церковь в отмеченное место',
          after: 'эйфория станет ' + pct(s.ratio) + (money != null && money < CH.cm ? '. Не хватает монет (' + fmt(money) + ' из 16 800): сначала соберите ратушу.' : '') };
        else next = { kind: 'none', text: 'Нет места под церковь 3×3. Освободите место.' };
      } else {
        const cand = (groups[s.houseId] || []).map((e) => {
          const occ2 = occupancy(new Set([e.id]));
          return { e, score: spots(unl, occ2, CH.w, CH.h).length * 100000 + windowScore(unl, occ2, e, CH.w, CH.h) };
        }).sort((a, b) => b.score - a.score);
        if (cand.length) next = { kind: 'demolish', ent: cand[0].e, text: 'Снесите: ' + s.house, after: '+' + fmt(s.got) + ' монет, +' + fmt(s.gotChrono) + ' хроно' };
      }
    } else if (!plan && H.length) next = { kind: 'none', text: 'Нужный уровень эйфории недостижим на этом поле' };
    else if (!H.length) next = { kind: 'none', text: 'Жилых домов нет' };

    // молотки после сбора монет: сколько церквей можно заменить пивоварнями
    let hammers = null;
    if (st.ratio >= 1.41 && st.dem > 0) {
      const churches = [...S.ents.values()].filter((e) => e.cityentity_id === CHURCH_ID && built(e)).length;
      const r = Math.max(0, Math.min(churches, Math.floor((st.sup - 1.41 * st.dem) / CH.eu)));
      let supBase = 0;
      S.ents.forEach((e) => { const d = def(e); if (d.s && built(e) && d.pop < 0) supBase += d.s; });
      const brew = DEFS[BREWERY_ID];
      const B = Math.max(0, Math.min(r + free.length, Math.floor(st.popFree / 30)));
      const gainEach = brew.bs * supBase;
      hammers = { r, B, supBase, gainEach, worth: gainEach > (brew.cm - brew.rm) };
    }
    return { st, plan, next, free, preview, readyCount: readyHouses.length, houseCount: houses.length, hammers };
  }

  // ---------- интерфейс ----------
  const fmt = (x) => Math.round(x).toLocaleString('ru-RU');
  const pct = (r) => (isFinite(r) ? Math.round(r * 100) + '%' : '—');
  const num2 = (x) => x.toFixed(2).replace('.', ',');
  let panel, body, canvas, timer;
  function schedule() { clearTimeout(timer); timer = setTimeout(render, 250); }

  function buildPanel() {
    if (panel || !document.body) return;
    panel = document.createElement('div');
    panel.style.cssText = 'position:fixed;z-index:2147483646;width:380px;background:rgba(18,24,33,.95);color:#e6ebf1;' +
      'font:12.5px/1.4 system-ui,sans-serif;border-radius:8px;box-shadow:0 4px 18px rgba(0,0,0,.4);display:none';
    place();
    const head = document.createElement('div');
    head.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 10px;cursor:move;background:#1f6f8b;border-radius:8px 8px 0 0;user-select:none';
    head.innerHTML = '<b style="flex:1">КВ помощник</b>';
    const tog = document.createElement('button');
    tog.style.cssText = 'font:12px sans-serif;cursor:pointer;padding:0 6px';
    tog.textContent = cfg.collapsed ? '▼' : '▲';
    tog.addEventListener('click', (ev) => { ev.stopPropagation(); cfg.collapsed = !cfg.collapsed; saveCfg(); tog.textContent = cfg.collapsed ? '▼' : '▲'; render(); });
    head.appendChild(tog);
    drag(head);
    body = document.createElement('div');
    body.style.cssText = 'padding:8px 10px;display:grid;gap:8px;max-height:80vh;overflow:auto';
    panel.appendChild(head); panel.appendChild(body);
    document.body.appendChild(panel);
    render();
  }
  function place() {
    if (cfg.left == null) { panel.style.right = '8px'; panel.style.left = ''; } else { panel.style.left = cfg.left + 'px'; panel.style.right = ''; }
    panel.style.top = cfg.top + 'px';
  }
  function drag(h) {
    let sx, sy, ox, oy;
    h.addEventListener('mousedown', (e) => {
      sx = e.clientX; sy = e.clientY; const r = panel.getBoundingClientRect(); ox = r.left; oy = r.top;
      const mv = (ev) => { cfg.left = Math.max(0, ox + ev.clientX - sx); cfg.top = Math.max(0, oy + ev.clientY - sy); place(); };
      const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); saveCfg(); };
      document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
    });
  }

  function render() {
    if (!panel) return;
    panel.style.display = S.inQI && S.ready ? 'block' : 'none';
    if (!S.inQI || !S.ready) return;
    if (cfg.collapsed) { body.style.display = 'none'; return; }
    body.style.display = 'grid';
    let c;
    try { c = compute(); } catch (e) { body.textContent = 'Ошибка расчёта: ' + e.message; console.error(e); return; }
    const st = c.st, R = S.res;
    const moodColor = st.mf >= 1.2 ? '#6cc28a' : st.mf >= 1 ? '#e0a54a' : '#ec7b72';
    let h = '';
    h += '<div style="display:flex;gap:10px;flex-wrap:wrap">' +
      '<span>Эйфория <b style="color:' + moodColor + '">' + pct(st.ratio) + '</b> (' + fmt(st.sup) + '/' + fmt(st.dem) + ') ×' + num2(st.mf) + '</span>' +
      '<span>монеты ×' + num2(st.coinMul) + '</span><span>молотки ×' + num2(st.supMul) + '</span></div>';
    h += '<div style="color:#9aa6b5">Монеты ' + fmt(R.guild_raids_money || 0) + ' · молотки ' + fmt(R.guild_raids_supplies || 0) +
      ' · хроно ' + fmt(R.guild_raids_chrono_alloy || 0) + ' · осколки ' + fmt(R.guild_raids_currency || 0) + '</div>';
    h += '<div style="color:#9aa6b5">Домов ' + c.houseCount + ', готовы к сбору ' + c.readyCount + (c.preview ? ' — план показан заранее, как если бы все были готовы' : '') + '</div>';
    if (c.next) {
      const col = { church: '#b28ce6', demolish: '#5fb4d1', collect: '#6cc28a', wait: '#e0a54a', none: '#ec7b72' }[c.next.kind] || '#e6ebf1';
      h += '<div style="border-left:4px solid ' + col + ';background:rgba(255,255,255,.06);padding:8px 10px;border-radius:4px">' +
        '<div style="font-size:14px;font-weight:600">' + esc(c.next.text) + '</div>' + (c.next.after ? '<div style="color:#9aa6b5">' + esc(c.next.after) + '</div>' : '') + '</div>';
    }
    h += '<canvas id="qi-map" width="360" height="230" style="width:360px;height:230px;background:#0f141b;border-radius:4px"></canvas>';
    if (c.plan) {
      const p = c.plan;
      h += '<details><summary style="cursor:pointer">План до ' + cfg.minRatio + '%: церквей ' + p.c + ', снести ' + p.D.reduce((a, b) => a + b, 0) +
        ' · хроно ' + fmt(p.chrono) + ' (без сноса ' + fmt(p.noActionChrono) + ')</summary><ol style="margin:6px 0 0 18px;padding:0">';
      p.groups.forEach((g) => {
        if (g.type === 'church') h += '<li>Церковь → ' + pct(g.ratio) + '</li>';
        else {
          const by = {}; g.items.forEach((x) => { by[x.house] = (by[x.house] || 0) + 1; });
          h += '<li>Снести ' + Object.entries(by).map(([n, k]) => k + ' × ' + esc(n)).join(', ') + '</li>';
        }
      });
      h += '</ol></details>';
    }
    if (c.hammers && c.hammers.supBase > 0) {
      const m = c.hammers;
      h += '<div style="color:#9aa6b5">Молотки: после сбора монет можно убрать ' + m.r + ' церкв. без потери ×1,2 и поставить до ' + m.B +
        ' пивоварен. Каждая даёт +' + fmt(m.gainEach) + ' молотков' + (m.worth ? '.' : ' — это меньше её цены, не окупается.') + '</div>';
    }
    h += '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">' +
      '<label>Цель, % <input id="qi-min" type="number" min="141" step="1" value="' + cfg.minRatio + '" style="width:54px"></label>' +
      '<label><input id="qi-reb" type="checkbox"' + (cfg.rebuild ? ' checked' : '') + '> учитывать пересборку</label></div>';
    body.innerHTML = h;
    const mi = body.querySelector('#qi-min');
    mi.addEventListener('change', () => { cfg.minRatio = Math.max(141, Number(mi.value) || 150); saveCfg(); render(); });
    mi.addEventListener('keydown', (e) => e.stopPropagation());
    body.querySelector('#qi-reb').addEventListener('change', (e) => { cfg.rebuild = e.target.checked; saveCfg(); render(); });
    drawMap(body.querySelector('#qi-map'), c);
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch])); }

  // изометрическая мини-карта: ориентация как в игре (ратуша сверху)
  function drawMap(cv, c) {
    const g = cv.getContext('2d');
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    S.areas.forEach((a) => { minX = Math.min(minX, a.x); minY = Math.min(minY, a.y); maxX = Math.max(maxX, a.x + a.w); maxY = Math.max(maxY, a.y + a.h); });
    if (!isFinite(minX)) return;
    const W = maxX - minX, Hh = maxY - minY;
    const cw = Math.min((cv.width - 10) / ((W + Hh) / 2), 2 * (cv.height - 10) / ((W + Hh) / 2));
    const chh = cw / 2;
    const ox = cv.width / 2 - ((W - Hh) / 2) * (cw / 2), oy = (cv.height - (W + Hh) * chh / 2) / 2;
    const P2 = (x, y) => [ox + ((x - minX) - (y - minY)) * cw / 2, oy + ((x - minX) + (y - minY)) * chh / 2];
    const poly = (x, y, w, h) => { const p = [P2(x, y), P2(x + w, y), P2(x + w, y + h), P2(x, y + h)]; g.beginPath(); g.moveTo(...p[0]); p.slice(1).forEach((q) => g.lineTo(...q)); g.closePath(); };
    g.clearRect(0, 0, cv.width, cv.height);
    g.fillStyle = '#26313d'; g.strokeStyle = '#33404e'; g.lineWidth = 0.5;
    S.areas.forEach((a) => { poly(a.x, a.y, a.w, a.h); g.fill(); g.stroke(); });
    S.ents.forEach((e) => {
      const d = def(e);
      let col = '#6b7785';
      if (d.cat === 'main_building') col = '#8a7a5c';
      else if (d.cat === 'impediment') col = '#4a525c';
      else if (e.cityentity_id === CHURCH_ID) col = '#8f6bc4';
      else if (isHouse(d)) col = d.bm ? '#2f8f7a' : '#3f7fae';
      else if (d.s) col = '#b5793a';
      else if (d.eu > 0) col = '#a07ad6';
      poly(e.x || 0, e.y || 0, d.w || 1, d.h || 1);
      g.fillStyle = col; g.globalAlpha = built(e) ? 1 : 0.5; g.fill(); g.globalAlpha = 1;
      g.strokeStyle = isReady(e) ? '#e8d27a' : '#0f141b'; g.lineWidth = isReady(e) ? 1.2 : 0.8; g.stroke();
    });
    const n = c.next;
    if (n && n.kind === 'demolish' && n.ent) {
      const d = def(n.ent); poly(n.ent.x || 0, n.ent.y || 0, d.w, d.h); g.strokeStyle = '#ff4d4d'; g.lineWidth = 3; g.stroke();
    }
    if (n && n.kind === 'church' && n.spot) {
      poly(n.spot.x, n.spot.y, 3, 3); g.fillStyle = 'rgba(108,194,138,.35)'; g.fill(); g.setLineDash([4, 3]); g.strokeStyle = '#6cc28a'; g.lineWidth = 2.5; g.stroke(); g.setLineDash([]);
    }
  }

  window.foeQiHelper = { S, handle, compute: () => compute(), render: () => render(), spots, occupancy, cellsUnlocked }; // для отладки из консоли
  setInterval(() => { if (S.inQI) render(); }, 30000); // обновлять таймеры готовности
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', buildPanel);
  else buildPanel();
})();
