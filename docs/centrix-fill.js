/* Fill Centrix (bookmarklet). Fills the Centrix Consumer Credit Report form from an applicant copied in Tenant
   Management (Credit check > Copy for Centrix). Each box is found by Centrix's own id (MainContent_...TextBox),
   else by the caption shown under it (Surname, DD, Suburb...),
   so it keeps working if Centrix renames its fields. Nothing is sent anywhere and GO is never pressed. */
(function () {
  var TAG = 'CENTRIX-FILL ', BG = '#fff3b0';
  function norm(s) { return String(s || '').replace(/[\u2018\u2019]/g, "'").replace(/[\s\u00a0]+/g, ' ').replace(/[*?:]+$/, '').trim().toLowerCase(); }
  function shown(el) { var r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !el.disabled && el.type !== 'hidden'; }
  function docs() {
    var out = [document];
    [].forEach.call(document.querySelectorAll('iframe,frame'), function (f) { try { if (f.contentDocument) out.push(f.contentDocument); } catch (e) {} });
    return out;
  }
  function fieldsOf(doc) {
    return [].filter.call(doc.querySelectorAll('input,select,textarea'), function (el) {
      return shown(el) && !/^(checkbox|radio|submit|button|image|reset|file)$/i.test(el.type || '');
    });
  }
  /* Elements whose own text is this caption, in page order (text starting with it when prefix is true) */
  function captions(doc, text, prefix) {
    var want = norm(text), out = [], w = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, null, false), n;
    while ((n = w.nextNode())) {
      var t = norm(n.nodeValue), p = n.parentElement;
      if (!t || !p || /^(SCRIPT|STYLE|OPTION)$/.test(p.tagName)) continue;
      if (prefix ? t.indexOf(want) === 0 : t === want) { var r = p.getBoundingClientRect(); if (r.width > 0) out.push(p); }
    }
    return out;
  }
  /* The box directly above a caption (captions sit under their box) */
  function above(cap, fields) {
    var c = cap.getBoundingClientRect(), best = null, bs = 1e9;
    fields.forEach(function (el) {
      var r = el.getBoundingClientRect(), gap = c.top - r.bottom;
      if (gap < -6 || gap > 45) return;
      if (c.left < r.left - 25 || c.left > r.right) return;
      var score = gap * 4 + Math.abs(c.left - r.left);
      if (score < bs) { bs = score; best = el; }
    });
    return best;
  }
  /* The box to the right of a label (for "Applicant's Email Address") */
  function beside(cap, fields) {
    var c = cap.getBoundingClientRect(), best = null, bs = 1e9;
    fields.forEach(function (el) {
      var r = el.getBoundingClientRect(), dy = Math.abs((r.top + r.bottom) / 2 - (c.top + c.bottom) / 2), dx = r.left - c.right;
      if (dx < -4 || dy > 30) return;
      var score = dx + dy * 4;
      if (score < bs) { bs = score; best = el; }
    });
    return best;
  }
  function setVal(el, v) {
    var proto = el.tagName === 'SELECT' ? HTMLSelectElement : el.tagName === 'TEXTAREA' ? HTMLTextAreaElement : HTMLInputElement;
    var d = Object.getOwnPropertyDescriptor(proto.prototype, 'value');
    if (d && d.set) d.set.call(el, v); else el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));   // no "change": a change can make the page post back mid-fill
    el.style.backgroundColor = BG;
  }
  function note(html) {
    var old = document.getElementById('centrixFillNote'); if (old) old.remove();
    var b = document.createElement('div'); b.id = 'centrixFillNote';
    b.style.cssText = 'position:fixed;top:12px;right:12px;z-index:2147483647;max-width:380px;background:#fff;color:#0f172a;border:2px solid #16a34a;' +
      'border-radius:12px;padding:12px 14px;font:14px/1.45 system-ui,Segoe UI,Arial,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.25)';
    b.innerHTML = html + '<div style="text-align:right;margin-top:8px"><button type="button" style="font:inherit;padding:4px 12px;border-radius:8px;border:1px solid #cbd5e1;background:#f8fafc;cursor:pointer">Close</button></div>';
    b.querySelector('button').onclick = function () { b.remove(); };
    document.body.appendChild(b);
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  function fill(d) {
    var plan = [   // [caption, value, which occurrence (0 = first), how]; each also has Centrix's own box id (below)
      ['Your Reference', d.reference, 0],
      ['Surname', d.surname, 0], ['First Name', d.firstName, 0], ['Middle Name', d.middleName, 0],
      ['DD', d.dobDay, 0], ['MM', d.dobMonth, 0], ['YYYY', d.dobYear, 0],
      ['Drivers Licence', d.licenceNumber, 0], ['Version', d.licenceVersion, 0],
      ["Applicant's Email", d.email, 0, 'beside'],
      ['First line of address', d.a1 && d.a1.line1, 0, 'prefix'], ['Second line of address', d.a1 && d.a1.line2, 0],
      ['Suburb', d.a1 && d.a1.suburb, 0], ['Town or City', d.a1 && d.a1.city, 0], ['Postcode', d.a1 && d.a1.postcode, 0],
      ['Years at Address', d.a1 && d.a1.years, 0],
      ['First line of address', d.a2 && d.a2.line1, 1, 'prefix'], ['Second line of address', d.a2 && d.a2.line2, 1],
      ['Suburb', d.a2 && d.a2.suburb, 1], ['Town or City', d.a2 && d.a2.city, 1], ['Postcode', d.a2 && d.a2.postcode, 1],
      ['Years at Address', d.a2 && d.a2.years, 1]
    ];
    ['SubscriberReference', 'FamilyName', 'FirstName', 'MiddleName', 'DayOfBirth', 'MonthOfBirth', 'YearOfBirth',
     'DriversLicense', 'Version', 'Email', 'CurrentAddressLine1', 'CurrentAddressLine2', 'CurrentAddressSuburb',
     'CurrentAddressCity', 'CurrentAddressPostcode', 'CurrentAddressYearsAtAddress', 'PreviousAddressLine1',
     'PreviousAddressLine2', 'PreviousAddressSuburb', 'PreviousAddressCity', 'PreviousAddressPostcode', 'PreviousAddressYearsAtAddress'].forEach(function (id, i) { plan[i].id = 'MainContent_' + id + 'TextBox'; });
    var filled = 0, missed = [];
    docs().forEach(function (doc) {
      var fields = fieldsOf(doc); if (!fields.length) return;
      plan.forEach(function (p) {
        if (p.done || p[1] === undefined || p[1] === null || String(p[1]) === '') return;
        var byId = doc.getElementById(p.id);   // Centrix's own ids first; captions if they ever change
        if (byId && shown(byId)) { setVal(byId, String(p[1])); p.done = true; filled++; return; }
        var how = p[3] || '', caps = captions(doc, p[0], how !== '');   // label text may run on ("...Email Address", "..., e.g. 23 Planet Road")
        var cap = caps[p[2]]; if (!cap) return;
        var el = how === 'beside' ? beside(cap, fields) : above(cap, fields);
        if (!el) return;
        setVal(el, String(p[1])); p.done = true; filled++;
      });
    });
    // report options (Y / N) and the court fines terms tick, as sent from Tenant Management
    var o = d.options || {}, set = [];
    [['IncludeCourtFinesDropDownList', o.courtFines, 'Court fines'], ['IncludePropertyOwnershipDropDownList', o.propertyOwnership, 'Property ownership']].forEach(function (x) {
      var el = document.getElementById('MainContent_' + x[0]);
      if (!x[1]) return;
      if (el && [].some.call(el.options, function (op) { return op.value === x[1]; })) { setVal(el, x[1]); el.dispatchEvent(new Event('change', { bubbles: true })); set.push(x[2] + ' ' + (x[1] === 'Y' ? 'Yes' : 'No')); }
      else missed.push(x[2] + ' option');
    });
    if (o.acceptTerms) {
      var cb = document.getElementById('MainContent_AcceptCourtFinesTermsCheckBox');
      if (cb) { if (!cb.checked) cb.click(); cb.style.outline = '3px solid ' + BG; set.push('terms ticked'); } else missed.push('accept terms tick');
    }
    plan.forEach(function (p) { if (!p.done && p[1] !== undefined && p[1] !== null && String(p[1]) !== '') missed.push((p[2] ? 'Address 2 ' : '') + p[0]); });
    note('<b>\u2713 Filled ' + filled + ' box' + (filled === 1 ? '' : 'es') + ' for ' + esc(d.fullName || 'the applicant') + '</b> (shaded yellow).' +
      (set.length ? '<div style="margin-top:6px">Report options: ' + esc(set.join(', ')) + '.</div>' : '') +
      (missed.length ? '<div style="margin-top:6px;color:#b45309">Couldn\u2019t find: ' + esc(missed.join(', ')) + '. Fill these in by hand.</div>' : '') +
      '<div style="margin-top:6px">Check the details and the report options, then press <b>GO</b>.</div>');
  }
  function use(txt) {
    var i = String(txt || '').indexOf(TAG);
    if (i < 0) { note('<b>Nothing to fill.</b> In Tenant Management open the application, then <b>Credit check</b> &gt; <b>Copy for Centrix</b>, and click this bookmark again.'); return; }
    var d; try { d = JSON.parse(String(txt).slice(i + TAG.length)); } catch (e) { note('<b>The copied details are incomplete.</b> Copy them again from Tenant Management.'); return; }
    fill(d);
  }
  function ask() { var t = window.prompt('Paste the applicant details copied from Tenant Management (Ctrl+V), then OK:'); if (t) use(t); }
  if (navigator.clipboard && navigator.clipboard.readText) navigator.clipboard.readText().then(function (t) { if (String(t || '').indexOf(TAG) < 0) ask(); else use(t); }, ask);
  else ask();
})();
