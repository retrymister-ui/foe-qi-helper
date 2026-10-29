// ==UserScript==
// @name         FoE КВ журнал наград
// @namespace    foe-qi-reward-log
// @version      1.1
// @description  Записывает каждое действие на квантовой карте (бой, пожертвование) и выпавшую награду; считает частоты и проверяет, влияет ли перезаход. Сам ничего не нажимает.
// @match        https://*.forgeofempires.com/game/*
// @run-at       document-start
// @grant        none
// @updateURL    https://raw.githubusercontent.com/retrymister-ui/foe-qi-helper/main/foe-qi-reward-log.meta.js
// @downloadURL  https://raw.githubusercontent.com/retrymister-ui/foe-qi-helper/main/foe-qi-reward-log.user.js
// ==/UserScript==


(function () {
  'use strict';
  const KEY = 'foeQiRewardLog_v1';
  const server = location.host.split('.')[0];
  let rows = [];
  try { rows = JSON.parse(localStorage.getItem(KEY) || '[]'); } catch (e) { rows = []; }
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(rows)); } catch (e) { console.warn('[журнал наград] память переполнена — выгрузите CSV', e); } };

  // состояние текущего захода на карту
  let session = Math.max(0, ...rows.map((r) => r.ses || 0));
  let idx = 0;              // номер действия в заходе
  let curNode = null;
  const chests = {};        // nodeId -> {id, table}
  let visible = false;

  function bodyText(b) {
    try { if (typeof b === 'string') return b; if (b instanceof ArrayBuffer || ArrayBuffer.isView(b)) return new TextDecoder().decode(b); } catch (e) { /* ignore */ }
    return null;
  }
  const oOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (m, u) { this.__rl = String(u || ''); return oOpen.apply(this, arguments); };
  const oSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (body) {
    if (this.__rl.indexOf('game/json') !== -1) {
      const req = bodyText(body);
      this.addEventListener('load', () => {
        try { if (this.responseType === '' || this.responseType === 'text') handle(req ? JSON.parse(req) : [], JSON.parse(this.responseText)); }
        catch (e) { console.warn('[журнал наград]', e); }
      });
    }
    return oSend.apply(this, arguments);
  };

  function handle(reqs, resps) {
    if (!Array.isArray(resps)) return;
    const R = {};
    resps.forEach((r) => { if (r && r.requestClass) (R[r.requestClass + '.' + r.requestMethod] = R[r.requestClass + '.' + r.requestMethod] || []).push(r.responseData); });
    const Q = (Array.isArray(reqs) ? reqs : []).filter(Boolean);

    // любые данные квантов — показываем панель
    if (R['GuildRaidsService.getState'] || R['GuildRaidsService.getInstance'] || R['GuildRaidsMapService.getNodeExtendedInfo'] ||
        (R['CityMapService.getCityMap'] || []).some((d) => d && d.gridId === 'guild_raids')) { if (!visible) { visible = true; render(); } }
    if (R['GuildRaidsMapService.getOverview']) {
      const d = R['GuildRaidsMapService.getOverview'][0];
      session++; idx = 0; curNode = d && d.currentNode; visible = true; render();
    }
    ['AnnouncementsService.fetchAllAnnouncements', 'GuildExpeditionService.getOverview', 'GuildBattlegroundService.getBattleground', 'OtherPlayerService.visitPlayer']
      .forEach((k) => { if (R[k]) { visible = false; render(); } });
    (R['GuildRaidsMapService.updateNodeMovement'] || []).forEach((m) => { if (m && m.nodeTo) curNode = m.nodeTo; });
    // ход по карте: последняя точка маршрута — новый узел
    Q.filter((q) => q.requestClass === 'GuildRaidsMapService' && q.requestMethod === 'move').forEach((q) => {
      const path = (q.requestData || []).flat();
      if (path.length && R['GuildRaidsMapService.move']) curNode = path[path.length - 1];
    });
    Q.filter((q) => q.requestClass === 'GuildRaidsMapService' && q.requestMethod === 'getNodeExtendedInfo').forEach((q, i) => {
      const d = (R['GuildRaidsMapService.getNodeExtendedInfo'] || [])[i];
      const rw = d && d.reward && d.reward.reward;
      if (rw) chests[q.requestData[0]] = { id: rw.id, table: (rw.possible_rewards || []).map((p) => ({ c: p.drop_chance, k: rkey(p.reward), n: p.reward.name })) };
    });

    // действие: пожертвование или бой на карте
    let action = null;
    const don = Q.find((q) => q.requestClass === 'GuildRaidsMapService' && q.requestMethod === 'donate');
    if (don && R['GuildRaidsMapService.donate']) action = { a: 'donate', node: curNode, win: 1 };
    const bat = Q.find((q) => q.requestClass === 'BattlefieldService' && q.requestMethod === 'startByBattleType' && q.requestData && q.requestData[0] && q.requestData[0].type === 'guild_raids');
    if (bat && R['BattlefieldService.startByBattleType']) {
      const b = R['BattlefieldService.startByBattleType'][0];
      action = { a: 'battle', node: bat.requestData[0].nodeId || curNode, win: b && b.state && b.state.winnerBit === 1 ? 1 : 0, auto: bat.requestData[1] ? 1 : 0 };
    }
    if (action) {
      idx++;
      const set = (R['RewardService.collectRewardSet'] || []).find((s) => s && s.context === 'guild_raids');
      const rw = set && set.reward && set.reward.rewards && set.reward.rewards[0];
      const deck = (R['RewardDeckService.getFreeRewardsState'] || [])[0];
      const ch = chests[action.node];
      rows.push({
        t: new Date().toISOString(), srv: server, ses: session, i: idx, node: action.node, chest: ch ? ch.id : '', a: action.a, win: action.win,
        rw: rw ? rkey(rw) : '', rn: rw ? rw.name : '', deck: deck ? deck.currentProgress : null,
      });
      save(); render();
    }
  }
  function rkey(r) { return (r.subType || r.type || '') + ':' + (r.amount || ''); }

  // ---------- статистика ----------
  function erf(x) { const t = 1 / (1 + 0.3275911 * Math.abs(x)); const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return x >= 0 ? y : -y; }
  function pTwoProp(k1, n1, k2, n2) {
    if (!n1 || !n2) return null;
    const p = (k1 + k2) / (n1 + n2), se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
    if (!se) return null;
    const z = Math.abs(k1 / n1 - k2 / n2) / se;
    return 1 - erf(z / Math.SQRT2);
  }
  function gammaPQ(a, x) { // регуляризованная верхняя неполная гамма
    if (x <= 0) return 1;
    const lg = lgamma(a);
    if (x < a + 1) { let s = 1 / a, t = s; for (let n = 1; n < 200; n++) { t *= x / (a + n); s += t; if (t < s * 1e-12) break; } return 1 - s * Math.exp(-x + a * Math.log(x) - lg); }
    let b = x + 1 - a, c = 1e300, d = 1 / b, h = d;
    for (let i = 1; i < 200; i++) { const an = -i * (i - a); b += 2; d = an * d + b; if (Math.abs(d) < 1e-300) d = 1e-300; c = b + an / c; if (Math.abs(c) < 1e-300) c = 1e-300; d = 1 / d; const del = d * c; h *= del; if (Math.abs(del - 1) < 1e-12) break; }
    return Math.exp(-x + a * Math.log(x) - lg) * h;
  }
  function lgamma(z) { const g = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5]; let x = z, y = z, t = x + 5.5; t -= (x + 0.5) * Math.log(t); let s = 1.000000000190015; for (const c of g) s += c / ++y; return -t + Math.log(2.5066282746310005 * s / x); }

  function stats(list) {
    const acts = list.filter((r) => r.win);
    const got = acts.filter((r) => r.rw);
    const first = acts.filter((r) => r.i === 1), later = acts.filter((r) => r.i > 1);
    const kf = first.filter((r) => r.rw).length, kl = later.filter((r) => r.rw).length;
    // распределение типов против заявленного (по самому частому сундуку)
    const chestCount = {}; got.forEach((r) => { chestCount[r.chest] = (chestCount[r.chest] || 0) + 1; });
    const mainChest = Object.keys(chestCount).sort((a, b) => chestCount[b] - chestCount[a])[0];
    let dist = null;
    const table = Object.values(chests).find((c) => c.id === mainChest);
    if (table && mainChest) {
      const g = got.filter((r) => r.chest === mainChest), n = g.length;
      let chi = 0;
      const rowsD = table.table.map((x) => { const o = g.filter((r) => r.rw === x.k).length, e = n * x.c / 100; if (e > 0) chi += (o - e) * (o - e) / e; return { n: x.n, exp: x.c, obs: n ? o / n * 100 : 0, o }; });
      dist = { n, rows: rowsD, p: n >= 20 ? gammaPQ((table.table.length - 1) / 2, chi / 2) : null };
    }
    const byPos = [1, 2, 3, 4, 5].map((p) => { const g = acts.filter((r) => (p < 5 ? r.i === p : r.i >= 5)); return { p: p < 5 ? String(p) : '5+', n: g.length, k: g.filter((r) => r.rw).length }; });
    return { n: acts.length, lost: list.length - acts.length, k: got.length, first: [kf, first.length], later: [kl, later.length], pFL: pTwoProp(kf, first.length, kl, later.length), dist, byPos };
  }

  // ---------- интерфейс ----------
  let panel, open = false;
  const pct = (k, n) => (n ? (k / n * 100).toFixed(1) + '%' : '—');
  function pText(p) {
    if (p == null) return 'мало данных';
    if (p < 0.01) return 'p = ' + p.toFixed(3) + ' — разница почти наверняка не случайна';
    if (p < 0.05) return 'p = ' + p.toFixed(3) + ' — разница, скорее всего, есть';
    return 'p = ' + p.toFixed(2) + ' — разница в пределах случайности';
  }
  function render() {
    if (!document.body) return;
    if (!panel) {
      panel = document.createElement('div');
      panel.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:2147483645;background:rgba(18,24,33,.95);color:#e6ebf1;font:12.5px/1.4 system-ui,sans-serif;border-radius:8px;box-shadow:0 4px 14px rgba(0,0,0,.4);max-width:420px';
      document.body.appendChild(panel);
    }
    panel.style.display = visible ? 'block' : 'none';
    const mine = rows.filter((r) => r.srv === server);
    const s = stats(mine);
    let h = '<div id="rl-h" style="padding:6px 10px;cursor:pointer;background:#7a4fb3;border-radius:8px;display:flex;gap:8px"><b style="flex:1">Журнал наград</b><span>' +
      s.n + ' действ. · награда в ' + pct(s.k, s.n) + '</span><span>' + (open ? '▼' : '▲') + '</span></div>';
    if (open) {
      h += '<div style="padding:8px 10px;display:grid;gap:8px">';
      h += '<div>Сервер ' + server + '. Действий с победой: ' + s.n + (s.lost ? ', проигранных боёв: ' + s.lost : '') + '. Заход на карту сейчас № ' + session + ', действие ' + idx + '.</div>';
      h += '<div><b>Выпадает ли награда</b><br>первое действие после захода: ' + s.first[0] + ' из ' + s.first[1] + ' (' + pct(s.first[0], s.first[1]) + ')<br>' +
        'остальные действия: ' + s.later[0] + ' из ' + s.later[1] + ' (' + pct(s.later[0], s.later[1]) + ')<br><span style="color:#9aa6b5">' + pText(s.pFL) + '</span>' +
        '<div style="display:flex;gap:6px;margin-top:4px">' + s.byPos.map((b) => '<span style="flex:1;background:rgba(255,255,255,.06);border-radius:4px;padding:3px 4px;text-align:center">№' + b.p + '<br><b>' + pct(b.k, b.n) + '</b><br><span style="color:#9aa6b5">' + b.k + '/' + b.n + '</span></span>').join('') + '</div></div>';
      if (s.dist) {
        h += '<div><b>Что выпадает</b> (' + s.dist.n + ' наград)<table style="border-collapse:collapse;width:100%;margin-top:4px;color:inherit;font:inherit">' +
          '<tr style="color:#9aa6b5"><td>награда</td><td style="text-align:right">заявлено</td><td style="text-align:right">факт</td></tr>' +
          s.dist.rows.map((r) => '<tr><td>' + r.n + '</td><td style="text-align:right">' + r.exp + '%</td><td style="text-align:right">' + r.obs.toFixed(1) + '% (' + r.o + ')</td></tr>').join('') +
          '</table><span style="color:#9aa6b5">' + pText(s.dist.p) + '</span></div>';
      }
      h += '<div style="color:#9aa6b5">Схема: 3–5 действий → выйти с карты → зайти снова → ещё 3–5. Номер действия в заходе журнал считает сам. Надёжный вывод — примерно от 150 первых действий (это 500–700 действий всего).</div>';
      h += '<div style="display:flex;gap:8px"><button id="rl-csv" style="cursor:pointer">Скачать CSV</button><button id="rl-clr" style="cursor:pointer">Очистить</button></div></div>';
    }
    panel.innerHTML = h;
    panel.querySelector('#rl-h').onclick = () => { open = !open; render(); };
    const csv = panel.querySelector('#rl-csv');
    if (csv) csv.onclick = () => {
      const head = ['время', 'сервер', 'заход', 'номер_в_заходе', 'узел', 'сундук', 'действие', 'победа', 'награда', 'название', 'колода'];
      const lines = [head.join(';')].concat(rows.map((r) => [r.t, r.srv, r.ses, r.i, r.node, r.chest, r.a, r.win, r.rw, r.rn, r.deck].map((v) => String(v == null ? '' : v).replace(/;/g, ',')).join(';')));
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' }));
      a.download = 'qi-rewards-' + new Date().toISOString().slice(0, 10) + '.csv'; document.body.appendChild(a); a.click(); setTimeout(() => a.remove(), 1000);
    };
    const clr = panel.querySelector('#rl-clr');
    if (clr) clr.onclick = () => { if (clr.dataset.ok) { rows = []; save(); render(); } else { clr.dataset.ok = 1; clr.textContent = 'Точно очистить?'; } };
  }
  window.foeQiRewardLog = { handle, rows: () => rows, stats: () => stats(rows) };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', render); else render();
})();

