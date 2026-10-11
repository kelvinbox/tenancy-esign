'use strict';
/*
 * Runs the real Apps Script files (Template.js, Core.js, Code.js) in a sandbox with fake
 * Google services, and drives them through doPost exactly as the web pages would.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { sampleInput, SIGNATURE } = require('./helpers');
const build = require('../tools/build');

const signed = buf => Array.from(buf).map(b => (b > 127 ? b - 256 : b));

function fakeGoogle() {
  let n = 0;
  const id = p => p + '-' + (++n);
  const mails = [], fetches = [], sheets = {}, files = {}, folders = {};
  const props = {};

  class Blob {
    constructor(bytes, mime, name) { this.buf = Buffer.from(bytes); this.mime = mime; this.name = name; }
    getBytes() { return signed(this.buf); }
    setName(x) { this.name = x; return this; }
    getName() { return this.name; }
    getContentType() { return this.mime; }
    getAs(mime) { return new Blob(Buffer.concat([Buffer.from('%PDF-1.4 fake\n'), this.buf]), mime, this.name); }
  }

  function makeSheet() {
    const rows = [];
    let maxCols = 26;
    const store = v => {
      if (typeof v === 'string' && v.length > 50000) throw new Error('Cell over 50000 characters');
      return typeof v === 'string' && v.startsWith("'") ? v.slice(1) : v;
    };
    return {
      rows,
      getLastRow: () => rows.length,
      getLastColumn: () => rows.reduce((m, r) => Math.max(m, r.length), 0),
      getMaxColumns: () => maxCols,
      insertColumnsAfter: (after, k) => { maxCols += k; },
      appendRow: r => { if (r.length > maxCols) throw new Error('Too many columns'); rows.push(r.map(store)); },
      setFrozenRows: () => {},
      protect: () => ({ setWarningOnly() { return this; }, setDescription() { return this; } }),
      getRange: (r, c, nr, nc) => ({
        getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => {
          const v = (rows[r - 1 + i] || [])[c - 1 + j]; return v === undefined ? '' : v;
        })),
        setValues: vals => vals.forEach((row, i) => row.forEach((v, j) => {
          if (c - 1 + j >= maxCols) throw new Error('Too many columns');
          (rows[r - 1 + i] = rows[r - 1 + i] || [])[c - 1 + j] = store(v);
        }))
      })
    };
  }

  function makeFolder(name) {
    const f = {
      id: id('folder'), name, children: [],
      getId: () => f.id,
      getFoldersByName: nm => { const m = f.children.filter(c => c.name === nm); let i = 0; return { hasNext: () => i < m.length, next: () => m[i++] }; },
      createFolder: nm => { const c = makeFolder(nm); f.children.push(c); return c; },
      createFile: blob => {
        const fid = id('file');
        const file = { getId: () => fid, getUrl: () => 'https://drive.example/' + fid, getBlob: () => new Blob(blob.buf, blob.mime, blob.name), getMimeType: () => blob.mime, getName: () => blob.name };
        files[fid] = file; return file;
      }
    };
    folders[f.id] = f;
    return f;
  }

  const ctx = {
    console,
    Logger: { log: () => {} },
    Session: { getEffectiveUser: () => ({ getEmail: () => 'owner@example.com' }), getActiveUser: () => ({ getEmail: () => 'owner@example.com' }) },
    PropertiesService: { getScriptProperties: () => ({ getProperties: () => Object.assign({}, props), setProperties: o => Object.assign(props, o), getProperty: k => props[k] || null }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: s => ({ setMimeType() { return this; }, getContent: () => s }) },
    SpreadsheetApp: {
      create: () => { const sid = id('sheet'); sheets[sid] = { tabs: {} }; return { getId: () => sid }; },
      openById: sid => ({
        getSheetByName: nm => sheets[sid].tabs[nm] || null,
        insertSheet: nm => (sheets[sid].tabs[nm] = makeSheet())
      })
    },
    DriveApp: { createFolder: nm => makeFolder(nm), getFolderById: fid => folders[fid], getFileById: fid => files[fid] },
    MailApp: { sendEmail: o => mails.push(o), getRemainingDailyQuota: () => 100 },
    HtmlService: { createHtmlOutput: html => ({ getBlob: () => new Blob(Buffer.from(html, 'utf8'), 'text/html', 'x.html') }) },
    UrlFetchApp: { fetch: (url, o) => { fetches.push({ url, o }); return { getContentText: () => '' }; } },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' },
      computeDigest: (alg, bytes) => signed(crypto.createHash(alg).update(Buffer.from(bytes)).digest()),
      base64Decode: s => signed(Buffer.from(s, 'base64')),
      base64Encode: b => Buffer.from(b).toString('base64'),
      newBlob: (bytes, mime, name) => new Blob(bytes, mime, name),
      getUuid: () => crypto.randomUUID(),
      formatDate: (d, tz, fmt) => fmt === 'yyyy-MM-dd'
        ? new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
        : new Intl.DateTimeFormat('en-NZ', { timeZone: tz, dateStyle: 'medium', timeStyle: 'long' }).format(d)
    }
  };
  vm.createContext(ctx);
  for (const f of ['Template.js', 'Core.js', 'Code.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'apps-script', f), 'utf8'), ctx, { filename: f });
  }
  const post = req => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(req) } }).getContent());
  return { ctx, post, mails, fetches, sheets, files, props };
}

test('generated Apps Script copies match the shared sources', () => {
  for (const [src, dest] of build.pairs) {
    assert.equal(fs.readFileSync(path.join(build.root, dest), 'utf8'), build.generated(src), dest + ' is stale: run npm run build');
  }
});

test('Apps Script backend: full signing flow through doPost', () => {
  const g = fakeGoogle();
  assert.equal(g.post({ action: 'admin.list' }).code, 'SETUP');
  g.ctx.setup();
  Object.assign(g.props, { SIGN_URL: 'https://example.github.io/tenancy-esign/sign.html', OWNER_NAME: 'Sam Owner', WEBHOOK_URL: 'https://hook.example/x' });
  const key = g.props.ADMIN_KEY;
  assert.ok(key.length >= 32);

  assert.equal(g.post({ action: 'admin.list', adminKey: 'wrong' }).code, 'AUTH');

  // Long "other terms" forces the record across several spreadsheet cells.
  const input = sampleInput({ terms: Object.assign({}, sampleInput().terms, { additionalTerms: 'x'.repeat(60000) }) });
  const created = g.post({ action: 'admin.create', adminKey: key, actor: 'Sam', input });
  assert.equal(created.ok, true, created.error);
  const id = created.data.agreement.id;

  const signer = (email) => {
    const m = g.mails.filter(x => x.to === email && /Please sign/.test(x.subject)).slice(-1)[0];
    assert.ok(m, 'invite for ' + email);
    assert.equal(m.name, 'Sam Owner');
    const token = new URL(m.body.match(/https:\/\/\S+/)[0]).searchParams.get('t');
    const client = { ua: 'test', ip: '203.0.113.9' };
    const open = g.post({ action: 'sign.open', token, client });
    assert.equal(open.ok, true, open.error);
    g.post({ action: 'sign.consent', token, client });
    assert.equal(g.post({ action: 'sign.sendCode', token, client }).ok, true);
    const code = g.mails.slice(-1)[0].subject.slice(0, 6);
    assert.equal(g.post({ action: 'sign.verifyCode', token, code, client }).ok, true);
    g.post({ action: 'sign.reviewed', token, client, info: { termsHash: open.data.termsHash, secondsOnPage: 30 } });
    const details = Object.assign({}, open.data.me.details, { addressForService: 'Here' });
    const r = g.post({ action: 'sign.submit', token, client, payload: { details, typedName: details.name, agree: true, termsHash: open.data.termsHash, signaturePng: SIGNATURE, strokes: { count: 2 }, submissionId: 'x' + email } });
    assert.equal(r.ok, true, r.error);
    return { token, view: r.data };
  };

  signer('mia@example.com');
  signer('tui@example.net');
  const last = signer('landlord@example.com');
  assert.equal(last.view.agreement.status, 'Completed');

  const got = g.post({ action: 'admin.get', adminKey: key, id });
  assert.equal(got.data.chain.ok, true);
  assert.equal(got.data.agreement.status, 'Completed');

  // Record stored across multiple cells, and every cell is within the limit.
  const sid = g.props.SHEET_ID;
  const row = g.sheets[sid].tabs.Agreements.rows[1];
  assert.ok(row.length > 6, 'record split into several cells');

  // Signed PDF went to Drive and was attached to every completion email.
  const finals = g.mails.filter(m => /^Signed:/.test(m.subject));
  assert.equal(finals.length, 4);
  finals.forEach(m => assert.equal(m.attachments.length, 1));
  const pdf = g.files[got.data.agreement.final ? Object.keys(g.files).find(k => g.files[k].getName().endsWith('signed.pdf')) : ''];
  const bytes = Buffer.from(pdf.getBlob().getBytes());
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), got.data.agreement.final.sha256);

  // Public verification and signer download.
  assert.equal(g.post({ action: 'verify', sha256: got.data.agreement.final.sha256 }).data.found, true);
  const dl = g.post({ action: 'sign.download', token: last.token });
  assert.equal(dl.data.mime, 'application/pdf');

  // Webhook told the Tenant Management app about each change.
  assert.ok(g.fetches.some(f => JSON.parse(f.o.payload).event === 'completed'));
});

test('Apps Script backend: TEST_EMAIL_REDIRECT sends everything to the tester', () => {
  const g = fakeGoogle();
  g.ctx.setup();
  g.props.TEST_EMAIL_REDIRECT = 'me@example.com';
  const r = g.post({ action: 'admin.create', adminKey: g.props.ADMIN_KEY, input: sampleInput() });
  assert.equal(r.ok, true, r.error);
  assert.equal(g.mails[0].to, 'me@example.com');
  assert.match(g.mails[0].subject, /^\[for mia@example\.com\]/);
});

test('unexpected server errors are hidden from the caller', () => {
  const g = fakeGoogle();
  g.ctx.setup();
  g.ctx.MailApp.sendEmail = () => { throw new Error('Service invoked too many times'); };
  // Email failure during create is logged in the audit trail, not thrown.
  const r = g.post({ action: 'admin.create', adminKey: g.props.ADMIN_KEY, input: sampleInput() });
  assert.equal(r.ok, true);
  assert.ok(r.data.firstLink);
});
