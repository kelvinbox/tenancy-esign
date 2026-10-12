/*
 * Signer page. Steps: 1 Start (consent) -> 2 Verify email -> 3 Read -> 4 Your details -> 5 Sign.
 * Every step is recorded by the server in the audit trail.
 */
(function () {
  'use strict';
  var $ = UI.$, esc = UI.esc;
  var token = new URLSearchParams(location.search).get('t') || '';
  var view = null, step = 'start', pad = null, readStart = 0, details = {};
  var submissionId = 'sub-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  var app = $('#app'), bar = $('#bar'), barInner = $('#barInner');
  var STEPS = ['start', 'verify', 'read', 'details', 'sign'];
  var STEP_LABEL = { start: 'Step 1 of 5: Before you start', verify: 'Step 2 of 5: Check it\'s you', read: 'Step 3 of 5: Read the agreement', details: 'Step 4 of 5: Your details', sign: 'Step 5 of 5: Sign' };

  if (!ESignApi.live) $('#demoBadge').hidden = false;
  ESignApi.warmUp();

  function setBar(html) {
    if (!html) { bar.hidden = true; barInner.innerHTML = ''; return; }
    bar.hidden = false; barInner.innerHTML = html;
  }

  function stepsHtml() {
    var i = STEPS.indexOf(step);
    return '<div class="steps">' + STEPS.map(function (s, n) { return '<div class="s ' + (n < i ? 'done' : n === i ? 'cur' : '') + '"></div>'; }).join('') +
      '</div><div class="step-label">' + esc(STEP_LABEL[step]) + '</div>';
  }

  function showError(e, btn) {
    UI.busy(btn, false);
    var code = e && e.code;
    if (code === 'REVERIFY') { UI.toast(e.message, 'error'); step = 'verify'; render(); return; }
    if (code === 'STALE' || code === 'CANCELLED' || code === 'DECLINED' || code === 'EXPIRED' || code === 'DONE' || code === 'NOT_YOUR_TURN') { load(); UI.toast(e.message, 'error'); return; }
    UI.toast(e && e.message ? e.message : 'Something went wrong. Please try again.', 'error');
  }

  function firstName() { return String(view.me.name || '').split(' ')[0]; }

  /* ---------- loading ---------- */

  function load() {
    if (!token || token.length < 20) { fatal('This link is incomplete', 'Open the link again from your email or text message. If it still doesn\'t work, ask the landlord to send a new one.'); return; }
    ESignApi.signerCall('sign.open', { token: token }).then(function (v) {
      view = v;
      $('#hdrSub').textContent = v.agreement.propertyAddress;
      if (v.agreement.kind === 'variation') $('.hdr h1').textContent = 'Tenancy variation';
      details = Object.assign({}, v.me.details);
      if (!v.me.consentAt) step = 'start';
      else if (!v.me.verified) step = 'verify';
      else if (!v.me.reviewedAt) step = 'read';
      else step = 'details';
      render();
    }).catch(function (e) {
      fatal('This link can\'t be used', e.message);
    });
  }

  function fatal(title, msg) {
    $('#hdrSub').textContent = '';
    setBar('');
    app.innerHTML = '<div class="card state"><div class="big">&#128279;</div><h2>' + esc(title) + '</h2><p class="muted">' + esc(msg) + '</p></div>';
  }

  /* ---------- rendering ---------- */

  /** The landlord's logo (when they've uploaded one) replaces the pen icon in the header. */
  function showLogo() {
    var b = view && view.brand, tile = document.querySelector('.hdr .tile');
    if (!b || !b.logo || !tile || tile.getAttribute('data-logo')) return;
    tile.setAttribute('data-logo', '1');
    tile.className = 'hdr-logo';
    tile.removeAttribute('style');
    tile.innerHTML = '<img alt="' + esc(b.name || '') + '" src="' + esc(b.logo) + '">';
  }

  function render() {
    window.scrollTo(0, 0);
    showLogo();
    var a = view.agreement, me = view.me;
    if (me.status === 'Signed') return renderDone();
    if (a.status === 'Cancelled') return renderClosed('&#128683;', 'This agreement was cancelled', view.ownerName + ' cancelled this agreement, so it can\'t be signed. If a new version is needed, you\'ll get a new link.');
    if (a.status === 'Declined') return renderClosed('&#9995;', 'This agreement was declined', 'Someone declined to sign this agreement, so it can\'t be signed. ' + view.ownerName + ' will be in touch.');
    if (a.status === 'Expired') return renderClosed('&#8987;', 'This link has expired', 'Ask ' + view.ownerName + ' to send the agreement again.');
    if (view.waitingFor) {
      return renderClosed('&#9203;', 'It\'s not your turn yet', 'Everyone signs one after another. We\'re waiting for ' + view.waitingFor.name + ' (' + view.waitingFor.roleLabel + '). We\'ll email you when it\'s your turn.', true);
    }
    ({ start: renderStart, verify: renderVerify, read: renderRead, details: renderDetails, sign: renderSign })[step]();
  }

  function signersList() {
    return '<ul class="signers">' + view.signers.map(function (s, i) {
      var cls = s.status === 'Signed' ? 'done' : s.isMe ? 'me' : '';
      var right = s.status === 'Signed' ? '<span class="pill green">Signed ' + esc(UI.when(s.signedAt)) + '</span>' :
        s.isMe ? '<span class="pill teal">You</span>' : s.status === 'Declined' ? '<span class="pill red">Declined</span>' : '<span class="pill grey">Waiting</span>';
      return '<li><span class="num ' + cls + '">' + (s.status === 'Signed' ? '&#10003;' : i + 1) + '</span><div class="grow"><div><b>' + esc(s.name) + '</b></div><div class="small muted">' + esc(s.roleLabel) + '</div></div>' + right + '</li>';
    }).join('') + '</ul>';
  }

  function renderClosed(icon, title, msg, showSigners) {
    setBar('');
    app.innerHTML = '<div class="card state"><div class="big">' + icon + '</div><h2>' + esc(title) + '</h2><p class="muted">' + esc(msg) + '</p></div>' +
      (showSigners ? '<div class="card"><h2>Signing order</h2>' + signersList() + '</div>' : '');
  }

  function renderStart() {
    app.innerHTML = stepsHtml() +
      '<div class="card"><h2>Hi ' + esc(firstName()) + ' &#128075;</h2>' +
      '<p>' + esc(view.ownerName) + ' has sent you ' + esc(view.agreement.docLabel) + ' for <b>' + esc(view.agreement.propertyAddress) + '</b> to sign as <b>' + esc(view.me.roleLabel) + '</b>.</p>' +
      (view.agreement.changeSummary ? '<div class="info">' + esc(view.agreement.changeSummary) +
        (view.me.kind === 'incoming' ? ' You\'ll read the signed tenancy agreement you are joining before you sign. You won\'t be re-signing it: you sign a short variation that adds you to it.' :
          ' The rest of the agreement stays the same.') + '</div>' : '') +
      '<p class="muted small">It takes about 5 minutes. You\'ll check it\'s you with a code sent to your email, read the ' +
      (view.agreement.kind === 'variation' ? 'change' : 'agreement') + ', confirm your details, then sign with your finger.</p></div>' +
      '<div class="card"><h2>Signing order</h2><p class="small muted">Everyone signs one after another. The landlord signs last.</p>' + signersList() + '</div>' +
      '<div class="card"><h2>Signing electronically</h2>' +
      '<label class="check" id="consentBox"><input type="checkbox" id="consent"><span>' + esc(view.consentText) + '</span></label>' +
      '<button class="btn link small" id="declineBtn" type="button">I don\'t want to sign this</button></div>';
    setBar('<button class="btn block" id="go" disabled>Continue</button>');
    var cb = $('#consent'), go = $('#go');
    cb.addEventListener('change', function () { go.disabled = !cb.checked; $('#consentBox').classList.toggle('on', cb.checked); });
    $('#declineBtn').addEventListener('click', openDecline);
    go.addEventListener('click', function () {
      UI.busy(go, true, 'Saving...');
      ESignApi.signerCall('sign.consent', { token: token }).then(function (v) { view = v; step = 'verify'; render(); }).catch(function (e) { showError(e, go); });
    });
  }

  function renderVerify() {
    var sent = !!view.me.codeSentAt;
    app.innerHTML = stepsHtml() +
      '<div class="card"><h2>Check it\'s you</h2>' +
      '<p>We\'ll email a 6-digit code to <b>' + esc(view.me.emailMasked) + '</b>. This proves the person signing controls that email address.</p>' +
      '<div id="codeArea"' + (sent ? '' : ' hidden') + '>' +
      '<label class="f"><span class="l">Enter the code</span><input id="code" class="otp" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]*" placeholder="------"></label>' +
      '<div id="demoCode"></div>' +
      '<button class="btn link small" id="resend" type="button">Send a new code</button>' +
      '</div></div>' +
      '<p class="small muted center">Can\'t get the email? Check your junk folder, or contact ' + esc(view.ownerName) + '.</p>';
    function showSendBar() {
      setBar('<button class="btn block" id="send">Email me a code</button>');
      $('#send').addEventListener('click', function () { sendCode($('#send')); });
    }
    function showVerifyBar() {
      setBar('<button class="btn block" id="verify" disabled>Verify</button>');
      var input = $('#code'), btn = $('#verify');
      input.addEventListener('input', function () {
        input.value = input.value.replace(/\D/g, '').slice(0, 6);
        btn.disabled = input.value.length !== 6;
        if (input.value.length === 6) btn.click();
      });
      btn.addEventListener('click', function () {
        if (btn.disabled && input.value.length !== 6) return;
        UI.busy(btn, true, 'Checking...');
        ESignApi.signerCall('sign.verifyCode', { token: token, code: input.value }).then(function (v) {
          view = v; step = 'read'; UI.toast('Thanks, that\'s verified.', 'ok'); render();
        }).catch(function (e) { input.value = ''; input.focus(); showError(e, btn); btn.disabled = true; });
      });
      setTimeout(function () { input.focus(); }, 50);
    }
    function sendCode(btn) {
      UI.busy(btn, true, 'Sending...');
      ESignApi.signerCall('sign.sendCode', { token: token }).then(function (r) {
        UI.busy(btn, false);
        UI.toast('Code sent to ' + r.sentTo + '. It lasts ' + r.expiresInMinutes + ' minutes.', 'ok');
        $('#codeArea').hidden = false;
        showDemoCode();
        showVerifyBar();
      }).catch(function (e) { showError(e, btn); });
    }
    function showDemoCode() {
      if (ESignApi.live || !window.DemoBackend) return;
      var c = DemoBackend.latestCodeFor();
      if (c) $('#demoCode').innerHTML = '<div class="info"><b>Demo mode:</b> no real email is sent. The code "emailed" to ' + esc(c.to) + ' is <b style="font-size:18px;letter-spacing:2px">' + esc(c.code) + '</b></div>';
    }
    $('#resend').addEventListener('click', function () { sendCode($('#resend')); });
    if (sent) { showDemoCode(); showVerifyBar(); } else showSendBar();
  }

  /** The sections; a signed document a joining tenant is agreeing to goes in its own bordered box under a bold header. */
  function sectionsHtml(list) {
    var h = '', cur = null;
    list.forEach(function (s) {
      var r = s.ref ? s.ref.id : null;
      if (r !== cur) {
        if (cur) h += '</div>';
        if (r) h += '<div class="refdoc"><div class="refdoc-h"><div class="refdoc-t">' + esc(s.ref.label) + '</div><div class="refdoc-s">' + esc(s.ref.signed) +
          '. Read only: you are not re-signing it.</div><div class="refdoc-id">' + esc(s.ref.docId) + (s.ref.sha256 ? ' &middot; SHA-256 ' + esc(s.ref.sha256) : '') + '</div></div>';
        cur = r;
      }
      h += '<details open data-sec="' + esc(s.id) + '"><summary><span class="tick">&#10003;</span><span>' + esc(s.heading) + '</span><span class="chev">&#8250;</span></summary><div class="sec-body">' + s.html + '</div></details>';
    });
    return h + (cur ? '</div>' : '');
  }

  function renderRead() {
    var d = view.document;
    readStart = Date.now();
    app.innerHTML = stepsHtml() +
      '<div class="info small">Read each section. The <span class="fv">highlighted</span> parts are filled in for this tenancy. Tap a heading to fold it away.</div>' +
      '<div class="card doc">' + (d.brand || '') + '<h2 class="doc-title">' + esc(d.title) + '</h2><div class="doc-sub">' + esc(d.subtitle) + ' &middot; ' + esc(view.agreement.id) + '</div>' +
      (d.keyDetails || '') + '<p>' + d.intro + '</p>' +
      sectionsHtml(d.sections) +
      (d.footer || '') + '<div class="end-marker" id="endMarker">&#8212; End of agreement &#8212;</div></div>' +
      attachmentsCard() +
      '<div class="card small"><b>Something not right?</b> If any of the terms are wrong, don\'t sign. <button class="btn link small" id="declineBtn" type="button">Tell the landlord and decline</button></div>';
    setBar('<div class="grow hint" id="readHint">Scroll to the end to continue</div><button class="btn" id="go" disabled>I\'ve read it</button>');
    var go = $('#go');
    $('#declineBtn').addEventListener('click', openDecline);

    UI.$all('[data-att]', app).forEach(function (b) {
      b.addEventListener('click', function () {
        UI.busy(b, true, 'Opening...');
        ESignApi.signerCall('sign.attachment', { token: token, id: b.dataset.att }).then(function (f) { UI.busy(b, false); UI.downloadB64(f); }).catch(function (e) { showError(e, b); });
      });
    });
    var secs = UI.$all('details[data-sec]');
    function markSeen() {
      var vh = window.innerHeight;
      secs.forEach(function (el) { if (el.getBoundingClientRect().top < vh * 0.8) el.classList.add('seen'); });
    }
    function reached() {
      go.disabled = false;
      $('#readHint').textContent = 'Thanks for reading it all.';
      secs.forEach(function (el) { el.classList.add('seen'); });
    }
    function onScroll() {
      markSeen();
      var r = $('#endMarker').getBoundingClientRect();
      if (r.top < window.innerHeight - 40) reached();
      else {
        var total = document.documentElement.scrollHeight - window.innerHeight;
        var pct = total > 0 ? Math.round(window.scrollY / total * 100) : 100;
        if (go.disabled) $('#readHint').textContent = 'Scroll to the end to continue (' + pct + '%)';
      }
    }
    window.addEventListener('scroll', onScroll, { passive: true });
    UI.$all('details').forEach(function (d) { d.addEventListener('toggle', onScroll); });
    onScroll();

    go.addEventListener('click', function () {
      UI.busy(go, true, 'Saving...');
      ESignApi.signerCall('sign.reviewed', { token: token, info: { termsHash: view.termsHash, secondsOnPage: Math.round((Date.now() - readStart) / 1000) } })
        .then(function (v) { window.removeEventListener('scroll', onScroll); view = v; step = 'details'; render(); })
        .catch(function (e) { showError(e, go); });
    });
  }

  /* files that form part of the agreement, e.g. the body corporate rules */
  function attachmentsCard() {
    var list = view.attachments || [];
    if (!list.length) return '';
    return '<div class="card"><h2>Attached documents</h2><p class="small muted">These form part of the agreement. Open and read them before you sign.</p>' +
      list.map(function (a) { return '<button class="btn light block" type="button" style="margin-top:8px" data-att="' + esc(a.id) + '">&#128196; ' + esc(a.label) + ': ' + esc(a.name) + '</button>'; }).join('') + '</div>';
  }

  function fieldHtml(f) {
    var v = details[f.key] || '';
    var id = 'f_' + f.key;
    var hint = f.hint ? '<span class="h">' + esc(f.hint) + '</span>' : '';
    var input;
    if (f.type === 'textarea') {
      input = '<textarea id="' + id + '" data-k="' + f.key + '" rows="2" autocomplete="street-address">' + esc(v) + '</textarea>' +
        (f.quick === 'property' ? '<button type="button" class="btn light small" style="margin-top:6px" id="useProp">Use the rental address</button>' : '');
    } else if (f.type === 'select') {
      input = '<select id="' + id + '" data-k="' + f.key + '"><option value="">Choose...</option>' + f.options.map(function (o) {
        return '<option' + (o === v ? ' selected' : '') + '>' + esc(o) + '</option>';
      }).join('') + '</select>';
    } else if (f.type === 'radio') {
      return '<div class="f" style="margin-bottom:14px"><span class="l" style="display:block;font-weight:600;font-size:14px;margin-bottom:5px">' + esc(f.label) + '</span><div class="seg" data-k="' + f.key + '">' +
        f.options.map(function (o) { return '<label class="' + (o === v ? 'on' : '') + '"><input type="radio" name="' + id + '" value="' + esc(o) + '"' + (o === v ? ' checked' : '') + '>' + esc(o) + '</label>'; }).join('') +
        '</div>' + hint + '</div>';
    } else {
      var auto = { name: 'name', mobile: 'tel', email: 'email', dob: 'bday' }[f.key] || 'off';
      input = '<input id="' + id + '" data-k="' + f.key + '" type="' + (f.type || 'text') + '" value="' + esc(v) + '" autocomplete="' + auto + '"' + (f.readonly ? ' readonly' : '') + '>';
    }
    return '<label class="f" for="' + id + '"><span class="l">' + esc(f.label) + (f.required || f.readonly ? '' : ' <span class="muted">(optional)</span>') + '</span>' + input + hint + '</label>';
  }

  function readDetails() {
    UI.$all('[data-k]', app).forEach(function (el) {
      if (el.classList.contains('seg')) {
        var c = el.querySelector('input:checked');
        details[el.dataset.k] = c ? c.value : '';
      } else details[el.dataset.k] = el.value.trim();
    });
  }

  function renderDetails() {
    app.innerHTML = stepsHtml() +
      '<div class="card"><h2>Your details</h2><p class="small muted">These go into the agreement next to your signature. Check them and fix anything that\'s wrong.</p>' +
      '<div id="errs"></div>' + view.fields.map(fieldHtml).join('') + '</div>';
    setBar('<button class="btn ghost" id="back">Back</button><button class="btn grow" id="go">Continue</button>');
    var up = $('#useProp');
    if (up) up.addEventListener('click', function () { $('#f_addressForService').value = view.agreement.propertyAddress; });
    UI.$all('.seg', app).forEach(function (seg) {
      seg.addEventListener('change', function () {
        UI.$all('label', seg).forEach(function (l) { l.classList.toggle('on', l.querySelector('input').checked); });
      });
    });
    $('#back').addEventListener('click', function () { readDetails(); step = 'read'; render(); });
    $('#go').addEventListener('click', function () {
      readDetails();
      var r = ESign.validateDetails(view.me.kind, details, view.me.details);
      UI.$all('.invalid', app).forEach(function (el) { el.classList.remove('invalid'); });
      if (r.errors.length) {
        $('#errs').innerHTML = '<div class="err">' + esc(r.errors.join('\n')) + '</div>';
        view.fields.forEach(function (f) { if (f.required && !details[f.key]) { var el = $('#f_' + f.key); if (el) el.classList.add('invalid'); } });
        window.scrollTo(0, 0);
        return;
      }
      step = 'sign'; render();
    });
  }

  function renderSign() {
    var rows = view.fields.filter(function (f) { return f.key !== 'email'; }).map(function (f) {
      var v = details[f.key] || '';
      if (f.type === 'date' && v) v = ESign.longDate(v);
      return '<tr><th>' + esc(f.label) + '</th><td>' + esc(v || '-') + '</td></tr>';
    }).join('');
    app.innerHTML = stepsHtml() +
      '<div class="card doc"><h2>Your details</h2><table class="kv">' + rows + '</table><button class="btn link small" id="edit" type="button">Change</button></div>' +
      '<div class="card"><h2>Sign</h2>' +
      '<p class="small muted">Sign in the box with your finger (or mouse). Turn your phone sideways for more room.</p>' +
      '<div class="pad-wrap" id="pad"><canvas></canvas><div class="pad-line"></div><div class="pad-x">&#10005;</div><div class="pad-hint">Sign here</div></div>' +
      '<div class="pad-tools"><button class="btn link small" id="undo" type="button">Undo</button><button class="btn link small" id="clear" type="button">Clear</button></div>' +
      '<label class="f" style="margin-top:12px"><span class="l">Type your full name</span><input id="typed" type="text" autocomplete="off" autocapitalize="words" placeholder="' + esc(details.name) + '"><span class="h">Must match: ' + esc(details.name) + '</span></label>' +
      (view.declarationText ? '<label class="check" id="declareBox"><input type="checkbox" id="declare"><span>' + esc(view.declarationText) + '</span></label>' : '') +
      '<label class="check" id="agreeBox"><input type="checkbox" id="agree"><span>' + esc(view.agreeText) + '</span></label>' +
      '</div>';
    setBar('<button class="btn block" id="go" disabled>&#9997;&#65039; Sign the agreement</button>');
    var go = $('#go'), typed = $('#typed'), agree = $('#agree'), declare = $('#declare');
    function check() {
      var ok = pad && !pad.isEmpty() && ESign.normName(typed.value) === ESign.normName(details.name) && agree.checked && (!declare || declare.checked);
      go.disabled = !ok;
      $('#agreeBox').classList.toggle('on', agree.checked);
      if (declare) $('#declareBox').classList.toggle('on', declare.checked);
    }
    pad = SignaturePad($('#pad'), check);
    $('#undo').addEventListener('click', function () { pad.undo(); });
    $('#clear').addEventListener('click', function () { pad.clear(); });
    typed.addEventListener('input', check);
    agree.addEventListener('change', check);
    if (declare) declare.addEventListener('change', check);
    $('#edit').addEventListener('click', function () { step = 'details'; render(); });
    go.addEventListener('click', function () {
      if (go.disabled) return;
      UI.busy(go, true, 'Signing...');
      ESignApi.signerCall('sign.submit', {
        token: token,
        payload: {
          details: details, typedName: typed.value.trim(), agree: true, declare: !!(declare && declare.checked), termsHash: view.termsHash,
          signaturePng: pad.toPng(), strokes: pad.stats(), submissionId: submissionId
        }
      }).then(function (v) { view = v; render(); }).catch(function (e) { showError(e, go); });
    });
  }

  function renderDone() {
    var a = view.agreement, me = view.me;
    var complete = a.status === 'Completed';
    app.innerHTML = '<div class="card state"><div class="big">&#9989;</div><h2>You\'ve signed</h2>' +
      '<p class="muted">Signed ' + esc(UI.whenLong(me.signedAt)) + '.<br>Reference ' + esc(a.id) + '</p></div>' +
      '<div class="card"><h2>' + (complete ? 'Everyone has signed' : 'What happens next') + '</h2>' +
      (complete ? '<p>The agreement is complete. A copy has been emailed to everyone with its signing certificate.</p>' +
        (a.finalSha256 ? '<p class="small muted">Document fingerprint (SHA-256):<br><span class="mono">' + esc(a.finalSha256) + '</span></p>' : '') :
        '<p>The others will now sign in order. When everyone has signed, you\'ll get an email with the signed agreement and its signing certificate.</p>') +
      signersList() + '</div>';
    if (complete) {
      setBar('<button class="btn block" id="dl">&#11015;&#65039; Download signed copy</button>');
      $('#dl').addEventListener('click', function () {
        var b = $('#dl');
        UI.busy(b, true, 'Preparing...');
        ESignApi.signerCall('sign.download', { token: token }).then(function (f) { UI.busy(b, false); UI.downloadB64(f); }).catch(function (e) { showError(e, b); });
      });
    } else setBar('');
  }

  function openDecline() {
    var m = UI.modal('<p>If something in the agreement is wrong, tell ' + esc(view.ownerName) + ' what needs to change. This stops the agreement for everyone, and a corrected one can be sent.</p>' +
      '<label class="f"><span class="l">What\'s wrong?</span><textarea id="why" rows="4" placeholder="For example: the start date should be 8 November"></textarea></label>' +
      '<div class="btn-row"><button class="btn ghost" data-close>Keep signing</button><button class="btn danger" id="doDecline">Decline to sign</button></div>', { title: 'Decline to sign' });
    $('#doDecline', m.el).addEventListener('click', function () {
      var b = $('#doDecline', m.el), why = $('#why', m.el).value.trim();
      if (!why) { $('#why', m.el).classList.add('invalid'); return; }
      UI.busy(b, true, 'Sending...');
      ESignApi.signerCall('sign.decline', { token: token, reason: why }).then(function (v) {
        m.close(); view = v; render(); UI.toast('You declined. ' + view.ownerName + ' has been told.');
      }).catch(function (e) { showError(e, b); });
    });
  }

  load();
})();
