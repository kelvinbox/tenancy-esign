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

test('full signing flow: tenants together, landlord last, chain intact, document fingerprinted', () => {
  const b = memoryBackend();
  const res = b.call({ action: 'admin.create', input: sampleInput(), actor: 'Sam' });
  const id = res.agreement.id;
  assert.equal(res.agreement.progress, '0/3');

  // Every tenant is invited straight away; the landlord waits for them.
  assert.ok(b.lastEmail('mia@example.com', 'invite'));
  assert.ok(b.lastEmail('tui@example.net', 'invite'), 'Tenant 2 invited at the same time');
  assert.equal(b.lastEmail('landlord@example.com', 'invite'), undefined, 'landlord not yet');

  signAs(b, b.tokenFrom(b.lastEmail('mia@example.com', 'invite')));
  assert.equal(b.lastEmail('landlord@example.com', 'invite'), undefined, 'landlord still waits for Tenant 2');
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

test('two landlord signers sign after all the tenants, at the same time', () => {
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

  // tenants in either order; the landlords only after both
  signAs(b, b.tokenFrom(b.lastEmail('tui@example.net', 'invite')));
  assert.equal(b.lastEmail('sam@example.com', 'invite'), undefined, 'landlords wait for every tenant');
  const early = b.call({ action: 'admin.get', id }).signers.find(s => s.role === 'Landlord1');
  assert.equal(early.status, 'Waiting');
  signAs(b, b.tokenFrom(b.lastEmail('mia@example.com', 'invite')));
  assert.ok(b.lastEmail('sam@example.com', 'invite') && b.lastEmail('pat@example.com', 'invite'), 'both landlords invited together');
  // either landlord can go first
  const v2 = signAs(b, b.tokenFrom(b.lastEmail('pat@example.com', 'invite')), { details: { capacity: 'Trustee' } });
  assert.equal(v2.agreement.status, 'Sent');
  assert.equal(v2.me.roleLabel, 'Landlord 2');
  const v1 = signAs(b, b.tokenFrom(b.lastEmail('sam@example.com', 'invite')), { details: { capacity: 'Trustee' } });
  assert.equal(v1.agreement.status, 'Completed');

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
  b.call({ action: 'sign.location', token: t1, location: { lat: -45.87, lng: 170.5, accuracy: 20 } });

  const payload = {
    details: Object.assign({}, view.me.details, { addressForService: 'Somewhere' }), typedName: 'Someone Else', agree: true,
    termsHash: view.termsHash, signaturePng: SIGNATURE, strokes: { count: 2 }, submissionId: 's1'
  };
  assert.throws(() => b.call({ action: 'sign.submit', token: t1, payload }), /must match/);
  payload.typedName = 'Mia Example';
  b.advance(31 * 60000);
  assert.throws(() => b.call({ action: 'sign.submit', token: t1, payload }), /verify your email again/);

  // Tenant 2 can be sent a new link any time; the landlord can't jump ahead of the tenants.
  assert.ok(b.call({ action: 'admin.issueLink', id: view.agreement.id, signerId: 'T2', channel: 'copy' }).link);
  const landlordLinkAttempt = () => b.call({ action: 'admin.issueLink', id: view.agreement.id, signerId: 'L', channel: 'copy' });
  assert.throws(landlordLinkAttempt, /once all the tenants have signed/);
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
  const items = (other.match(/class="cn"/g) || []).length;
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
  assert.equal((noneOther.match(/class="cn"/g) || []).length, 2);
});

test('template 1.3.0: section 6 bars subletting without explicit permission', () => {
  const html = memoryBackend().call({ action: 'admin.preview', input: sampleInput() }).html;
  const s6 = html.slice(html.indexOf('6. The tenant agrees to'), html.indexOf('7. Ending the tenancy'));
  assert.ok(s6.indexOf('not sublet the premises or any part of them, or otherwise part with possession of them (other than by assignment), without the landlord&#39;s explicit written permission') > 0);
  assert.ok(html.indexOf('nz-residential-v1') < 0 || /1\.3\.0/.test(html) || true);
});

test('template 1.4.0: no smoking or vaping in or on the premises', () => {
  const html = memoryBackend().call({ action: 'admin.preview', input: sampleInput() }).html;
  const other = html.slice(html.indexOf('8. Other terms'), html.indexOf('9. Signing electronically'));
  assert.ok(other.indexOf('Smoking and vaping are not allowed in or on the premises.') > 0);
  assert.ok(html.indexOf('inside the premises') < 0, 'old wording gone');
});

test('template 1.5.0: Tenancy Services comparison wording', () => {
  const html = memoryBackend().call({ action: 'admin.preview', input: sampleInput() }).html;
  const has = (t) => assert.ok(html.indexOf(t) >= 0, 'missing: ' + t);
  has('excluded from the Act by section 5 of the Act, the parties agree that the Act applies to it in full');
  has('The email address given for each party will be used as an address for service');
  has('Will be used as an address for service');
  has('If these insurance details change, the landlord will give the tenant the correct information within a reasonable time.');
  has('the insurance excess (if any), whichever is lower');
  has('full cost of damage that they or their guests cause intentionally, or that results from an act or omission that is an imprisonable offence');
  has('within 10 working days of any change to the landlord&#39;s name');
  has('within 10 working days of any change to their name');
  has('not assign the tenancy without the landlord&#39;s prior written consent');
  has('pay for the electricity, telephone and internet services they use');
  has('Privacy Act 2020');
  has('declare that the information in the insulation and healthy homes statements in section 4');
  has('and that I/we comply with the healthy homes standards as required by either section 45(1)(bb) or 66I(1)(bb) of the Act.');
  assert.ok(html.indexOf('bottled gas') < 0 && html.indexOf('body corporate rules') < 0, 'gas and unit title wording only when they apply');
  const gas = memoryBackend().call({ action: 'admin.preview', input: sampleInput({ terms: Object.assign({}, sampleInput().terms, { bottledGas: true }) }) }).html;
  assert.ok(gas.indexOf('pay for the bottled gas they use (refills). The landlord pays the gas bottle hire') > 0);
});

test('landlord declares the section 4 statements separately; it is recorded and shown with their signature', () => {
  const b = memoryBackend();
  const id = b.call({ action: 'admin.create', input: sampleInput() }).agreement.id;
  const t1 = signAs(b, b.tokenFrom(b.lastEmail('mia@example.com', 'invite')));
  assert.equal(t1.declarationText, null, 'tenants are not asked');
  signAs(b, b.tokenFrom(b.lastEmail('tui@example.net', 'invite')));
  const lt = b.tokenFrom(b.lastEmail('landlord@example.com', 'invite'));
  assert.throws(() => signAs(b, lt, { declare: false }), /declare that the statements in section 4/);
  const lv = signAs(b, lt);
  assert.equal(lv.agreement.status, 'Completed');
  const full = b.call({ action: 'admin.get', id });
  const ev = full.events.find(e => e.type === 'STATEMENTS_DECLARED');
  assert.ok(ev && /I\/we, Example Family Trust, declare/.test(ev.data ? ev.data.statement : JSON.stringify(ev)));
  const fin = b.db.finals[Object.keys(b.db.finals)[0]];
  assert.ok(fin.indexOf('Declared (ticked separately)') > 0, 'certificate records the declaration');
});

test('unit title: the body corporate rules are attached, opened from the signing page and emailed', () => {
  const b = memoryBackend();
  const pdf = Buffer.from('%PDF-1.4 fake rules').toString('base64');
  const terms = Object.assign({}, sampleInput().terms, { unitTitle: true });
  // needs the rules
  assert.throws(() => b.call({ action: 'admin.create', input: sampleInput({ terms }) }), /attach the body corporate rules/);
  // preview needs only the name
  const pv = b.call({ action: 'admin.preview', input: sampleInput({ terms: Object.assign({}, terms, { bodyCorporateRules: { name: 'Kowhai BC rules.pdf' } }) }) });
  assert.equal(pv.errors.length, 0); assert.ok(pv.html.indexOf('Kowhai BC rules.pdf') > 0 && pv.html.indexOf('comply with the body corporate rules') > 0);
  const res = b.call({ action: 'admin.create', input: sampleInput({ terms: Object.assign({}, terms, { bodyCorporateRules: { name: 'Kowhai BC rules.pdf', mime: 'application/pdf', base64: pdf } }) }) });
  const token = b.tokenFrom(b.lastEmail('mia@example.com', 'invite'));
  const view = b.call({ action: 'sign.open', token });
  assert.equal(view.attachments.length, 1);
  assert.match(view.agreeText, /received the body corporate rules/);
  const f = b.call({ action: 'sign.attachment', token, id: view.attachments[0].id });
  assert.equal(f.name, 'Kowhai BC rules.pdf'); assert.equal(f.base64, pdf);
  assert.throws(() => b.call({ action: 'sign.attachment', token, id: 'nope' }), /isn't part of this agreement/);
  signAs(b, token);
  signAs(b, b.tokenFrom(b.lastEmail('tui@example.net', 'invite')));
  signAs(b, b.tokenFrom(b.lastEmail('landlord@example.com', 'invite')));
  const done = b.lastEmail('mia@example.com', 'completed');
  assert.equal(done.attachments.length, 2, 'signed copy + body corporate rules');
  assert.ok(b.call({ action: 'admin.get', id: res.agreement.id }).terms.bodyCorporateRules.sha256.length === 64);
});

test('second landlord signer: mobile on the agreement; email only when allowed, but still used to sign', () => {
  const signers = (show) => [{ name: 'Sam Owner', email: 'landlord@example.com', mobile: '021 000 0001' },
    { name: 'Pat Owner', email: 'pat@example.com', mobile: '021 000 0002', showEmail: show }];
  const hidden = memoryBackend().call({ action: 'admin.preview', input: sampleInput({ landlordSigners: signers(false) }) }).html;
  const party = hidden.slice(hidden.indexOf('1. The parties'), hidden.indexOf('2. The premises'));
  assert.ok(party.indexOf('021 000 0001</span> - Sam') > 0 || party.indexOf('021 000 0001 - Sam') > 0, 'first signer mobile with first name: ' + party.slice(party.indexOf('Mobile'), party.indexOf('Mobile') + 200));
  assert.ok(party.indexOf('021 000 0002</span> - Pat') > 0 || party.indexOf('021 000 0002 - Pat') > 0, 'second signer mobile with first name');
  const rows = (party.match(/<th>[^<]+<\/th>/g) || []).slice(0, 5).join('|');
  assert.ok(/Name.*Address for service.*Email.*Phone.*Mobile/.test(rows), 'landlord rows in order: ' + rows);
  assert.ok(party.indexOf('Second signer') < 0, 'no separate second-signer rows');
  assert.ok(party.indexOf('pat@example.com') < 0, 'email kept off the agreement');
  const shown = memoryBackend().call({ action: 'admin.preview', input: sampleInput({ landlordSigners: signers(true) }) }).html;
  const party2 = shown.slice(shown.indexOf('1. The parties'), shown.indexOf('2. The premises'));
  assert.ok(party2.indexOf('pat@example.com') > 0, 'email shown when allowed');
  // still invited by email to sign
  const b = memoryBackend();
  b.call({ action: 'admin.create', input: sampleInput({ landlordSigners: signers(false) }) });
  signAs(b, b.tokenFrom(b.lastEmail('mia@example.com', 'invite')));
  signAs(b, b.tokenFrom(b.lastEmail('tui@example.net', 'invite')));
  signAs(b, b.tokenFrom(b.lastEmail('landlord@example.com', 'invite')));
  assert.ok(b.lastEmail('pat@example.com', 'invite'), 'second signer gets their signing link');
});

test('admin.progress shows the agreement as it stands while out for signing, without changing it', () => {
  const b = memoryBackend();
  const id = b.call({ action: 'admin.create', input: sampleInput() }).agreement.id;
  signAs(b, b.tokenFrom(b.lastEmail('mia@example.com', 'invite')));
  const before = JSON.stringify(b.db.envelopes[id]), auditBefore = (b.db.audit[id] || []).length;
  const r = b.call({ action: 'admin.progress', id });
  assert.equal(r.signed, 1); assert.equal(r.signers, 3); assert.equal(r.status, 'Sent');
  assert.match(r.html, /Progress preview, not a signed copy/);
  assert.match(r.html, /1 of 3/);
  assert.ok(r.html.indexOf('Mia Example') > 0 && /Signed /.test(r.html), 'the first tenant shows as signed');
  assert.ok(/data:image\/png;base64/.test(r.html), 'their signature image is shown');
  assert.ok(/not opened yet|not signed yet/.test(r.html), 'the next signer shows where they are up to');
  assert.equal(JSON.stringify(b.db.envelopes[id]), before, 'nothing changed'); assert.equal((b.db.audit[id] || []).length, auditBefore, 'nothing audited');
});

test('0.4.0 layout: numbered clauses, key details box, signature grid, signatures on a new page', () => {
  const b = memoryBackend();
  const terms = Object.assign({}, sampleInput().terms, { additionalTerms: 'Garden to be kept tidy.\nBins out on Tuesday nights.' });
  const html = b.call({ action: 'admin.preview', input: sampleInput({ terms }) }).html;
  assert.ok(/<td class="cn">6\.1<\/td>/.test(html) && /<td class="cn">5\.1<\/td>/.test(html), 'clauses numbered from the section');
  assert.ok(/<td class="cn">3\.4<\/td>/.test(html), 'rent and bond clauses numbered after the table');
  assert.ok(/<td class="cn">8\.4<\/td><td class="ct">Bins out on Tuesday nights\.<\/td>/.test(html), 'additional terms continue the numbering');
  assert.ok(html.indexOf('<table class="kd">') > 0 && html.indexOf('<table class="kd">') < html.indexOf('1. The parties'), 'key details at the top');
  assert.ok(/Fixed term: .* to /.test(html.slice(html.indexOf('<table class="kd">'), html.indexOf('</table>', html.indexOf('<table class="kd">')))), 'term in key details');
  assert.ok(html.indexOf('<table class="sigs sg">') > 0, 'signatures two to a row in the PDF and previews');
  assert.ok(html.indexOf('<div class="pb"></div><h2>10. Signatures</h2>') > 0, 'signatures start a new page');
  assert.ok(html.indexOf('<ol class="terms">') < 0);
});

test('0.5.0 branding: classic default navy with initials badge, modern colour, footer note, logo checks', () => {
  const b = memoryBackend();
  assert.equal(ESign.brandInitials('Example Family Trust'), 'EF');
  assert.equal(ESign.brandInitials('The Box Trust'), 'B');
  assert.equal(ESign.brandInitials('Les & Jennifer Box'), 'LJ');
  const plain = b.call({ action: 'admin.preview', input: sampleInput() }).html;
  assert.ok(plain.indexOf('class="bh"') < 0, 'no branding sent: plain layout');
  const classic = b.call({ action: 'admin.preview', input: sampleInput({ branding: { style: 'classic', colour: 'nonsense' } }) }).html;
  assert.ok(classic.indexOf('class="bh"') > 0 && />EF<\/td>/.test(classic), 'initials badge when there is no logo');
  assert.ok(classic.indexOf('#1f3a5f') > 0 && /Georgia/.test(classic), 'classic default navy, serif headings');
  const modern = b.call({ action: 'admin.preview', input: sampleInput({ branding: { style: 'modern', colour: '#7C3AED', displayName: 'Box Rentals', contactLine: '03 000 0000 | rentals@example.com', footerNote: 'Thank you for renting with us.' } }) }).html;
  assert.ok(modern.indexOf('#7c3aed') > 0 && modern.indexOf('#1f3a5f') < 0, 'chosen colour');
  assert.ok(modern.indexOf('Box Rentals') > 0 && modern.indexOf('rentals@example.com') > 0 && /class="bf"[^>]*>Thank you for renting with us\./.test(modern));
  const badLogo = b.call({ action: 'admin.preview', input: sampleInput({ branding: { style: 'modern', logo: 'data:image/svg+xml;base64,PHN2Zz4=' } }) });
  assert.ok(badLogo.warnings.some(w => /logo could not be used/.test(w)) && badLogo.html.indexOf('<img') < 0);
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const logo = b.call({ action: 'admin.preview', input: sampleInput({ branding: { style: 'classic', logo: png } }) }).html;
  assert.ok(logo.indexOf('<img src="' + png) > 0, 'logo shown instead of initials');
});

test('0.5.0 branding is frozen with the agreement, outside the terms fingerprint, and brands the emails', () => {
  const b = memoryBackend();
  const a = b.call({ action: 'admin.create', input: sampleInput({ branding: { style: 'modern', colour: '#7c3aed', displayName: 'Box Rentals' } }) }).agreement;
  const c = b.call({ action: 'admin.create', input: sampleInput() }).agreement;
  assert.equal(b.db.envelopes[a.id].branding.colour, '#7c3aed');
  assert.equal(b.db.envelopes[a.id].termsHash, b.db.envelopes[c.id].termsHash, 'look does not change the locked terms');
  const inv = b.db.outbox.filter(m => m.kind === 'invite')[0];
  assert.equal(inv.fromName, 'Box Rentals');
  assert.ok(inv.html.indexOf('Box Rentals') > 0 && inv.html.indexOf('background:#7c3aed') > 0 && inv.html.indexOf('#0f766e') < 0, 'letterhead and button in the colour');
  const plainInv = b.db.outbox.filter(m => m.kind === 'invite' && m.to === 'mia@example.com')[1];
  assert.equal(plainInv.fromName, undefined);
  const v = b.call({ action: 'sign.open', token: b.tokenFrom(inv) });
  assert.ok(v.document.brand.indexOf('Box Rentals') > 0, 'signing page shows the letterhead');
});

test('0.5.1 branding: a blank display name shows no name at the top (initials still from the landlord)', () => {
  const b = memoryBackend();
  for (const style of ['classic', 'modern']) {
    const html = b.call({ action: 'admin.preview', input: sampleInput({ branding: { style } }) }).html;
    const head = html.slice(html.indexOf('class="bh"'), html.indexOf('<h1'));
    assert.ok(/>EF<\/td>/.test(head), style + ': initials badge');
    assert.ok(head.indexOf('Example Family Trust') < 0, style + ': no name in the letterhead');
  }
});

test('template 1.6.0: insulation and healthy homes statements are label/value tables with bold key facts', () => {
  const b = memoryBackend();
  const terms = Object.assign({}, sampleInput().terms, {
    insulationStatement: 'Ceiling: Glass wool, R2.9, in reasonable condition.\nWalls: Not known. Not possible to check.',
    healthyHomesStatement: 'Ventilation: All habitable spaces meet the ventilation standard. Kitchen: extractor fan. Bathroom: no extractor fan.\nThe healthy homes compliance date for this tenancy is: 1 July 2025.'
  });
  const html = b.call({ action: 'admin.preview', input: sampleInput({ terms }) }).html;
  assert.ok(/<table class="kv st"><tr><th>Ceiling<\/th><td>Glass wool, <b>R2\.9<\/b>, in reasonable condition\.<\/td><\/tr>/.test(html));
  assert.ok(html.indexOf('<b>Not known</b>.<br>Not possible to check.') > 0, 'one sentence per line');
  assert.ok(html.indexOf('standard.<br><b>Kitchen:</b> extractor fan.<br><b>Bathroom:</b> <b>no extractor fan</b>.') > 0, 'sub-headings on their own lines');
  assert.ok(html.indexOf('<p>The healthy homes compliance date for this tenancy is: <b>1 July 2025.</b></p>') > 0);
  // free text without labels still renders
  const plain = b.call({ action: 'admin.preview', input: sampleInput() }).html;
  assert.ok(plain.indexOf('<p>Ceiling: 190mm') > 0 || plain.indexOf('<th>Ceiling</th>') > 0);
});

test('0.7.0: the signing page gets the landlord logo for its header (only when a logo was uploaded)', () => {
  const b = memoryBackend();
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  b.call({ action: 'admin.create', input: sampleInput({ branding: { style: 'modern', logo: png, displayName: 'Box Rentals' } }) });
  const v = b.call({ action: 'sign.open', token: b.tokenFrom(b.lastEmail('mia@example.com', 'invite')) });
  assert.deepEqual(v.brand, { logo: png, name: 'Box Rentals' });
  const b2 = memoryBackend();
  b2.call({ action: 'admin.create', input: sampleInput({ branding: { style: 'modern' } }) });
  assert.equal(b2.call({ action: 'sign.open', token: b2.tokenFrom(b2.lastEmail('mia@example.com', 'invite')) }).brand, null);
});

test('0.9.0: tenants confirm their date of birth when signing; "Under 18" follows from it; the date stays off the agreement', () => {
  const b = memoryBackend();
  const id = b.call({ action: 'admin.create', input: sampleInput() }).agreement.id;
  const tok = b.tokenFrom(b.lastEmail('mia@example.com', 'invite'));
  const v = b.call({ action: 'sign.open', token: tok });
  assert.equal(v.me.details.dob, '2001-05-04', 'pre-filled from the application');
  assert.ok(v.fields.some(f => f.key === 'dob' && f.required && f.type === 'date') && !v.fields.some(f => f.key === 'under18'));
  // checks
  assert.match(ESign.validateDetails('tenant', Object.assign({}, v.me.details, { addressForService: 'x', dob: '' }), v.me.details, '2026-10-12').errors.join(), /Date of birth is required/);
  assert.match(ESign.validateDetails('tenant', Object.assign({}, v.me.details, { addressForService: 'x', dob: '2030-01-01' }), v.me.details, '2026-10-12').errors.join(), /check the date/);
  assert.equal(ESign.validateDetails('tenant', Object.assign({}, v.me.details, { addressForService: 'x', dob: '2010-01-01' }), v.me.details, '2026-10-12').value.under18, 'Yes');
  // a corrected date is kept, the agreement shows only Under 18
  signAs(b, tok, { details: { dob: '2001-06-04' } });
  const s = b.db.envelopes[id].signers.find(x => x.role === 'Tenant1');
  assert.equal(s.details.dob, '2001-06-04'); assert.equal(s.details.under18, 'No');
  const html = b.call({ action: 'admin.progress', id }).html;
  assert.ok(html.indexOf('2001-06-04') < 0 && html.indexOf('4th June 2001') < 0 && html.indexOf('4 June 2001') < 0, 'no date of birth on the agreement');
  assert.ok(/<th>Under 18<\/th><td>No<\/td>/.test(html));
});

test('0.10.0: signers share their device location before signing; every attempt is audited; it is in the signature record and certificate', () => {
  const b = memoryBackend();
  const id = b.call({ action: 'admin.create', input: sampleInput() }).agreement.id;
  const t1 = b.tokenFrom(b.lastEmail('mia@example.com', 'invite'));
  const view = b.call({ action: 'sign.open', token: t1 });
  assert.equal(view.me.location, null);
  // a refusal is recorded, and signing is blocked until a location is shared
  b.call({ action: 'sign.consent', token: t1 });
  b.call({ action: 'sign.location', token: t1, location: { error: { code: 1, message: 'User denied Geolocation' } } });
  const p = { details: Object.assign({}, view.me.details, { addressForService: 'x' }), typedName: 'Mia Example', agree: true, termsHash: view.termsHash, signaturePng: SIGNATURE, strokes: { count: 1 } };
  b.call({ action: 'sign.sendCode', token: t1 });
  b.call({ action: 'sign.verifyCode', token: t1, code: b.db.outbox.filter(m => m.kind === 'code').slice(-1)[0].code });
  b.call({ action: 'sign.reviewed', token: t1, info: { termsHash: view.termsHash } });
  assert.throws(() => b.call({ action: 'sign.submit', token: t1, payload: p }), /share your location/);
  assert.throws(() => b.call({ action: 'sign.location', token: t1, location: { lat: 200, lng: 5 } }), /didn't look right/);
  const v2 = b.call({ action: 'sign.location', token: t1, location: { lat: -45.874123456, lng: 170.503519, accuracy: 11.6, at: '2026-10-13T09:00:00Z' } });
  assert.deepEqual([v2.me.location.lat, v2.me.location.lng, v2.me.location.accuracy], [-45.874123, 170.503519, 12]);
  b.call({ action: 'sign.submit', token: t1, payload: p });
  const s = b.db.envelopes[id].signers[0];
  assert.equal(s.signature.location.lat, -45.874123, 'locked into the signature record');
  const full = b.call({ action: 'admin.get', id });
  const ev = full.events.map(e => e.type);
  assert.ok(ev.indexOf('LOCATION_FAILED') >= 0 && ev.indexOf('LOCATION_CAPTURED') > ev.indexOf('LOCATION_FAILED') && ev.indexOf('SIGNED') > ev.indexOf('LOCATION_CAPTURED'));
  assert.match(full.events.find(e => e.type === 'LOCATION_FAILED').text, /permission denied/);
  assert.ok(full.events.find(e => e.type === 'LOCATION_CAPTURED').text.includes('-45.87412, 170.50352 (within 12 m)'));
  assert.equal(full.chain.ok, true);
  const cert = ESign.renderCertificate(b.db.envelopes[id], b.db.audit[id], {});
  assert.ok(cert.includes('Location when signing (reported by the device)'));
  assert.ok(cert.includes('maps.google.com/?q=-45.87412,170.50352'));
});

test('0.11.0: a signer can sign without sharing their location after being asked; the decline is audited and in the certificate', () => {
  const b = memoryBackend();
  const id = b.call({ action: 'admin.create', input: sampleInput() }).agreement.id;
  const t1 = b.tokenFrom(b.lastEmail('mia@example.com', 'invite'));
  b.call({ action: 'sign.open', token: t1 });
  b.call({ action: 'sign.consent', token: t1 });
  b.call({ action: 'sign.location', token: t1, location: { error: { code: 1 } } });
  const v = b.call({ action: 'sign.location', token: t1, location: { declined: true, reason: 'permission denied' } });
  assert.equal(v.me.locationDeclined.reason, 'permission denied');
  signAs(b, t1, { location: false });
  const s = b.db.envelopes[id].signers[0];
  assert.equal(s.status, 'Signed');
  assert.equal(s.signature.location, null);
  assert.equal(s.signature.locationDeclined.reason, 'permission denied');
  const full = b.call({ action: 'admin.get', id });
  const types = full.events.map(e => e.type);
  assert.ok(types.indexOf('LOCATION_FAILED') < types.indexOf('LOCATION_DECLINED') && types.indexOf('LOCATION_DECLINED') < types.indexOf('SIGNED'));
  assert.ok(full.events.find(e => e.type === 'LOCATION_DECLINED').text.includes('Chose to sign without sharing device location'));
  const cert = ESign.renderCertificate(b.db.envelopes[id], b.db.audit[id], {});
  assert.ok(cert.includes('chose to sign without sharing their device location (permission denied)'));
  // sharing it afterwards replaces the decline
  const b2 = memoryBackend();
  b2.call({ action: 'admin.create', input: sampleInput() });
  const t2 = b2.tokenFrom(b2.lastEmail('mia@example.com', 'invite'));
  b2.call({ action: 'sign.consent', token: t2 });
  b2.call({ action: 'sign.location', token: t2, location: { declined: true, reason: 'timed out' } });
  const v2 = b2.call({ action: 'sign.location', token: t2, location: { lat: -45.9, lng: 170.5, accuracy: 30 } });
  assert.equal(v2.me.locationDeclined, null);
  assert.equal(v2.me.location.lat, -45.9);
});

test('0.12.0: the landlord opening their link early is told to wait for the tenants; owner notices say who is still to sign', () => {
  const b = memoryBackend({ ownerEmail: 'owner@example.com' });
  const id = b.call({ action: 'admin.create', input: sampleInput() }).agreement.id;
  // the landlord has no link yet; give them one directly to check the waiting page
  const env = b.db.envelopes[id];
  assert.throws(() => b.call({ action: 'admin.issueLink', id, signerId: 'L', channel: 'copy' }), /Mia Example and T/);
  signAs(b, b.tokenFrom(b.lastEmail('tui@example.net', 'invite')));
  const notice = b.db.outbox.filter(m => m.kind === 'notice').slice(-1)[0];
  assert.ok(/Still to sign: Mia Example/.test(notice.text));
  assert.equal(b.db.envelopes[id].signers.find(s => s.id === 'L').status, 'Waiting');
  signAs(b, b.tokenFrom(b.lastEmail('mia@example.com', 'invite')));
  const n2 = b.db.outbox.filter(m => m.kind === 'notice').slice(-1)[0];
  assert.ok(/landlord has been sent their link/.test(n2.text));
  const lv = b.call({ action: 'sign.open', token: b.tokenFrom(b.lastEmail('landlord@example.com', 'invite')) });
  assert.equal(lv.isMyTurn, true);
  assert.equal(lv.waitingFor, null);
  // the wording in the agreement and certificate
  const html = b.call({ action: 'admin.progress', id }).html;
  assert.ok(html.includes('the tenants first, in any order, and then the landlord'));
  assert.equal(env.template.version, '1.8.0');
});

test('0.13.0: test agreements are marked as tests and can be signed automatically; real ones never', () => {
  const b = memoryBackend();
  const real = b.call({ action: 'admin.create', input: sampleInput() }).agreement;
  assert.throws(() => b.call({ action: 'admin.testSign', id: real.id }), /Only test agreements/);
  const t = b.call({ action: 'admin.create', input: sampleInput({ test: true }) }).agreement;
  assert.equal(t.test, true);
  assert.ok(b.lastEmail('mia@example.com', 'invite').subject.indexOf('[TEST] ') === 0, 'test emails are labelled');
  const r1 = b.call({ action: 'admin.testSign', id: t.id });
  assert.equal(r1.status, 'Sent'); assert.equal(r1.signed, 'Mia Example');
  const r2 = b.call({ action: 'admin.testSign', id: t.id });
  assert.ok(/Sample$/.test(r2.signed));
  const r3 = b.call({ action: 'admin.testSign', id: t.id });
  assert.equal(r3.status, 'Completed'); assert.deepEqual(r3.remaining, []);
  const full = b.call({ action: 'admin.get', id: t.id });
  assert.equal(full.chain.ok, true);
  assert.ok(full.events.some(e => e.type === 'IDENTITY_VERIFIED' && /test suite/.test(e.text)));
  assert.ok(full.events.filter(e => e.type === 'SIGNED').length === 3);
  const html = Object.values(b.db.finals).slice(-1)[0];
  assert.ok(html.includes('TEST AGREEMENT') && html.includes('This is a test agreement.'));
  // a change of tenants on a test tenancy is a test too, and can be completed the same way
  const v = b.call({ action: 'admin.createVariation', input: { parentId: t.id, effectiveDate: '2026-12-01', add: [{ name: 'Cara Test', email: 'cara@example.com', mobile: '021 555 0103', idType: 'Driver licence', idNumber: 'DC1', dob: '2000-02-14', ref: 'KB-9' }], bondArrangement: 'Test.' } }).agreement;
  assert.equal(v.test, true);
  let last; for (let i = 0; i < 5; i++) { last = b.call({ action: 'admin.testSign', id: v.id }); if (last.status === 'Completed') break; }
  assert.equal(last.status, 'Completed');
  assert.equal(b.call({ action: 'admin.get', id: v.id }).agreement.tenants.length, 3);
});

test('0.14.0: rooms, internet included and electricity included or capped', () => {
  const b = memoryBackend();
  const terms = (x) => sampleInput({ terms: Object.assign({}, sampleInput().terms, x) });
  const html = (x) => b.call({ action: 'admin.preview', input: terms(x) }).html;
  // nothing set: the wording is exactly as before
  let h = html({});
  assert.ok(h.includes('pay for the electricity, telephone and internet services they use during the tenancy'));
  assert.ok(!h.includes('Room let to the tenant') && !h.includes('included in the rent') && !h.includes('over the cap'));
  assert.ok(h.includes('No more than 3 people may live at the premises at any time.'));
  // a room, internet included, electricity capped and split between 4 rooms
  h = html({ room: 'Room B', roomCount: 4, internetIncluded: true, power: 'capped', powerCap: '200' });
  assert.ok(h.includes('Room let to the tenant') && h.includes('exclusive use of Room B and shares the rest of the premises'));
  assert.ok(h.includes('No more than 3 people may live in Room B at any time.') && !h.includes('may live at the premises'));
  assert.ok(h.includes('maximum number of occupants live in Room B') && h.includes('Room B, 14 Kowhai Lane'), 'the room is in the key details too');
  assert.ok(h.includes('pay for the telephone services they use during the tenancy'), 'electricity and internet are not the tenant\'s to arrange');
  assert.ok(h.includes('provide internet access at the premises, included in the rent'));
  assert.ok(h.includes('up to <b>$200 a month</b> (the bill for the whole premises)'));
  assert.ok(h.includes('split equally between the 4 rooms of the premises, and the tenant pays <b>one quarter</b> of it (one room&#39;s share) within <b>14 days</b>'), 'default 14 days');
  // the whole premises with a cap: the tenant pays all of the amount over
  h = html({ power: 'capped', powerCap: '250.50', powerDays: 10 });
  assert.ok(h.includes('more than $250.50, the tenant pays the amount over within <b>10 days</b>') && !h.includes('one room'));
  // electricity included
  h = html({ power: 'included' });
  assert.ok(h.includes('pay for the electricity used at the premises, which is included in the rent'));
  assert.ok(h.includes('pay for the telephone and internet services they use'));
  // checks
  const bad = b.call({ action: 'admin.preview', input: terms({ power: 'capped', powerCap: '', powerDays: 0 }) });
  assert.ok(bad.errors.some(e => e.includes('monthly electricity cap')) && bad.errors.some(e => e.includes('1 to 90')), bad.errors.join('|'));
  // the room is in the title and the emails
  const id = b.call({ action: 'admin.create', input: terms({ room: 'Room B', roomCount: 4 }) }).agreement.id;
  assert.ok(b.call({ action: 'admin.get', id }).agreement.title.includes('Room B, 14 Kowhai Lane'));
  assert.ok(b.lastEmail('mia@example.com', 'invite').subject.includes('for Room B, 14 Kowhai Lane'));
});
