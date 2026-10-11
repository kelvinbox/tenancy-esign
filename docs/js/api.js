/*
 * API client used by every page. Talks to the in-browser demo backend, or to the Apps Script
 * web app when ESIGN_CONFIG.apiUrl is set. Apps Script needs a "simple" POST (text/plain) so
 * the browser doesn't send a CORS preflight.
 */
var ESignApi = (function () {
  'use strict';
  var cfg = window.ESIGN_CONFIG || {};
  var live = !!cfg.apiUrl;
  var SAFE_TO_RETRY = { ping: 1, verify: 1, 'sign.open': 1, 'sign.submit': 1, 'sign.download': 1, 'admin.list': 1, 'admin.get': 1, 'admin.download': 1, 'admin.preview': 1 };

  function lsGet(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } }

  var ipPromise = null;
  function publicIp() {
    if (!cfg.captureIp) return Promise.resolve('');
    if (!ipPromise) {
      ipPromise = new Promise(function (resolve) {
        var done = false;
        setTimeout(function () { if (!done) { done = true; resolve(''); } }, 2500);
        fetch('https://api.ipify.org?format=json').then(function (r) { return r.json(); })
          .then(function (j) { if (!done) { done = true; resolve(String(j.ip || '')); } })
          .catch(function () { if (!done) { done = true; resolve(''); } });
      });
    }
    return ipPromise;
  }

  function clientInfo() {
    return publicIp().then(function (ip) {
      var tz = '';
      try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) { /* old browser */ }
      return {
        ip: ip, ua: navigator.userAgent, tz: tz, lang: navigator.language,
        screen: (screen.width || 0) + 'x' + (screen.height || 0) + '@' + (window.devicePixelRatio || 1),
        platform: navigator.platform || ''
      };
    });
  }

  function post(req, attempt) {
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 45000) : null;
    return fetch(cfg.apiUrl, {
      method: 'POST', redirect: 'follow', body: JSON.stringify(req),
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, signal: ctrl ? ctrl.signal : undefined
    }).then(function (r) {
      if (timer) clearTimeout(timer);
      if (!r.ok) throw Object.assign(new Error('The server replied with an error (' + r.status + '). Please try again.'), { network: true });
      return r.json();
    }, function () {
      if (timer) clearTimeout(timer);
      throw Object.assign(new Error('Couldn\'t reach the server. Check your connection and try again.'), { network: true });
    }).then(function (res) {
      if (!res.ok) throw Object.assign(new Error(res.error || 'Something went wrong.'), { code: res.code });
      return res.data;
    }).catch(function (e) {
      if (e.network && SAFE_TO_RETRY[req.action] && attempt < 3) {
        return new Promise(function (r) { setTimeout(r, 1200 * attempt); }).then(function () { return post(req, attempt + 1); });
      }
      throw e;
    });
  }

  function call(action, params) {
    var req = Object.assign({ action: action }, params || {});
    if (action.indexOf('admin.') === 0) {
      req.adminKey = lsGet('esign-admin-key');
      req.actor = lsGet('esign-actor') || 'landlord';
    }
    if (!live) return window.DemoBackend.call(req);
    return post(req, 1);
  }

  /** Signer calls carry device details for the audit trail. */
  function signerCall(action, params) {
    return clientInfo().then(function (client) {
      return call(action, Object.assign({ client: client }, params || {}));
    });
  }

  /** Wake a cold Apps Script server early, so the first real request is quick. */
  function warmUp() { if (live) post({ action: 'ping' }, 1).catch(function () { /* ignore */ }); }

  return {
    live: live,
    call: call,
    signerCall: signerCall,
    clientInfo: clientInfo,
    warmUp: warmUp,
    getAdminKey: function () { return lsGet('esign-admin-key'); },
    setAdminKey: function (v) { lsSet('esign-admin-key', v); },
    getActor: function () { return lsGet('esign-actor'); },
    setActor: function (v) { lsSet('esign-actor', v); }
  };
})();

/* Shared page helpers */
var UI = (function () {
  'use strict';
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function esc(v) { return ESign.esc(v); }
  var fmtter = new Intl.DateTimeFormat('en-NZ', { timeZone: 'Pacific/Auckland', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  var fmtLong = new Intl.DateTimeFormat('en-NZ', { timeZone: 'Pacific/Auckland', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short' });
  function when(iso) { return iso ? fmtter.format(new Date(iso)) : ''; }
  function whenLong(iso) { return iso ? fmtLong.format(new Date(iso)) : ''; }

  var toastTimer = null;
  function toast(msg, kind) {
    var el = $('#toast');
    if (!el) { el = document.createElement('div'); el.id = 'toast'; document.body.appendChild(el); }
    el.className = 'toast show ' + (kind || '');
    el.textContent = msg;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.className = 'toast'; }, kind === 'error' ? 6000 : 3000);
  }

  function copy(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    return new Promise(function (resolve, reject) {
      var ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.top = '-1000px';
      document.body.appendChild(ta); ta.select(); ta.setSelectionRange(0, text.length);
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      ok ? resolve() : reject(new Error('Copy failed'));
    });
  }

  function busy(btn, on, label) {
    if (!btn) return;
    if (on) { btn.dataset.label = btn.innerHTML; btn.disabled = true; btn.innerHTML = '<span class="spin"></span>' + (label || 'Working...'); }
    else { btn.disabled = false; if (btn.dataset.label) btn.innerHTML = btn.dataset.label; }
  }

  function modal(html, opts) {
    opts = opts || {};
    var wrap = document.createElement('div');
    wrap.className = 'modal-wrap';
    wrap.innerHTML = '<div class="modal' + (opts.wide ? ' wide' : '') + '" role="dialog" aria-modal="true">' +
      '<div class="modal-h"><div class="modal-t">' + esc(opts.title || '') + '</div><button class="icon-btn" data-close aria-label="Close">&times;</button></div>' +
      '<div class="modal-b">' + html + '</div></div>';
    document.body.appendChild(wrap);
    document.body.classList.add('noscroll');
    function close() { wrap.remove(); if (!$('.modal-wrap')) document.body.classList.remove('noscroll'); if (opts.onClose) opts.onClose(); }
    wrap.addEventListener('click', function (e) { if (e.target === wrap || e.target.hasAttribute('data-close')) close(); });
    return { el: wrap, close: close };
  }

  /**
   * In-page confirmation (native confirm() is silently blocked by some phone and in-app browsers).
   * opts: {title, message, list[], ok, danger}. Resolves true or false.
   */
  function ask(opts) {
    return new Promise(function (resolve) {
      var done = false;
      var body = (opts.message ? '<p>' + esc(opts.message) + '</p>' : '') +
        (opts.list && opts.list.length ? '<ol class="small" style="padding-left:20px;margin:6px 0 12px">' + opts.list.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ol>' : '') +
        (opts.note ? '<p class="small muted">' + esc(opts.note) + '</p>' : '') +
        '<div class="btn-row" style="margin-top:12px"><button class="btn ghost" data-ask="no">' + esc(opts.cancel || 'Cancel') + '</button>' +
        '<button class="btn' + (opts.danger ? ' danger' : '') + '" data-ask="yes">' + esc(opts.ok || 'OK') + '</button></div>';
      var m = modal(body, { title: opts.title || 'Are you sure?', onClose: function () { if (!done) { done = true; resolve(false); } } });
      $('[data-ask=yes]', m.el).addEventListener('click', function () { done = true; m.close(); resolve(true); });
      $('[data-ask=no]', m.el).addEventListener('click', function () { m.close(); });
    });
  }

  function downloadB64(file) {
    var bin = atob(file.base64), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    var url = URL.createObjectURL(new Blob([bytes], { type: file.mime }));
    var a = document.createElement('a');
    a.href = url; a.download = file.name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
  }

  function openB64(file) {
    var bin = atob(file.base64), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    var url = URL.createObjectURL(new Blob([bytes], { type: file.mime + (file.mime === 'text/html' ? ';charset=utf-8' : '') }));
    var w = window.open(url, '_blank');
    if (!w) downloadB64(file);
  }

  function statusPill(status, signer) {
    var cls = { Sent: 'amber', Completed: 'green', Signed: 'green', Declined: 'red', Cancelled: 'grey', Expired: 'grey', Waiting: 'grey', Opened: 'blue', Verified: 'blue' }[status] || 'grey';
    var label = status === 'Sent' ? (signer ? 'Link sent' : 'Out for signing') : status;
    return '<span class="pill ' + cls + '">' + esc(label) + '</span>';
  }

  return { $: $, $all: $all, esc: esc, when: when, whenLong: whenLong, toast: toast, copy: copy, busy: busy, modal: modal, ask: ask, downloadB64: downloadB64, openB64: openB64, statusPill: statusPill };
})();
