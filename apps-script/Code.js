/**
 * Tenancy e-sign: Google Apps Script backend (live mode).
 *
 * Deploy as a web app: Execute as "Me" (the owner), Who has access "Anyone".
 * Signers are identified by their private link token plus an emailed one-time code.
 * Landlord (admin) actions need the ADMIN_KEY script property.
 *
 * Core.js and Template.js are generated copies of docs/js/core.js and
 * docs/js/agreement-template.js (run: npm run build). Don't edit them here.
 *
 * Storage
 *   Spreadsheet "Agreements" sheet: one row per agreement (JSON split across columns
 *               so it never hits the 50,000-character cell limit).
 *   Spreadsheet "Audit" sheet:      one row per audit event, append-only, hash-chained.
 *   Drive folder:                   one sub-folder per agreement with each signature PNG
 *               and the final signed PDF.
 *
 * Pure ASCII: non-ASCII characters are written as \u escapes.
 */

var TZ = 'Pacific/Auckland';
var CHUNK = 45000;
var AGREEMENT_HEADERS = ['Agreement', 'Status', 'Property', 'Created', 'Updated', 'Record (JSON, continues in the next columns)'];
var AUDIT_HEADERS = ['Agreement', 'Seq', 'At (UTC)', 'Event', 'By', 'Hash', 'Event (JSON)'];

/* ---------- web app entry points ---------- */

/*
 * Keep-warm: a cold start can take close to a minute, longer than Tenant Management waits. Run installKeepWarm()
 * once from the editor; every 10 minutes keepWarm() pings this web app so the request path stays loaded.
 */
function keepWarm() {
  try {
    UrlFetchApp.fetch(ScriptApp.getService().getUrl(), { method: 'post', contentType: 'text/plain', payload: '{"action":"ping"}',
      muteHttpExceptions: true, followRedirects: true });
  } catch (e) { console.warn('keepWarm: ' + (e && e.message)); }
}
function installKeepWarm() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'keepWarm') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('keepWarm').timeBased().everyMinutes(10).create();
  return 'The signing service will be kept warm every 10 minutes.';
}

function doGet() {
  return json_({ ok: true, app: 'tenancy-esign', version: ESign.VERSION });
}

var ESIGN_T0 = Date.now();   // when this request's script started (cold starts included), for the timing reply
/* Requests that only read (they may at most mark an expired agreement): they wait a few seconds for the lock, then go ahead */
var ESIGN_READS = { verify: 1, 'admin.list': 1, 'admin.get': 1, 'admin.preview': 1, 'admin.download': 1, 'admin.progress': 1,
                    'admin.previewVariation': 1, 'admin.summary': 1, 'sign.download': 1, 'sign.attachment': 1 };

function doPost(e) {
  var req, t0 = Date.now(), t1 = t0, held = false;
  try {
    req = JSON.parse(e && e.postData ? e.postData.contents : '{}');
  } catch (err) {
    return json_({ ok: false, error: 'Bad request.', code: 'BAD_REQUEST' });
  }
  if (req.action === 'ping') return json_({ ok: true, data: { ok: true, version: ESign.VERSION } });

  var lock = LockService.getScriptLock();
  try {
    if (ESIGN_READS[req.action]) held = lock.tryLock(3000);   // a status check never queues long behind someone signing
    else { lock.waitLock(25000); held = true; }
    t1 = Date.now();
    var p = props_();
    if (!p.SHEET_ID || !p.FOLDER_ID) throw codeError_('The server isn\'t set up yet. Run setup() in the Apps Script editor.', 'SETUP');
    var engine = ESign.createEngine(sheetStore_(p), services_(p));
    var data = ESign.dispatch(engine, req, { requireAdminKey: true, adminKey: p.ADMIN_KEY || '' });
    var t2 = Date.now();
    return json_({ ok: true, data: data, ms: { start: t0 - ESIGN_T0, lockWait: t1 - t0, work: t2 - t1, total: t2 - ESIGN_T0 } });
  } catch (err) {
    if (err && err.code) return json_({ ok: false, error: err.message, code: err.code });
    console.error(err && err.stack ? err.stack : err);
    return json_({ ok: false, error: 'Something went wrong on the server. Please try again in a minute.', code: 'SERVER' });
  } finally {
    if (held) { try { lock.releaseLock(); } catch (x) { /* not held */ } }
  }
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function codeError_(msg, code) { var e = new Error(msg); e.code = code; return e; }

function props_() { return PropertiesService.getScriptProperties().getProperties(); }

/* ---------- one-off setup (run from the editor) ---------- */

/**
 * Creates the records spreadsheet, the Drive folder and a random admin key, and stores
 * them as script properties. Safe to run again: existing values are kept.
 */
function setup() {
  var sp = PropertiesService.getScriptProperties();
  var p = sp.getProperties();
  if (!p.SHEET_ID) p.SHEET_ID = SpreadsheetApp.create('Tenancy e-sign records (TEST)').getId();
  var ss = SpreadsheetApp.openById(p.SHEET_ID);
  ensureSheet_(ss, 'Agreements', AGREEMENT_HEADERS);
  ensureSheet_(ss, 'Audit', AUDIT_HEADERS);
  if (!p.FOLDER_ID) p.FOLDER_ID = DriveApp.createFolder('Tenancy e-sign (TEST)').getId();
  if (!p.ADMIN_KEY) p.ADMIN_KEY = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  if (!p.OWNER_EMAIL) p.OWNER_EMAIL = Session.getEffectiveUser().getEmail();
  if (!p.OWNER_NAME) p.OWNER_NAME = 'The landlord';
  if (!p.SIGN_URL) p.SIGN_URL = 'https://kelvinbox.github.io/tenancy-esign/sign.html';
  if (!p.VERIFY_URL) p.VERIFY_URL = p.SIGN_URL.replace(/sign\.html.*$/, 'verify.html');
  sp.setProperties(p);
  Logger.log('Setup done.\n' +
    'Records sheet: https://docs.google.com/spreadsheets/d/' + p.SHEET_ID + '\n' +
    'Drive folder:  https://drive.google.com/drive/folders/' + p.FOLDER_ID + '\n' +
    'ADMIN_KEY (paste into the console Setup tab): ' + p.ADMIN_KEY + '\n' +
    'Now check SIGN_URL, VERIFY_URL and OWNER_NAME in Project Settings > Script properties.');
}

function ensureSheet_(ss, name, headers) {
  var sh = ss.getSheetByName(name) || ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.appendRow(headers);
    sh.setFrozenRows(1);
    sh.protect().setWarningOnly(true).setDescription('Written by Tenancy e-sign. Editing by hand breaks the audit chain.');
  }
  return sh;
}

/* ---------- storage adapter ---------- */

function sheetStore_(p) {
  var ss = SpreadsheetApp.openById(p.SHEET_ID);
  var agr = ss.getSheetByName('Agreements');
  var aud = ss.getSheetByName('Audit');
  var cache = null;

  function copy(o) { return JSON.parse(JSON.stringify(o)); }

  function readAll() {
    if (cache) return cache;
    cache = [];
    var n = agr.getLastRow();
    if (n < 2) return cache;
    var vals = agr.getRange(2, 1, n - 1, agr.getLastColumn()).getValues();
    vals.forEach(function (r, i) {
      var json = r.slice(5).join('');
      if (json) cache.push({ row: i + 2, env: JSON.parse(json) });
    });
    return cache;
  }

  return {
    getEnvelope: function (id) {
      var f = readAll().filter(function (x) { return x.env.id === id; })[0];
      return f ? copy(f.env) : null;
    },
    listEnvelopes: function () { return readAll().map(function (x) { return copy(x.env); }); },
    saveEnvelope: function (env) {
      var json = JSON.stringify(env), parts = [];
      // A leading apostrophe makes Sheets store each value as plain text.
      for (var i = 0; i < json.length; i += CHUNK) parts.push("'" + json.slice(i, i + CHUNK));
      var row = [env.id, env.status, "'" + env.propertyAddress, "'" + env.createdAt, "'" + (env.updatedAt || '')].concat(parts);
      var width = Math.max(agr.getLastColumn(), row.length);
      if (agr.getMaxColumns() < width) agr.insertColumnsAfter(agr.getMaxColumns(), width - agr.getMaxColumns());
      while (row.length < width) row.push('');
      var all = readAll();
      var f = all.filter(function (x) { return x.env.id === env.id; })[0];
      if (f) {
        agr.getRange(f.row, 1, 1, width).setValues([row]);
        f.env = copy(env);
      } else {
        agr.appendRow(row);
        all.push({ row: agr.getLastRow(), env: copy(env) });
      }
    },
    deleteEnvelope: function (id) {   // the agreement row and its audit rows
      var all = readAll(), f = all.filter(function (x) { return x.env.id === id; })[0];
      if (f) agr.deleteRow(f.row);
      cache = null;
      var n = aud.getLastRow();
      if (n >= 2) {
        var ids = aud.getRange(2, 1, n - 1, 1).getValues();
        for (var i = ids.length - 1; i >= 0; i--) if (ids[i][0] === id) aud.deleteRow(i + 2);
      }
    },
    appendAudit: function (ev) {
      aud.appendRow([ev.envelopeId, ev.seq, "'" + ev.at, ev.type, "'" + ev.actor, ev.hash, "'" + JSON.stringify(ev)]);
    },
    listAudit: function (id) {
      var n = aud.getLastRow();
      if (n < 2) return [];
      return aud.getRange(2, 1, n - 1, 7).getValues()
        .filter(function (r) { return r[0] === id; })
        .map(function (r) { return JSON.parse(r[6]); })
        .sort(function (a, b) { return a.seq - b.seq; });
    }
  };
}

/* ---------- services adapter ---------- */

function services_(p) {
  var root = null;
  function rootFolder() { return root || (root = DriveApp.getFolderById(p.FOLDER_ID)); }
  function envFolder(envId) {
    var it = rootFolder().getFoldersByName(envId);
    return it.hasNext() ? it.next() : rootFolder().createFolder(envId);
  }
  function sha(bytes) {
    return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes)
      .map(function (b) { return ('0' + (b & 255).toString(16)).slice(-2); }).join('');
  }
  function uuidHex() { return Utilities.getUuid().replace(/-/g, ''); }

  return {
    config: {
      signUrl: p.SIGN_URL,
      verifyUrl: p.VERIFY_URL,
      ownerName: p.OWNER_NAME || 'The landlord',
      ownerEmail: p.OWNER_EMAIL,
      appName: 'Tenancy e-sign',
      linkDays: Number(p.LINK_DAYS) || 14,
      notifyOwnerEachSignature: p.NOTIFY_EACH_SIGNATURE !== 'false'
    },
    templates: ESignTemplates,
    now: function () { return new Date(); },
    today: function () { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'); },
    fmt: function (iso) { return Utilities.formatDate(new Date(iso), TZ, 'd MMM yyyy, h:mm:ss a z'); },
    randomString: function (n) {
      var s = '';
      while (s.length < n) s += uuidHex();
      return s.slice(0, n);
    },
    randomDigits: function (n) {
      var v = parseInt(uuidHex().slice(0, 12), 16) % Math.pow(10, n);
      return ('000000000' + v).slice(-n);
    },
    sendEmail: function (m) {
      var opts = { to: m.to, subject: m.subject, body: m.text, htmlBody: m.html, name: m.fromName || p.OWNER_NAME || 'The landlord' };
      if (m.inlineImages) {   // the landlord's logo in the email letterhead (data URIs -> inline images)
        opts.inlineImages = {};
        Object.keys(m.inlineImages).forEach(function (k) {
          var d = String(m.inlineImages[k]), mime = d.slice(5, d.indexOf(';'));
          opts.inlineImages[k] = Utilities.newBlob(Utilities.base64Decode(d.split(',')[1]), mime, k);
        });
      }
      if (p.OWNER_EMAIL && p.OWNER_EMAIL.toLowerCase() !== String(m.to).toLowerCase()) opts.replyTo = p.OWNER_EMAIL;
      if (m.attachments && m.attachments.length) opts.attachments = m.attachments.map(function (a) { return DriveApp.getFileById(a.ref).getBlob(); });
      if (p.TEST_EMAIL_REDIRECT) {
        // Testing with invented people: every email goes to you instead, labelled with who it was for.
        opts.subject = '[for ' + m.to + '] ' + opts.subject;
        opts.to = p.TEST_EMAIL_REDIRECT;
        delete opts.replyTo;
      }
      MailApp.sendEmail(opts);
    },
    saveImage: function (envId, name, dataUrl) {
      var bytes = Utilities.base64Decode(dataUrl.split(',')[1]);
      var file = envFolder(envId).createFile(Utilities.newBlob(bytes, 'image/png', name));
      return { ref: file.getId(), sha256: sha(bytes) };
    },
    saveFile: function (envId, name, base64, mime) {   // a file that is part of the agreement (body corporate rules)
      var bytes = Utilities.base64Decode(base64);
      var file = envFolder(envId).createFile(Utilities.newBlob(bytes, mime || 'application/pdf', name));
      return { ref: file.getId(), sha256: sha(bytes) };
    },
    trashFiles: function (envId) {   // the agreement's Drive folder (signatures, signed PDF, attachments) goes to the bin
      var it = rootFolder().getFoldersByName(envId);
      while (it.hasNext()) it.next().setTrashed(true);
    },
    loadImage: function (ref) {
      return 'data:image/png;base64,' + Utilities.base64Encode(DriveApp.getFileById(ref).getBlob().getBytes());
    },
    storeFinal: function (env, html) {
      var name = env.id + ' signed.pdf';
      var pdf = HtmlService.createHtmlOutput(html).getBlob().getAs('application/pdf').setName(name);
      var file = envFolder(env.id).createFile(pdf);
      var bytes = file.getBlob().getBytes();
      return { ref: file.getId(), url: file.getUrl(), sha256: sha(bytes), name: name, mime: 'application/pdf' };
    },
    readFinal: function (ref) {
      var file = DriveApp.getFileById(ref);
      return { name: file.getName(), mime: file.getMimeType(), base64: Utilities.base64Encode(file.getBlob().getBytes()) };
    },
    notify: function (payload) {
      if (!p.WEBHOOK_URL) return;
      UrlFetchApp.fetch(p.WEBHOOK_URL, {
        method: 'post', contentType: 'application/json', muteHttpExceptions: true,
        payload: JSON.stringify({ key: p.WEBHOOK_KEY || '', event: payload.event, agreement: payload.agreement })
      });
    }
  };
}

/* ---------- helpers for the Tenant Management app (server to server) ---------- */

/**
 * Example of how the Tenant Management Apps Script project could send an agreement.
 * Copy this into that project (not this one) and fill in the URL and key.
 */
function exampleSendFromTenantManagement_() {
  var url = 'https://script.google.com/macros/s/YOUR-DEPLOYMENT-ID/exec';
  var res = UrlFetchApp.fetch(url, {
    method: 'post', contentType: 'text/plain', muteHttpExceptions: true,
    payload: JSON.stringify({
      action: 'admin.create', adminKey: 'YOUR-ADMIN-KEY', actor: Session.getActiveUser().getEmail(),
      input: {
        propertyAddress: '14 Kowhai Lane, Roslyn, Dunedin',
        landlord: { name: 'Owner Family Trust', signerName: 'Sam Owner', email: 'sam.owner@example.com', mobile: '021 000 0100', addressForService: '9 Sample Terrace, Maori Hill, Dunedin' },
        terms: { rentPerWeek: '650', bond: '2600', startDate: '2026-11-01', endDate: '2027-10-31', maxOccupants: 3, rentPaymentDetails: 'Automatic payment', insurer: 'Not insured', insulationStatement: '...', healthyHomesStatement: '...' },
        tenants: [{ name: 'Mia Example', email: 'mia@example.com', mobile: '021 000 1001', idType: 'Driver licence', idNumber: 'DX000001', dob: '2001-05-04', ref: 'KB-20031' }],
        source: { groupKey: 'KB-20031', propertyId: 'P1' }
      }
    })
  });
  Logger.log(res.getContentText());
}
