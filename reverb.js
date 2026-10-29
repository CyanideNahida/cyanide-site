/* ============================================================
   LAB · Underwater Reverb —— 浏览器版 DSP
   严丝合缝地复刻桌面版 uxfx/dsp.py（那版是被耳朵验证过的）：
     高通 28Hz → 低架 bass(+low dB) → 中频凹陷 mid →
     主低通 cutoff×(lpOrder/2 级, Q0.62) → 转角小峰 res →
     高架 hf(-8dB) → 末段悬崖 top×(topOrder/2 级, Q0.62)
     → 大厅混响（按频带分别衰减的 IR, 45ms 预延迟, wobble）
     → 软饱和（ceiling +6dB, 几乎透明）→ 立体声收窄
     → 响度对齐 target_lufs → 12ms 前视限幅到 -1dBFS
   关键：图里不放 WaveShaper、不放压缩器——上一版就是被这两样
   弄出满耳朵的高频毛刺。
   ============================================================ */
(function () {
  'use strict';

  var SR = 48000;
  var MAX_SEC = 300;          // 整首最长 5 分钟

  /* 预设逐项照抄 uxfx/params.py */
  var PRESETS = {
    under: {
      label: 'UnderEffect + Reverb',
      speed: 1.00, cutoff: 380, wet: 0.42, rt60: 2.3, low: 7.0,
      lpOrder: 2, resDb: 4.0, midHz: 650, midDb: -3.5, midQ: 1.1,
      bassHz: 140, hfHz: 2600, hfDb: -8.0, topHz: 5600, topOrder: 4,
      preDelay: 0.045, drive: 0.35, wobble: 0.10, width: 0.62, lufs: -13.0
    },
    under_slow: {
      label: 'UnderEffect + Slowed Reverb',
      speed: 0.85, cutoff: 380, wet: 0.42, rt60: 2.3, low: 7.0,
      lpOrder: 2, resDb: 4.0, midHz: 650, midDb: -3.5, midQ: 1.1,
      bassHz: 140, hfHz: 2600, hfDb: -8.0, topHz: 5600, topOrder: 4,
      preDelay: 0.045, drive: 0.35, wobble: 0.10, width: 0.62, lufs: -13.0
    },
    deep: {
      label: 'DeepEffect + Reverb',
      speed: 1.00, cutoff: 250, wet: 0.52, rt60: 3.0, low: 8.5,
      lpOrder: 2, resDb: 4.5, midHz: 600, midDb: -4.5, midQ: 1.2,
      bassHz: 130, hfHz: 2300, hfDb: -9.0, topHz: 4600, topOrder: 4,
      preDelay: 0.062, drive: 0.50, wobble: 0.16, width: 0.55, lufs: -12.5
    },
    shallow: {
      label: 'ShallowEffect + Reverb',
      speed: 1.00, cutoff: 900, wet: 0.30, rt60: 1.8, low: 3.0,
      lpOrder: 2, resDb: 1.5, midHz: 800, midDb: -1.2, midQ: 1.0,
      bassHz: 140, hfHz: 3000, hfDb: -3.0, topHz: 9000, topOrder: 2,
      preDelay: 0.032, drive: 0.15, wobble: 0.04, width: 0.75, lufs: -14.0
    },
    shallow_slow: {
      label: 'ShallowEffect + Slowed Reverb',
      speed: 0.85, cutoff: 900, wet: 0.30, rt60: 1.8, low: 3.0,
      lpOrder: 2, resDb: 1.5, midHz: 800, midDb: -1.2, midQ: 1.0,
      bassHz: 140, hfHz: 3000, hfDb: -3.0, topHz: 9000, topOrder: 2,
      preDelay: 0.032, drive: 0.15, wobble: 0.04, width: 0.75, lufs: -14.0
    }
  };

  /* ---------- DOM ---------- */
  var $ = function (id) { return document.getElementById(id); };
  var drop = $('drop'), fileInput = $('file');
  var fileline = $('fileline'), fname = $('fname'), fdur = $('fdur');
  var playBtn = $('play'), playIcon = $('playIcon'), track = $('track'), prog = $('prog'), timeEl = $('time');
  var statusEl = $('status'), runBtn = $('run'), dlBtn = $('dl');
  var abOrig = $('ab-orig'), abFx = $('ab-fx');
  var presetBox = $('presets'), presetName = $('presetName');
  var kSpeed = $('k-speed'), kCutoff = $('k-cutoff'), kWet = $('k-wet'), kLow = $('k-low');
  var vSpeed = $('v-speed'), vCutoff = $('v-cutoff'), vWet = $('v-wet'), vLow = $('v-low');

  /* ---------- state ---------- */
  var srcBuf = null;        // 原始音频
  var fxBuf = null;         // 效果后
  var fileName = 'track';
  var presetKey = 'under';
  var listening = 'fx';     // 'orig' | 'fx'
  var actx = null, node = null, startedAt = 0, offset = 0, playing = false, rafId = 0;

  /* ---------- 小工具 ---------- */
  function fmt(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    var m = Math.floor(sec / 60), s = Math.floor(sec % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }
  function say(msg, isErr, spinning) {
    statusEl.className = 'status' + (isErr ? ' err' : '');
    statusEl.innerHTML = '';
    if (spinning) {
      var d = document.createElement('i'); d.className = 'spin'; statusEl.appendChild(d);
    }
    statusEl.appendChild(document.createTextNode(msg));
  }
  function params() {
    var base = PRESETS[presetKey] || PRESETS.under;
    var p = {}, k;
    for (k in base) {
      if (Object.prototype.hasOwnProperty.call(base, k)) p[k] = base[k];
    }
    p.speed = parseInt(kSpeed.value, 10) / 100;
    p.cutoff = parseInt(kCutoff.value, 10);
    p.wet = parseInt(kWet.value, 10) / 100;
    p.low = parseFloat(kLow.value);
    return p;
  }
  function syncLabels() {
    var p = params();
    vSpeed.textContent = p.speed.toFixed(2) + '×';
    vCutoff.textContent = p.cutoff + ' Hz';
    vWet.textContent = p.wet.toFixed(2);
    vLow.textContent = '+' + p.low.toFixed(1) + ' dB';
  }
  function applyPreset(key, silent) {
    var p = PRESETS[key];
    if (!p) return;
    presetKey = key;
    kSpeed.value = Math.round(p.speed * 100);
    kCutoff.value = p.cutoff;
    kWet.value = Math.round(p.wet * 100);
    kLow.value = p.low;
    presetName.textContent = p.label;
    Array.prototype.forEach.call(presetBox.querySelectorAll('.preset'), function (b) {
      b.classList.toggle('on', b.getAttribute('data-preset') === key);
    });
    syncLabels();
    if (!silent) markDirty();
  }
  function markDirty() {
    if (!srcBuf) return;
    say('参数改了，重新点「开始转换」才听得到新效果。');
  }

  /* ---------- 合成脉冲响应（对照 dsp.reverb_ir，频域掩码版本）---------- */
  /* 上一版用一串 biquad 拼带通，频带互相重叠，湿声里中高频偏亮；
     这里照 Python 的做法：白噪声整段 FFT → 六个频带各自乘掩码 → IFFT
     → 乘上各自的 tau 包络 → 叠加 + 早期反射 → 逐声道能量归一到 1。 */

  function fftInPlace(re, im, inverse) {
    var n = re.length, i, j, k, m, len, ang, wr, wi, tr, ti;
    for (i = 1, j = 0; i < n; i++) {
      var bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        tr = re[i]; re[i] = re[j]; re[j] = tr;
        ti = im[i]; im[i] = im[j]; im[j] = ti;
      }
    }
    ang = (inverse ? 2 : -2) * Math.PI;
    for (len = 2; len <= n; len <<= 1) {
      var half = len >> 1;
      wr = Math.cos(ang / len);
      wi = Math.sin(ang / len);
      for (i = 0; i < n; i += len) {
        var cr = 1, ci = 0;
        for (k = 0; k < half; k++) {
          var ur = re[i + k], ui = im[i + k];
          var vr = re[i + k + half] * cr - im[i + k + half] * ci;
          var vi = re[i + k + half] * ci + im[i + k + half] * cr;
          re[i + k] = ur + vr; im[i + k] = ui + vi;
          re[i + k + half] = ur - vr; im[i + k + half] = ui - vi;
          var ncr = cr * wr - ci * wi;
          ci = cr * wi + ci * wr;
          cr = ncr;
        }
      }
    }
    if (inverse) {
      for (i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
    }
  }

  function makeIR(ctx, p) {
    var sr = ctx.sampleRate;
    var pre = Math.max(0, p.preDelay);
    var rt60 = Math.max(0.2, p.rt60);
    var n = Math.floor(rt60 * 1.5 * sr);
    var N = 1;
    while (N < n) N <<= 1;
    var preN = Math.floor(pre * sr);
    var buf = ctx.createBuffer(2, n + preN, sr);
    var bands = [
      [0, 90, 1.45],
      [90, 260, 1.28],
      [260, 700, 1.10],
      [700, 2000, 1.00],
      [2000, 5000, 0.80],
      [5000, sr / 2, 0.62]
    ];
    var nbins = (N >> 1) + 1;
    var freqs = new Float64Array(nbins);
    for (var q = 0; q < nbins; q++) freqs[q] = q * sr / N;
    /* 掩码边缘做一次滑动平均，避免频带接缝出现"咔"的振铃（同 Python） */
    var smoothK = Math.max(Math.round(sr * 0.004 / n * nbins), 2);

    for (var ch = 0; ch < 2; ch++) {
      var seed = ch === 0 ? 123456789 : 987654321;
      function rnd() {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        return (seed / 2147483648) * 2 - 1;
      }
      var re = new Float64Array(N), im = new Float64Array(N);
      for (var i = 0; i < n; i++) {
        /* Box-Muller 取高斯（Python 用 standard_normal） */
        var u1 = Math.abs(rnd()) + 1e-9, u2 = rnd();
        re[i] = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      }
      var sre = Float64Array.from(re), sim = Float64Array.from(im);
      fftInPlace(sre, sim, false);

      var wet = new Float64Array(n);
      for (var b = 0; b < bands.length; b++) {
        var lo = bands[b][0], hi = Math.min(bands[b][1], sr / 2);
        if (hi <= lo) continue;
        var mask = new Float64Array(nbins), any = false;
        for (var k = 0; k < nbins; k++) {
          if (freqs[k] >= lo && freqs[k] < hi) { mask[k] = 1; any = true; }
        }
        if (!any) continue;
        /* 滑动平均平滑边界 */
        var sm = new Float64Array(nbins), acc = 0, halfK = smoothK >> 1;
        for (var k2 = 0; k2 < nbins + halfK; k2++) {
          if (k2 < nbins) acc += mask[k2];
          if (k2 - smoothK >= 0) acc -= mask[k2 - smoothK];
          var dstIdx = k2 - halfK;
          if (dstIdx >= 0 && dstIdx < nbins) sm[dstIdx] = acc / smoothK;
        }
        var bre = new Float64Array(N), bim = new Float64Array(N);
        for (var k3 = 0; k3 < nbins; k3++) {
          bre[k3] = sre[k3] * sm[k3];
          bim[k3] = sim[k3] * sm[k3];
          if (k3 > 0 && k3 < nbins - 1) {
            bre[N - k3] = bre[k3];
            bim[N - k3] = -bim[k3];
          }
        }
        fftInPlace(bre, bim, true);
        var tau = rt60 * bands[b][2];
        var k = 6.9078 / Math.max(tau, 0.05) / sr;
        var env = 1, dec = Math.exp(-k);
        for (var s = 0; s < n; s++) {
          wet[s] += bre[s] * env;
          env *= dec;
        }
      }

      /* 早期反射：7 个随机抽头，幅度 N(0,1)*0.25 并向尾部衰减 */
      for (var e = 0; e < 7; e++) {
        var uu1 = Math.abs(rnd()) + 1e-9, uu2 = rnd();
        var gauss = Math.sqrt(-2 * Math.log(uu1)) * Math.cos(2 * Math.PI * uu2);
        var tap = Math.floor(Math.abs(gauss) * 0.012 * sr);
        if (tap >= n) tap = n - 1;
        wet[tap] += gauss * 0.25 * (1 - tap / (n * 0.5));
      }

      /* 能量归一到 1 */
      var sum = 0;
      for (var s2 = 0; s2 < n; s2++) sum += wet[s2] * wet[s2];
      var g = sum > 0 ? 1 / Math.sqrt(sum) : 0;
      var ch2 = buf.getChannelData(ch);
      var fadeN = Math.min(n, Math.floor(0.004 * sr));
      for (var s3 = 0; s3 < n; s3++) {
        ch2[preN + s3] = wet[s3] * g * (s3 < fadeN ? s3 / fadeN : 1);
      }
    }
    return buf;
  }

  /* ---------- 小工具 ---------- */
  function fmt(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    var m = Math.floor(sec / 60), s = Math.floor(sec % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }
  function say(msg, isErr, spinning) {
    statusEl.className = 'status' + (isErr ? ' err' : '');
    statusEl.innerHTML = '';
    if (spinning) {
      var d = document.createElement('i'); d.className = 'spin'; statusEl.appendChild(d);
    }
    statusEl.appendChild(document.createTextNode(msg));
  }
  function params() {
    var base = PRESETS[presetKey] || PRESETS.under;
    var p = {}, k;
    for (k in base) {
      if (Object.prototype.hasOwnProperty.call(base, k)) p[k] = base[k];
    }
    p.speed = parseInt(kSpeed.value, 10) / 100;
    p.cutoff = parseInt(kCutoff.value, 10);
    p.wet = parseInt(kWet.value, 10) / 100;
    p.low = parseFloat(kLow.value);
    return p;
  }
  function syncLabels() {
    var p = params();
    vSpeed.textContent = p.speed.toFixed(2) + '×';
    vCutoff.textContent = p.cutoff + ' Hz';
    vWet.textContent = p.wet.toFixed(2);
    vLow.textContent = '+' + p.low.toFixed(1) + ' dB';
  }
  function applyPreset(key, silent) {
    var p = PRESETS[key];
    if (!p) return;
    presetKey = key;
    kSpeed.value = Math.round(p.speed * 100);
    kCutoff.value = p.cutoff;
    kWet.value = Math.round(p.wet * 100);
    kLow.value = p.low;
    presetName.textContent = p.label;
    Array.prototype.forEach.call(presetBox.querySelectorAll('.preset'), function (b) {
      b.classList.toggle('on', b.getAttribute('data-preset') === key);
    });
    syncLabels();
    if (!silent) markDirty();
  }
  function markDirty() {
    if (!srcBuf) return;
    say('参数改了，重新点「开始转换」才听得到新效果。');
  }

  /* ---------- 合成脉冲响应（对应 dsp.make_ir）---------- */
  /* 白噪声按 6 个频带分别滤波、各自按 tau 衰减后叠加：
     高频先死、低频拖尾，这才是"水下"的暗尾巴。 */
  function addBand(dst, noise, sr, fc, q, tau, gain) {
    var w0 = 2 * Math.PI * fc / sr;
    var cs = Math.cos(w0), sn = Math.sin(w0), alpha = sn / (2 * Math.max(0.3, q));
    var a0 = 1 + alpha;
    var b0 = alpha / a0, b2 = -alpha / a0;
    var a1 = (-2 * cs) / a0, a2 = (1 - alpha) / a0;
    var x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    var dec = Math.exp(-1 / (Math.max(tau, 0.02) * sr));
    var env = gain;
    for (var i = 0; i < noise.length; i++) {
      var x = noise[i];
      var y = b0 * x + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = x; y2 = y1; y1 = y;
      dst[i] += y * env;
      env *= dec;
    }
  }

  function makeIR(ctx, p) {
    var sr = ctx.sampleRate;
    var pre = Math.max(0, p.preDelay);
    var rt60 = Math.max(0.2, p.rt60);
    var len = Math.ceil((pre + rt60 * 1.6) * sr);
    var preN = Math.floor(pre * sr);
    var n = len - preN;
    var buf = ctx.createBuffer(2, len, sr);
    var bands = [
      [30, 90, 1.45],
      [90, 260, 1.28],
      [260, 700, 1.10],
      [700, 2000, 1.00],
      [2000, 5000, 0.80],
      [5000, sr / 2 - 200, 0.62]
    ];
    var early = [0.0031, 0.0067, 0.0109, 0.0173, 0.0261, 0.0389];

    for (var ch = 0; ch < 2; ch++) {
      var d = buf.getChannelData(ch);
      var noise = new Float32Array(n);
      var seed = ch === 0 ? 12345 : 67890;
      for (var i = 0; i < n; i++) {
        seed = (seed * 16807) % 2147483647;
        noise[i] = (seed / 2147483647) * 2 - 1;
      }
      var band = new Float32Array(n);
      for (var b = 0; b < bands.length; b++) {
        var lo = Math.max(bands[b][0], 25);
        var hi = Math.min(bands[b][1], sr / 2 - 100);
        if (hi <= lo) continue;
        var fc = Math.sqrt(lo * hi);
        var q = fc / Math.max(1, hi - lo);
        addBand(d, noise, sr, fc, q, rt60 * bands[b][2] / 6.9078, 1);
      }
      /* 早期反射：让混响有个"房间"的轮廓 */
      for (var e = 0; e < early.length; e++) {
        var idx = preN + Math.floor(early[e] * sr);
        if (idx < len) d[idx] += (1 - e / (early.length + 1)) * 0.30 * (ch === 0 ? 1 : -0.7);
      }
      /* 能量归一到 1（Python 也是这么干的），这样 wet 增益就是纯预设值 */
      var sum = 0;
      for (var s = 0; s < n; s++) sum += d[preN + s] * d[preN + s];
      var g = sum > 0 ? 1 / Math.sqrt(sum) : 0;
      for (var f = 0; f < n; f++) d[preN + f] *= g;
      /* 4ms 淡入，避免卷积起头爆点 */
      var fadeN = Math.min(n, Math.floor(0.004 * sr));
      for (var w = 0; w < fadeN; w++) d[preN + w] *= w / fadeN;
      if (band.length) { /* noop, 保持引用 */ }
    }
    return buf;
  }

  /* ---------- 小工具 ---------- */
  function bq(ctx, type, freq, q, gain) {
    var f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = Math.max(10, Math.min(ctx.sampleRate / 2 - 100, freq));
    f.Q.value = q;
    if (gain) f.gain.value = gain;
    return f;
  }

  /* ---------- 渲染 ---------- */
  function renderFX(input, p) {
    var outSec = Math.min(input.duration / p.speed, MAX_SEC);
    var frames = Math.max(1, Math.ceil(outSec * SR));
    var ctx = new OfflineAudioContext(2, frames, SR);

    var src = ctx.createBufferSource();
    src.buffer = input;
    src.playbackRate.value = p.speed;

    /* 滤波链：与 dsp.py 的滤波段一一对应 */
    var prev = src;
    var hp = bq(ctx, 'highpass', 28, 0.7071, 0);
    prev.connect(hp); prev = hp;

    var bass = bq(ctx, 'lowshelf', p.bassHz, 0.7071, p.low);
    prev.connect(bass); prev = bass;

    var mid = bq(ctx, 'peaking', p.midHz, p.midQ, p.midDb);
    prev.connect(mid); prev = mid;

    var nLp = Math.max(1, Math.round(p.lpOrder / 2));
    for (var i = 0; i < nLp; i++) {
      var lp = bq(ctx, 'lowpass', p.cutoff, 0.62, 0);
      prev.connect(lp); prev = lp;
    }
    var res = bq(ctx, 'peaking', p.cutoff * 1.05, 1.1, p.resDb);
    prev.connect(res); prev = res;

    var hs = bq(ctx, 'highshelf', p.hfHz, 0.7071, p.hfDb);
    prev.connect(hs); prev = hs;

    var nTop = Math.max(1, Math.round(p.topOrder / 2));
    for (var j = 0; j < nTop; j++) {
      var tp = bq(ctx, 'lowpass', p.topHz, 0.62, 0);
      prev.connect(tp); prev = tp;
    }

    /* 干湿：dry 恒为 unity（Python 就是 1，不是 1-wet） */
    var dry = ctx.createGain();
    dry.gain.value = 1;

    var conv = ctx.createConvolver();
    conv.buffer = makeIR(ctx, p);
    conv.normalize = false;

    var wetGain = ctx.createGain();
    wetGain.gain.value = p.wet;

    /* wobble：0.22Hz 慢速起伏，只作用于湿声 */
    var wobble = ctx.createOscillator();
    wobble.type = 'sine';
    wobble.frequency.value = 0.22;
    var wobbleAmt = ctx.createGain();
    wobbleAmt.gain.value = p.wobble * p.wet;
    wobble.connect(wobbleAmt).connect(wetGain.gain);

    var mix = ctx.createGain();
    mix.gain.value = 1;

    prev.connect(dry).connect(mix);
    prev.connect(conv).connect(wetGain).connect(mix);
    mix.connect(ctx.destination);

    src.start(0);
    wobble.start(0);
    wobble.stop(Math.max(0.1, outSec));

    return ctx.startRendering().then(function (buf) {
      master(buf, p);
      return buf;
    });
  }

  /* ---------- 母带：软饱和 + 收窄 + 响度对齐 + 前视限幅 ---------- */
  /* 1) 与 dsp._soft_clip(mix, ceiling_db=6.0, drive*2) 等价
     2) side × width
     3) 门控响度对齐到 p.lufs（BS.1770 K 加权，48k 系数）
     4) 12ms 前视 / 180ms 释放 / -1dBFS 限幅 */
  function kWeight(x, n) {
    var b1 = [1.53512485958697, -2.69169618940638, 1.19839281085285];
    var a1 = [1, -1.69065929318241, 0.73248077421585];
    var b2 = [1, -2, 1];
    var a2 = [1, -1.99004745483398, 0.99007225036621];
    function run(b, a) {
      var x1 = 0, x2 = 0, y1 = 0, y2 = 0;
      for (var i = 0; i < n; i++) {
        var v = b[0] * x[i] + b[1] * x1 + b[2] * x2 - a[1] * y1 - a[2] * y2;
        x2 = x1; x1 = x[i]; y2 = y1; y1 = v; x[i] = v;
      }
    }
    run(b1, a1);
    run(b2, a2);
  }

  function loudnessGain(L, R, targetLufs) {
    /* EBU R128 / BS.1770：门控是在「能量」上做的，不是在对数值上。
       上一版把 LUFS 当数字求平均，安静段把均值拉低，于是多推了 1.3 dB。 */
    var n = L.length;
    var a = new Float32Array(n), b = new Float32Array(n);
    for (var i = 0; i < n; i++) { a[i] = L[i]; b[i] = R[i]; }
    kWeight(a, n);
    kWeight(b, n);
    var hop = Math.floor(0.1 * SR), win = Math.floor(0.4 * SR);
    if (n < win) win = n;
    var zs = [];
    for (var s2 = 0; s2 + win <= n; s2 += hop) {
      var zl = 0, zr = 0;
      for (var k = 0; k < win; k++) { zl += a[s2 + k] * a[s2 + k]; zr += b[s2 + k] * b[s2 + k]; }
      zs.push((zl + zr) / win);
    }
    if (!zs.length) return 1;
    var toLufs = function (z) { return -0.691 + 10 * Math.log10(z + 1e-14); };
    var keep = [];
    var z0 = 0, c0 = 0;
    for (var j = 0; j < zs.length; j++) {
      if (toLufs(zs[j]) > -70) { z0 += zs[j]; c0++; }
    }
    if (!c0) return 1;
    var gate = toLufs(z0 / c0) - 10;
    var z1 = 0, c1 = 0;
    for (var j2 = 0; j2 < zs.length; j2++) {
      var lv = toLufs(zs[j2]);
      if (lv > -70 && lv > gate) { z1 += zs[j2]; c1++; }
    }
    if (!c1) { z1 = z0; c1 = c0; }
    var measured = toLufs(z1 / c1);
    var g = Math.pow(10, (targetLufs - measured) / 20);
    return isFinite(g) && g > 0 ? g : 1;
  }

  function limiter(L, R, ceil, lookSec, relSec) {
    var n = L.length;
    var blk = 32;
    var nb = Math.ceil(n / blk);
    var pk = new Float32Array(nb);
    for (var b = 0; b < nb; b++) {
      var mx = 0, e = Math.min(n, (b + 1) * blk);
      for (var i = b * blk; i < e; i++) {
        var x = Math.abs(L[i]); if (x > mx) mx = x;
        var y = Math.abs(R[i]); if (y > mx) mx = y;
      }
      pk[b] = mx;
    }
    /* 向前看：未来 lookSec 内的最大值决定当前增益 */
    var wb = Math.max(1, Math.round(lookSec * SR / blk));
    var relPerBlk = Math.exp(-blk / (relSec * SR));
    var g = 1;
    var gain = new Float32Array(nb);
    for (var b2 = 0; b2 < nb; b2++) {
      var env = 0;
      for (var k = b2; k < Math.min(nb, b2 + wb); k++) if (pk[k] > env) env = pk[k];
      var want = env > ceil ? ceil / env : 1;
      if (want < g) g = want;                        /* 立即压 */
      else g = want + (g - want) * relPerBlk;        /* 缓慢放 */
      gain[b2] = g;
    }
    /* 逐样本线性插值施加增益，再硬削一次保证不过顶 */
    for (var b3 = 0; b3 < nb; b3++) {
      var g0 = gain[b3];
      var g1 = b3 + 1 < nb ? gain[b3 + 1] : g0;
      var s0 = b3 * blk, s1 = Math.min(n, s0 + blk);
      for (var t = s0; t < s1; t++) {
        var gg = g0 + (g1 - g0) * ((t - s0) / blk);
        var l = L[t] * gg, r = R[t] * gg;
        L[t] = l > ceil ? ceil : (l < -ceil ? -ceil : l);
        R[t] = r > ceil ? ceil : (r < -ceil ? -ceil : r);
      }
    }
  }

  function master(buf, p) {
    var L = buf.getChannelData(0), R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
    var n = L.length, i;

    /* 1) 软饱和：ceiling +6dB、drive×2 —— 基本上只在极大电平时才起作用 */
    var ceil6 = Math.pow(10, 6 / 20);
    var drv = Math.max(0.001, p.drive * 2);
    var kn = Math.tanh(drv);
    for (i = 0; i < n; i++) {
      L[i] = ceil6 * Math.tanh(L[i] * drv / ceil6) / kn;
      R[i] = ceil6 * Math.tanh(R[i] * drv / ceil6) / kn;
    }

    /* 2) 中侧收窄 */
    for (i = 0; i < n; i++) {
      var m = (L[i] + R[i]) * 0.5;
      var s = (L[i] - R[i]) * 0.5 * p.width;
      L[i] = m + s;
      R[i] = m - s;
    }

    /* 3) 响度对齐 */
    var g = loudnessGain(L, R, p.lufs);
    if (isFinite(g) && g > 0) {
      for (i = 0; i < n; i++) { L[i] *= g; R[i] *= g; }
    }

    /* 4) 限幅到 -1 dBFS */
    limiter(L, R, Math.pow(10, -1 / 20), 0.012, 0.180);
    return buf;
  }

  /* ---------- 解码 ---------- */
  function decode(file) {
    return file.arrayBuffer().then(function (ab) {
      return new Promise(function (res, rej) {
        var ctx = new (window.AudioContext || window.webkitAudioContext)();
        ctx.decodeAudioData(ab, function (buf) {
          ctx.close && ctx.close();
          res(buf);
        }, function (e) {
          ctx.close && ctx.close();
          rej(e || new Error('decode failed'));
        });
      });
    });
  }

  /* ---------- 播放 ---------- */
  function currentBuf() { return listening === 'orig' ? srcBuf : fxBuf; }
  function stopPlay() {
    if (node) { try { node.stop(); } catch (e) {} node = null; }
    playing = false;
    cancelAnimationFrame(rafId);
    setIcon(false);
  }
  function setIcon(isPlaying) {
    playIcon.innerHTML = isPlaying
      ? '<path d="M7 5h4v14H7zM13 5h4v14h-4z"/>'
      : '<path d="M8 5v14l11-7z"/>';
  }
  function startPlay() {
    var buf = currentBuf();
    if (!buf) return;
    if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === 'suspended') actx.resume();
    var dur = buf.duration;
    if (offset >= dur - 0.05) offset = 0;
    node = actx.createBufferSource();
    node.buffer = buf;
    node.connect(actx.destination);
    node.onended = function () {
      if (!playing) return;
      stopPlay(); offset = 0; paint(0, dur);
    };
    startedAt = actx.currentTime - offset;
    node.start(0, offset);
    playing = true;
    setIcon(true);
    tick();
  }
  function tick() {
    if (!playing) return;
    var buf = currentBuf();
    var t = actx.currentTime - startedAt;
    if (buf && t >= buf.duration) { stopPlay(); offset = 0; paint(0, buf.duration); return; }
    paint(t, buf ? buf.duration : 0);
    rafId = requestAnimationFrame(tick);
  }
  function paint(t, dur) {
    var pct = dur > 0 ? Math.min(100, (t / dur) * 100) : 0;
    prog.style.width = pct + '%';
    timeEl.textContent = fmt(t) + ' / ' + fmt(dur);
  }
  function togglePlay() {
    if (!currentBuf()) return;
    if (playing) { offset = actx.currentTime - startedAt; stopPlay(); }
    else startPlay();
  }

  /* ---------- WAV 导出 ---------- */
  function toWav(buf) {
    var ch = Math.min(2, buf.numberOfChannels);
    var len = buf.length;
    var bytes = 44 + len * ch * 2;
    var ab = new ArrayBuffer(bytes);
    var v = new DataView(ab);
    var w = function (o, s) { for (var i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); v.setUint32(4, bytes - 8, true); w(8, 'WAVE');
    w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
    v.setUint16(22, ch, true); v.setUint32(24, buf.sampleRate, true);
    v.setUint32(28, buf.sampleRate * ch * 2, true); v.setUint16(32, ch * 2, true);
    v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, len * ch * 2, true);
    var off = 44;
    var chans = [];
    for (var c = 0; c < ch; c++) chans.push(buf.getChannelData(c));
    for (var i = 0; i < len; i++) {
      for (var c2 = 0; c2 < ch; c2++) {
        var s = Math.max(-1, Math.min(1, chans[c2][i]));
        v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
        off += 2;
      }
    }
    return new Blob([ab], { type: 'audio/wav' });
  }

  /* ---------- 事件 ---------- */
  function loadFile(file) {
    if (!file) return;
    if (!/^audio\//.test(file.type) && !/\.(mp3|wav|flac|m4a|ogg|aac|opus)$/i.test(file.name)) {
      say('这个文件看起来不是音频。', true); return;
    }
    if (file.size > 80 * 1024 * 1024) {
      say('文件超过 80 MB，先在本地压一下再丢进来。', true); return;
    }
    fileName = file.name.replace(/\.[^.]+$/, '');
    say('读取 ' + file.name + ' …', false, true);
    decode(file).then(function (buf) {
      srcBuf = buf; fxBuf = null;
      fileline.hidden = false;
      drop.classList.add('has-file');
      drop.querySelector('b').textContent = '换一首';
      fname.textContent = file.name;
      fdur.textContent = fmt(buf.duration);
      playBtn.disabled = false;
      runBtn.disabled = false;
      dlBtn.disabled = true;
      listening = 'orig'; abOrig.classList.add('on'); abFx.classList.remove('on');
      offset = 0; stopPlay(); paint(0, buf.duration);
      say('解码完成，' + fmt(buf.duration) + ' · 选个预设再点转换。');
    }).catch(function (err) {
      console.error(err);
      say('读不了这个文件（浏览器可能不支持它的编码）。', true);
    });
  }

  drop.addEventListener('click', function () { fileInput.click(); });
  drop.addEventListener('dragover', function (e) { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', function () { drop.classList.remove('over'); });
  drop.addEventListener('drop', function (e) {
    e.preventDefault(); drop.classList.remove('over');
    if (e.dataTransfer.files && e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]);
  });
  fileInput.addEventListener('change', function () {
    if (fileInput.files && fileInput.files[0]) loadFile(fileInput.files[0]);
  });

  presetBox.addEventListener('click', function (e) {
    var b = e.target.closest('.preset');
    if (b) applyPreset(b.getAttribute('data-preset'));
  });
  [kSpeed, kCutoff, kWet, kLow].forEach(function (k) {
    k.addEventListener('input', function () {
      // 手动改动 → 取消预设高亮
      Array.prototype.forEach.call(presetBox.querySelectorAll('.preset'), function (b) {
        b.classList.remove('on');
      });
      syncLabels();
      markDirty();
    });
  });

  runBtn.addEventListener('click', function () {
    if (!srcBuf) return;
    var p = params();
    runBtn.disabled = true;
    dlBtn.disabled = true;
    stopPlay(); offset = 0;
    say('渲染中 · 这首歌大约要几秒 …', false, true);
    var t0 = performance.now();
    setTimeout(function () {
      renderFX(srcBuf, p).then(function (buf) {
        fxBuf = buf;
        listening = 'fx';
        abFx.classList.add('on'); abOrig.classList.remove('on');
        dlBtn.disabled = false;
        runBtn.disabled = false;
        paint(0, buf.duration);
        var sec = ((performance.now() - t0) / 1000).toFixed(1);
        say('好了 · ' + fmt(buf.duration) + ' · 用时 ' + sec + 's · 点播放听效果，或下载。');
      }).catch(function (err) {
        console.error(err);
        runBtn.disabled = false;
        say('渲染失败了：' + (err && err.message ? err.message : '未知错误'), true);
      });
    }, 30);
  });

  dlBtn.addEventListener('click', function () {
    if (!fxBuf) return;
    var blob = toWav(fxBuf);
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fileName + ' (' + (PRESETS[presetKey] ? PRESETS[presetKey].label : 'Underwater') + ').wav';
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
    say('已经存到你电脑上了 · ' + (blob.size / 1048576).toFixed(1) + ' MB');
  });

  playBtn.addEventListener('click', togglePlay);

  abOrig.addEventListener('click', function () {
    if (!srcBuf) return;
    var wasPlaying = playing, t = playing ? actx.currentTime - startedAt : offset;
    listening = 'orig'; abOrig.classList.add('on'); abFx.classList.remove('on');
    stopPlay(); offset = Math.min(t, srcBuf.duration - 0.05); paint(offset, srcBuf.duration);
    if (wasPlaying) startPlay();
  });
  abFx.addEventListener('click', function () {
    if (!fxBuf) { say('还没有效果后的版本，先点「开始转换」。'); return; }
    var wasPlaying = playing, t = playing ? actx.currentTime - startedAt : offset;
    listening = 'fx'; abFx.classList.add('on'); abOrig.classList.remove('on');
    stopPlay(); offset = Math.min(t, fxBuf.duration - 0.05); paint(offset, fxBuf.duration);
    if (wasPlaying) startPlay();
  });

  /* ---------- 进度条：点击 + 拖动 + 键盘 ---------- */
  function ratioAt(e) {
    var r = track.getBoundingClientRect();
    if (!r.width) return 0;
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  }
  function previewAt(ratio) {
    var buf = currentBuf(); if (!buf) return;
    prog.style.width = (ratio * 100).toFixed(2) + '%';
    timeEl.textContent = fmt(ratio * buf.duration) + ' / ' + fmt(buf.duration);
  }
  var dragging = false, resumeAfter = false;
  function seekTo(ratio, keepPlaying) {
    var buf = currentBuf(); if (!buf) return;
    stopPlay();
    offset = Math.max(0, Math.min(ratio * buf.duration, buf.duration - 0.05));
    paint(offset, buf.duration);
    if (keepPlaying) startPlay();
  }
  track.addEventListener('pointerdown', function (e) {
    if (!currentBuf()) return;
    e.preventDefault();
    dragging = true;
    resumeAfter = playing;
    stopPlay();
    if (resumeAfter) setIcon(true);          // 拖动中图标别闪成暂停
    track.classList.add('dragging');
    try { track.setPointerCapture(e.pointerId); } catch (err) {}
    previewAt(ratioAt(e));
  });
  track.addEventListener('pointermove', function (e) {
    if (!dragging) return;
    e.preventDefault();
    previewAt(ratioAt(e));
  });
  function endDrag(e) {
    if (!dragging) return;
    dragging = false;
    track.classList.remove('dragging');
    try { track.releasePointerCapture(e.pointerId); } catch (err) {}
    var keep = resumeAfter;
    resumeAfter = false;
    seekTo(ratioAt(e), keep);
  }
  track.addEventListener('pointerup', endDrag);
  track.addEventListener('pointercancel', endDrag);
  track.addEventListener('lostpointercapture', function () {
    if (dragging) { dragging = false; track.classList.remove('dragging'); }
  });

  /* 键盘：左右 5 秒，Home/End 跳首尾 */
  track.tabIndex = 0;
  track.setAttribute('role', 'slider');
  track.setAttribute('aria-label', '播放进度');
  track.addEventListener('keydown', function (e) {
    var buf = currentBuf(); if (!buf) return;
    var keep = playing;
    var cur = keep ? actx.currentTime - startedAt : offset;
    if (e.key === 'ArrowRight') { e.preventDefault(); seekTo(Math.min(1, (cur + 5) / buf.duration), keep && true); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); seekTo(Math.max(0, (cur - 5) / buf.duration), keep && true); }
    else if (e.key === 'Home') { e.preventDefault(); seekTo(0, keep && true); }
    else if (e.key === 'End') { e.preventDefault(); seekTo(0.999, keep && true); }
  });

  applyPreset('under', true);
  syncLabels();
  say('等待一首歌。');
})();
