/*
 * Finger / mouse / stylus signature pad.
 * Points are stored as fractions of the pad size, so rotating the phone redraws the
 * signature correctly. Exports a trimmed PNG on a transparent background.
 */
function SignaturePad(wrap, onChange) {
  'use strict';
  var canvas = wrap.querySelector('canvas');
  var ctx = canvas.getContext('2d');
  var strokes = [], current = null, firstAt = 0, lastAt = 0, w = 0, h = 0;
  var INK = '#0b1f4d';

  function lineWidth() { return Math.max(2.2, Math.min(3.2, w / 160)); }

  function resize() {
    var r = canvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    if (!r.width) return;
    w = r.width; h = r.height;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    redraw();
  }

  function drawStroke(c, s, sx, sy, lw) {
    c.lineWidth = lw; c.lineCap = 'round'; c.lineJoin = 'round'; c.strokeStyle = INK; c.fillStyle = INK;
    if (s.length === 1) { c.beginPath(); c.arc(s[0][0] * sx, s[0][1] * sy, lw / 2, 0, Math.PI * 2); c.fill(); return; }
    c.beginPath();
    c.moveTo(s[0][0] * sx, s[0][1] * sy);
    for (var i = 1; i < s.length - 1; i++) {
      var mx = (s[i][0] + s[i + 1][0]) / 2, my = (s[i][1] + s[i + 1][1]) / 2;
      c.quadraticCurveTo(s[i][0] * sx, s[i][1] * sy, mx * sx, my * sy);
    }
    var last = s[s.length - 1];
    c.lineTo(last[0] * sx, last[1] * sy);
    c.stroke();
  }

  function redraw() {
    ctx.clearRect(0, 0, w, h);
    strokes.forEach(function (s) { drawStroke(ctx, s, w, h, lineWidth()); });
    wrap.classList.toggle('has-ink', strokes.length > 0);
  }

  function pos(e) {
    var r = canvas.getBoundingClientRect();
    return [Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), Math.max(0, Math.min(1, (e.clientY - r.top) / r.height))];
  }

  canvas.addEventListener('pointerdown', function (e) {
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    current = [pos(e)];
    strokes.push(current);
    if (!firstAt) firstAt = Date.now();
    redraw();
  });
  canvas.addEventListener('pointermove', function (e) {
    if (!current) return;
    e.preventDefault();
    var evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    (evs.length ? evs : [e]).forEach(function (ev) { current.push(pos(ev)); });
    redraw();
  });
  function end(e) {
    if (!current) return;
    current = null;
    lastAt = Date.now();
    if (onChange) onChange();
  }
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('touchstart', function (e) { e.preventDefault(); }, { passive: false });
  canvas.addEventListener('touchmove', function (e) { e.preventDefault(); }, { passive: false });
  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', function () { setTimeout(resize, 250); });

  resize();

  return {
    resize: resize,
    isEmpty: function () {
      var pts = strokes.reduce(function (n, s) { return n + s.length; }, 0);
      return strokes.length === 0 || pts < 6;
    },
    clear: function () { strokes = []; firstAt = 0; lastAt = 0; redraw(); if (onChange) onChange(); },
    undo: function () { strokes.pop(); redraw(); if (onChange) onChange(); },
    stats: function () {
      return {
        count: strokes.length,
        points: strokes.reduce(function (n, s) { return n + s.length; }, 0),
        ms: firstAt && lastAt ? lastAt - firstAt : 0
      };
    },
    /** Trimmed PNG, about 3x the on-screen size for a crisp print. */
    toPng: function () {
      var scale = 3, W = Math.round(w * scale), H = Math.round(h * scale);
      var minX = 1, minY = 1, maxX = 0, maxY = 0;
      strokes.forEach(function (s) { s.forEach(function (p) { minX = Math.min(minX, p[0]); minY = Math.min(minY, p[1]); maxX = Math.max(maxX, p[0]); maxY = Math.max(maxY, p[1]); }); });
      var lw = lineWidth() * scale, padPx = lw * 2 + 6;
      var x0 = Math.max(0, minX * W - padPx), y0 = Math.max(0, minY * H - padPx);
      var x1 = Math.min(W, maxX * W + padPx), y1 = Math.min(H, maxY * H + padPx);
      var out = document.createElement('canvas');
      out.width = Math.max(10, Math.round(x1 - x0)); out.height = Math.max(10, Math.round(y1 - y0));
      var c = out.getContext('2d');
      c.translate(-x0, -y0);
      strokes.forEach(function (s) { drawStroke(c, s, W, H, lw); });
      return out.toDataURL('image/png');
    }
  };
}
