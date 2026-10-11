'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ESign, memoryBackend, sampleInput, signAs } = require('./helpers');

/** A fully signed original agreement (Mia, Tui, landlord). */
function signedOriginal(opts) {
  const b = memoryBackend(opts);
  const id = b.call({ action: 'admin.create', input: sampleInput() }).agreement.id;
  signAs(b, b.tokenFrom(b.lastEmail('mia@example.com', 'invite')));
  signAs(b, b.tokenFrom(b.lastEmail('tui@example.net', 'invite')));
  signAs(b, b.tokenFrom(b.lastEmail('landlord@example.com', 'invite')));
  return { b, id };
}

const riley = { name: 'Riley Sample', email: 'riley@example.com', mobile: '021 000 1050', idType: 'Driver licence', idNumber: 'DX000050', dob: '1999-07-07', ref: 'KB-20050' };

function lastInvite(b, email) { return b.tokenFrom(b.lastEmail(email, 'invite')); }

test('add a tenant: joining tenant first, then existing tenants, then landlord; versions chain', () => {
  const { b, id } = signedOriginal();
  const orig = b.call({ action: 'admin.get', id });
  assert.equal(orig.tenancy.canChange, true);

  const res = b.call({ action: 'admin.createVariation', input: { parentId: id, effectiveDate: '2026-12-01', add: [riley], bondArrangement: 'Riley pays $650 bond to Tenancy Services as a top-up.', bondTotal: '2600' } });
  const vid = res.agreement.id;
  assert.equal(res.agreement.kind, 'variation');
  assert.equal(res.agreement.version, 2);
  assert.deepEqual(res.agreement.signers.map(s => s.role), ['NewTenant1', 'ContinuingTenant1', 'ContinuingTenant2', 'Landlord']);
  assert.match(b.lastEmail('riley@example.com', 'invite').subject, /change of tenants/);

  // The original is locked while the change is out.
  assert.equal(b.call({ action: 'admin.get', id }).tenancy.canChange, false);
  assert.throws(() => b.call({ action: 'admin.createVariation', input: { parentId: id, effectiveDate: '2026-12-01', remove: ['tui@example.net'], bondArrangement: 'x' } }), /already out for signing/);

  // The joining tenant reads the original exactly as it was signed (not re-rendered with new
  // tenants) and signs a statement binding them to it; continuing tenants just read the variation.
  const rv = b.call({ action: 'sign.open', token: lastInvite(b, 'riley@example.com') });
  const refRent = rv.document.sections.find(s => s.id === 'ref-1-rent');
  assert.ok(refRent, 'signed original shown to joining tenant');
  const refParties = rv.document.sections.find(s => s.id === 'ref-1-parties');
  assert.ok(refParties.html.includes('Mia Example') && !refParties.html.includes('Riley'), 'original shown as signed, not updated');
  assert.match(rv.document.sections.find(s => s.id === 'ref-intro').heading, /not being re-signed/);
  assert.match(rv.agreeText, /as if I had signed the original agreement/);
  assert.match(rv.agreement.changeSummary, /Riley Sample is joining on 1st December 2026/);

  signAs(b, lastInvite(b, 'riley@example.com'));
  const signedEv = b.call({ action: 'admin.get', id: vid }).events.find(e => e.type === 'SIGNED');
  assert.match(signedEv.details.statement, /bound by all of its terms/);
  const mv = b.call({ action: 'sign.open', token: lastInvite(b, 'mia@example.com') });
  assert.ok(!mv.document.sections.some(s => s.id.startsWith('ref-')));
  assert.match(mv.agreeText, /I have read this variation/);
  signAs(b, lastInvite(b, 'mia@example.com'));
  signAs(b, lastInvite(b, 'tui@example.net'));
  const done = signAs(b, lastInvite(b, 'landlord@example.com'));
  assert.equal(done.agreement.status, 'Completed');

  const v = b.call({ action: 'admin.get', id: vid });
  assert.deepEqual(v.agreement.tenants.map(t => t.name), ['Mia Example', 'T\u016bi Sample', 'Riley Sample']);
  assert.equal(v.agreement.tenants[2].ref, 'KB-20050');
  assert.equal(v.tenancy.links.ok, true);
  assert.equal(v.tenancy.isCurrent, true);

  // The original is now marked as replaced, and its own audit trail says so.
  const o = b.call({ action: 'admin.get', id });
  assert.equal(o.agreement.supersededBy.id, vid);
  assert.equal(o.chain.ok, true);
  assert.ok(o.events.some(e => e.type === 'SUPERSEDED'));
  assert.equal(o.tenancy.canChange, false);

  // The signed variation incorporates the original by fingerprint and does not restate it.
  const html = b.db.finals['fin-' + vid];
  assert.ok(html.includes(o.agreement.final.sha256));
  assert.ok(html.includes('Variation of Tenancy Agreement: Change of Tenants'));
  assert.ok(html.includes('It is not a new tenancy agreement'));
  assert.ok(!html.includes('Residential Tenancy Agreement<'), 'no re-rendered agreement inside the variation');
  assert.ok(!html.includes('The landlord agrees to'), 'agreement clauses are not repeated');

  // The joining tenant is emailed the original signed agreement as well as the variation.
  const rileyCopy = b.db.outbox.find(m => m.kind === 'completed' && m.to === 'riley@example.com');
  assert.deepEqual(rileyCopy.attachments.map(a => a.ref), ['fin-' + vid, 'fin-' + id]);
  assert.match(rileyCopy.text, /signed documents that make up the tenancy agreement you have joined/);
  const miaCopy = b.db.outbox.find(m => m.kind === 'completed' && m.to === 'mia@example.com' && m.subject.includes('variation'));
  assert.equal(miaCopy.attachments.length, 1);
  assert.ok(b.call({ action: 'admin.get', id: vid }).events.find(e => e.type === 'COPIES_SENT').details.joiningTenantsAlsoSent);

  // Verify: the original is found, but flagged as replaced.
  const vo = b.call({ action: 'verify', sha256: o.agreement.final.sha256 });
  assert.equal(vo.supersededBy.id, vid);
  assert.equal(vo.history.length, 2);

  // The tenancy summary is a cover sheet, not an agreement.
  const sum = b.call({ action: 'admin.summary', id });
  assert.equal(sum.version, 2);
  assert.ok(sum.html.includes('Riley Sample') && sum.html.includes('not a signed document and not a tenancy agreement'));
  assert.ok(sum.html.includes(o.agreement.final.sha256));
  assert.ok(!sum.html.includes('The landlord agrees to'));
});

test('swap a tenant: leaving tenant gives a forwarding address; the result replaces them', () => {
  const { b, id } = signedOriginal();
  const res = b.call({
    action: 'admin.createVariation',
    input: { parentId: id, effectiveDate: '2027-03-01', remove: ['tui@example.net'], add: [riley], reason: 'Tui is moving to Auckland', bondArrangement: 'Riley pays Tui $1300 for Tui\'s share. Total bond unchanged.' }
  });
  assert.deepEqual(res.agreement.signers.map(s => s.role), ['NewTenant1', 'LeavingTenant1', 'ContinuingTenant1', 'Landlord']);
  signAs(b, lastInvite(b, 'riley@example.com'));
  const leaving = b.call({ action: 'sign.open', token: lastInvite(b, 'tui@example.net') });
  assert.equal(leaving.fields.find(f => f.key === 'addressForService').label, 'Forwarding address for service');
  signAs(b, lastInvite(b, 'tui@example.net'), { details: { addressForService: '1 Elsewhere Street, Auckland' } });
  signAs(b, lastInvite(b, 'mia@example.com'));
  signAs(b, lastInvite(b, 'landlord@example.com'));
  const v = b.call({ action: 'admin.get', id: res.agreement.id });
  assert.deepEqual(v.agreement.tenants.map(t => t.email), ['mia@example.com', 'riley@example.com']);
  const html = b.db.finals['fin-' + res.agreement.id];
  assert.ok(html.includes('Tui is moving to Auckland') && html.includes('Riley pays Tui $1300'));
  // Everyone involved, including the leaving tenant, gets the signed copy.
  assert.ok(b.db.outbox.some(m => m.kind === 'completed' && m.to === 'tui@example.net' && /change of tenants/.test(m.subject)));

  // A third version builds on the second, not the original.
  assert.throws(() => b.call({ action: 'admin.createVariation', input: { parentId: id, effectiveDate: '2027-04-01', remove: ['mia@example.com'], bondArrangement: 'x' } }), /already been replaced/);
  const v3 = b.call({ action: 'admin.createVariation', input: { parentId: res.agreement.id, effectiveDate: '2027-04-01', remove: ['mia@example.com'], bondArrangement: 'Mia refunded by Riley.' } });
  assert.equal(v3.agreement.version, 3);
});

test('a declined or cancelled change frees the agreement for another', () => {
  const { b, id } = signedOriginal();
  const r1 = b.call({ action: 'admin.createVariation', input: { parentId: id, effectiveDate: '2026-12-01', add: [riley], bondArrangement: 'Top-up.' } });
  b.call({ action: 'sign.decline', token: lastInvite(b, 'riley@example.com'), reason: 'Found another place' });
  assert.equal(b.call({ action: 'admin.get', id }).tenancy.canChange, true);
  assert.ok(b.call({ action: 'admin.get', id }).events.some(e => e.type === 'VARIATION_ENDED'));
  const r2 = b.call({ action: 'admin.createVariation', input: { parentId: id, effectiveDate: '2026-12-01', remove: ['tui@example.net'], bondArrangement: 'Refund via Bond Hub.' } });
  b.call({ action: 'admin.cancel', id: r2.agreement.id, reason: 'Changed plans' });
  assert.equal(b.call({ action: 'admin.get', id }).tenancy.canChange, true);
  assert.equal(b.call({ action: 'admin.get', id }).agreement.supersededBy, null);
  assert.notEqual(r1.agreement.id, r2.agreement.id);
});

test('change validation', () => {
  const { b, id } = signedOriginal();
  const bad = input => {
    try { b.call({ action: 'admin.createVariation', input: Object.assign({ parentId: id, effectiveDate: '2026-12-01', bondArrangement: 'x' }, input) }); }
    catch (e) { return e.message; }
    assert.fail('expected an error');
  };
  assert.match(bad({}), /who is leaving/);
  assert.match(bad({ add: [Object.assign({}, riley, { ref: '' })] }), /approved application/);
  assert.match(bad({ remove: ['mia@example.com', 'tui@example.net'] }), /At least one tenant must remain/);
  assert.match(bad({ remove: ['nobody@example.com'] }), /isn't a tenant/);
  assert.match(bad({ add: [riley, Object.assign({}, riley, { email: 'b@example.com', ref: 'KB-2' })] }), /maximum number of occupants is 3/);
  assert.match(bad({ add: [Object.assign({}, riley, { email: 'mia@example.com' })] }), /already a tenant/);
  assert.match(bad({ add: [riley], bondTotal: '9999' }), /4 weeks' rent/);
  assert.match(bad({ add: [riley], bondArrangement: '' }), /how the bond is being settled/);
  assert.match(bad({ add: [riley], effectiveDate: '2028-01-01' }), /after the fixed term ends/);

  // An agreement that isn't fully signed can't be changed.
  const b2 = memoryBackend();
  const id2 = b2.call({ action: 'admin.create', input: sampleInput() }).agreement.id;
  assert.throws(() => b2.call({ action: 'admin.createVariation', input: { parentId: id2, effectiveDate: '2026-12-01', add: [riley], bondArrangement: 'x' } }), /fully signed/);
});

test('tampering with an earlier signed version breaks the link to the change', () => {
  const { b, id } = signedOriginal();
  const r = b.call({ action: 'admin.createVariation', input: { parentId: id, effectiveDate: '2026-12-01', add: [riley], bondArrangement: 'Top-up.' } });
  assert.equal(b.call({ action: 'admin.get', id: r.agreement.id }).tenancy.links.ok, true);
  b.db.envelopes[id].final.sha256 = 'f'.repeat(64);
  const links = b.call({ action: 'admin.get', id: r.agreement.id }).tenancy.links;
  assert.equal(links.ok, false);
  assert.deepEqual(links.problems, [r.agreement.id]);
});

test('preview of a change renders without sending anything', () => {
  const { b, id } = signedOriginal();
  const before = b.db.outbox.length;
  const p = b.call({ action: 'admin.previewVariation', input: { parentId: id, effectiveDate: '2026-12-01', add: [riley], bondArrangement: 'Top-up.' } });
  assert.deepEqual(p.errors, []);
  assert.ok(p.html.includes('Variation of Tenancy Agreement') && p.html.includes('Riley Sample') && !p.html.includes('Annex'));
  assert.equal(b.db.outbox.length, before);
  assert.equal(b.call({ action: 'admin.get', id }).tenancy.canChange, true);
  assert.equal(ESign.roleLabel('LeavingTenant1'), 'Leaving tenant 1');
});
