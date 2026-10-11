/*
 * Demo backend: runs the real engine (core.js) inside the browser, storing everything in
 * localStorage, with a fake outbox instead of email. Every page on this site shares it, so
 * you can send an agreement in the console and open the signing link in another tab.
 */
var DemoBackend = (function () {
  'use strict';
  var KEY = 'tenancy-esign-demo-v1';

  function fresh() { return { envelopes: {}, audit: {}, images: {}, finals: {}, outbox: [] }; }
  function load() {
    try { return JSON.parse(localStorage.getItem(KEY)) || fresh(); } catch (e) { return fresh(); }
  }
  function save(db) {
    try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) {
      throw new Error('The browser storage for the demo is full. Use "Reset demo" in Settings.');
    }
  }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  var store = {
    getEnvelope: function (id) { var db = load(); return db.envelopes[id] ? db.envelopes[id] : null; },
    saveEnvelope: function (env) { var db = load(); db.envelopes[env.id] = clone(env); save(db); },
    listEnvelopes: function () { var db = load(); return Object.keys(db.envelopes).map(function (k) { return db.envelopes[k]; }); },
    appendAudit: function (ev) { var db = load(); (db.audit[ev.envelopeId] = db.audit[ev.envelopeId] || []).push(clone(ev)); save(db); },
    listAudit: function (id) { return load().audit[id] || []; }
  };

  function randomString(n) {
    var chars = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    var bytes = new Uint8Array(n), out = '';
    crypto.getRandomValues(bytes);
    for (var i = 0; i < n; i++) out += chars.charAt(bytes[i] % chars.length);
    return out;
  }
  function randomDigits(n) {
    var bytes = new Uint32Array(n), out = '';
    crypto.getRandomValues(bytes);
    for (var i = 0; i < n; i++) out += String(bytes[i] % 10);
    return out;
  }
  function b64ToBytes(b64) {
    var bin = atob(b64), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function utf8ToB64(s) {
    var bytes = new TextEncoder().encode(s), bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  var fmtter = new Intl.DateTimeFormat('en-NZ', {
    timeZone: 'Pacific/Auckland', day: 'numeric', month: 'short', year: 'numeric',
    hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short'
  });
  var dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Auckland', year: 'numeric', month: '2-digit', day: '2-digit' });

  function pageUrl(name) { return new URL(name, location.href).href.split('?')[0]; }

  var cfg = window.ESIGN_CONFIG || {};
  var svc = {
    config: {
      signUrl: pageUrl('sign.html'),
      verifyUrl: pageUrl('verify.html'),
      ownerName: cfg.ownerName || 'The landlord',
      ownerEmail: 'sam.owner@example.com',
      appName: cfg.appName
    },
    templates: window.ESignTemplates,
    now: function () { return new Date(); },
    today: function () { return dayFmt.format(new Date()); },
    fmt: function (iso) { return fmtter.format(new Date(iso)); },
    randomString: randomString,
    randomDigits: randomDigits,
    sendEmail: function (m) {
      var db = load();
      db.outbox.unshift({ at: new Date().toISOString(), to: m.to, subject: m.subject, text: m.text, kind: m.kind, link: m.link || null, code: m.code || null, attachments: (m.attachments || []).map(function (a) { return a.name; }) });
      db.outbox = db.outbox.slice(0, 200);
      save(db);
    },
    saveImage: function (envId, name, dataUrl) {
      var db = load(), ref = 'img-' + randomString(10);
      db.images[ref] = dataUrl;
      save(db);
      return { ref: ref, sha256: ESign.sha256(b64ToBytes(dataUrl.split(',')[1])) };
    },
    saveFile: function (envId, name, base64, mime) {
      var db = load(), ref = 'file-' + randomString(10);
      db.files = db.files || {};
      db.files[ref] = { name: name, mime: mime, base64: base64 };
      save(db);
      return { ref: ref, sha256: ESign.sha256(b64ToBytes(base64)) };
    },
    loadImage: function (ref) { return load().images[ref]; },
    storeFinal: function (env, html) {
      var db = load(), ref = 'final-' + env.id;
      db.finals[ref] = html;
      save(db);
      return { ref: ref, url: null, sha256: ESign.sha256(html), name: env.id + ' signed.html', mime: 'text/html' };
    },
    readFinal: function (ref) {
      var files = load().files || {};
      if (files[ref]) return { name: files[ref].name, mime: files[ref].mime, base64: files[ref].base64 };
      var html = load().finals[ref];
      return { name: ref.replace(/^final-/, '') + ' signed.html', mime: 'text/html', base64: utf8ToB64(html) };
    },
    notify: function (payload) {
      var db = load();
      db.outbox.unshift({ at: new Date().toISOString(), to: 'Tenant Management app (webhook)', subject: 'Agreement ' + payload.event + ': ' + payload.agreement.id + ' (' + payload.agreement.progress + ' signed)', kind: 'webhook', text: JSON.stringify(payload, null, 2) });
      save(db);
    }
  };

  var engine = ESign.createEngine(store, svc);

  function call(req) {
    return new Promise(function (resolve, reject) {
      setTimeout(function () {
        try { resolve(clone(ESign.dispatch(engine, req, {}))); } catch (e) { reject(e); }
      }, 120 + Math.random() * 180);
    });
  }

  return {
    call: call,
    outbox: function () { return load().outbox; },
    latestCodeFor: function () {
      var m = load().outbox.filter(function (x) { return x.kind === 'code'; })[0];
      return m ? { code: m.code, to: m.to, at: m.at } : null;
    },
    reset: function () { localStorage.removeItem(KEY); },
    clearOutbox: function () { var db = load(); db.outbox = []; save(db); }
  };
})();
