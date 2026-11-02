// ==UserScript==
// @name         FoE Data Capture
// @namespace    foe-data-capture
// @version      1.1
// @description  Разовый сбор всех данных, которые игра получает от сервера (только чтение). Данные хранятся в памяти вкладки и выгружаются кнопкой.
// @match        https://*.forgeofempires.com/*
// @run-at       document-start
// @grant        none
// @updateURL    https://raw.githubusercontent.com/retrymister-ui/foe-qi-helper/main/foe-data-capture.meta.js
// @downloadURL  https://raw.githubusercontent.com/retrymister-ui/foe-qi-helper/main/foe-data-capture.user.js
// ==/UserScript==

(function () {
  'use strict';

  const cap = [];          // { t, kind, req?, data }
  let bytes = 0;
  let on = true;

  function push(kind, text, req) {
    if (!on || !text) return;
    let data;
    try { data = JSON.parse(text); } catch (e) { return; }
    let reqData;
    if (req) { try { reqData = JSON.parse(req); } catch (e) { reqData = undefined; } }
    cap.push({ t: new Date().toISOString(), kind, req: reqData, data });
    bytes += text.length;
    upd();
  }

  // XHR
  const oOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (m, url) { this.__u = String(url || ''); return oOpen.apply(this, arguments); };
  const oSend = XMLHttpRequest.prototype.send;
  const URL_RE = /game\/json|metadata\?id=/i;
  function bodyText(body) {
    try {
      if (typeof body === 'string') return body;
      if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return new TextDecoder().decode(body);
    } catch (e) { /* ignore */ }
    return undefined;
  }
  XMLHttpRequest.prototype.send = function (body) {
    const reqBody = bodyText(body);
    this.addEventListener('load', () => {
      try {
        if (!URL_RE.test(this.__u)) return;
        const kind = /metadata\?id=/i.test(this.__u) ? 'meta:' + this.__u.split('metadata?id=')[1].split('-')[0] : 'xhr';
        let text;
        if (this.responseType === '' || this.responseType === 'text') text = this.responseText;
        else if (this.responseType === 'json') text = JSON.stringify(this.response);
        else if (this.responseType === 'arraybuffer') text = new TextDecoder().decode(this.response);
        push(kind, text, reqBody);
      } catch (e) { /* ignore */ }
    });
    return oSend.apply(this, arguments);
  };

  // fetch
  if (window.fetch) {
    const oFetch = window.fetch;
    window.fetch = function (input, init) {
      const url = String((input && input.url) || input || '');
      const reqBody = init ? bodyText(init.body) : undefined;
      return oFetch.apply(this, arguments).then((r) => {
        if (URL_RE.test(url)) { try { r.clone().text().then((t) => push('fetch', t, reqBody)).catch(() => {}); } catch (e) { /* ignore */ } }
        return r;
      });
    };
  }

  // WebSocket (входящие сообщения)
  const OWS = window.WebSocket;
  if (OWS) {
    const WS = function (url, prot) {
      const ws = prot !== undefined ? new OWS(url, prot) : new OWS(url);
      ws.addEventListener('message', (ev) => { if (typeof ev.data === 'string') push('ws', ev.data); });
      return ws;
    };
    WS.prototype = OWS.prototype;
    ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach((k) => { WS[k] = OWS[k]; });
    window.WebSocket = WS;
  }

  // Панель
  let panel, cnt, btnPause;
  function upd() {
    if (cnt) cnt.textContent = 'Данные: ' + cap.length + ' отв., ' + (bytes / 1048576).toFixed(1) + ' МБ' + (on ? '' : ' (пауза)');
  }
  function stamp() { return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19); }
  function download() {
    const blob = new Blob([JSON.stringify({ host: location.host, exported: new Date().toISOString(), items: cap })], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'foe-capture-' + location.host.split('.')[0] + '-' + stamp() + '.json';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  }
  function build() {
    if (panel || !document.body) return;
    panel = document.createElement('div');
    panel.style.cssText = 'position:fixed;right:6px;top:6px;z-index:2147483647;background:rgba(10,30,50,.9);color:#cfe8ff;' +
      'font:12px sans-serif;padding:5px 7px;border-radius:6px;display:flex;gap:6px;align-items:center';
    cnt = document.createElement('span');
    panel.appendChild(cnt);
    const mk = (label, fn) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.style.cssText = 'font:12px sans-serif;cursor:pointer;padding:2px 6px';
      b.addEventListener('click', fn);
      panel.appendChild(b);
      return b;
    };
    mk('Скачать', download);
    btnPause = mk('Пауза', () => { on = !on; btnPause.textContent = on ? 'Пауза' : 'Продолжить'; upd(); });
    mk('Сброс', () => { cap.length = 0; bytes = 0; upd(); });
    document.body.appendChild(panel);
    upd();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build);
  else build();
})();
