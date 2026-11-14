// ==UserScript==
// @name         FoE калькулятор вложений в ВЗ
// @namespace    foe-gb-calc
// @version      1.5
// @description  При открытии чужого ВЗ показывает, сколько СО вложить, чтобы гарантированно занять место, и прибыль с учётом медного и золотого бонуса Арки. Сам ничего не нажимает.
// @author       MisterDan
// @match        https://*.forgeofempires.com/game
// @match        https://*.forgeofempires.com/game?*
// @match        https://*.forgeofempires.com/game/*
// @run-at       document-start
// @grant        none
// @updateURL    https://raw.githubusercontent.com/retrymister-ui/foe-qi-helper/main/foe-gb-calc.meta.js
// @downloadURL  https://raw.githubusercontent.com/retrymister-ui/foe-qi-helper/main/foe-gb-calc.user.js
// ==/UserScript==
// © MisterDan. Все права защищены.

(function () {
  'use strict';
  const KEY = 'foeGbCalc_v1';
  let cfg = { gold: 1.29, copper: 100, f: 1.9, pre: [1.9, 1.97, 2], wg: false, pl: {}, x: null, y: 60, hidden: false };
  try { Object.assign(cfg, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch (e) { /* ignore */ }
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(cfg)); } catch (e) { /* ignore */ } };

  const ents = {};          // entityId -> {cost, level, name, owner}
  let cur = null;           // {id, owner, rankings, cost}
  let shown = {};           // rank -> показанная награда СО (до золота) для калибровки

  function bodyText(b) {
    try { if (typeof b === 'string') return b; if (b instanceof ArrayBuffer || ArrayBuffer.isView(b)) return new TextDecoder().decode(b); } catch (e) { /* ignore */ }
    return null;
  }
  const oOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (m, u) { this.__gc = String(u || ''); return oOpen.apply(this, arguments); };
  const oSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (body) {
    if (this.__gc.indexOf('game/json') !== -1) {
      const req = bodyText(body);
      this.addEventListener('load', () => {
        try { if (this.responseType === '' || this.responseType === 'text') handle(req ? JSON.parse(req) : [], JSON.parse(this.responseText)); }
        catch (e) { console.warn('[калькулятор ВЗ]', e); }
      });
    }
    return oSend.apply(this, arguments);
  };

  // бонусы вложений складываются: ВЗ (Арка, Сифон…) + исследования и прочие постоянные усиления
  let myId = null;
  const gbB = {};           // entityId -> {name, cu, au}
  let extB = null;          // из BoostService.getAllBoosts: {cu, au, list}
  const GBN = { X_FutureEra_Landmark1: 'Арка', X_StellarAgeDiscovery_Landmark1: 'Сифон' };
  const NAMES = {"X_FutureEra_Landmark1": "Арка", "X_ArcticFuture_Landmark2": "Арктическая оранжерея", "X_OceanicFuture_Landmark3": "Синяя галактика", "X_SpaceAgeTitan_Landmark3": "Врата Сатурна VI: ГИДРА", "X_SpaceAgeSpaceHub_Landmark2": "Космический катализатор", "X_SpaceAgeTitan_Landmark2": "Врата Сатурна VI: ПЕГАС", "X_SpaceAgeTitan_Landmark1": "Врата Сатурна VI: КЕНТАВР", "X_SpaceAgeSpaceHub_Landmark1": "Звездный военный корабль", "X_SpaceAgeAsteroidBelt_Landmark1": "Космический авианосец", "X_StellarAgeDiscovery_Landmark1": "Сифон расколотого горизонта", "X_ArcticFuture_Landmark3": "Зернохранилище", "X_AllAge_Expedition": "Храм реликвий", "X_AllAge_EasterBonus4": "Обсерватория", "X_AllAge_Oracle": "Дельфийский оракул", "X_ArcticFuture_Landmark1": "Статуя Геи", "X_BronzeAge_Landmark1": "Вавилонская башня", "X_BronzeAge_Landmark2": "Статуя Зевса", "X_ColonialAge_Landmark1": "Фрауэнкирхе", "X_ColonialAge_Landmark2": "Дильский замок", "X_ContemporaryEra_Landmark1": "Храм Лотоса", "X_ContemporaryEra_Landmark2": "Башня Инноваций", "X_EarlyMiddleAge_Landmark1": "Собор Святой Софии", "X_EarlyMiddleAge_Landmark2": "Ахенский Собор", "X_EarlyMiddleAge_Landmark3": "Галатская башня", "X_FutureEra_Landmark2": "Проект «Дождевой лес»", "X_HighMiddleAge_Landmark1": "Собор Святого Марка", "X_HighMiddleAge_Landmark3": "Нотр-Дам", "X_IndustrialAge_Landmark1": "Королевский Альберт-холл", "X_IndustrialAge_Landmark2": "Капитолий", "X_IronAge_Landmark1": "Колизей", "X_IronAge_Landmark2": "Александрийский маяк", "X_LateMiddleAge_Landmark1": "Храм Василия Блаженного", "X_LateMiddleAge_Landmark3": "Кастель-дель-Монте", "X_ModernEra_Landmark1": "Спейс-Нидл", "X_ModernEra_Landmark2": "Атомиум", "X_OceanicFuture_Landmark1": "Музей Атлантиды", "X_OceanicFuture_Landmark2": "Кракен", "X_PostModernEra_Landmark1": "Космодром на мысе Канаверал", "X_PostModernEra_Landmark2": "Хабитат", "X_ProgressiveEra_Landmark1": "Алькатрас", "X_ProgressiveEra_Landmark2": "Шато-Фронтенак", "X_SpaceAgeJupiterMoon_Landmark1": "Ядро ИИ", "X_SpaceAgeMars_Landmark1": "Звездочёт", "X_SpaceAgeMars_Landmark2": "Проект «Дева»", "X_SpaceAgeVenus_Landmark1": "Парящий остров", "X_TomorrowEra_Landmark1": "Вояджер V1", "X_TomorrowEra_Landmark2": "Башня перемирия", "X_VirtualFuture_Landmark1": "Терракотовая армия", "X_VirtualFuture_Landmark2": "Замок Химэдзи"};
  function keepBonus(e) {
    if (myId == null || e.player_id !== myId) return;
    let cu = 0, au = 0;
    (e.bonuses || []).forEach((b) => { if (b.type === 'contribution_boost') cu += b.value || 0; if (b.type === 'contribution_boost_gold') au += b.value || 0; });
    if (cu || au) gbB[e.id] = { name: GBN[e.cityentity_id] || e.cityentity_id, cu, au }; else delete gbB[e.id];
  }
  function auto() {
    const g = Object.values(gbB);
    if (!g.length && !extB) return null;
    let cu = 0, au = 0; const parts = [];
    g.forEach((b) => { cu += b.cu; au += b.au; if (b.au) parts.push(`${b.name} ${b.au}`); });
    if (extB) { cu += extB.cu; au += extB.au; extB.list.forEach((x) => parts.push(x)); }
    return { cu, au, parts };
  }
  const copperPct = () => { const a = auto(); return a && cfg.autoB !== false ? a.cu : cfg.copper; };
  const goldK = () => { const a = auto(); return a && cfg.autoB !== false ? 1 + a.au / 100 : cfg.gold; };

  function keepEnt(e) {
    if (!e || e.type !== 'greatbuilding') return;
    keepBonus(e);
    const st = e.state || {};
    ents[e.id] = { cost: st.forge_points_for_level_up, inv: st.invested_forge_points || 0, level: e.level, max: e.max_level, cid: e.cityentity_id, owner: e.player_id };
  }

  function handle(reqs, resps) {
    const byId = {};
    (Array.isArray(reqs) ? reqs : []).forEach((q) => { if (q && q.requestId != null) byId[q.requestId] = q; });
    (Array.isArray(resps) ? resps : []).forEach((r) => {
      if (!r || !r.requestMethod) return;
      const q = byId[r.requestId] || {};
      const d = r.responseData;
      const m = r.requestMethod;
      if (m === 'getData' && d && d.city_map) { if (d.user_data) myId = d.user_data.player_id; (d.city_map.entities || []).forEach(keepEnt); }
      else if (m === 'getAllBoosts' && Array.isArray(d)) {
        const sum = { cu: 0, au: 0, list: [] }; const by = {};
        d.forEach((b) => {
          if (b.type !== 'contribution_boost' && b.type !== 'contribution_boost_gold') return;
          if (b.type === 'contribution_boost') sum.cu += b.value || 0; else { sum.au += b.value || 0; const o = b.origin === 'research' ? 'исследования' : (b.origin || 'прочее'); by[o] = (by[o] || 0) + (b.value || 0); }
        });
        sum.list = Object.entries(by).map(([k, v]) => `${k} ${v}`);
        extB = sum; if (cur) render();
      }
      else if (m === 'getOtherPlayerCityMapEntity' || m === 'getCityMapEntity') keepEnt(d);
      else if (r.requestClass === 'CityMapService' && m === 'updateEntity' && Array.isArray(d)) d.forEach(keepEnt);
      else if (m === 'getConstruction' && d && d.rankings) {
        const rd = q.requestData || [];
        const id = rd[0];
        cur = { id, owner: rd[1], rankings: d.rankings, era: d.ownerEra };
        render();
      } else if ((m === 'getConstructionRanking' || m === 'contributeForgePoints') && Array.isArray(d) && cur) {
        const rd = q.requestData || [];
        if (rd[0] == null || rd[0] === cur.id) { cur.rankings = d; render(); }
      } else if (r.requestClass === 'BlueprintService' && m === 'newReward' && d && d.rank && d.strategy_point_amount) {
        const s = shown[d.rank];
        if (s && s > 0) {
          const f = d.strategy_point_amount / s;
          const a = auto();
          if (a && cfg.autoB !== false) note = `Проверка: показано ${s}, пришло ${d.strategy_point_amount} (×${(Math.round(f * 1000) / 1000)}), по бонусам ×${goldK()}`;
          else if (f > 0.9 && f < 3) { cfg.gold = Math.round(f * 1000) / 1000; save(); note = `Калибровка: показано ${s}, пришло ${d.strategy_point_amount}, коэффициент ${cfg.gold}`; render(); }
        }
      }
    });
  }
  let note = '';
  // коэффициент вложения: свой для игрока, если меняли, иначе общий
  const ownerName = () => { const o = ((cur && cur.rankings) || []).find((x) => x.rank == null && x.player && !x.player.is_self); return o ? o.player.name : ''; };
  const plKey = () => (cur && cur.owner != null ? String(cur.owner) : '');
  const factor = () => { const p = cfg.pl[plKey()]; return p && p.f ? p.f : cfg.f; };

  // сколько вложить, чтобы место k было гарантировано при любом раскладе оставшихся СО
  function compute() {
    if (!cur) return null;
    const e = ents[cur.id];
    const rows = cur.rankings || [];
    let invested = 0, myCur = 0, isMine = false;
    const others = [];
    const rew = {};
    rows.forEach((x) => {
      const fp = x.forge_points || 0;
      invested += fp;
      if (x.player && x.player.is_self) { myCur = fp; if (x.rank == null) isMine = true; }
      else if (x.rank != null && fp > 0) others.push(fp);
      if (x.rank != null && x.reward && x.reward.strategy_point_amount) rew[x.rank] = x.reward;
    });
    others.sort((a, b) => b - a);
    if (!e || !e.cost) return { err: 'Нет стоимости уровня. Закройте и откройте ВЗ ещё раз.' };
    if (isMine) return { err: 'Это ваше ВЗ.' };
    const R = e.cost - invested;
    const out = [];
    shown = {};
    for (let k = 1; k <= 5; k++) {
      const rw = rew[k];
      if (!rw) continue;
      shown[k] = rw.strategy_point_amount;
      // место k потеряно, если k соперников станут выше вас. Чтобы обогнать ваш итог T, сопернику
      // с p СО нужно T+1-p (кто уже выше — 0; при равенстве место у того, кто вложил раньше).
      // Место надёжно, когда соперникам на это не хватает оставшихся СО: need(T) > R - добавка.
      const top = others.slice(0, k);
      while (top.length < k) top.push(0);
      const safe = (add) => {
        const T = myCur + add;
        let need = 0;
        for (const p of top) need += p > T ? 0 : T + 1 - p;
        return need > R - add;
      };
      let add = -1;
      if (safe(R)) { let lo = 0, hi = R; while (lo < hi) { const mid = (lo + hi) >> 1; if (safe(mid)) hi = mid; else lo = mid + 1; } add = lo; }
      const sp = Math.round(rw.strategy_point_amount * goldK());
      // номинал места (без Арки) × коэффициент; таблица показывает награду уже с медным бонусом
      const nom = rw.strategy_point_amount / (1 + copperPct() / 100);
      const fa = Math.round(nom * factor() * (cfg.wg ? goldK() : 1));   // с золотом: как в FoE Helper, выход в ноль
      const med = Math.round(((rw.resources && rw.resources.medals) || 0) * goldK());
      const ok = add >= 0;
      // сколько реально вложить: по коэффициенту, но не меньше минимума и не больше остатка
      const put = ok ? Math.min(R, Math.max(fa, add)) : 0;
      const bp = { cu: 0, au: 0 };
      (rw.blueprintRewards || []).forEach((b) => { if (b.tier && b.tier.value === 'gold') bp.au += b.amount || 0; else bp.cu += b.amount || 0; });
      out.push({ k, add, ok, sp, med, bp, fa, put, short: ok && fa < add, profit: sp - put, held: ok && add === 0 });
    }
    return { R, cost: e.cost, invested, myCur, level: e.level, name: NAMES[e.cid] || e.cid || 'ВЗ', out };
  }

  // ---- окно ----
  const CSS = `
  .gbc{position:fixed;z-index:99999;width:370px;color:#f3e6c8;font:12px/1.4 "Segoe UI",Arial,sans-serif;
    background:linear-gradient(#3b2a19,#2a1d11);border:2px solid #a9824a;border-radius:8px;box-shadow:0 4px 18px #000b;user-select:none}
  .gbc *{box-sizing:border-box}
  .gbc-h{display:flex;align-items:center;gap:6px;padding:6px 8px;cursor:move;background:linear-gradient(#6b4a26,#4a3219);border-radius:6px 6px 0 0;border-bottom:1px solid #a9824a}
  .gbc-t{flex:1;min-width:0}
  .gbc-t b{display:block;font-size:13px;color:#ffd98a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .gbc-t span{font-size:11px;color:#d8c39a}
  .gbc-i{cursor:pointer;width:22px;height:22px;display:flex;align-items:center;justify-content:center;border-radius:4px;background:#2a1d11;border:1px solid #7a5c33;color:#ffd98a;font-size:13px}
  .gbc-i:hover{background:#5a3e20}
  .gbc-b{padding:8px}
  .gbc-rem{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:7px;padding:5px 8px;background:#1d140b;border-radius:5px;border:1px solid #5a4326}
  .gbc-rem b{font-size:15px;color:#fff}
  .gbc-chips{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:7px;align-items:center}
  .gbc-c{cursor:pointer;padding:3px 9px;border-radius:12px;background:#4a3219;border:1px solid #7a5c33;font-weight:600}
  .gbc-c:hover{border-color:#ffd98a}
  .gbc-c.on{background:#c8902f;color:#1d140b;border-color:#ffd98a}
  .gbc-c.gold.on{background:#e8c04a}
  .gbc-own{font-size:11px;color:#9fd0ff;cursor:pointer;text-decoration:underline;margin-left:2px}
  .gbc table{width:100%;border-collapse:separate;border-spacing:0 3px}
  .gbc th{font-weight:400;font-size:11px;color:#bfa77a;font-size:11px;text-align:right;padding:0 6px}
  .gbc th:first-child{text-align:center}
  .gbc td{padding:4px 6px;text-align:right;background:#22180d;vertical-align:middle;color:#f3e6c8;font-size:13px}
  .gbc td:first-child{text-align:center;border-radius:5px 0 0 5px;font-weight:700;color:#ffd98a;width:24px}
  .gbc td:last-child{border-radius:0 5px 5px 0}
  .gbc tr.best td{background:#2d3a1a}
  .gbc tr.off td{color:#7c6a4c}
  .gbc .put{cursor:pointer;font-size:14px;font-weight:700;color:#fff;padding:1px 5px;border-radius:4px;border:1px dashed transparent}
  .gbc .put:hover{border-color:#ffd98a}
  .gbc .put.bad{color:#ff8a70}
  .gbc .sub{display:block;font-size:10px;color:#a8916a;line-height:1.2;white-space:nowrap}
  .gbc .pos{color:#8fe07a;font-weight:700}.gbc .zero{color:#ffd98a;font-weight:700}.gbc .neg{color:#ff8a70;font-weight:700}
  .gbc .held{color:#8fe07a;text-align:center!important}
  .gbc-f{margin-top:6px;font-size:11px;color:#bfa77a;display:flex;justify-content:space-between;gap:6px}
  .gbc-note{margin-top:5px;font-size:11px;color:#9fd0ff}
  .gbc-s{padding:8px;border-top:1px solid #5a4326;background:#1d140b;border-radius:0 0 6px 6px}
  .gbc-s .r{display:flex;align-items:center;gap:6px;margin:4px 0;flex-wrap:wrap}
  .gbc-s input[type=number]{width:58px;background:#2a1d11;color:#fff;border:1px solid #7a5c33;border-radius:4px;padding:2px 4px}
  .gbc-s .x{cursor:pointer;color:#ff8a70;margin-left:-2px}
  .gbc-s .lnk{cursor:pointer;color:#9fd0ff;text-decoration:underline}
  .gbc-s .hint{color:#8d7955;font-size:11px;margin-top:6px}
  .gbc-toast{position:absolute;left:50%;top:44px;transform:translateX(-50%);background:#c8902f;color:#1d140b;font-weight:700;padding:3px 10px;border-radius:10px;pointer-events:none}`;
  let box = null, setOpen = false;
  function ensureBox() {
    if (box || !document.body) return box;
    const st = document.createElement('style'); st.textContent = CSS; (document.head || document.body).appendChild(st);
    box = document.createElement('div'); box.className = 'gbc';
    place();
    document.body.appendChild(box);
    return box;
  }
  function place() {
    if (cfg.x == null) { box.style.right = '12px'; box.style.left = ''; } else { box.style.left = cfg.x + 'px'; box.style.right = ''; }
    box.style.top = cfg.y + 'px';
  }
  function drag(ev) {
    const r = box.getBoundingClientRect(); const dx = ev.clientX - r.left, dy = ev.clientY - r.top;
    const mv = (e) => { cfg.x = Math.max(0, Math.min(innerWidth - 60, e.clientX - dx)); cfg.y = Math.max(0, Math.min(innerHeight - 30, e.clientY - dy)); place(); };
    const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); save(); };
    document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
    ev.preventDefault();
  }
  const fmt = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const pct = (v) => Math.round((v - 1) * 100) + '%';
  function toast(t) {
    const d = document.createElement('div'); d.className = 'gbc-toast'; d.textContent = t; box.appendChild(d);
    setTimeout(() => d.remove(), 1200);
  }

  function render() {
    if (!ensureBox()) { setTimeout(render, 300); return; }
    const c = compute();
    const nm = ownerName();
    const own = cfg.pl[plKey()];
    const head = c && !c.err ? `<b>${c.name}</b><span>ур. ${c.level}→${c.level + 1}${nm ? ' · ' + nm : ''}</span>` : '<b>Вложения в ВЗ</b>';
    let h = `<div class="gbc-h" data-h><div class="gbc-t">${head}</div>
      <div class="gbc-i" data-s title="Настройки">⚙</div><div class="gbc-i" data-t title="${cfg.hidden ? 'Развернуть' : 'Свернуть'}">${cfg.hidden ? '▸' : '▾'}</div><div class="gbc-i" data-x title="Закрыть">✕</div></div>`;
    if (!cfg.hidden) {
      h += '<div class="gbc-b">';
      if (!c) h += 'Откройте чужое ВЗ.';
      else if (c.err) h += c.err;
      else {
        h += `<div class="gbc-rem"><span>Осталось до уровня</span><b>${fmt(c.R)}</b></div>`;
        if (c.myCur) h += `<div style="margin:-3px 0 7px;color:#d8c39a">Ваш вклад: <b style="color:#fff">${fmt(c.myCur)}</b></div>`;
        h += '<div class="gbc-chips">' + cfg.pre.map((v) => `<span class="gbc-c${v === factor() ? ' on' : ''}" data-ps="${v}" title="×${v}">${pct(v)}</span>`).join('')
          + `<span class="gbc-c gold${cfg.wg ? ' on' : ''}" data-wg title="Вкладывать с золотом: выход в ноль, как FoE Helper">+золото</span>`
          + (own ? `<span class="gbc-own" data-pr title="Вернуть общий ${pct(cfg.f)}">свой для игрока ×</span>` : '') + '</div>';
        const best = c.out.filter((o) => o.ok && !o.held).reduce((m, o) => (!m || o.profit > m.profit ? o : m), null);
        h += '<table><tr><th>#</th><th>Вложить</th><th>Придёт</th><th>Итог</th></tr>';
        let heldSeen = false;
        c.out.forEach((o) => {
          if (heldSeen) return;
          if (o.held) { heldSeen = true; h += `<tr><td>${o.k}</td><td colspan="3" class="held">место ваше, придёт ${fmt(o.sp)} СО</td></tr>`; return; }
          if (!o.ok) { h += `<tr class="off"><td>${o.k}</td><td colspan="3" style="text-align:center">не закрепить</td></tr>`; return; }
          const cls = o.profit > 0 ? 'pos' : o.profit === 0 ? 'zero' : 'neg';
          const putCell = o.short
            ? `<span class="put bad" data-cp="${o.add}" title="По коэффициенту ${fmt(o.fa)} — место отнимут. Нажмите, чтобы скопировать надёжную сумму">${fmt(o.add)}</span><span class="sub">по коэф. ${fmt(o.fa)} мало</span>`
            : `<span class="put" data-cp="${o.put}" title="Нажмите, чтобы скопировать">${fmt(o.put)}</span><span class="sub">надёжно от ${fmt(o.add)}</span>`;
          h += `<tr class="${o === best && o.profit >= 0 ? 'best' : ''}"><td>${o.k}</td><td>${putCell}</td>
            <td>${fmt(o.sp)}<span class="sub">чертежи ${o.bp.cu}+${o.bp.au} · мед. ${fmt(o.med)}</span></td>
            <td class="${cls}">${o.profit > 0 ? '+' : ''}${fmt(o.profit)}</td></tr>`;
        });
        h += '</table>';
        const a = auto();
        h += `<div class="gbc-f"><span>Медь ${copperPct()}% · золото ${Math.round((goldK() - 1) * 100)}%${a && cfg.autoB !== false ? ' (авто)' : ''}</span><span>нажмите сумму — скопируется</span></div>`;
      }
      if (note) h += `<div class="gbc-note">${note}</div>`;
      h += '</div>';
      if (setOpen) {
        const a = auto();
        h += '<div class="gbc-s">';
        h += `<div class="r">Общий коэффициент ×<input data-df type="number" step="0.01" min="1" max="3" value="${cfg.f}"></div>`;
        h += `<div class="r">Для этого игрока ×<input data-pf type="number" step="0.01" min="1" max="3" value="${factor()}" ${plKey() ? '' : 'disabled'}></div>`;
        h += '<div class="r">Кнопки: ' + cfg.pre.map((v) => `${pct(v)}<span class="x" data-pd="${v}" title="Убрать">✕</span>`).join(' ') + ' <span class="lnk" data-pa>добавить текущий</span></div>';
        if (a && cfg.autoB !== false) {
          h += `<div class="r">Бонус Арки: медь ${a.cu}%, золото ${a.au}% <span class="lnk" data-am>вручную</span></div>`;
          if (a.parts.length) h += `<div class="r" style="color:#a8916a">золото: ${a.parts.join(' + ')}</div>`;
        } else {
          h += `<div class="r">Медь <input data-cu type="number" step="1" min="0" max="300" value="${cfg.copper}">% золото ×<input data-g type="number" step="0.01" min="1" max="2" value="${cfg.gold}">${a ? ' <span class="lnk" data-aa>авто</span>' : ''}</div>`;
          if (!a) h += '<div class="hint">Бонусы подтянутся сами после перезагрузки игры.</div>';
        }
        h += '<div class="hint">Кнопка % — бонус Арки вкладчика: 90% = ×1,9. Нажатие запоминает коэффициент для владельца открытого ВЗ, другим не меняет. «Надёжно от»: меньше нельзя, место отнимут.</div>';
        h += '</div>';
      }
    }
    box.innerHTML = h;
    box.style.display = '';
    const q = (sel) => box.querySelector(sel);
    q('[data-h]').addEventListener('mousedown', (e) => { if (!e.target.closest('.gbc-i')) drag(e); });
    q('[data-t]').onclick = () => { cfg.hidden = !cfg.hidden; save(); render(); };
    q('[data-x]').onclick = () => { box.style.display = 'none'; };
    q('[data-s]').onclick = () => { setOpen = !setOpen; if (setOpen) cfg.hidden = false; render(); };
    const setF = (v) => { const k = plKey(); if (!k) return; if (v === cfg.f) delete cfg.pl[k]; else cfg.pl[k] = { f: v, n: ownerName() }; save(); render(); };
    box.querySelectorAll('[data-ps]').forEach((el) => { el.onclick = () => setF(parseFloat(el.dataset.ps)); });
    box.querySelectorAll('[data-pd]').forEach((el) => { el.onclick = () => { const v = parseFloat(el.dataset.pd); cfg.pre = cfg.pre.filter((x) => x !== v); save(); render(); }; });
    box.querySelectorAll('[data-cp]').forEach((el) => { el.onclick = () => {
      const v = el.dataset.cp;
      try { navigator.clipboard.writeText(v).then(() => toast('Скопировано ' + fmt(v)), () => toast(fmt(v))); } catch (e) { toast(fmt(v)); }
    }; });
    const on = (sel, ev, fn) => { const el = q(sel); if (el) el[ev] = fn; };
    on('[data-pa]', 'onclick', () => { const v = factor(); if (!cfg.pre.includes(v)) { cfg.pre.push(v); cfg.pre.sort((a, b) => a - b); save(); render(); } });
    on('[data-wg]', 'onclick', () => { cfg.wg = !cfg.wg; save(); render(); });
    on('[data-pr]', 'onclick', () => { delete cfg.pl[plKey()]; save(); render(); });
    on('[data-am]', 'onclick', () => { const a = auto(); cfg.autoB = false; if (a) { cfg.copper = a.cu; cfg.gold = 1 + a.au / 100; } save(); render(); });
    on('[data-aa]', 'onclick', () => { cfg.autoB = true; save(); render(); });
    const num = (sel, lo, hi, fn) => { const el = q(sel); if (el) el.onchange = () => { const v = parseFloat(el.value); if (v >= lo && v <= hi) { fn(v); save(); render(); } }; };
    num('[data-df]', 1, 3, (v) => { cfg.f = v; });
    num('[data-pf]', 1, 3, (v) => setF(v));
    num('[data-cu]', 0, 300, (v) => { cfg.copper = v; });
    num('[data-g]', 1, 2, (v) => { cfg.gold = v; note = ''; });
  }

  window.foeGbCalc = { get cfg() { return cfg; }, compute, handle, ents, auto };
})();
