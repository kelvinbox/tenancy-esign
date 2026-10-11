/*
 * Landlord console: create agreements, follow progress, resend links, read the audit trail.
 * In live use the Tenant Management app would create agreements through the same API.
 */
(function () {
  'use strict';
  var $ = UI.$, $all = UI.$all, esc = UI.esc;
  var app = $('#app');
  var tab = 'list', filter = 'Active', detailId = null, outboxSeen = 0;
  var form = null; // draft of the New agreement form
  var isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);

  if (!ESignApi.live) {
    $('#demoBadge').hidden = false;
    $('#tabOutbox').hidden = false;
    try { outboxSeen = Number(localStorage.getItem('esign-outbox-seen') || 0); } catch (e) { outboxSeen = 0; }
  }
  ESignApi.warmUp();

  function header(title, sub, back) {
    $('#hdrTitle').textContent = title;
    $('#hdrSub').textContent = sub || (ESignApi.live ? 'Tenancy e-sign' : 'Tenancy e-sign \u00b7 demo data only');
    $('#backBtn').hidden = !back;
    $('#hdrTile').hidden = !!back;
  }

  function go(t) {
    tab = t; detailId = null;
    $all('#tabbar button').forEach(function (b) { b.classList.toggle('on', b.dataset.tab === t); });
    render();
  }

  $all('#tabbar button').forEach(function (b) {
    b.addEventListener('click', function () {
      if (b.dataset.tab === 'verify') { location.href = 'verify.html'; return; }
      go(b.dataset.tab);
    });
  });
  $('#backBtn').addEventListener('click', function () { detailId = null; render(); });

  function render() {
    window.scrollTo(0, 0);
    updateBadges();
    if (detailId) return renderDetail(detailId);
    ({ list: renderList, 'new': renderNew, outbox: renderOutbox, settings: renderSettings })[tab]();
  }

  function updateBadges() {
    if (!ESignApi.live) {
      var n = DemoBackend.outbox().length - outboxSeen;
      $('#badgeOutbox').hidden = n <= 0 || tab === 'outbox';
      $('#badgeOutbox').textContent = n;
    }
  }

  function loading() { app.innerHTML = '<div class="card center muted" style="padding:30px"><span class="spin" style="border-color:#cbd5e1;border-top-color:#0f766e"></span></div>'; }

  function failCard(e) {
    app.innerHTML = '<div class="card"><div class="err">' + esc(e.message) + '</div>' +
      (e.code === 'AUTH' ? '<button class="btn" id="toSettings">Open Setup</button>' : '<button class="btn" id="retry">Try again</button>') + '</div>';
    var t = $('#toSettings'); if (t) t.addEventListener('click', function () { go('settings'); });
    var r = $('#retry'); if (r) r.addEventListener('click', render);
  }

  /* ---------- list ---------- */

  function progressBar(a) {
    var cur = null;
    a.signers.some(function (s) { if (s.status !== 'Signed') { cur = s; return true; } return false; });
    return '<div class="prog">' + a.signers.map(function (s) {
      var cls = s.status === 'Signed' ? 'signed' : s.status === 'Declined' ? 'declined' : (a.status === 'Sent' && cur === s ? 'active' : '');
      return '<span class="' + cls + '" title="' + esc(s.name + ': ' + s.status) + '"></span>';
    }).join('') + '</div>';
  }

  function renderList() {
    header('Agreements');
    loading();
    ESignApi.call('admin.list').then(function (list) {
      var active = list.filter(function (a) { return a.status === 'Sent'; });
      $('#badgeOpen').hidden = !active.length;
      $('#badgeOpen').textContent = active.length;
      var groups = { Active: active, Completed: list.filter(function (a) { return a.status === 'Completed'; }), Other: list.filter(function (a) { return ['Declined', 'Cancelled', 'Expired'].indexOf(a.status) >= 0; }) };
      var shown = groups[filter];
      var h = '<div class="chips">' + ['Active', 'Completed', 'Other'].map(function (k) {
        return '<button class="chip' + (k === filter ? ' on' : '') + '" data-f="' + k + '">' + (k === 'Active' ? 'Out for signing' : k === 'Other' ? 'Declined / cancelled' : k) + ' (' + groups[k].length + ')</button>';
      }).join('') + '</div>';
      if (!list.length) {
        h += '<div class="card state"><div class="big">&#128221;</div><h2>No agreements yet</h2><p class="muted">Create one, then open the signing link from the ' +
          (ESignApi.live ? 'tenant\'s email' : 'Outbox tab') + ' to try signing on your phone.</p><button class="btn" id="newBtn">&#10133; New agreement</button></div>';
      } else if (!shown.length) {
        h += '<div class="card center muted">Nothing here.</div>';
      }
      shown.forEach(function (a) {
        var tenants = a.signers.filter(function (s) { return s.kind === 'tenant'; }).map(function (s) { return s.name; }).join(', ');
        var cur = a.signers.filter(function (s) { return s.status !== 'Signed'; })[0];
        var next = a.status === 'Sent' && cur ? 'Waiting for ' + cur.name + (cur.status === 'Opened' || cur.status === 'Verified' ? ' (opened ' + UI.when(cur.openedAt) + ')' : '') : '';
        h += '<div class="card list-card" data-id="' + esc(a.id) + '"><div class="tile">&#127968;</div><div class="grow">' +
          '<div class="row"><div class="title grow">' + esc(a.propertyAddress) + '</div>' + UI.statusPill(a.status) + '</div>' +
          '<div class="small muted">' + esc(tenants) + '</div>' +
          '<div class="small">' + esc(a.progress) + ' signed' + (next ? ' &middot; ' + esc(next) : '') + (a.completedAt ? ' &middot; completed ' + esc(UI.when(a.completedAt)) : '') + '</div>' +
          progressBar(a) + '</div></div>';
      });
      app.innerHTML = h;
      $all('.chip').forEach(function (c) { c.addEventListener('click', function () { filter = c.dataset.f; renderList(); }); });
      $all('.list-card').forEach(function (c) { c.addEventListener('click', function () { detailId = c.dataset.id; render(); }); });
      var nb = $('#newBtn'); if (nb) nb.addEventListener('click', function () { go('new'); });
    }).catch(failCard);
  }

  /* ---------- detail ---------- */

  function smsHref(number, body) {
    var n = String(number || '').replace(/[^\d+]/g, '');
    return 'sms:' + n + (isIOS ? '&' : '?') + 'body=' + encodeURIComponent(body);
  }

  function renderDetail(id) {
    header('Agreement', id, true);
    loading();
    ESignApi.call('admin.get', { id: id }).then(function (d) {
      var a = d.agreement;
      header('Agreement', a.id, true);
      var cur = a.status === 'Sent' ? d.signers.filter(function (s) { return s.status !== 'Signed'; })[0] : null;
      var h = '<div class="card"><div class="row"><div class="tile">&#127968;</div><div class="grow"><div class="title" style="font-weight:700">' + esc(a.propertyAddress) + '</div>' +
        '<div class="small muted">Sent ' + esc(UI.whenLong(a.createdAt)) + ' by ' + esc(a.createdBy) + '</div></div></div>' +
        '<div class="row wrap-row" style="margin-top:10px">' + UI.statusPill(a.status) + '<span class="pill grey">' + esc(a.progress) + ' signed</span>' +
        (a.status === 'Sent' ? '<span class="pill grey">Links expire ' + esc(UI.when(a.expiresAt)) + '</span>' : '') + '</div>' + progressBar(a) + '</div>';

      if (a.status === 'Completed' && a.final) {
        h += '<div class="card"><h2>&#9989; Signed by everyone</h2><p class="small">Completed ' + esc(UI.whenLong(a.completedAt)) + '. Everyone was emailed a copy.</p>' +
          '<div class="btn-row"><button class="btn" id="openFinal">Open signed document</button><button class="btn ghost" id="dlFinal">Download</button></div>' +
          '<p class="small muted" style="margin-top:10px">Document fingerprint (SHA-256)<br><span class="mono">' + esc(a.final.sha256) + '</span></p>' +
          (ESignApi.live ? '' : '<p class="small muted">In demo mode the signed document is an HTML file (use Print &rarr; Save as PDF). The live Apps Script version saves a PDF to Google Drive.</p>') + '</div>';
      }

      h += '<div class="card"><h2>Signers</h2><p class="small muted">They sign in this order. The next person is emailed automatically when the one before finishes.</p><ul class="signers">';
      d.signers.forEach(function (s, i) {
        var steps = [['Sent', s.sentAt], ['Opened', s.openedAt], ['Agreed to e-sign', s.consentAt], ['Email verified', s.verifiedAt], ['Read', s.reviewedAt], ['Signed', s.signedAt]]
          .filter(function (x) { return x[1]; }).map(function (x) { return x[0] + ' ' + UI.when(x[1]); }).join(' \u00b7 ');
        h += '<li style="align-items:flex-start"><span class="num ' + (s.status === 'Signed' ? 'done' : cur && cur.id === s.id ? 'me' : '') + '">' + (s.status === 'Signed' ? '&#10003;' : i + 1) + '</span>' +
          '<div class="grow"><div class="row"><b class="grow">' + esc(s.name) + '</b>' + UI.statusPill(s.status, true) + '</div>' +
          '<div class="small muted">' + esc(ESign.roleLabel(s.role)) + ' &middot; ' + esc(s.email) + '</div>' +
          (steps ? '<div class="small" style="margin-top:2px">' + esc(steps) + '</div>' : '') +
          (s.declineReason ? '<div class="warn small" style="margin-top:6px">Declined: ' + esc(s.declineReason) + '</div>' : '') +
          (cur && cur.id === s.id ? '<div class="btn-row" style="margin-top:8px">' +
            '<button class="btn small light" data-link="email" data-s="' + s.id + '">&#9993;&#65039; Email again</button>' +
            '<button class="btn small light" data-link="sms" data-s="' + s.id + '" data-m="' + esc(s.details.mobile || '') + '">&#128172; Text link</button>' +
            '<button class="btn small light" data-link="copy" data-s="' + s.id + '">&#128203; Copy link</button></div>' : '') +
          '</div></li>';
      });
      h += '</ul></div>';

      var t = d.terms;
      h += '<div class="card doc"><h2>Locked terms</h2><table class="kv">' +
        '<tr><th>Rent</th><td>$' + esc(t.rentPerWeek) + ' per week</td></tr>' +
        '<tr><th>Bond</th><td>$' + esc(t.bond) + '</td></tr>' +
        '<tr><th>Start</th><td>' + esc(ESign.longDate(t.startDate)) + '</td></tr>' +
        '<tr><th>End</th><td>' + (t.endDate ? esc(ESign.longDate(t.endDate)) : 'Periodic') + '</td></tr>' +
        '<tr><th>Max occupants</th><td>' + esc(t.maxOccupants) + '</td></tr>' +
        '<tr><th>Landlord</th><td>' + esc(d.landlord.name) + '</td></tr></table>' +
        '<p class="small muted">Terms can\'t be changed once sent. To fix a mistake, cancel and send a new agreement.</p></div>';

      h += '<div class="card"><h2>Integrity</h2>' +
        '<div class="' + (d.chain.ok ? 'ok-box' : 'err') + '">' + (d.chain.ok ? '&#10003; Audit trail intact: ' + d.chain.count + ' events, each linked to the one before by its hash.' :
          '&#9888;&#65039; The audit trail has been altered at event ' + d.chain.brokenAt + '. Don\'t rely on this record.') + '</div>' +
        '<p class="small"><b>Terms fingerprint</b><br><span class="mono">' + esc(d.termsHash) + '</span></p>' +
        '<p class="small"><b>Latest audit hash</b><br><span class="mono">' + esc(d.chain.head) + '</span></p>' +
        '<p class="small muted">Template ' + esc(d.template.id) + ' v' + esc(d.template.version) + '</p></div>';

      h += '<div class="card"><h2>Audit trail</h2><ul class="tl">' + d.events.slice().reverse().map(function (ev) {
        var dev = ev.client ? [ev.client.ip ? 'IP ' + ev.client.ip : '', shortUa(ev.client.ua)].filter(Boolean).join(' \u00b7 ') : '';
        return '<li><div>' + esc(ev.text) + '</div><div class="t">' + esc(UI.whenLong(ev.at)) + ' &middot; ' + esc(ev.actor) + (dev ? ' &middot; ' + esc(dev) : '') +
          ' &middot; <span class="mono" style="font-size:11px">#' + ev.seq + ' ' + esc(ev.hash.slice(0, 10)) + '</span></div></li>';
      }).join('') + '</ul></div>';

      if (a.status === 'Sent') h += '<button class="btn danger block" id="cancelBtn">Cancel this agreement</button>';
      app.innerHTML = h;

      $all('[data-link]').forEach(function (b) {
        b.addEventListener('click', function () { issueLink(a, b.dataset.s, b.dataset.link, b.dataset.m, b); });
      });
      var c = $('#cancelBtn'); if (c) c.addEventListener('click', function () { confirmCancel(a); });
      var of = $('#openFinal'); if (of) of.addEventListener('click', function () { download(a.id, false, of); });
      var df = $('#dlFinal'); if (df) df.addEventListener('click', function () { download(a.id, true, df); });
    }).catch(failCard);
  }

  function shortUa(ua) {
    if (!ua) return '';
    var m = /(iPhone|iPad|Android|Windows|Macintosh|Linux)/.exec(ua), b = /(Edg|CriOS|Chrome|FxiOS|Firefox|Safari)\//.exec(ua);
    return (m ? m[1].replace('Macintosh', 'Mac') : 'Device') + (b ? ' ' + b[1].replace('CriOS', 'Chrome').replace('FxiOS', 'Firefox').replace('Edg', 'Edge') : '');
  }

  function download(id, save, btn) {
    UI.busy(btn, true, 'Loading...');
    ESignApi.call('admin.download', { id: id }).then(function (f) {
      UI.busy(btn, false);
      save ? UI.downloadB64(f) : UI.openB64(f);
    }).catch(function (e) { UI.busy(btn, false); UI.toast(e.message, 'error'); });
  }

  function issueLink(a, signerId, channel, mobile, btn) {
    var warn = channel === 'email' ? '' : 'A new link will be made. Any earlier link for this person stops working.';
    if (warn && !confirm(warn)) return;
    UI.busy(btn, true, '...');
    ESignApi.call('admin.issueLink', { id: a.id, signerId: signerId, channel: channel }).then(function (r) {
      UI.busy(btn, false);
      if (channel === 'email') { UI.toast('Signing link emailed again.', 'ok'); render(); return; }
      if (channel === 'sms') {
        var m = UI.modal('<p>Your phone\'s Messages app will open with this text. It\'s sent from your own phone, so it doesn\'t use the email quota.</p>' +
          '<pre class="mono" style="white-space:pre-wrap;background:#f8fafb;padding:10px;border-radius:8px">' + esc(r.smsBody) + '</pre>' +
          '<a class="btn block" target="_blank" rel="noopener" href="' + esc(smsHref(mobile, r.smsBody)) + '">Open Messages</a>', { title: 'Text the signing link', onClose: render });
        return m;
      }
      UI.copy(r.link).then(function () { UI.toast('Link copied. Earlier links no longer work.', 'ok'); }, function () {
        UI.modal('<p>Copy this link:</p><textarea readonly rows="4" style="font-size:13px">' + esc(r.link) + '</textarea>', { title: 'Signing link' });
      });
      render();
    }).catch(function (e) { UI.busy(btn, false); UI.toast(e.message, 'error'); });
  }

  function confirmCancel(a) {
    var m = UI.modal('<p>Cancelling stops all signing. Tenants who already got a link are emailed to say it\'s cancelled. You can then send a corrected agreement.</p>' +
      '<label class="f"><span class="l">Reason (recorded in the audit trail)</span><input id="why" placeholder="For example: wrong start date"></label>' +
      '<div class="btn-row"><button class="btn ghost" data-close>Keep it</button><button class="btn danger" id="doCancel">Cancel agreement</button></div>', { title: 'Cancel agreement' });
    $('#doCancel', m.el).addEventListener('click', function () {
      var b = $('#doCancel', m.el);
      UI.busy(b, true, 'Cancelling...');
      ESignApi.call('admin.cancel', { id: a.id, reason: $('#why', m.el).value }).then(function () {
        m.close(); UI.toast('Agreement cancelled.', 'ok'); render();
      }).catch(function (e) { UI.busy(b, false); UI.toast(e.message, 'error'); });
    });
  }

  /* ---------- new agreement ---------- */

  function blankForm() {
    return {
      propertyAddress: '', landlord: { name: '', signerName: '', email: '', phone: '', mobile: '', addressForService: '' },
      terms: { rentPerWeek: '', bond: '', startDate: '', length: '12 months', endDate: '', maxOccupants: '', rentPaymentDetails: '', chattels: '',
        insurer: '', insurancePolicy: '', excess: '', insulationDate: '', insulationStatement: '', healthyHomesStatement: '', pets: '', additionalTerms: '' },
      tenants: [{ name: '', email: '', mobile: '', idType: 'Driver licence', idNumber: '', dob: '' }],
      source: null
    };
  }

  function computeEnd() {
    var t = form.terms, s = t.startDate;
    if (!ESign.parseYmd(s)) return;
    if (t.length === '12 months') t.endDate = ESign.addDays(addMonths(s, 12), -1);
    else if (t.length === '6 months') t.endDate = ESign.addDays(addMonths(s, 6), -1);
    else if (t.length === 'Periodic') t.endDate = '';
  }
  function addMonths(s, n) {
    var p = ESign.parseYmd(s), d = new Date(Date.UTC(p.y, p.m - 1 + n, p.d));
    return d.toISOString().slice(0, 10);
  }

  function applyProperty(p) {
    var L = DemoData.landlords.filter(function (l) { return l.name === p.landlord; })[0];
    form.propertyAddress = p.address;
    if (L) form.landlord = JSON.parse(JSON.stringify(L));
    Object.assign(form.terms, {
      rentPerWeek: p.rent, bond: p.bond, maxOccupants: p.maxOccupants, length: p.tenancyLength, chattels: p.chattels,
      insurer: p.insurer, insurancePolicy: p.insurancePolicy, excess: p.excess, insulationDate: p.insulationDate,
      insulationStatement: p.insulationStatement, rentPaymentDetails: DemoData.rentPaymentDetails, healthyHomesStatement: DemoData.healthyHomesStatement
    });
    computeEnd();
  }

  function applyGroup(g) {
    var p = DemoData.properties.filter(function (x) { return x.id === g.property; })[0];
    if (p) applyProperty(p);
    form.tenants = JSON.parse(JSON.stringify(g.tenants));
    form.source = { groupKey: g.key, propertyId: g.property, applicantRefs: g.tenants.map(function (t) { return t.ref; }) };
    if (!form.terms.startDate) {
      var d = new Date(Date.now() + 21 * 86400000);
      form.terms.startDate = d.toISOString().slice(0, 10);
      computeEnd();
    }
  }

  function inp(path, label, opts) {
    opts = opts || {};
    var v = get(path);
    var id = 'n_' + path.replace(/\W/g, '_');
    var hint = opts.hint ? '<span class="h">' + opts.hint + '</span>' : '';
    var field;
    if (opts.type === 'textarea') field = '<textarea id="' + id + '" data-p="' + path + '" rows="' + (opts.rows || 3) + '">' + esc(v) + '</textarea>';
    else if (opts.options) field = '<select id="' + id + '" data-p="' + path + '">' + opts.options.map(function (o) { return '<option' + (o === v ? ' selected' : '') + '>' + esc(o) + '</option>'; }).join('') + '</select>';
    else field = '<input id="' + id + '" data-p="' + path + '" type="' + (opts.type || 'text') + '" value="' + esc(v) + '"' + (opts.inputmode ? ' inputmode="' + opts.inputmode + '"' : '') + (opts.placeholder ? ' placeholder="' + esc(opts.placeholder) + '"' : '') + '>';
    return '<label class="f"><span class="l">' + esc(label) + '</span>' + field + hint + '</label>';
  }
  function get(path) {
    var v = path.split('.').reduce(function (o, k) { return o == null ? undefined : o[k]; }, form);
    return v == null ? '' : v;
  }
  function set(path, v) {
    var ks = path.split('.'), o = form;
    for (var i = 0; i < ks.length - 1; i++) o = o[ks[i]];
    o[ks[ks.length - 1]] = v;
  }

  function bondHint() {
    var r = ESign.moneyNum(form.terms.rentPerWeek);
    return r > 0 ? 'Maximum 4 weeks\' rent: $' + ESign.money(r * 4) : 'Up to 4 weeks\' rent.';
  }

  function renderNew() {
    header('New agreement');
    if (!form) form = blankForm();
    var h = '';
    if (!ESignApi.live) {
      h += '<div class="card"><h2>Quick fill</h2><p class="small muted">Demo only: in live use, Tenant Management fills this from the approved group and the property.</p>' +
        '<label class="f"><span class="l">Approved group</span><select id="pickGroup"><option value="">Choose a group...</option>' +
        DemoData.groups.map(function (g) { return '<option value="' + esc(g.key) + '"' + (form.source && form.source.groupKey === g.key ? ' selected' : '') + '>' + esc(g.label) + '</option>'; }).join('') +
        '</select></label></div>';
    }
    h += '<div class="card"><h2>&#127968; Property and landlord</h2>' +
      inp('propertyAddress', 'Rental address', { placeholder: 'Street, suburb' }) +
      '<div class="grid2">' + inp('landlord.name', 'Landlord name') + inp('landlord.signerName', 'Signs as') + '</div>' +
      inp('landlord.email', 'Landlord email', { type: 'email', hint: 'The landlord signs last, using a link sent here.' }) +
      '<div class="grid2">' + inp('landlord.phone', 'Landlord phone', { type: 'tel' }) + inp('landlord.mobile', 'Landlord mobile', { type: 'tel' }) + '</div>' +
      inp('landlord.addressForService', 'Landlord address for service', { type: 'textarea', rows: 2 }) + '</div>';

    h += '<div class="card"><h2>&#128176; Rent, bond and dates</h2>' +
      '<div class="grid2">' + inp('terms.rentPerWeek', 'Rent per week ($)', { inputmode: 'decimal' }) + inp('terms.bond', 'Bond ($)', { inputmode: 'decimal', hint: '<span id="bondHint">' + esc(bondHint()) + '</span>' }) + '</div>' +
      '<div class="grid2">' + inp('terms.startDate', 'Start date', { type: 'date' }) + inp('terms.length', 'Length of tenancy', { options: ['12 months', '6 months', 'Periodic', 'Fixed term (other)'] }) + '</div>' +
      '<div class="grid2">' + inp('terms.endDate', 'End date', { type: 'date', hint: 'Start + length - 1 day. Blank = periodic.' }) + inp('terms.maxOccupants', 'Maximum occupants', { inputmode: 'numeric' }) + '</div>' +
      inp('terms.rentPaymentDetails', 'How rent is paid', { type: 'textarea', rows: 2 }) +
      inp('terms.chattels', 'Chattels', { type: 'textarea', rows: 2 }) + '</div>';

    h += '<div class="card"><h2>&#128220; Statements</h2>' +
      '<div class="grid2">' + inp('terms.insurer', 'Insurer', { hint: 'Or "Not insured"' }) + inp('terms.insurancePolicy', 'Policy') + '</div>' +
      '<div class="grid2">' + inp('terms.excess', 'Insurance excess ($)', { inputmode: 'decimal' }) + inp('terms.insulationDate', 'Insulation inspected', { type: 'date' }) + '</div>' +
      inp('terms.insulationStatement', 'Insulation statement', { type: 'textarea', hint: 'Where the insulation is, its type and condition.' }) +
      inp('terms.healthyHomesStatement', 'Healthy homes statement', { type: 'textarea', rows: 4 }) +
      inp('terms.pets', 'Pets', { placeholder: 'No pets are allowed without the landlord\'s written consent.' }) +
      inp('terms.additionalTerms', 'Other terms (optional)', { type: 'textarea', rows: 2 }) + '</div>';

    h += '<div class="card"><h2>&#128101; Tenants, in signing order</h2><p class="small muted">Tenant 1 signs first, then the others in order. The landlord signs last. Each person needs their own email.</p>';
    form.tenants.forEach(function (t, i) {
      h += '<div class="party" style="background:#f8fafb;border-radius:12px;padding:12px;margin-bottom:10px"><div class="row" style="margin-bottom:6px"><b class="grow">Tenant ' + (i + 1) + '</b>' +
        (i > 0 ? '<button class="btn small ghost" data-up="' + i + '" type="button" aria-label="Move up">&#8593;</button>' : '') +
        (form.tenants.length > 1 ? '<button class="btn small danger" data-rm="' + i + '" type="button">Remove</button>' : '') + '</div>' +
        inp('tenants.' + i + '.name', 'Full name') +
        '<div class="grid2">' + inp('tenants.' + i + '.email', 'Email', { type: 'email' }) + inp('tenants.' + i + '.mobile', 'Mobile', { type: 'tel' }) + '</div>' +
        '<div class="grid2">' + inp('tenants.' + i + '.idType', 'ID type', { options: ['Driver licence', 'Passport', 'Other photo ID'] }) + inp('tenants.' + i + '.idNumber', 'ID number') + '</div>' +
        inp('tenants.' + i + '.dob', 'Date of birth', { type: 'date', hint: 'Used to pre-fill "Under 18". Not shown on the agreement.' }) + '</div>';
    });
    if (form.tenants.length < 5) h += '<button class="btn light block" id="addTenant" type="button">+ Add tenant</button>';
    h += '</div><div id="newErrs"></div>' +
      '<div class="btn-row" style="margin-bottom:10px"><button class="btn ghost" id="previewBtn">Preview</button><button class="btn" id="sendBtn">Send for signing</button></div>' +
      '<button class="btn link small" id="clearForm">Clear the form</button>';
    app.innerHTML = h;

    $all('[data-p]').forEach(function (el) {
      el.addEventListener('input', function () {
        set(el.dataset.p, el.value);
        if (el.dataset.p === 'terms.rentPerWeek') $('#bondHint').textContent = bondHint();
      });
      el.addEventListener('change', function () {
        set(el.dataset.p, el.value);
        if (el.dataset.p === 'terms.startDate' || el.dataset.p === 'terms.length') { computeEnd(); $('#n_terms_endDate').value = form.terms.endDate; }
      });
    });
    var pg = $('#pickGroup');
    if (pg) pg.addEventListener('change', function () {
      var g = DemoData.groups.filter(function (x) { return x.key === pg.value; })[0];
      if (g) { applyGroup(g); renderNew(); }
    });
    $all('[data-rm]').forEach(function (b) { b.addEventListener('click', function () { form.tenants.splice(+b.dataset.rm, 1); renderNew(); }); });
    $all('[data-up]').forEach(function (b) {
      b.addEventListener('click', function () { var i = +b.dataset.up, t = form.tenants[i]; form.tenants[i] = form.tenants[i - 1]; form.tenants[i - 1] = t; renderNew(); });
    });
    var at = $('#addTenant');
    if (at) at.addEventListener('click', function () { form.tenants.push({ name: '', email: '', mobile: '', idType: 'Driver licence', idNumber: '', dob: '' }); renderNew(); });
    $('#clearForm').addEventListener('click', function () { if (confirm('Clear everything in this form?')) { form = blankForm(); renderNew(); } });
    $('#previewBtn').addEventListener('click', preview);
    $('#sendBtn').addEventListener('click', send);
  }

  function payload() {
    var t = form.terms;
    return {
      propertyAddress: form.propertyAddress, landlord: form.landlord, source: form.source,
      terms: {
        rentPerWeek: t.rentPerWeek, bond: t.bond, startDate: t.startDate, endDate: t.length === 'Periodic' ? '' : t.endDate,
        maxOccupants: t.maxOccupants, rentPaymentDetails: t.rentPaymentDetails, chattels: t.chattels, insurer: t.insurer,
        insurancePolicy: t.insurancePolicy, excess: t.excess, insulationDate: t.insulationDate, insulationStatement: t.insulationStatement,
        healthyHomesStatement: t.healthyHomesStatement, pets: t.pets, additionalTerms: t.additionalTerms
      },
      tenants: form.tenants
    };
  }

  function showErrs(errors, warnings) {
    $('#newErrs').innerHTML = (errors && errors.length ? '<div class="err">' + esc(errors.join('\n')) + '</div>' : '') +
      (warnings && warnings.length ? '<div class="warn">' + esc(warnings.join(' ')) + '</div>' : '');
  }

  function preview() {
    var b = $('#previewBtn');
    UI.busy(b, true, 'Preparing...');
    ESignApi.call('admin.preview', { input: payload() }).then(function (r) {
      UI.busy(b, false);
      showErrs(r.errors, r.warnings);
      var m = UI.modal((r.errors.length ? '<div class="err">Fix these before sending:\n' + esc(r.errors.join('\n')) + '</div>' : '') + '<iframe title="Preview"></iframe>', { title: 'Preview (unsigned)', wide: true });
      $('iframe', m.el).srcdoc = r.html;
    }).catch(function (e) { UI.busy(b, false); UI.toast(e.message, 'error'); });
  }

  function send() {
    var b = $('#sendBtn');
    var local = ESign.validateCreate(payload(), new Date().toISOString().slice(0, 10));
    if (local.errors.length) { showErrs(local.errors, local.warnings); $('#newErrs').scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
    var names = form.tenants.map(function (t, i) { return (i + 1) + '. ' + t.name; }).join('\n');
    if (!confirm('Send for signing?\n\n' + names + '\n' + (form.tenants.length + 1) + '. ' + (form.landlord.signerName || form.landlord.name) + ' (landlord)\n\n' + form.tenants[0].name + ' will be emailed first. The terms are locked once sent.')) return;
    UI.busy(b, true, 'Sending...');
    ESignApi.call('admin.create', { input: payload() }).then(function (r) {
      form = null;
      UI.toast('Sent. ' + r.agreement.signers[0].name + ' has been emailed a signing link.', 'ok');
      if (r.firstLink) UI.modal('<div class="warn">The email couldn\'t be sent. Send this link to ' + esc(r.agreement.signers[0].name) + ' another way:</div><textarea readonly rows="4">' + esc(r.firstLink) + '</textarea>', { title: 'Email failed' });
      tab = 'list';
      $all('#tabbar button').forEach(function (x) { x.classList.toggle('on', x.dataset.tab === 'list'); });
      detailId = r.agreement.id;
      render();
    }).catch(function (e) { UI.busy(b, false); showErrs([e.message]); $('#newErrs').scrollIntoView({ behavior: 'smooth', block: 'center' }); });
  }

  /* ---------- outbox (demo) ---------- */

  function renderOutbox() {
    header('Demo outbox', 'Emails that would have been sent');
    var list = DemoBackend.outbox();
    outboxSeen = list.length;
    try { localStorage.setItem('esign-outbox-seen', String(outboxSeen)); } catch (e) { /* ignore */ }
    updateBadges();
    var h = '<div class="info small">Demo mode sends no real email. Messages appear here instead. Open a signing link to sign as that person. ' +
      'To try it on your phone, open this site on the phone and send the agreement from there (the demo data lives in each browser).</div>';
    if (!list.length) h += '<div class="card center muted">Nothing sent yet.</div>';
    list.forEach(function (m, i) {
      var icon = { invite: '&#9993;&#65039;', code: '&#128273;', completed: '&#9989;', cancelled: '&#128683;', notice: '&#128276;', webhook: '&#128279;' }[m.kind] || '&#9993;&#65039;';
      h += '<div class="card mail ' + esc(m.kind) + '"><div class="row"><div class="grow"><div><b>' + icon + ' ' + esc(m.subject) + '</b></div>' +
        '<div class="small muted">To ' + esc(m.to) + ' &middot; ' + esc(UI.whenLong(m.at)) + '</div></div></div>' +
        (m.code ? '<div style="font-size:26px;font-weight:800;letter-spacing:5px;margin-top:6px">' + esc(m.code) + '</div>' : '') +
        (m.link ? '<div class="btn-row" style="margin-top:10px"><a class="btn small" target="_blank" href="' + esc(m.link) + '">Open signing link</a><button class="btn small ghost" data-copy="' + i + '">Copy link</button></div>' : '') +
        (m.attachFinal ? '<div class="small" style="margin-top:6px">&#128206; Signed agreement attached</div>' : '') +
        '<details style="margin-top:6px"><summary class="small muted" style="cursor:pointer">Show message</summary><pre>' + esc(m.text) + '</pre></details></div>';
    });
    if (list.length) h += '<button class="btn link small" id="clearOutbox">Clear the outbox</button>';
    app.innerHTML = h;
    $all('[data-copy]').forEach(function (b) { b.addEventListener('click', function () { UI.copy(list[+b.dataset.copy].link).then(function () { UI.toast('Copied', 'ok'); }); }); });
    var c = $('#clearOutbox'); if (c) c.addEventListener('click', function () { DemoBackend.clearOutbox(); outboxSeen = 0; try { localStorage.setItem('esign-outbox-seen', '0'); } catch (e) { /* */ } renderOutbox(); });
  }

  /* ---------- settings ---------- */

  function renderSettings() {
    header('Setup');
    var h = '<div class="card"><h2>You</h2>' +
      '<label class="f"><span class="l">Your name</span><input id="actor" value="' + esc(ESignApi.getActor()) + '" placeholder="e.g. Sam"><span class="h">Recorded in the audit trail when you send, resend or cancel.</span></label></div>';
    h += '<div class="card"><h2>Connection</h2>';
    if (ESignApi.live) {
      h += '<p class="small">Live mode. Server: <span class="mono">' + esc(window.ESIGN_CONFIG.apiUrl) + '</span></p>' +
        '<label class="f"><span class="l">Admin key</span><input id="adminKey" type="password" value="' + esc(ESignApi.getAdminKey()) + '" autocomplete="off"><span class="h">From the Apps Script log after running setup(). Stored only on this device.</span></label>' +
        '<button class="btn ghost small" id="testConn">Test connection</button>';
    } else {
      h += '<p class="small"><span class="pill amber">Demo mode</span> Everything runs in this browser with invented data. No emails are sent.</p>' +
        '<p class="small muted">To go live, deploy the Apps Script backend and put its URL in <span class="mono">js/config.js</span>. See the README.</p>' +
        '<button class="btn danger small" id="resetDemo">Reset demo data</button>';
    }
    h += '</div><div class="card"><h2>How signing is traced</h2><ul class="small" style="padding-left:18px;margin:0">' +
      '<li>Terms are locked and fingerprinted (SHA-256) when sent.</li>' +
      '<li>Each signer gets a private link, agrees to sign electronically and proves their email with a one-time code.</li>' +
      '<li>They must scroll to the end, confirm their details, draw a signature and type their full name.</li>' +
      '<li>Every step is written to a hash-chained audit trail with the time, device and reported IP address.</li>' +
      '<li>The signed document carries a signing certificate, its fingerprint is emailed to everyone, and anyone can check a copy on the Verify page.</li></ul></div>' +
      '<p class="small muted center">Tenancy e-sign v' + esc(ESign.VERSION) + '</p>';
    app.innerHTML = h;
    $('#actor').addEventListener('change', function () { ESignApi.setActor(this.value.trim()); UI.toast('Saved', 'ok'); });
    var k = $('#adminKey'); if (k) k.addEventListener('change', function () { ESignApi.setAdminKey(this.value.trim()); UI.toast('Saved', 'ok'); });
    var t = $('#testConn'); if (t) t.addEventListener('click', function () {
      UI.busy(t, true, 'Testing...');
      ESignApi.call('admin.list').then(function (l) { UI.busy(t, false); UI.toast('Connected. ' + l.length + ' agreements.', 'ok'); }).catch(function (e) { UI.busy(t, false); UI.toast(e.message, 'error'); });
    });
    var r = $('#resetDemo'); if (r) r.addEventListener('click', function () {
      if (!confirm('Delete all demo agreements and the outbox from this browser?')) return;
      DemoBackend.reset(); outboxSeen = 0; try { localStorage.setItem('esign-outbox-seen', '0'); } catch (e) { /* */ }
      UI.toast('Demo data cleared.', 'ok'); go('list');
    });
  }

  // Refresh when coming back to this tab (e.g. after signing in another tab).
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && (tab === 'list' || tab === 'outbox' || detailId)) render();
  });

  render();
})();
