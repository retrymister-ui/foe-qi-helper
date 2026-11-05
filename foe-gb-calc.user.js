// ==UserScript==
// @name         FoE калькулятор вложений в ВЗ
// @namespace    foe-gb-calc
// @version      1.1
// @description  При открытии чужого ВЗ показывает, сколько СО вложить, чтобы гарантированно занять место, и прибыль с учётом медного и золотого бонуса Арки. Сам ничего не нажимает.
// @author       MisterDan
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
  let cfg = { gold: 1.29, copper: 100, f: 1.9, pl: {}, x: null, y: 60, hidden: false };
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

  function keepEnt(e) {
    if (!e || e.type !== 'greatbuilding') return;
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
      if (m === 'getData' && d && d.city_map) (d.city_map.entities || []).forEach(keepEnt);
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
          if (f > 0.9 && f < 3) { cfg.gold = Math.round(f * 1000) / 1000; save(); note = `Калибровка: показано ${s}, пришло ${d.strategy_point_amount}, коэффициент ${cfg.gold}`; render(); }
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
      const sp = Math.round(rw.strategy_point_amount * cfg.gold);
      // номинал места (без Арки) × коэффициент; таблица показывает награду уже с медным бонусом
      const nom = rw.strategy_point_amount / (1 + cfg.copper / 100);
      const fa = Math.round(nom * factor());
      const med = Math.round(((rw.resources && rw.resources.medals) || 0) * cfg.gold);
      const ok = add >= 0;
      // сколько реально вложить: по коэффициенту, но не меньше минимума и не больше остатка
      const put = ok ? Math.min(R, Math.max(fa, add)) : 0;
      out.push({ k, add, ok, sp, med, fa, put, short: ok && fa < add, profit: sp - put, held: ok && add === 0 });
    }
    return { R, cost: e.cost, invested, myCur, level: e.level, out };
  }

  // ---- окно ----
  let box = null;
  function ensureBox() {
    if (box || !document.body) return box;
    box = document.createElement('div');
    box.style.cssText = 'position:fixed;z-index:99999;min-width:250px;background:rgba(25,22,18,.94);color:#eee;font:12px/1.35 Arial,sans-serif;border:1px solid #8a6d3b;border-radius:6px;box-shadow:0 2px 10px #000a;user-select:none';
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
    const mv = (e) => { cfg.x = Math.max(0, e.clientX - dx); cfg.y = Math.max(0, e.clientY - dy); place(); };
    const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); save(); };
    document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
    ev.preventDefault();
  }
  const fmt = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

  function render() {
    if (!ensureBox()) { setTimeout(render, 300); return; }
    const c = compute();
    let h = '<div data-h style="cursor:move;padding:5px 8px;background:#3a2e1c;border-radius:6px 6px 0 0;display:flex;justify-content:space-between;align-items:center">'
      + '<b>Вложения в ВЗ</b><span><span data-t style="cursor:pointer;padding:0 5px" title="Свернуть">' + (cfg.hidden ? '▸' : '▾') + '</span><span data-x style="cursor:pointer;padding:0 3px" title="Закрыть">✕</span></span></div>';
    if (!cfg.hidden) {
      h += '<div style="padding:6px 8px">';
      if (!c) h += 'Откройте чужое ВЗ.';
      else if (c.err) h += c.err;
      else {
        h += `<div style="color:#bbb;margin-bottom:4px">Ур. ${c.level}→${c.level + 1}: осталось <b style="color:#fff">${fmt(c.R)}</b> из ${fmt(c.cost)}${c.myCur ? `, ваше ${fmt(c.myCur)}` : ''}</div>`;
        h += `<table style="border-collapse:collapse;width:100%"><tr style="color:#aaa"><td>Место</td><td style="text-align:right">×${factor()}</td><td style="text-align:right">Мин.</td><td style="text-align:right">Придёт</td><td style="text-align:right">Итог</td></tr>`;
        let heldSeen = false;
        c.out.forEach((o) => {
          if (heldSeen) return;
          if (o.held) heldSeen = true;
          if (o.held) { h += `<tr><td>${o.k}</td><td colspan="4" style="text-align:right;color:#7fd17f">закреплено, придёт ${fmt(o.sp)}</td></tr>`; return; }
          if (!o.ok) { h += `<tr style="color:#777"><td>${o.k}</td><td colspan="4" style="text-align:right">не закрепить</td></tr>`; return; }
          const col = o.profit > 0 ? '#7fd17f' : o.profit === 0 ? '#e8d27a' : '#e07a6a';
          const faTxt = o.short ? `<span style="color:#e07a6a" title="По коэффициенту место отнимут">${fmt(o.fa)}</span>` : `<b>${fmt(o.fa)}</b>`;
          h += `<tr><td>${o.k}</td><td style="text-align:right">${faTxt}</td><td style="text-align:right;color:#bbb">${fmt(o.add)}</td><td style="text-align:right">${fmt(o.sp)}</td><td style="text-align:right;color:${col}" title="при вложении ${fmt(o.put)}">${o.profit > 0 ? '+' : ''}${fmt(o.profit)}</td></tr>`;
        });
        h += '</table>';
      }
      const own = cfg.pl[plKey()];
      const nm = ownerName();
      const row = 'margin-top:5px;color:#aaa;display:flex;align-items:center;gap:4px;flex-wrap:wrap';
      if (c && !c.err) h += `<div style="${row}">Коэф. ${nm ? 'для ' + nm : ''} ×<input data-pf type="number" step="0.05" min="1" max="3" value="${factor()}" style="width:46px;background:#222;color:#fff;border:1px solid #555;border-radius:3px;padding:1px 3px">${own ? '<span data-pr style="cursor:pointer;color:#9ab;text-decoration:underline" title="Вернуть общий">свой, сброс</span>' : ''}</div>`;
      h += `<div style="${row}">По умолчанию ×<input data-df type="number" step="0.05" min="1" max="3" value="${cfg.f}" style="width:46px;background:#222;color:#fff;border:1px solid #555;border-radius:3px;padding:1px 3px"> Медь Арки <input data-cu type="number" step="1" min="0" max="200" value="${cfg.copper}" style="width:46px;background:#222;color:#fff;border:1px solid #555;border-radius:3px;padding:1px 3px">%</div>`;
      h += `<div style="${row}">Золото ×<input data-g type="number" step="0.01" min="1" max="2" value="${cfg.gold}" style="width:46px;background:#222;color:#fff;border:1px solid #555;border-radius:3px;padding:1px 3px"></div>`;
      if (note) h += `<div style="color:#9ab;margin-top:3px">${note}</div>`;
      h += '<div style="color:#777;margin-top:3px;font-size:11px">×коэф.: номинал места × коэффициент. Мин.: меньше нельзя, место отнимут. Красным: по коэффициенту место не удержать, считаю по минимуму.</div>';
      h += '</div>';
    }
    box.innerHTML = h;
    box.style.display = '';
    box.querySelector('[data-h]').addEventListener('mousedown', (e) => { if (!e.target.closest('[data-t],[data-x]')) drag(e); });
    box.querySelector('[data-t]').onclick = () => { cfg.hidden = !cfg.hidden; save(); render(); };
    box.querySelector('[data-x]').onclick = () => { box.style.display = 'none'; };
    const g = box.querySelector('[data-g]');
    if (g) g.onchange = () => { const v = parseFloat(g.value); if (v >= 1 && v <= 2) { cfg.gold = v; save(); note = ''; render(); } };
    const num = (sel, lo, hi, fn) => { const el = box.querySelector(sel); if (el) el.onchange = () => { const v = parseFloat(el.value); if (v >= lo && v <= hi) { fn(v); save(); render(); } }; };
    num('[data-pf]', 1, 3, (v) => { const k = plKey(); if (!k) return; if (v === cfg.f) delete cfg.pl[k]; else cfg.pl[k] = { f: v, n: ownerName() }; });
    num('[data-df]', 1, 3, (v) => { cfg.f = v; });
    num('[data-cu]', 0, 200, (v) => { cfg.copper = v; });
    const pr = box.querySelector('[data-pr]');
    if (pr) pr.onclick = () => { delete cfg.pl[plKey()]; save(); render(); };
  }

  window.foeGbCalc = { get cfg() { return cfg; }, compute, handle, ents };
})();
