/**
 * Tenancy e-sign provider for Tenant Management.
 *
 * Drop this file into the Tenant Management Apps Script project, next to the DocHub code. It
 * talks server-to-server to the separate "Tenancy e-sign" web app (repo kelvinbox/tenancy-esign),
 * which owns the signing pages, the records and the audit trail. Nothing here touches the
 * Register directly: every function takes plain objects and returns plain objects, so the
 * Tenant Management code decides where things are read from and saved to.
 *
 * Script properties needed in the Tenant Management project (Project Settings > Script properties):
 *   ESIGN_API_URL    the e-sign web app URL, ending in /exec
 *   ESIGN_ADMIN_KEY  the e-sign ADMIN_KEY (logged by setup() in the e-sign project)
 *
 * Settings sheet (Tenant Management):  "Agreement signing" = "DocHub" (default) or "Built-in".
 * Each agreement records agreement.provider = 'dochub' | 'esign' when it is sent, and every later
 * action (check status, cancel, PDF) uses the provider the agreement was sent with.
 *
 * Every function here ends in "_", so google.script.run can't call it from the browser. Write
 * small public wrappers that load data, call these and save the results.
 *
 * Tested by test/integration.test.js in the tenancy-esign repo. Pure ASCII.
 */

var ESIGN_PROVIDER = 'esign';
var DOCHUB_PROVIDER = 'dochub';
var ESIGN_SAFE_TO_RETRY = { 'admin.get': 1, 'admin.list': 1, 'admin.download': 1, 'admin.summary': 1, 'admin.preview': 1, 'admin.previewVariation': 1, 'admin.purge': 1, 'admin.progress': 1 };

/* =====================================================================
 * Transport
 * ===================================================================== */

function esignConfig_() {
  var p = PropertiesService.getScriptProperties();
  var url = p.getProperty('ESIGN_API_URL'), key = p.getProperty('ESIGN_ADMIN_KEY');
  if (!url || !key) {
    throw new Error('Built-in signing isn\'t set up yet. Add ESIGN_API_URL and ESIGN_ADMIN_KEY in Project Settings > Script properties.');
  }
  return { url: url, key: key };
}

/**
 * Calls the e-sign API. Errors from the service (bad input, wrong key...) are thrown with
 * err.code set and a plain-English message. Network failures are retried only for read-only
 * actions, so a timeout can never send an agreement twice.
 */
/**
 * Records how long a call to the signing service took (for Tenant Management's Speed check, when it's there):
 * the whole call, and the service's own start-up, wait for its lock and work. The rest is Google and the network.
 */
function esignNoteTiming_(action, ms, srv, tries) {
  if (typeof TM_PARTS === 'undefined') return;
  var k = 'signing ' + String(action).replace(/^admin\./, '');
  TM_PARTS[k] = (TM_PARTS[k] || 0) + ms;
  if (srv) { TM_PARTS[k + ': their queue'] = srv.lockWait; TM_PARTS[k + ': their work'] = srv.work; }
  if (tries > 1) TM_PARTS[k + ': tries'] = tries;
}

function esignCall_(action, params, actor) {
  var cfg = esignConfig_();
  var body = { action: action, adminKey: cfg.key, actor: String(actor || '').slice(0, 60) };
  Object.keys(params || {}).forEach(function (k) { body[k] = params[k]; });
  var attempts = ESIGN_SAFE_TO_RETRY[action] ? 3 : 1, lastErr = null;
  var tf = Date.now();
  for (var i = 1; i <= attempts; i++) {
    var res;
    try {
      res = UrlFetchApp.fetch(cfg.url, {
        method: 'post', contentType: 'text/plain', payload: JSON.stringify(body),
        muteHttpExceptions: true, followRedirects: true
      });
    } catch (e) {
      lastErr = e;
      if (i < attempts) Utilities.sleep(1000 * i);
      continue;
    }
    var code = res.getResponseCode();
    if (code >= 500 || code === 429) {
      lastErr = new Error('The signing service replied ' + code);
      if (i < attempts) Utilities.sleep(1000 * i);
      continue;
    }
    var out;
    try { out = JSON.parse(res.getContentText()); } catch (e2) {
      throw new Error('The signing service sent an unexpected reply (HTTP ' + code + '). Check ESIGN_API_URL is the /exec URL.');
    }
    if (!out.ok) {
      var err = new Error(out.error || 'The signing service reported an error.');
      err.code = out.code || 'ESIGN';
      throw err;
    }
    // A cold start can answer with the service's GET page ({ok, app, version}) instead of the action's
    // reply. Read-only actions are retried; anything that changes data never is, so it can't happen twice.
    if (!Object.prototype.hasOwnProperty.call(out, 'data')) {
      lastErr = new Error('the signing service was still starting up');
      if (ESIGN_SAFE_TO_RETRY[action]) { if (i < attempts) Utilities.sleep(1000 * i); continue; }
      throw new Error('The signing service was still starting up and didn\'t confirm. Wait a minute and tap Check status before trying again, so nothing is sent twice.');
    }
    esignNoteTiming_(action, Date.now() - tf, out.ms, i);
    return out.data;
  }
  if (!ESIGN_SAFE_TO_RETRY[action]) {
    throw new Error('The signing service didn\'t answer in time (' + (lastErr && lastErr.message ? lastErr.message : 'no reply') + '). It may still have gone through: wait a minute and tap Check status before trying again.');
  }
  throw new Error('Couldn\'t reach the signing service: ' + (lastErr && lastErr.message ? lastErr.message : 'no reply') + '. Try again in a minute.');
}

/* =====================================================================
 * Mapping helpers (Tenant Management -> e-sign)
 * ===================================================================== */

/** Accepts a Date, 'yyyy-mm-dd', "'yyyy-mm-dd" (Sheets text) or ''. Returns 'yyyy-mm-dd' or ''. */
function esignYmd_(v) {
  if (v === null || v === undefined || v === '') return '';
  if (Object.prototype.toString.call(v) === '[object Date]') {
    if (isNaN(v.getTime())) return '';
    return Utilities.formatDate(v, 'Pacific/Auckland', 'yyyy-MM-dd');
  }
  var s = String(v).replace(/^'/, '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
}

function esignAddDays_(ymd, n) {
  var p = ymd.split('-');
  var d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2] + n));
  return d.getUTCFullYear() + '-' + ('0' + (d.getUTCMonth() + 1)).slice(-2) + '-' + ('0' + d.getUTCDate()).slice(-2);
}

function esignAddMonths_(ymd, n) {
  var p = ymd.split('-');
  var d = new Date(Date.UTC(+p[0], +p[1] - 1 + n, +p[2]));
  return d.getUTCFullYear() + '-' + ('0' + (d.getUTCMonth() + 1)).slice(-2) + '-' + ('0' + d.getUTCDate()).slice(-2);
}

/** End date rule from the brief: start + tenancy length - 1 day; blank = periodic. */
function esignEndDate_(startYmd, tenancyLength) {
  if (!startYmd) return '';
  if (tenancyLength === '12 months') return esignAddDays_(esignAddMonths_(startYmd, 12), -1);
  if (tenancyLength === '6 months') return esignAddDays_(esignAddMonths_(startYmd, 6), -1);
  return '';
}

/** The one-line address is always "street, suburb". */
function esignOneLineAddress_(property) {
  return [property.address1, property.address2].map(function (x) { return String(x || '').trim(); }).filter(String).join(', ');
}

/**
 * ID from the application answers: licence first, then passport, then the Tenancy Services
 * form's alternative ID (number only).
 */
function esignIdFromAnswers_(answers) {
  answers = answers || {};
  if (answers.LicenceNumber) return { idType: 'Driver licence', idNumber: String(answers.LicenceNumber) };
  if (answers.PassportNumber) return { idType: 'Passport', idNumber: String(answers.PassportNumber) };
  if (answers.AlternativeId) return { idType: 'Other photo ID', idNumber: String(answers.AlternativeId) };
  return { idType: '', idNumber: '' };
}

/** An applicant (with their application answers) -> an e-sign tenant. */
function esignTenantFromApplicant_(a) {
  var ans = a.answers || {};
  var id = esignIdFromAnswers_(ans);
  return {
    ref: a.ref,
    name: ans.ApplicantName || a.name,
    email: String(ans.ApplicantEmail || a.email || '').trim().toLowerCase(),
    mobile: ans.ApplicantMobile || a.mobile || '',
    idType: id.idType,
    idNumber: id.idNumber,
    dob: esignYmd_(ans.DateOfBirth)
  };
}

/** Landlord record -> 1 or 2 people signing for the landlord. */
function esignLandlordSigners_(landlord) {
  var out = [{ name: landlord.signerName || landlord.name, email: landlord.email, mobile: landlord.mobile || '' }];
  if (landlord.signer2Name && landlord.signer2Email) {
    out.push({ name: landlord.signer2Name, email: landlord.signer2Email, mobile: landlord.signer2Mobile || '',
               showEmail: landlord.signer2EmailOnAgreement === undefined ? true : !!landlord.signer2EmailOnAgreement });   // still used to sign either way
  }
  return out;
}

/**
 * Builds the e-sign "create agreement" input from Tenant Management data.
 *
 * ctx = {
 *   groupKey,                         the group's key (first member's ref)
 *   property,                         Property record (+ the new e-sign fields, see HANDOVER.md)
 *   landlord,                         Landlord record (+ optional signer2Name/Email/Mobile)
 *   applicants: [ {ref, name, email, mobile, answers} ]   in signing order (group order)
 *   details: {                        from the send dialog (already defaulted the same way as for DocHub)
 *     rentPerWeek, bond, startDate, endDate (or tenancyLength), maxOccupants,
 *     landlordAddressForService (optional override)
 *   }
 * }
 */
function esignBuildAgreementInput_(ctx) {
  var p = ctx.property || {}, L = ctx.landlord || {}, d = ctx.details || {};
  var start = esignYmd_(d.startDate);
  var end = d.endDate !== undefined && d.endDate !== null ? esignYmd_(d.endDate) : esignEndDate_(start, d.tenancyLength || p.tenancyLength);
  return {
    propertyAddress: esignOneLineAddress_(p),
    landlord: {
      name: L.name, email: L.email, phone: L.phone || '', mobile: L.mobile || '',
      addressForService: d.landlordAddressForService || L.addressForService || ''
    },
    landlordSigners: esignLandlordSigners_(L),
    branding: L.branding || null,   // how the agreement and its emails look (frozen with it when sent; not part of the terms)
    test: ctx.test === true,        // from the test suite: marked as a test, and can be signed automatically
    terms: {
      rentPerWeek: String(d.rentPerWeek !== undefined ? d.rentPerWeek : p.rent),
      bond: String(d.bond !== undefined ? d.bond : p.bond),
      startDate: start,
      endDate: end,
      maxOccupants: Number(d.maxOccupants || p.maxOccupants),
      rentPaymentDetails: p.rentPaymentDetails || '',
      chattels: p.chattels || '',
      insurer: p.insurer || 'Not insured',
      insurancePolicy: p.insurancePolicy || '',
      excess: p.excess === undefined || p.excess === null ? '' : String(p.excess),
      insulationDate: esignYmd_(p.insulationDate),
      insulationStatement: p.insulationStatement || '',
      healthyHomesStatement: p.healthyHomesStatement || '',
      healthyHomesExemptions: p.healthyHomesExemptions || [],   // standards with an exemption, named in the landlord declaration
      pets: p.pets || '',
      additionalTerms: p.additionalTerms || '',
      unitTitle: !!p.unitTitle,
      bodyCorporateRules: p.unitTitle && p.bodyCorporateRules ? p.bodyCorporateRules : null,   // { name, mime, base64 }
      bottledGas: !!p.bottledGas,
      room: d.room || '',                       // a room let on its own (blank = the whole premises)
      roomCount: Number(p.roomCount) || 0,      // rooms at the premises, to split electricity over the cap
      internetIncluded: !!p.internetIncluded,
      power: p.power || 'tenant',               // tenant | included | capped
      powerCap: p.powerCap === undefined || p.powerCap === null ? '' : String(p.powerCap),
      powerDays: p.powerDays === undefined || p.powerDays === null || p.powerDays === '' ? '' : Number(p.powerDays)
    },
    tenants: (ctx.applicants || []).map(esignTenantFromApplicant_),
    source: {
      groupKey: ctx.groupKey || null,
      propertyId: p.id || null,
      applicantRefs: (ctx.applicants || []).map(function (a) { return a.ref; })
    }
  };
}

/* =====================================================================
 * Mapping helpers (e-sign -> Tenant Management)
 * ===================================================================== */

/** e-sign agreement status -> Tenant Management agreement status (Sent/Signed/Cancelled/Declined/Expired). */
function esignStatus_(s) {
  return { Sent: 'Sent', Completed: 'Signed', Declined: 'Declined', Cancelled: 'Cancelled', Expired: 'Expired' }[s] || s;
}

/** e-sign signer status -> the sent / opened / signed progress Tenant Management shows. */
function esignSignerStatus_(s) {
  return { Waiting: 'Waiting', Sent: 'Sent', Opened: 'Opened', Verified: 'Opened', Signed: 'Signed', Declined: 'Declined' }[s] || s;
}

/**
 * e-sign agreement summary -> the Tenant Management agreement record
 * {provider, status, requestId, documentId, landlord, sentAt, signed, signedAt, pdf, signers[], details}.
 * `previous` is the stored record (its landlord and details are kept).
 */
function esignAgreementRecord_(a, previous) {
  previous = previous || {};
  return {
    provider: ESIGN_PROVIDER,
    kind: a.kind || 'agreement',
    status: esignStatus_(a.status),
    requestId: a.id,
    documentId: a.id,
    tenancyId: a.tenancyId || a.id,
    version: a.version || 1,
    landlord: previous.landlord || null,
    sentAt: a.createdAt,
    signed: a.progress,
    signedAt: a.status === 'Completed' ? a.completedAt : '',
    pdf: a.final ? (a.final.url || '') : '',
    pdfSha256: a.final ? a.final.sha256 : '',
    replacedBy: a.supersededBy ? a.supersededBy.id : '',
    signers: (a.signers || []).map(function (s) {
      return {
        role: s.role, name: s.name, email: s.email, status: esignSignerStatus_(s.status),
        sentAt: s.sentAt || '', openedAt: s.openedAt || '', signedAt: s.signedAt || ''
      };
    }),
    details: previous.details || null,
    changeSummary: a.changeSummary || ''
  };
}

/**
 * A fully signed agreement -> a draft Tenancy record for Tenant Management to save.
 * Tenants come back with the details they confirmed when signing (including address for
 * service, which DocHub left blank), in signing order. DOB comes from the applications.
 *
 * ctx = { propertyId, landlordName, applicantsByRef: { ref: {answers...} } }
 */
function esignTenancyDraft_(a, ctx) {
  if (a.status !== 'Completed') throw new Error('The agreement isn\'t fully signed yet.');
  ctx = ctx || {};
  var byRef = ctx.applicantsByRef || {};
  var start = a.terms ? a.terms.startDate : '';
  return {
    propertyId: ctx.propertyId || (a.source && a.source.propertyId) || '',
    status: 'Current',
    start: start,
    end: a.terms ? a.terms.endDate : '',
    rent: a.terms ? a.terms.rentPerWeek : '',
    room: a.terms && a.terms.room ? a.terms.room : '',
    bond: a.terms ? a.terms.bond : '',
    landlord: ctx.landlordName || '',
    groupKey: a.source ? a.source.groupKey : '',
    agreementProvider: ESIGN_PROVIDER,
    agreementRequestId: a.id,
    agreementPdf: a.final ? (a.final.url || '') : '',
    agreementPdfSha256: a.final ? a.final.sha256 : '',
    tenants: (a.tenants || []).map(function (t) {
      var app = byRef[t.ref] || {};
      return {
        ref: t.ref || '', name: t.name, email: t.email, mobile: t.mobile,
        dob: t.dob || esignYmd_((app.answers || {}).DateOfBirth), moveIn: start,
        addressForService: t.addressForService || '',
        emergency: t.emergency || null   // given when signing (e-sign 0.16.0); not part of the agreement
      };
    })
  };
}

/* =====================================================================
 * Actions
 * ===================================================================== */

/** The agreement as it stands while out for signing: { status, signed, signers, html } (read-only). */
function esignProgress_(requestId) {
  return esignCall_('admin.progress', { id: requestId });
}

/** Permanently removes an agreement, its change-of-tenants variations and their files (clearing test data). {deleted: [ids]} */
function esignPurgeAgreement_(requestId, actor) {
  return esignCall_('admin.purge', { id: requestId }, actor);
}

/** Sends an agreement for signing. Returns {agreement, warnings} for Tenant Management to save. */
function esignSendAgreement_(ctx, actor) {
  var input = esignBuildAgreementInput_(ctx);
  var res = esignCall_('admin.create', { input: input }, actor);
  var record = esignAgreementRecord_(res.agreement, {
    landlord: ctx.landlord ? ctx.landlord.name : '',
    details: ctx.details || null
  });
  return { agreement: record, warnings: res.warnings || [], firstLink: res.firstLink || null };
}

/** Unsigned preview HTML (same validation as sending). Returns {errors, warnings, html}. */
function esignPreviewAgreement_(ctx, actor) {
  return esignCall_('admin.preview', { input: esignBuildAgreementInput_(ctx) }, actor);
}

/**
 * "Check status". Returns {agreement (updated record), full (the e-sign detail), completed}.
 * `completed` is true when the agreement is fully signed: create the tenancy (or, for a change
 * of tenants, update it) if that hasn't been done yet.
 */
function esignRefreshAgreement_(stored) {
  var full = esignCall_('admin.get', { id: stored.requestId });
  var a = full.agreement;
  a.terms = full.terms;
  return { agreement: esignAgreementRecord_(a, stored), full: a, completed: a.status === 'Completed' };
}

/** Test agreements only: the next person signs automatically (the Tenant Management test suite). */
function esignTestSign_(stored) {
  return esignCall_('admin.testSign', { id: stored.requestId }, 'test suite');
}

function esignCancelAgreement_(stored, reason, actor, opts) {
  opts = opts || {};   // { notify: false to email nobody, message: added to the cancellation email } (e-sign 0.17.0)
  var a = esignCall_('admin.cancel', { id: stored.requestId, reason: reason || 'Cancelled in Tenant Management',
    notify: opts.notify !== false, message: String(opts.message || '').trim() }, actor);
  return esignAgreementRecord_(a, stored);
}

/** Resend the current signer's link: channel 'email' | 'sms' (returns smsBody) | 'copy' (returns link). */
function esignResendLink_(stored, signerId, channel, actor) {
  return esignCall_('admin.issueLink', { id: stored.requestId, signerId: signerId, channel: channel || 'email' }, actor);
}

/** The signed PDF as a Blob (for saving into the family's shared agreements folder, if wanted). */
function esignSignedPdf_(stored) {
  var f = esignCall_('admin.download', { id: stored.requestId });
  return Utilities.newBlob(Utilities.base64Decode(f.base64), f.mime, f.name);
}

/** One-page tenancy summary HTML (current tenants, key terms, every signed version). */
function esignTenancySummaryHtml_(stored) {
  return esignCall_('admin.summary', { id: stored.requestId }).html;
}

/**
 * Change of tenants on a signed tenancy (fill a room, replace or remove someone).
 *
 * currentAgreementId: the requestId of the CURRENT signed version (original or latest change).
 * change = {
 *   effectiveDate,                    'yyyy-mm-dd'
 *   leavingEmails: [ ... ],           current tenants who are leaving
 *   joining: [ {ref, name, email, mobile, answers} ],   APPROVED applicants only
 *   bondTotal,                        optional; blank keeps the current total
 *   bondArrangement,                  required: how the bond is being settled between tenants
 *   reason                            optional
 * }
 * Returns the variation's agreement record (kind 'variation') for Tenant Management to save.
 */
function esignChangeTenants_(currentAgreementId, change, actor, previewOnly) {
  var input = {
    parentId: currentAgreementId,
    effectiveDate: esignYmd_(change.effectiveDate),
    remove: change.leavingEmails || [],
    add: (change.joining || []).map(esignTenantFromApplicant_),
    bondTotal: change.bondTotal === undefined || change.bondTotal === null ? '' : String(change.bondTotal),
    bondArrangement: change.bondArrangement || '',
    reason: change.reason || ''
  };
  if (previewOnly) return esignCall_('admin.previewVariation', { input: input }, actor);
  var res = esignCall_('admin.createVariation', { input: input }, actor);
  return { agreement: esignAgreementRecord_(res.agreement, {}), warnings: res.warnings || [], firstLink: res.firstLink || null };
}

/**
 * A fully signed change of tenants -> the updated Tenancy, plus what's needed for the Bond Hub
 * change-of-tenant task (notify Tenancy Services within 10 working days of the effective date).
 *
 * tenancy: the stored Tenancy record ({tenants: [{ref, name, email, mobile, dob, moveIn}], ...})
 * v:       the variation from esignRefreshAgreement_(...).full (status 'Completed')
 */
function esignApplyChangeToTenancy_(tenancy, v) {
  if (v.kind !== 'variation' || v.status !== 'Completed') throw new Error('That change of tenants isn\'t fully signed yet.');
  var eff = v.change.effectiveDate;
  var leaving = v.change.remove.map(function (r) { return r.email; });
  var before = tenancy.tenants || [];
  var byEmail = {};
  before.forEach(function (t) { byEmail[String(t.email).toLowerCase()] = t; });
  var tenants = v.tenants.map(function (t) {
    var old = byEmail[t.email];
    if (old) return Object.assign({}, old, { name: t.name, mobile: t.mobile });
    return { ref: t.ref || '', name: t.name, email: t.email, mobile: t.mobile, dob: t.dob || '', moveIn: eff, addressForService: t.addressForService || '', emergency: t.emergency || null };
  });
  var former = before.filter(function (t) { return leaving.indexOf(String(t.email).toLowerCase()) >= 0; })
    .map(function (t) { return Object.assign({}, t, { moveOut: eff }); });
  var updated = Object.assign({}, tenancy, {
    tenants: tenants,
    formerTenants: (tenancy.formerTenants || []).concat(former),
    agreementRequestId: v.id,
    agreementVersions: (tenancy.agreementVersions || [{ id: tenancy.agreementRequestId, pdf: tenancy.agreementPdf }])
      .concat([{ id: v.id, pdf: v.final ? (v.final.url || '') : '', sha256: v.final ? v.final.sha256 : '', effective: eff }])
  });
  return {
    tenancy: updated,
    bondChange: {
      effectiveDate: eff,
      leaving: former.map(function (t) { return t.name; }),
      joining: tenants.filter(function (t) { return !byEmail[t.email]; }).map(function (t) { return t.name; }),
      bondTotal: v.change.bondTotal,
      bondArrangement: v.change.bondArrangement,
      note: 'Notify Tenancy Services of this change of tenant in Bond Hub within 10 working days of ' + eff + '.'
    }
  };
}

/**
 * For a time-driven trigger: refreshes every open built-in agreement.
 * open:     [{ key, agreement }]  (key = whatever identifies the row, e.g. the group key)
 * onUpdate: function (key, result) -- save result.agreement; if result.completed, create or update the tenancy.
 * Returns a count. One failure never stops the rest.
 */
function esignRefreshOpenAgreements_(open, onUpdate) {
  var done = 0, failed = 0;
  (open || []).forEach(function (o) {
    if (!o.agreement || o.agreement.provider !== ESIGN_PROVIDER || o.agreement.status !== 'Sent') return;
    try {
      onUpdate(o.key, esignRefreshAgreement_(o.agreement));
      done++;
    } catch (e) {
      failed++;
      console.warn('E-sign refresh failed for ' + o.key + ': ' + (e && e.message));
    }
  });
  return { refreshed: done, failed: failed };
}
