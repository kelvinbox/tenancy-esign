'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { ESign, memoryBackend, sampleInput, signAs, SIGNATURE } = require('./helpers');

test('sha256 matches Node crypto, including macrons and emoji', () => {
  const samples = ['', 'abc', 'T\u016bi \u0100rana', 'x'.repeat(1000), '\u{1F3E0} home', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64)];
  for (const s of samples) {
    assert.equal(ESign.sha256(s), crypto.createHash('sha256').update(s, 'utf8').digest('hex'), JSON.stringify(s.slice(0, 20)));
  }
  const bytes = crypto.randomBytes(5000);
  assert.equal(ESign.sha256(bytes), crypto.createHash('sha256').update(bytes).digest('hex'));
});

test('stable JSON ignores key order', () => {
  assert.equal(ESign.stable({ b: 1, a: [2, { d: 1, c: 2 }] }), ESign.stable({ a: [2, { c: 2, d: 1 }], b: 1 }));
});

test('NZ date and money formats', () => {
  assert.equal(ESign.longDate('2027-01-01'), '1st January 2027');
  assert.equal(ESign.longDate('2025-03-12'), '12th March 2025');
  assert.equal(ESign.longDate('2026-11-22'), '22nd November 2026');
  assert.equal(ESign.longDate('2026-02-30'), '');
  assert.equal(ESign.money(848), '848');
  assert.equal(ESign.money('848.5'), '848.50');
  assert.equal(ESign.addDays('2026-11-01', 364), '2027-10-31');
});

test('validation: bond limit, duplicate emails, tenant count, occupants warning', () => {
  const bad = sampleInput({ terms: Object.assign({}, sampleInput().terms, { bond: '2700' }) });
  let r = ESign.validateCreate(bad, '2026-10-11');
  assert.ok(r.errors.some(e => e.includes("4 weeks' rent ($2600)")), r.errors.join('|'));

  const dup = sampleInput();
  dup.tenants[1].email = 'MIA@example.com';
  r = ESign.validateCreate(dup, '2026-10-11');
  assert.ok(r.errors.some(e => e.includes('own email')));

  const many = sampleInput();
  many.tenants = Array.from({ length: 6 }, (_, i) => ({ name: 'P' + i, email: `p${i}@example.com` }));
  r = ESign.validateCreate(many, '2026-10-11');
  assert.ok(r.errors.some(e => e.includes('at most 5')));
  assert.ok(r.warnings.some(w => w.includes('maximum occupants')));

  r = ESign.validateCreate(sampleInput(), '2026-10-11');
  assert.deepEqual(r.errors, []);
  assert.equal(r.value.tenants[0].under18, 'No');
});

test('full signing flow: in order, landlord last, chain intact, document fingerprinted', () => {
  const b = memoryBackend();
  const res = b.call({ action: 'admin.create', input: sampleInput(), actor: 'Sam' });
  const id = res.agreement.id;
  assert.equal(res.agreement.progress, '0/3');

  // Only Tenant 1 is invited at first.
  assert.ok(b.lastEmail('mia@example.com', 'invite'));
  assert.equal(b.lastEmail('tui@example.net', 'invite'), undefined);

  signAs(b, b.tokenFrom(b.lastEmail('mia@example.com', 'invite')));
  assert.ok(b.lastEmail('tui@example.net', 'invite'), 'Tenant 2 invited after Tenant 1 signs');
  assert.ok(b.lastEmail('owner@example.com', 'notice'));

  signAs(b, b.tokenFrom(b.lastEmail('tui@example.net', 'invite')), { typedName: 'tui SAMPLE' }); // macron-insensitive match
  const lv = signAs(b, b.tokenFrom(b.lastEmail('landlord@example.com', 'invite')));
  assert.equal(lv.agreement.status, 'Completed');

  const full = b.call({ action: 'admin.get', id });
  assert.equal(full.agreement.status, 'Completed');
  assert.equal(full.chain.ok, true);
  const types = full.events.map(e => e.type);
  for (const t of ['AGREEMENT_CREATED', 'INVITE_SENT', 'DOCUMENT_OPENED', 'ELECTRONIC_SIGNING_CONSENT', 'CODE_SENT',
    'IDENTITY_VERIFIED', 'DOCUMENT_REVIEWED', 'SIGNED', 'ALL_PARTIES_SIGNED', 'SIGNED_DOCUMENT_CREATED', 'COPIES_SENT']) {
    assert.ok(types.includes(t), 'missing ' + t);
  }
  // Everyone gets the signed copy with the fingerprint.
  const completed = b.db.outbox.filter(m => m.kind === 'completed');
  assert.deepEqual(completed.map(m => m.to).sort(), ['landlord@example.com', 'mia@example.com', 'owner@example.com', 'tui@example.net']);
  const sha = full.agreement.final.sha256;
  assert.ok(completed[0].text.includes(sha));

  // The final document holds the agreement, the signatures and the certificate.
  const html = Object.values(b.db.finals)[0];
  assert.ok(html.includes('Signing certificate'));
  assert.ok(html.includes('T\u016bi Sample'));
  assert.ok(html.includes(full.termsHash));
  assert.equal((html.match(/data:image\/png;base64/g) || []).length >= 3, true);

  // Verification by fingerprint.
  const v = b.call({ action: 'verify', sha256: sha });
  assert.equal(v.found, true);
  assert.equal(v.chainOk, true);
  assert.equal(b.call({ action: 'verify', sha256: 'a'.repeat(64) }).found, false);

  // Every signature record is bound to the same locked terms.
  full.signers.forEach(s => assert.ok(s.signature.recordHash));
});

test('two landlord signers sign after the tenants, in order', () => {
  const b = memoryBackend();
  const input = sampleInput({
    landlordSigners: [
      { name: 'Sam Owner', email: 'sam@example.com', mobile: '021 000 0100' },
      { name: 'Pat Owner', email: 'pat@example.com', mobile: '022 000 0200' }
    ]
  });
  const res = b.call({ action: 'admin.create', input });
  const id = res.agreement.id;
  assert.deepEqual(res.agreement.signers.map(s => s.role), ['Tenant1', 'Tenant2', 'Landlord1', 'Landlord2']);
  assert.equal(res.agreement.progress, '0/4');

  signAs(b, b.tokenFrom(b.lastEmail('mia@example.com', 'invite')));
  signAs(b, b.tokenFrom(b.lastEmail('tui@example.net', 'invite')));
  assert.equal(b.lastEmail('pat@example.com', 'invite'), undefined, 'second landlord waits for the first');
  const v1 = signAs(b, b.tokenFrom(b.lastEmail('sam@example.com', 'invite')), { details: { capacity: 'Trustee' } });
  assert.equal(v1.agreement.status, 'Sent');
  assert.equal(v1.me.roleLabel, 'Landlord 1');
  const v2 = signAs(b, b.tokenFrom(b.lastEmail('pat@example.com', 'invite')), { details: { capacity: 'Trustee' } });
  assert.equal(v2.agreement.status, 'Completed');

  const html = Object.values(b.db.finals)[0];
  assert.ok(html.includes('Trustee &ndash; for Example Family Trust'));
  assert.ok(html.includes('Landlord 2: Pat Owner'));
  assert.ok(b.db.outbox.some(m => m.kind === 'completed' && m.to === 'pat@example.com'));
  assert.equal(b.call({ action: 'admin.get', id }).chain.ok, true);
});

test('landlord signer validation: at most 2, unique emails', () => {
  const three = sampleInput({ landlordSigners: [1, 2, 3].map(n => ({ name: 'L' + n, email: `l${n}@example.com` })) });
  assert.ok(ESign.validateCreate(three, '2026-10-11').errors.some(e => e.includes('At most 2')));
  const dup = sampleInput({ landlordSigners: [{ name: 'Sam', email: 'mia@example.com' }] });
  assert.ok(ESign.validateCreate(dup, '2026-10-11').errors.some(e => e.includes('own email')));
  const noEmail = sampleInput({ landlordSigners: [{ name: 'Sam', email: 's@example.com' }, { name: 'Pat', email: '' }] });
  assert.ok(ESign.validateCreate(noEmail, '2026-10-11').errors.some(e => e.includes('Landlord signer 2 (Pat)')));
});

test('tampering with any audit event breaks the chain', () => {
  const b = memoryBackend();
  const id = b.call({ action: 'admin.create', input: sampleInput() }).agreement.id;
  signAs(b, b.tokenFrom(b.lastEmail('mia@example.com', 'invite')));
  assert.equal(b.call({ action: 'admin.get', id }).chain.ok, true);
  b.db.audit[id][3].at = '2026-10-10T00:00:00.000Z';
  const chain = b.call({ action: 'admin.get', id }).chain;
  assert.equal(chain.ok, false);
  assert.equal(chain.brokenAt, 4);

  const b2 = memoryBackend();
  const id2 = b2.call({ action: 'admin.create', input: sampleInput() }).agreement.id;
  signAs(b2, b2.tokenFrom(b2.lastEmail('mia@example.com', 'invite')));
  b2.db.audit[id2].splice(2, 1); // delete an event
  assert.equal(b2.call({ action: 'admin.get', id: id2 }).chain.ok, false);
});

test('signing rules: order, wrong codes, stale terms, name match, re-verification', () => {
  const b = memoryBackend();
  b.call({ action: 'admin.create', input: sampleInput() });
  const t1 = b.tokenFrom(b.lastEmail('mia@example.com', 'invite'));

  // Steps can't be skipped.
  b.call({ action: 'sign.open', token: t1 });
  assert.throws(() => b.call({ action: 'sign.sendCode', token: t1 }), /agree to sign electronically/);
  b.call({ action: 'sign.consent', token: t1 });
  b.call({ action: 'sign.sendCode', token: t1 });
  for (let i = 0; i < 4; i++) assert.throws(() => b.call({ action: 'sign.verifyCode', token: t1, code: '000000x' }), /isn't right/);
  assert.throws(() => b.call({ action: 'sign.verifyCode', token: t1, code: 'nope' }), /Too many wrong codes/);
  assert.throws(() => b.call({ action: 'sign.verifyCode', token: t1, code: '123456' }), /ask for a new code/);

  b.call({ action: 'sign.sendCode', token: t1 });
  b.advance(11 * 60000);
  const code = b.db.outbox.filter(m => m.kind === 'code').slice(-1)[0].code;
  assert.throws(() => b.call({ action: 'sign.verifyCode', token: t1, code }), /expired/);

  b.call({ action: 'sign.sendCode', token: t1 });
  b.call({ action: 'sign.verifyCode', token: t1, code: b.db.outbox.filter(m => m.kind === 'code').slice(-1)[0].code });
  const view = b.call({ action: 'sign.open', token: t1 });
  assert.throws(() => b.call({ action: 'sign.reviewed', token: t1, info: { termsHash: 'x' } }), /changed/);
  b.call({ action: 'sign.reviewed', token: t1, info: { termsHash: view.termsHash } });

  const payload = {
    details: Object.assign({}, view.me.details, { addressForService: 'Somewhere' }), typedName: 'Someone Else', agree: true,
    termsHash: view.termsHash, signaturePng: SIGNATURE, strokes: { count: 2 }, submissionId: 's1'
  };
  assert.throws(() => b.call({ action: 'sign.submit', token: t1, payload }), /must match/);
  payload.typedName = 'Mia Example';
  b.advance(31 * 60000);
  assert.throws(() => b.call({ action: 'sign.submit', token: t1, payload }), /verify your email again/);

  // Tenant 2 has no link yet, and the landlord can't jump the queue.
  const landlordLinkAttempt = () => b.call({ action: 'admin.issueLink', id: view.agreement.id, signerId: 'L', channel: 'copy' });
  assert.throws(landlordLinkAttempt, /whose turn it is/);
});

test('submit is idempotent for retries with the same submission id', () => {
  const b = memoryBackend();
  b.call({ action: 'admin.create', input: sampleInput() });
  const t1 = b.tokenFrom(b.lastEmail('mia@example.com', 'invite'));
  signAs(b, t1, { submissionId: 'retry-me' });
  const again = b.call({
    action: 'sign.submit', token: t1,
    payload: { submissionId: 'retry-me' }
  });
  assert.equal(again.me.status, 'Signed');
  assert.equal(b.db.outbox.filter(m => m.to === 'tui@example.net' && m.kind === 'invite').length, 1);
});

test('new link replaces the old one; decline and cancel are recorded', () => {
  const b = memoryBackend();
  const id = b.call({ action: 'admin.create', input: sampleInput() }).agreement.id;
  const old = b.tokenFrom(b.lastEmail('mia@example.com', 'invite'));
  const out = b.call({ action: 'admin.issueLink', id, signerId: 'T1', channel: 'sms', actor: 'Sam' });
  assert.match(out.smsBody, /Kowhai Lane/);
  assert.throws(() => b.call({ action: 'sign.open', token: old }), /isn't valid any more/);
  const fresh = new URL(out.link).searchParams.get('t');
  b.call({ action: 'sign.open', token: fresh });
  assert.throws(() => b.call({ action: 'sign.decline', token: fresh, reason: '' }), /say why/);
  const v = b.call({ action: 'sign.decline', token: fresh, reason: 'Rent is wrong' });
  assert.equal(v.agreement.status, 'Declined');
  assert.ok(b.lastEmail('owner@example.com', 'notice').text.includes('Rent is wrong'));

  const b2 = memoryBackend();
  const id2 = b2.call({ action: 'admin.create', input: sampleInput() }).agreement.id;
  b2.call({ action: 'admin.cancel', id: id2, reason: 'Wrong start date', actor: 'Sam' });
  const t = b2.tokenFrom(b2.lastEmail('mia@example.com', 'invite'));
  const opened = b2.call({ action: 'sign.open', token: t });
  assert.equal(opened.agreement.status, 'Cancelled');
  assert.throws(() => b2.call({ action: 'sign.consent', token: t }), /cancelled/);
  assert.ok(b2.lastEmail('mia@example.com', 'cancelled'));
});

test('links expire after 14 days', () => {
  const b = memoryBackend();
  const id = b.call({ action: 'admin.create', input: sampleInput() }).agreement.id;
  b.advance(15 * 86400000);
  const t = b.tokenFrom(b.lastEmail('mia@example.com', 'invite'));
  assert.equal(b.call({ action: 'sign.open', token: t }).agreement.status, 'Expired');
  assert.equal(b.call({ action: 'admin.get', id }).events.slice(-2)[0].type, 'EXPIRED');
});

test('admin actions need the admin key when required', () => {
  const b = memoryBackend({ dispatch: { requireAdminKey: true, adminKey: 'k'.repeat(32) } });
  assert.throws(() => b.call({ action: 'admin.list' }), /admin key is wrong/);
  assert.deepEqual(b.call({ action: 'admin.list', adminKey: 'k'.repeat(32) }), []);
  assert.equal(b.call({ action: 'ping' }).ok, true);
});

test('email failure is logged and the link can be copied instead', () => {
  const b = memoryBackend({ failEmail: true });
  const res = b.call({ action: 'admin.create', input: sampleInput() });
  assert.ok(res.firstLink, 'link returned when the email fails');
  const full = b.call({ action: 'admin.get', id: res.agreement.id });
  assert.ok(full.events.some(e => e.type === 'EMAIL_FAILED'));
});

test('editing the template file does not change an agreement already sent', () => {
  const b = memoryBackend();
  const id = b.call({ action: 'admin.create', input: sampleInput() }).agreement.id;
  const before = b.call({ action: 'admin.get', id }).termsHash;
  const tpl = b.svc.templates['nz-residential-v1'];
  const saved = tpl.intro;
  tpl.intro = 'Changed wording';
  try {
    const t = b.tokenFrom(b.lastEmail('mia@example.com', 'invite'));
    const view = b.call({ action: 'sign.open', token: t });
    assert.equal(view.termsHash, before);
    assert.ok(!view.document.intro.includes('Changed wording'));
  } finally { tpl.intro = saved; }
});

test('messages and the signing page name the agreement\'s own landlord, not OWNER_NAME', () => {
  const b = memoryBackend();
  const input = sampleInput({ landlord: Object.assign({}, sampleInput().landlord, { name: 'Les and Jennifer Box' }) });
  const res = b.call({ action: 'admin.create', input, actor: 'Sam' });
  const invite = b.lastEmail('mia@example.com', 'invite');
  assert.match(invite.text, /^Hi Mia,\n\nLes and Jennifer Box has sent you /);
  assert.match(invite.text, /Thanks,\nLes and Jennifer Box$/);
  assert.ok(invite.html.indexOf('Les and Jennifer Box has sent you') >= 0);
  assert.ok(invite.text.indexOf('Sam Owner') < 0, 'OWNER_NAME is not used in the message');
  const view = b.call({ action: 'sign.open', token: b.tokenFrom(invite) });
  assert.equal(view.ownerName, 'Les and Jennifer Box');
  const sms = b.call({ action: 'admin.issueLink', id: res.agreement.id, signerId: view.me.id, channel: 'sms' });
  assert.match(sms.smsBody, / - Les and Jennifer Box$/);
});
test('insurance statement about tenant liability appears only when the property is insured', () => {
  const b = memoryBackend();
  const statement = 'There is insurance covering this rental property that is relevant to tenant&#39;s liability';
  const insured = b.call({ action: 'admin.preview', input: sampleInput() });
  assert.ok(insured.html.indexOf('There is insurance covering this rental property') >= 0, 'shown when insured');
  assert.ok(insured.html.indexOf('including damage to body corporate facilities') >= 0);
  const none = b.call({ action: 'admin.preview', input: sampleInput({ terms: Object.assign({}, sampleInput().terms, { insurer: 'Not insured', insurancePolicy: '', excess: '' }) }) });
  assert.ok(none.html.indexOf('There is insurance covering this rental property') < 0, 'hidden when not insured');
  assert.ok(statement);
});

test('template 1.2.0: numbered additional terms, sections 5-7 wording', () => {
  const b = memoryBackend();
  const terms = Object.assign({}, sampleInput().terms, { additionalTerms: 'No smoking anywhere on the property.\nGarden to be kept tidy.\n\n  Bins out on Tuesday nights.  ' });
  const html = b.call({ action: 'admin.preview', input: sampleInput({ terms }) }).html;
  const other = html.slice(html.indexOf('8. Other terms'), html.indexOf('9. Signing electronically'));
  const items = (other.match(/<li>/g) || []).length;
  assert.equal(items, 5, 'smoking + pets + 3 additional terms, each its own numbered item');
  assert.ok(other.indexOf('Garden to be kept tidy.') > 0 && other.indexOf('Bins out on Tuesday nights.') > 0);
  assert.ok(html.indexOf('minor change') < 0, 'minor-change wording removed from sections 5 and 6');
  assert.ok(html.indexOf('without the landlord&#39;s written consent</li>') > 0 || html.indexOf('without the landlord&#39;s written consent<') > 0, 'section 6 item 7 ends after consent');
  const ending = html.slice(html.indexOf('7. Ending the tenancy'), html.indexOf('8. Other terms'));
  assert.ok(/no more than 90 days and no less than 21 days before the end date/.test(ending), 'fixed-term notice window');
  assert.ok(/automatically becomes a periodic tenancy/.test(ending));
  assert.ok(/at least 21 days&#39; written notice/.test(ending) && ending.indexOf('28 days') < 0, 'periodic tenant notice is 21 days');
  // periodic agreements leave the fixed-term paragraphs out
  const per = b.call({ action: 'admin.preview', input: sampleInput({ terms: Object.assign({}, sampleInput().terms, { endDate: '' }) }) }).html;
  const perEnding = per.slice(per.indexOf('7. Ending the tenancy'), per.indexOf('8. Other terms'));
  assert.ok(perEnding.indexOf('fixed-term tenancy ending on') < 0 && /at least 21 days/.test(perEnding));
  // no additional terms: no empty item
  const none = b.call({ action: 'admin.preview', input: sampleInput() }).html;
  const noneOther = none.slice(none.indexOf('8. Other terms'), none.indexOf('9. Signing electronically'));
  assert.equal((noneOther.match(/<li>/g) || []).length, 2);
});
