'use strict';
const crypto = require('crypto');
const ESign = require('../docs/js/core.js');
const ESignTemplates = require('../docs/js/agreement-template.js');

/** A tiny PNG-like data URL, big enough to pass the "not blank" check. */
const SIGNATURE = 'data:image/png;base64,' + Buffer.alloc(600, 7).toString('base64');

function memoryBackend(opts) {
  opts = opts || {};
  const db = { envelopes: {}, audit: {}, images: {}, finals: {}, outbox: [] };
  let clock = new Date(opts.start || '2026-10-11T01:00:00Z').getTime();
  const store = {
    getEnvelope: id => (db.envelopes[id] ? JSON.parse(JSON.stringify(db.envelopes[id])) : null),
    saveEnvelope: env => { db.envelopes[env.id] = JSON.parse(JSON.stringify(env)); },
    listEnvelopes: () => Object.values(db.envelopes).map(e => JSON.parse(JSON.stringify(e))),
    appendAudit: ev => { (db.audit[ev.envelopeId] = db.audit[ev.envelopeId] || []).push(JSON.parse(JSON.stringify(ev))); },
    listAudit: id => JSON.parse(JSON.stringify(db.audit[id] || [])),
    deleteEnvelope: id => { delete db.envelopes[id]; delete db.audit[id]; }
  };
  const svc = {
    config: Object.assign({ signUrl: 'https://example.test/sign.html', verifyUrl: 'https://example.test/verify.html', ownerName: 'Sam Owner', ownerEmail: 'owner@example.com' }, opts.config),
    templates: ESignTemplates,
    now: () => new Date(clock),
    today: () => new Date(clock + 13 * 3600000).toISOString().slice(0, 10),
    fmt: iso => iso,
    randomString: n => crypto.randomBytes(n).toString('hex').slice(0, n),
    randomDigits: n => String(crypto.randomInt(0, 10 ** n)).padStart(n, '0'),
    sendEmail: m => { if (opts.failEmail) throw new Error('quota'); db.outbox.push(m); },
    saveImage: (envId, name, dataUrl) => {
      const bytes = Buffer.from(dataUrl.split(',')[1], 'base64');
      const ref = 'img' + Object.keys(db.images).length;
      db.images[ref] = dataUrl;
      return { ref, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
    },
    saveFile: (envId, name, base64, mime) => {
      const ref = 'file' + Object.keys(db.files || (db.files = {})).length;
      db.files[ref] = { name, mime, base64 };
      return { ref, sha256: crypto.createHash('sha256').update(Buffer.from(base64, 'base64')).digest('hex') };
    },
    trashFiles: envId => { (db.trashed = db.trashed || []).push(envId); },
    loadImage: ref => db.images[ref],
    storeFinal: (env, html) => {
      const ref = 'fin-' + env.id;
      db.finals[ref] = html;
      return { ref, sha256: crypto.createHash('sha256').update(html, 'utf8').digest('hex'), name: env.id + '.html', mime: 'text/html' };
    },
    readFinal: ref => (db.files && db.files[ref]) ? Object.assign({}, db.files[ref]) : ({ name: ref + '.html', mime: 'text/html', base64: Buffer.from(db.finals[ref]).toString('base64') })
  };
  const engine = ESign.createEngine(store, svc);
  return {
    db, store, svc, engine,
    call: req => ESign.dispatch(engine, req, opts.dispatch || {}),
    advance: ms => { clock += ms; },
    lastEmail: (to, kind) => db.outbox.filter(m => m.to === to && (!kind || m.kind === kind)).slice(-1)[0],
    tokenFrom: m => new URL(m.link).searchParams.get('t')
  };
}

function sampleInput(over) {
  return Object.assign({
    propertyAddress: '14 Kowhai Lane, Roslyn, Dunedin',
    landlord: { name: 'Example Family Trust', signerName: 'Sam Owner', email: 'landlord@example.com', phone: '03 000 0000', mobile: '021 000 0001', addressForService: '1 Example Road, Mornington, Dunedin' },
    terms: {
      rentPerWeek: '650', bond: '2600', startDate: '2026-11-01', endDate: '2027-10-31', maxOccupants: 3,
      rentPaymentDetails: 'Bank transfer to 00-0000-0000000-00 (fake account)', chattels: 'Fridge, washing machine',
      insurer: 'Example Insurance Ltd', insurancePolicy: 'POL-0001', excess: '500',
      insulationDate: '2025-03-12', insulationStatement: 'Ceiling: 190mm glass wool, good condition. Underfloor: polystyrene, good condition.',
      healthyHomesStatement: 'The landlord complies with the healthy homes standards.'
    },
    tenants: [
      { name: 'Mia Example', email: 'mia@example.com', mobile: '021 000 1001', idType: 'Driver licence', idNumber: 'DX000001', dob: '2001-05-04' },
      { name: 'T\u016bi Sample', email: 'tui@example.net', mobile: '021 000 1002', idType: 'Passport', idNumber: 'LA000002', dob: '2000-01-02' }
    ]
  }, over || {});
}

/** Walks one signer through every step. Returns the final signer view. */
function signAs(b, token, over) {
  over = over || {};
  const client = { ua: 'node-test', ip: '203.0.113.5', tz: 'Pacific/Auckland' };
  let view = b.call({ action: 'sign.open', token, client });
  b.call({ action: 'sign.consent', token, client });
  b.call({ action: 'sign.sendCode', token, client });
  const codeMail = b.db.outbox.filter(m => m.kind === 'code').slice(-1)[0];
  b.call({ action: 'sign.verifyCode', token, code: codeMail.code, client });
  b.call({ action: 'sign.reviewed', token, info: { termsHash: view.termsHash, secondsOnPage: 42 }, client });
  const details = Object.assign({}, view.me.details, { addressForService: '14 Kowhai Lane, Roslyn, Dunedin' }, over.details || {});
  return b.call({
    action: 'sign.submit', token, client,
    payload: {
      details, typedName: over.typedName || details.name, agree: true, declare: over.declare !== undefined ? over.declare : !!view.declarationText, termsHash: view.termsHash,
      signaturePng: SIGNATURE, strokes: { count: 3, points: 120, ms: 2100 }, submissionId: over.submissionId || 'sub-' + Math.random()
    }
  });
}

module.exports = { ESign, ESignTemplates, memoryBackend, sampleInput, signAs, SIGNATURE };
