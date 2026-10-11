'use strict';
/*
 * Runs integration/esign-provider.gs (the file that goes into Tenant Management) against the real
 * engine, with UrlFetchApp routed in memory to the e-sign dispatcher (admin key required).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { memoryBackend, signAs } = require('./helpers');

const KEY = 'k'.repeat(40);

function tenantManagement(opts) {
  opts = opts || {};
  const b = memoryBackend({ dispatch: { requireAdminKey: true, adminKey: KEY } });
  const props = { ESIGN_API_URL: 'https://script.google.com/macros/s/TEST/exec', ESIGN_ADMIN_KEY: KEY };
  const calls = [];
  const ctx = {
    console: { warn: () => {}, log: () => {} },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k] || null }) },
    Utilities: {
      sleep: () => {},
      formatDate: d => d.toISOString().slice(0, 10),
      base64Decode: s => Array.from(Buffer.from(s, 'base64')),
      newBlob: (bytes, mime, name) => ({ bytes, mime, name })
    },
    UrlFetchApp: {
      fetch: (url, o) => {
        const req = JSON.parse(o.payload);
        calls.push(req.action);
        if (opts.down) throw new Error('DNS error');
        if (opts.hello && opts.hello.n > 0) { opts.hello.n--; return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ ok: true, app: 'tenancy-esign', version: 'x' }) }; }
        let body;
        try { body = { ok: true, data: b.call(req) }; } catch (e) { body = { ok: false, error: e.message, code: e.code }; }
        return { getResponseCode: () => 200, getContentText: () => JSON.stringify(body) };
      }
    }
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'integration', 'esign-provider.gs'), 'utf8'), ctx, { filename: 'esign-provider.gs' });
  const run = (fn, ...args) => JSON.parse(JSON.stringify(ctx[fn](...args)));
  return { b, ctx, run, props, calls };
}

// Shaped like the Tenant Management Register records described in the brief.
const property = {
  id: 'P1', address1: '14 Kowhai Lane', address2: 'Roslyn, Dunedin', rent: 650, bond: 2600, maxOccupants: 3, tenancyLength: '12 months',
  insurer: 'Example Insurance Ltd', insurancePolicy: 'POL-1', excess: 500, insulationDate: "'2025-03-12",
  rentPaymentDetails: 'Automatic payment to 00-0000-0000000-00 (fake)', chattels: 'Fridge',
  insulationStatement: 'Ceiling 190mm, good.', healthyHomesStatement: 'Complies with the healthy homes standards.'
};
const landlord = {
  name: 'Owner Family Trust', signerName: 'Sam Owner', email: 'sam@example.com', mobile: '021 000 0100',
  addressForService: '9 Sample Terrace, Dunedin', signer2Name: 'Pat Owner', signer2Email: 'pat@example.com'
};
const applicants = [
  { ref: 'KB-20031', name: 'Mia', answers: { ApplicantName: 'Mia Example', ApplicantEmail: 'Mia@Example.com', ApplicantMobile: '021 000 1001', LicenceNumber: 'DX000001', DateOfBirth: "'2001-05-04" } },
  { ref: 'KB-20032', name: 'Tui', answers: { ApplicantName: 'Tui Sample', ApplicantEmail: 'tui@example.net', ApplicantMobile: '021 000 1002', AlternativeId: 'ALT-77', DateOfBirth: "'2000-01-02" } }
];
const ctxFor = details => ({ groupKey: 'KB-20031', property, landlord, applicants, details: details || { startDate: "'2026-11-01" } });
const inviteToken = (b, email, re) => b.tokenFrom(b.db.outbox.filter(m => m.to === email && m.kind === 'invite' && (!re || re.test(m.subject))).slice(-1)[0]);

test('maps Tenant Management records to an e-sign agreement', () => {
  const tm = tenantManagement();
  const input = tm.run('esignBuildAgreementInput_', ctxFor());
  assert.equal(input.propertyAddress, '14 Kowhai Lane, Roslyn, Dunedin');
  assert.equal(input.terms.endDate, '2027-10-31', 'start + 12 months - 1 day');
  assert.equal(input.terms.insulationDate, '2025-03-12');
  assert.deepEqual(input.landlordSigners.map(s => s.name), ['Sam Owner', 'Pat Owner']);
  assert.deepEqual(input.tenants.map(t => [t.email, t.idType, t.idNumber, t.dob]), [
    ['mia@example.com', 'Driver licence', 'DX000001', '2001-05-04'],
    ['tui@example.net', 'Other photo ID', 'ALT-77', '2000-01-02']
  ]);
  assert.deepEqual(input.source, { groupKey: 'KB-20031', propertyId: 'P1', applicantRefs: ['KB-20031', 'KB-20032'] });
});

test('send, check status, complete, create the tenancy', () => {
  const tm = tenantManagement();
  const sent = tm.run('esignSendAgreement_', ctxFor(), 'sam@example.com');
  assert.equal(sent.agreement.provider, 'esign');
  assert.equal(sent.agreement.status, 'Sent');
  assert.equal(sent.agreement.signed, '0/4');
  assert.deepEqual(sent.agreement.signers.map(s => s.status), ['Sent', 'Waiting', 'Waiting', 'Waiting']);

  ['mia@example.com', 'tui@example.net', 'sam@example.com', 'pat@example.com'].forEach(e => signAs(tm.b, inviteToken(tm.b, e)));
  const r = tm.run('esignRefreshAgreement_', sent.agreement);
  assert.equal(r.completed, true);
  assert.equal(r.agreement.status, 'Signed');
  assert.equal(r.agreement.signed, '4/4');
  assert.ok(r.agreement.signedAt && r.agreement.pdfSha256);

  const byRef = {}; applicants.forEach(a => { byRef[a.ref] = a; });
  const tenancy = tm.run('esignTenancyDraft_', r.full, { propertyId: 'P1', landlordName: landlord.name, applicantsByRef: byRef });
  assert.equal(tenancy.start, '2026-11-01');
  assert.equal(tenancy.groupKey, 'KB-20031');
  assert.deepEqual(tenancy.tenants.map(t => [t.ref, t.name, t.dob, t.moveIn]), [
    ['KB-20031', 'Mia Example', '2001-05-04', '2026-11-01'],
    ['KB-20032', 'Tui Sample', '2000-01-02', '2026-11-01']
  ]);
  assert.ok(tenancy.tenants[0].addressForService, 'address for service confirmed by the tenant');

  const pdf = tm.ctx.esignSignedPdf_(sent.agreement);
  assert.ok(pdf.name.includes(sent.agreement.requestId));
  assert.ok(tm.run('esignTenancySummaryHtml_', sent.agreement).includes('Tenancy summary'));
});

test('validation errors come back as plain messages; cancel works', () => {
  const tm = tenantManagement();
  assert.throws(() => tm.ctx.esignSendAgreement_(ctxFor({ startDate: '2026-11-01', bond: 9999 })), /4 weeks' rent \(\$2600\)/);
  const sent = tm.run('esignSendAgreement_', ctxFor());
  const c = tm.run('esignCancelAgreement_', sent.agreement, 'Wrong date');
  assert.equal(c.status, 'Cancelled');
});

test('change of tenants: swap, then apply to the tenancy with the Bond Hub task', () => {
  const tm = tenantManagement();
  const sent = tm.run('esignSendAgreement_', ctxFor());
  ['mia@example.com', 'tui@example.net', 'sam@example.com', 'pat@example.com'].forEach(e => signAs(tm.b, inviteToken(tm.b, e)));
  const done = tm.run('esignRefreshAgreement_', sent.agreement);
  const tenancy = tm.run('esignTenancyDraft_', done.full, {});

  const riley = { ref: 'KB-20050', answers: { ApplicantName: 'Riley Sample', ApplicantEmail: 'riley@example.com', ApplicantMobile: '021 000 1050', PassportNumber: 'LA0050', DateOfBirth: '1999-07-07' } };
  const preview = tm.run('esignChangeTenants_', done.agreement.requestId, { effectiveDate: '2027-03-01', leavingEmails: ['tui@example.net'], joining: [riley], bondArrangement: 'Riley pays Tui $1300.' }, 'sam', true);
  assert.deepEqual(preview.errors, []);
  const v = tm.run('esignChangeTenants_', done.agreement.requestId, { effectiveDate: '2027-03-01', leavingEmails: ['tui@example.net'], joining: [riley], bondArrangement: 'Riley pays Tui $1300.' }, 'sam');
  assert.equal(v.agreement.kind, 'variation');
  assert.equal(v.agreement.version, 2);

  ['riley@example.com', 'tui@example.net', 'mia@example.com', 'sam@example.com', 'pat@example.com'].forEach(e => signAs(tm.b, inviteToken(tm.b, e, /variation/)));
  const vr = tm.run('esignRefreshAgreement_', v.agreement);
  assert.equal(vr.completed, true);
  const applied = tm.run('esignApplyChangeToTenancy_', tenancy, vr.full);
  assert.deepEqual(applied.tenancy.tenants.map(t => [t.name, t.moveIn]), [['Mia Example', '2026-11-01'], ['Riley Sample', '2027-03-01']]);
  assert.deepEqual(applied.tenancy.formerTenants.map(t => [t.name, t.moveOut]), [['Tui Sample', '2027-03-01']]);
  assert.equal(applied.tenancy.agreementRequestId, v.agreement.requestId);
  assert.equal(applied.tenancy.agreementVersions.length, 2);
  assert.deepEqual(applied.bondChange.joining, ['Riley Sample']);
  assert.match(applied.bondChange.note, /10 working days/);

  // The original now reports it was replaced.
  assert.equal(tm.run('esignRefreshAgreement_', sent.agreement).agreement.replacedBy, v.agreement.requestId);
});

test('only read-only calls are retried; the poller skips DocHub and survives failures', () => {
  const down = tenantManagement({ down: true });
  assert.throws(() => down.ctx.esignRefreshAgreement_({ requestId: 'X' }), /Couldn't reach the signing service/);
  assert.equal(down.calls.filter(a => a === 'admin.get').length, 3);
  assert.throws(() => down.ctx.esignSendAgreement_(ctxFor()), /didn't answer in time .*may still have gone through/);
  assert.equal(down.calls.filter(a => a === 'admin.create').length, 1, 'never resend a create');

  const tm = tenantManagement();
  const sent = tm.run('esignSendAgreement_', ctxFor());
  const seen = [];
  const res = tm.run('esignRefreshOpenAgreements_', [
    { key: 'g1', agreement: sent.agreement },
    { key: 'g2', agreement: { provider: 'dochub', status: 'Sent', requestId: 'dh-1' } },
    { key: 'g3', agreement: { provider: 'esign', status: 'Sent', requestId: 'missing' } }
  ], (k) => seen.push(k));
  assert.deepEqual(res, { refreshed: 1, failed: 1 });

  const unset = tenantManagement();
  delete unset.props.ESIGN_ADMIN_KEY;
  assert.throws(() => unset.ctx.esignRefreshAgreement_({ requestId: 'X' }), /isn't set up yet/);
});

test('a cold-start reply without data: status checks retry, sends never repeat', () => {
  const tm = tenantManagement();
  const sent = tm.run('esignSendAgreement_', { groupKey: 'KB-20031', property, landlord, applicants, details: { rentPerWeek: 650, bond: 2600, startDate: '2026-11-01', endDate: '2027-10-31', maxOccupants: 3 } }, 'Kelvin');
  // status check: first reply is the GET page, the retry gets the real answer
  const hello = { n: 1 }; const tm2 = tenantManagement({ hello });
  tm2.b.db.envelopes = tm.b.db.envelopes; tm2.b.db.audit = tm.b.db.audit;
  const r = tm2.run('esignRefreshAgreement_', sent.agreement);
  assert.equal(r.agreement.requestId, sent.agreement.requestId); assert.equal(hello.n, 0); assert.deepEqual(tm2.calls, ['admin.get', 'admin.get']);
  // a send that gets the GET page is never retried, and says what to do
  const tm3 = tenantManagement({ hello: { n: 1 } });
  assert.throws(() => tm3.ctx.esignSendAgreement_({ groupKey: 'KB-20031', property, landlord, applicants, details: { rentPerWeek: 650, bond: 2600, startDate: '2026-11-01', endDate: '2027-10-31', maxOccupants: 3 } }, 'Kelvin'),
    /still starting up and didn't confirm. Wait a minute and tap Check status/);
  assert.deepEqual(tm3.calls, ['admin.create']);
  // a send that times out says it may still have gone through
  const tm4 = tenantManagement({ down: true });
  assert.throws(() => tm4.ctx.esignSendAgreement_({ groupKey: 'KB-20031', property, landlord, applicants, details: { rentPerWeek: 650, bond: 2600, startDate: '2026-11-01', endDate: '2027-10-31', maxOccupants: 3 } }, 'Kelvin'),
    /didn't answer in time .*It may still have gone through/);
});
