/* 植物大战僵尸 · 二年级数学抽卡训练营 — 交互与间隔复习
 * 记录保存在本机浏览器 localStorage，无需账号、无需联网。
 * 复习机制：Leitner 分级盒子
 *   答错 → 第 0 级，10 分钟后本轮重练
 *   之后每答对一次升一级，间隔依次为 1 / 2 / 4 / 7 / 15 天
 *   满级且连续答对 3 次 → 标记「已掌握」，不再插入抽卡
 *   普通抽卡时，到期错题有 35% 概率被优先抽到（不会刷屏）
 */
(function () {
  'use strict';

  var BANK = window.QUESTION_BANK;
  var OP = window.OP_INFO;
  var RULE = window.GAME_RULES;
  var POOLS = window.POOL_GROUPS;
  var KEY = 'pvz-math-cards-v1';
  var DAY = 24 * 60 * 60 * 1000;
  var INTERVALS = [10 * 60 * 1000, 1 * DAY, 2 * DAY, 4 * DAY, 7 * DAY, 15 * DAY];
  var REVIEW_RATIO = 0.35;

  var state = load();
  var current = null;
  var view = 'home';
  var reviewFilter = 'all';
  var audioCtx = null;
  /* 本题口诀提示：抽到卡后先自己想 10 秒，倒计时结束才写入页面 */
  var HINT_TICKS = RULE.hintTicks;
  var hintTimer = null;
  var hintToken = 0;

  function defaults() {
    return {
      sun: 0, streak: 0, bestStreak: 0, correct: 0, answered: 0, mixCorrect: 0,
      round: 1, records: {}, recent: [], mode: 'all', theme: 'all', sound: true,
      ruleVersion: RULE.version, resetCount: 0
    };
  }
  function migrate(d) {
    /* 旧计分（答对 +25/+50、每 5 题升关）→ 新口径：阳光按比例折算、
       关卡由累计阳光重新推算。错题 / 复习 / 徽章 / 答对次数全部保留。 */
    if (d.ruleVersion === RULE.version) return false;
    d.sun = Math.max(0, Math.round((Number(d.sun) || 0) / RULE.migrateDivisor));
    d.streak = 0;
    d.round = RULE.levelForSun(d.sun);
    d.ruleVersion = RULE.version;
    if (!d.theme) d.theme = 'all';
    return true;
  }
  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return defaults();
      var d = JSON.parse(raw);
      var rawVersion = d ? d.ruleVersion : undefined;
      var s = defaults();
      for (var k in s) if (Object.prototype.hasOwnProperty.call(d, k)) s[k] = d[k];
      if (!s.records || typeof s.records !== 'object') s.records = {};
      if (!Array.isArray(s.recent)) s.recent = [];
      /* 默认值带的是最新版本号，这里必须还原存档里的真实版本：
         旧存档没有 ruleVersion，若沿用默认值会被误判为已迁移。 */
      s.ruleVersion = rawVersion;
      if (migrate(s)) s._migrated = true;
      return s;
    } catch (e) { return defaults(); }
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* 隐私模式下仍可内存运行 */ }
  }

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function byId(id) { return BANK.find(function (q) { return q.id === id; }); }
  function highlight(text, keywords) {
    var out = esc(text);
    (keywords || []).slice().sort(function (a, b) { return b.length - a.length; }).forEach(function (k) {
      var kk = esc(k);
      if (kk) out = out.split(kk).join('<mark>' + kk + '</mark>');
    });
    return out;
  }
  function fmtGap(ts) {
    if (!ts) return '—';
    var diff = ts - Date.now();
    if (diff <= 0) return '现在可复习';
    var mins = Math.round(diff / 60000);
    if (mins < 60) return mins + ' 分钟后';
    var hrs = Math.round(mins / 60);
    if (hrs < 24) return hrs + ' 小时后';
    return Math.round(hrs / 24) + ' 天后';
  }
  function fmtDate(ts) {
    if (!ts) return '—';
    var d = new Date(ts);
    return (d.getMonth() + 1) + '月' + d.getDate() + '日';
  }
  function toast(msg) {
    var el = $('toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      el.style.cssText = 'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);background:#23471B;color:#fff;padding:12px 22px;border-radius:999px;font-size:15px;font-weight:700;box-shadow:0 8px 24px rgba(0,0,0,.2);z-index:99;opacity:0;transition:opacity .2s;pointer-events:none;max-width:90vw;text-align:center';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.style.opacity = '1';
    clearTimeout(el._t);
    el._t = setTimeout(function () { el.style.opacity = '0'; }, 2200);
  }

  /* ---------- 音效 ---------- */
  function beep(kind) {
    if (!state.sound) return;
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      audioCtx = audioCtx || new AC();
      var t = audioCtx.currentTime;
      var notes = kind === 'ok' ? [523, 659, 784] : [392, 311];
      notes.forEach(function (f, i) {
        var o = audioCtx.createOscillator(), g = audioCtx.createGain();
        o.type = 'sine'; o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t + i * 0.09);
        g.gain.exponentialRampToValueAtTime(0.12, t + i * 0.09 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.09 + 0.16);
        o.connect(g); g.connect(audioCtx.destination);
        o.start(t + i * 0.09); o.stop(t + i * 0.09 + 0.18);
      });
    } catch (e) { /* 无音频设备时忽略 */ }
  }

  /* ---------- 错题记录 / 间隔复习 ---------- */
  function ensureRecord(id) {
    if (!state.records[id]) {
      state.records[id] = {
        wrongCount: 0, correctStreak: 0, box: 0,
        lastWrongAt: 0, nextReviewAt: 0, lastWrongOp: null,
        mastered: false, seenAt: 0
      };
    }
    return state.records[id];
  }
  function recordWrong(q, wrongOps) {
    var r = ensureRecord(q.id);
    r.wrongCount += 1;
    r.correctStreak = 0;
    r.box = 0;
    r.mastered = false;
    r.lastWrongAt = Date.now();
    r.lastWrongOp = wrongOps || null;
    r.nextReviewAt = Date.now() + INTERVALS[0];
    save();
  }
  function recordCorrect(q) {
    var r = state.records[q.id];
    if (!r || !r.wrongCount) return; // 从未错过的题不进错题库
    r.correctStreak += 1;
    r.box = Math.min(r.box + 1, 5);
    r.nextReviewAt = Date.now() + INTERVALS[r.box];
    if (r.box === 5 && r.correctStreak >= 3) r.mastered = true;
    save();
  }
  function duePairs() {
    return Object.keys(state.records)
      .filter(function (id) {
        var r = state.records[id];
        return byId(id) && r.wrongCount > 0 && !r.mastered && r.nextReviewAt <= Date.now();
      })
      .map(function (id) { return [id, state.records[id]]; });
  }
  function reviewStats() {
    var pairs = Object.keys(state.records)
      .filter(function (id) { return byId(id) && state.records[id].wrongCount > 0; })
      .map(function (id) { return [id, state.records[id]]; });
    return {
      total: pairs.length,
      due: duePairs().length,
      learning: pairs.filter(function (p) { return !p[1].mastered && p[1].nextReviewAt > Date.now(); }).length,
      mastered: pairs.filter(function (p) { return p[1].mastered; }).length
    };
  }

  /* ---------- 抽卡 ---------- */
  function poolForMode(mode, theme) {
    return BANK.filter(function (q) {
      if (mode === 'single' && q.level !== 1) return false;
      if (mode === 'mix' && q.level !== 2) return false;
      if (['add', 'sub', 'mul', 'div'].indexOf(mode) >= 0 && q.op !== mode) return false;
      if (theme && theme !== 'all' && q.theme !== theme) return false;
      return true;
    });
  }
  function pickPool() {
    var pool = poolForMode(state.mode, state.theme);
    /* 只有「全部题型 + 全部场景」才按关卡调节混合题占比；专项卡池尊重用户选择 */
    if (state.mode === 'all' && state.theme === 'all') {
      var rate = RULE.mixRate(state.round);
      var mix = pool.filter(function (q) { return q.level === 2; });
      var single = pool.filter(function (q) { return q.level === 1; });
      if (rate <= 0) return single;
      return (Math.random() < rate && mix.length) ? mix : single;
    }
    return pool;
  }
  function pick(pool, recent) {
    var fresh = pool.filter(function (q) { return recent.indexOf(q.id) === -1; });
    var list = fresh.length ? fresh : pool;
    return list[Math.floor(Math.random() * list.length)];
  }
  function drawCard(opts) {
    opts = opts || {};
    clearHintTimer();
    var q = null;
    if (opts.id) {
      q = byId(opts.id);
    } else {
      var pool = opts.reviewOnly ? BANK.slice() : pickPool();
      var dueIds = duePairs().map(function (p) { return p[0]; });
      if (opts.reviewOnly) {
        var duePool = pool.filter(function (x) { return dueIds.indexOf(x.id) !== -1; });
        if (!duePool.length) { toast('今天没有到期的错题，先自由抽卡吧 🌿'); return; }
        q = pick(duePool, state.recent);
      } else if (dueIds.length && Math.random() < REVIEW_RATIO) {
        var dueInMode = pool.filter(function (x) { return dueIds.indexOf(x.id) !== -1; });
        if (dueInMode.length) q = pick(dueInMode, state.recent);
      }
      if (!q) q = pick(pool, state.recent);
    }
    if (!q) return;
    state.recent = [q.id].concat(state.recent.filter(function (x) { return x !== q.id; })).slice(0, 3);
    save();
    var r = state.records[q.id];
    current = {
      q: q,
      attempts: 0,
      penalized: false,
      award: null,
      hintOpen: false,
      hintUnlocked: false,
      reviewOnly: !!opts.reviewOnly,
      isReview: !!(r && r.wrongCount > 0 && !r.mastered),
      selections: {}
    };
    renderQuiz();
    showView('quiz');
  }

  /* ---------- 视图切换 ---------- */
  function showView(v) {
    view = v;
    if (v !== 'quiz') clearHintTimer();
    $('view-home').classList.toggle('hidden', v !== 'home');
    $('view-quiz').classList.toggle('hidden', v !== 'quiz');
    $('view-review').classList.toggle('hidden', v !== 'review');
    $('main-layout').classList.toggle('review-mode', v === 'review');
    if (v === 'home') renderHome();
    if (v === 'review') renderReview();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /* ---------- 抽卡台 / 顶栏 / 右栏 ---------- */
  function renderHome() {
    var prog = RULE.levelProgress(state.sun, state.round);
    $('home-level').textContent = '第 ' + state.round + ' / ' + RULE.maxLevel + ' 关 · 还差 ' + prog.need + ' ☀️';
    var n = poolForMode(state.mode, state.theme).length;
    $('home-remain').textContent = '卡池 ' + n + ' 张';
    if ($('op-pool')) $('op-pool').value = state.mode;
    if ($('theme-pool')) $('theme-pool').value = state.theme;
    var due = duePairs().length;
    $('home-review-tip').textContent = due
      ? '📕 今天有 ' + due + ' 张错题到期，抽卡时会优先遇到它们'
      : '';
    updateHeader();
  }
  function updateHeader() {
    $('stat-sun').textContent = state.sun;
    $('stat-streak').textContent = state.streak;
    $('stat-round').textContent = state.round;
    $('side-round').textContent = state.round;
    $('stat-correct').textContent = state.correct;
    $('stat-streak-side').textContent = state.streak;
    var prog = RULE.levelProgress(state.sun, state.round);
    $('progress-fill').style.width = prog.pct + '%';
    if ($('progress-note')) {
      $('progress-note').textContent = '累计 ' + state.sun + ' / ' + prog.target + ' ☀️ · 本关还需 ' + prog.need + ' ☀️';
    }

    var badges = [
      [$('badge-1'), state.correct >= 5, '📖 口诀小达人 · 已获得'],
      [$('badge-2'), state.bestStreak >= 3, '🔍 场景侦探 · 已获得'],
      [$('badge-3'), state.mixCorrect >= 3, '🧮 两步高手 · 已获得']
    ];
    badges.forEach(function (b) {
      if (!b[0]) return;
      b[0].classList.toggle('unlocked', b[1]);
      b[0].classList.toggle('locked', !b[1]);
      if (b[1]) b[0].textContent = b[2];
    });
    var s = reviewStats();
    $('review-badge').textContent = s.total - s.mastered;
    $('review-mini').innerHTML = s.due
      ? '📕 有 <b>' + s.due + '</b> 张错题到期，抽卡会优先复习'
      : (s.total ? '📕 错题 ' + (s.total - s.mastered) + ' 张，按间隔表安排复习' : '📕 错题库空空的，继续保持！');
    $('btn-sound').textContent = state.sound ? '🔊' : '🔇';
    $('btn-sound').classList.toggle('muted', !state.sound);
  }

  /* ---------- 重新开始：清空本浏览器进度，从零重来 ---------- */
  var seenReset = Number(state.resetCount) || 0;
  function openResetDialog() {
    var m = $('reset-modal');
    if (m) m.classList.remove('hidden');
  }
  function closeResetDialog() {
    var m = $('reset-modal');
    if (m) m.classList.add('hidden');
  }
  function resetAll() {
    var sound = state.sound;
    var n = (Number(state.resetCount) || 0) + 1;
    closeResetDialog();
    clearHintTimer();
    current = null;
    reviewFilter = 'all';
    try { localStorage.removeItem(KEY); } catch (e) { /* 隐私模式下仍可在内存中重置 */ }
    state = defaults();
    state.sound = sound;           /* 音效属于设备偏好，重来时保留 */
    state.resetCount = n;          /* 供同一浏览器其他标签页识别「已重置」 */
    seenReset = n;
    save();
    showView('home');
    toast('🌱 已重新开始：阳光、关卡和错题记录都清零啦');
  }

  /* ---------- 本题口诀提示：10 秒倒计时 ---------- */
  function clearHintTimer() {
    hintToken += 1;
    if (hintTimer) { clearTimeout(hintTimer); hintTimer = null; }
  }
  function hintCountdownText(left) {
    return '⏳ 先自己想一想 · 口诀提示 ' + left + ' 秒后出现';
  }
  function hintHtml(q) {
    return '<b>读题三步：</b>① 圈出数字　② 想清已知什么、求什么　③ 对上口诀<br>' +
      '<b>这道题的口诀：</b>' + esc(q.mnemonic) + '<br>' +
      '<b>小提示：</b>' + esc(q.hint);
  }
  function startHintCountdown() {
    clearHintTimer();
    var token = hintToken, left = HINT_TICKS;
    var tick = function () {
      if (token !== hintToken || !current) return;
      if (left > 0) {
        var btn = $('hint-toggle');
        if (btn) btn.textContent = hintCountdownText(left);
        left -= 1;
        hintTimer = setTimeout(tick, 1000);
      } else {
        hintTimer = null;
        unlockHint('');
      }
    };
    tick();
  }
  function unlockHint(reason) {
    if (!current || current.hintUnlocked) return;
    clearHintTimer();
    current.hintUnlocked = true;
    current.hintOpen = true;
    var btn = $('hint-toggle');
    if (btn) {
      btn.disabled = false;
      btn.classList.remove('waiting');
      btn.textContent = '🔍 收起口诀提示';
    }
    var box = $('hint-box');
    if (box) {
      box.innerHTML = hintHtml(current.q) +
        (reason ? '<div class="hint-unlock-note">' + esc(reason) + '</div>' : '');
      box.classList.remove('hidden');
      box.classList.add('appear');
    }
    document.querySelectorAll('[data-step-mnemonic]').forEach(function (el) {
      var st = current.q.steps && current.q.steps[Number(el.dataset.stepMnemonic)];
      if (!st) return;
      el.textContent = '口诀：' + st.mnemonic;
      el.classList.remove('locked');
      el.classList.add('appear');
    });
  }

  /* ---------- 答题卡 ---------- */
  function opButtons(slot, mini) {
    return '<div class="op-grid' + (mini ? ' mini' : '') + '">' + Object.keys(OP).map(function (op) {
      return '<button class="op-btn" data-action="select-op" data-slot="' + slot + '" data-op="' + op + '">' +
        OP[op].symbol + ' ' + OP[op].name + '<small>' + OP[op].goal + '</small></button>';
    }).join('') + '</div>';
  }
  function renderQuiz() {
    var q = current.q;
    var lvl2 = q.level === 2;
    var art = q.art === 'zombies' ? 'assets/zombies.png' : 'assets/plants.png';
    var html = '<div class="quiz-card">' +
      '<div class="quiz-head"><span>' + esc(q.scene) + '　|　' + (lvl2 ? '难度 ★★★' : '难度 ★☆☆') + '</span>' +
      '<span class="quiz-tag' + (current.isReview ? ' review' : '') + '">' + (current.isReview ? '📕 复习卡' : '🎴 新抽到') + '</span></div>' +
      '<img class="quiz-art" src="' + art + '" alt="题目插画">' +
      '<div class="scene-pill">场景：' + esc(q.scene.split(' · ')[0]) + '</div>' +
      '<p class="question-text">' + highlight(q.text, q.keywords) + '</p>' +
      '<div class="keyword-bar' + (lvl2 ? ' mix' : '') + '">🧭 圈出已知的数量：' + esc(q.keywords.join('　/　')) + '</div>';

    if (lvl2) {
      html += '<h3 class="section-title">分步拆解：先算什么？再算什么？</h3>' +
        '<p class="section-sub">每一步都要先选运算，再填得数。第 2 步要用到第 1 步算出的数。</p>';
      q.steps.forEach(function (st, i) {
        html += '<div class="step-card s' + (i + 1) + '">' +
          '<div class="step-title">' + esc(st.label) + '</div>' +
          '<div class="step-key">🧭 想一想：' + esc(st.keyword) + '</div>' +
          opButtons(String(i), true) +
          '<div class="answer-row"><label>得数</label>' +
          '<input class="answer-input small" type="number" inputmode="numeric" data-answer="' + i + '" placeholder="?">' +
          '<span class="answer-unit">写在草稿纸上再填</span></div>' +
          '<div class="step-mnemonic locked" data-step-mnemonic="' + i + '">🔒 这一步的口诀，先自己想一想</div>' +
          '</div>';
        if (i === 0) html += '<div class="step-arrow">↓ 把第 1 步算出的数，带进第 2 步</div>';
      });
    } else {
      html += '<h3 class="section-title">这道题该用哪种运算？</h3>' +
        '<p class="section-sub">先想一想：题目里已知什么？要求什么？</p>' +
        opButtons('main', false) +
        '<div class="answer-row"><label>得数</label>' +
        '<input class="answer-input" type="number" inputmode="numeric" data-answer="main" placeholder="?">' +
        '<span class="answer-unit">' + esc(q.unit) + '</span></div>';
    }

    html += '<button class="hint-toggle waiting" id="hint-toggle" data-action="toggle-hint" disabled>' +
      hintCountdownText(HINT_TICKS) + '</button>' +
      '<div class="hint-box hidden" id="hint-box"></div>' +
      '<div class="action-row">' +
      '<button class="btn btn-primary" id="check-btn" data-action="check">✅ 检查答案</button>' +
      '<button class="btn btn-soft" data-action="add-wrong">📕 加入错题库</button>' +
      '</div>' +
      '<div id="feedback"></div>' +
      '<div class="action-row">' +
      '<button class="btn btn-yellow" data-action="next">下一张卡 →</button>' +
      '<button class="btn btn-soft" data-action="back-home">返回抽卡台</button>' +
      '</div>' +
      '</div>';
    $('quiz-content').innerHTML = html;
    startHintCountdown();
  }

  function renderFeedback(kind) {
    var q = current.q;
    var fb = $('feedback');
    var html = '';
    if (kind === 'ok') {
      var a = current.award || { base: 0, bonus: 0, total: 0, retry: false };
      html = '<div class="feedback-title">🎉 答对啦！+' + a.total + ' ☀️</div>' +
        '<div class="sun-detail">' +
        (a.retry ? '🔁 重试答对 +1' : '✅ 答对基础 +' + a.base) +
        (a.bonus ? '　·　🔥 连对加成 +' + a.bonus : '') + '</div>' +
        '<div class="feedback-formula">' + esc(q.formula) + '</div>' +
        '<div class="mnemonic-line">口诀：' + esc(q.mnemonic) + '</div>' +
        '<div class="feedback-explain">' + esc(q.explain) + '</div>';
      fb.className = 'feedback ok';
    } else if (kind === 'hint') {
      html = '<div class="feedback-title">🤔 差一点点，先别看答案！ −' + RULE.wrongPenalty + ' ☀️</div>' +
        '<div class="feedback-explain">再读一遍题目，想想<b>已经知道什么、要求什么</b>，别只盯着一个词。' +
        '口诀提示已经帮你展开啦，对照着再试一次。' +
        (current.q.level === 2 ? '两步题要一步一步算，别急着跳到第二步。' : '') +
        '<br><b>你还有 1 次重试机会，答对可拿回 +' + RULE.retryGain + ' ☀️。</b></div>';
      fb.className = 'feedback bad';
    } else {
      html = '<div class="feedback-title">📖 这题先记住这个算式</div>' +
        '<div class="feedback-formula">' + esc(q.formula) + '</div>' +
        '<div class="mnemonic-line">口诀：' + esc(q.mnemonic) + '</div>' +
        '<div class="feedback-explain">' + esc(q.explain) + '</div>' +
        '<div class="feedback-explain">已经放进错题库，10 分钟后会再遇到它，之后按 1/2/4/7/15 天间隔复习。</div>';
      fb.className = 'feedback bad';
    }
    fb.innerHTML = html;
    fb.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function checkAnswer() {
    if (!current) return;
    var q = current.q, s = current.selections;
    var ok = false, missing = false, wrongOps = [];

    if (q.level === 1) {
      var ans = s.mainAnswer === '' || s.mainAnswer == null ? NaN : parseInt(s.mainAnswer, 10);
      if (!s.main || isNaN(ans)) missing = true;
      ok = (s.main === q.op) && (ans === q.answer);
      if (s.main && s.main !== q.op) wrongOps.push(OP[s.main].name);
      if (!isNaN(ans) && ans !== q.answer) wrongOps.push('得数算错');
    } else {
      var a0 = s['0Answer'] === '' || s['0Answer'] == null ? NaN : parseInt(s['0Answer'], 10);
      var a1 = s['1Answer'] === '' || s['1Answer'] == null ? NaN : parseInt(s['1Answer'], 10);
      if (!s['0'] || !s['1'] || isNaN(a0) || isNaN(a1)) missing = true;
      ok = (s['0'] === q.steps[0].op) && (a0 === q.steps[0].answer) &&
           (s['1'] === q.steps[1].op) && (a1 === q.steps[1].answer);
      if (s['0'] && s['0'] !== q.steps[0].op) wrongOps.push('第1步选了' + OP[s['0']].name);
      if (s['1'] && s['1'] !== q.steps[1].op) wrongOps.push('第2步选了' + OP[s['1']].name);
      if ((!isNaN(a0) && a0 !== q.steps[0].answer) || (!isNaN(a1) && a1 !== q.steps[1].answer)) wrongOps.push('得数算错');
    }
    if (missing) { toast('先选好运算，再填上得数哦 ✏️'); return; }

    state.answered += 1;
    if (ok) {
      var isRetry = current.attempts > 0;
      var streakAfter = isRetry ? 0 : state.streak + 1;
      var award = RULE.award(q, isRetry, streakAfter);
      var prevRound = state.round;
      state.sun += award.total;
      if (!isRetry) {
        state.streak += 1;
        state.bestStreak = Math.max(state.bestStreak, state.streak);
      }
      state.correct += 1;
      if (q.level === 2) state.mixCorrect += 1;
      /* 关卡只升不降：答错扣了阳光也不会掉关 */
      state.round = Math.max(state.round, RULE.levelForSun(state.sun));
      current.award = award;
      recordCorrect(q);
      save();
      updateHeader();
      clearHintTimer();
      renderFeedback('ok');
      if (state.round > prevRound) toast('🎉 阳光攒够啦！晋级第 ' + state.round + ' 关');
      $('check-btn').disabled = true;
      $('check-btn').textContent = '✅ 已答对';
      beep('ok');
    } else {
      state.streak = 0;
      if (!current.penalized) {
        state.sun = Math.max(RULE.sunFloor, state.sun - RULE.wrongPenalty);
        current.penalized = true;
      }
      current.attempts += 1;
      if (current.attempts === 1) {
        recordWrong(q, wrongOps.join('、') || '未选运算');
        save();
        unlockHint('已经认真想过啦，口诀提示提前解锁');
        renderFeedback('hint');
        $('check-btn').textContent = '🔁 再检查一次';
        // 清空得数，保留运算选择，方便孩子改
        document.querySelectorAll('[data-answer]').forEach(function (i) { i.value = ''; });
        Object.keys(s).forEach(function (k) { if (/Answer$/.test(k)) s[k] = ''; });
      } else {
        clearHintTimer();
        renderFeedback('answer');
        $('check-btn').disabled = true;
        $('check-btn').textContent = '已看过答案';
      }
      updateHeader();
      beep('bad');
    }
  }

  /* ---------- 错题库 ---------- */
  function renderReview() {
    var s = reviewStats();
    var html = '<div class="review-card">' +
      '<div class="review-header"><div><h2>📕 错题库 · 间隔复习</h2>' +
      '<p>记录只保存在这台设备的浏览器里，刷新和下次打开都还在。</p></div>' +
      '<button class="btn btn-soft" data-action="back-home" style="flex:0 0 auto;min-width:130px">返回抽卡台</button></div>' +
      '<div class="review-stats">' +
      '<div class="stat-box due"><div class="stat-num">' + s.due + '</div><div class="stat-label">现在该复习</div></div>' +
      '<div class="stat-box"><div class="stat-num">' + s.learning + '</div><div class="stat-label">间隔等待中</div></div>' +
      '<div class="stat-box done"><div class="stat-num">' + s.mastered + '</div><div class="stat-label">已掌握</div></div>' +
      '<div class="stat-box"><div class="stat-num">' + s.total + '</div><div class="stat-label">累计错题</div></div>' +
      '</div>' +
      '<div class="review-mechanism"><h3>⏰ 复习是怎么安排的？</h3>' +
      '<p>答错 → 10 分钟后本轮重练；之后每答对一次，复习间隔就拉长一档。满级且连续答对 3 次即「已掌握」。普通抽卡时到期错题会优先出现，但最多占三分之一，不会一直刷同一题。</p>' +
      '<div class="interval-table">' +
      '<div class="interval-item">答错 / 第 0 级<span>10 分钟后</span></div>' +
      '<div class="interval-item">连对 1 次<span>1 天后</span></div>' +
      '<div class="interval-item">连对 2 次<span>2 天后</span></div>' +
      '<div class="interval-item">连对 3 次<span>4 天后</span></div>' +
      '<div class="interval-item">连对 4 次<span>7 天后</span></div>' +
      '<div class="interval-item">满级 · 已掌握<span>15 天后</span></div>' +
      '</div></div>' +
      '<div class="review-toolbar">' +
      '<button class="filter-btn' + (reviewFilter === 'all' ? ' active' : '') + '" data-action="filter" data-filter="all">全部</button>' +
      '<button class="filter-btn' + (reviewFilter === 'due' ? ' active' : '') + '" data-action="filter" data-filter="due">现在该复习</button>' +
      '<button class="filter-btn' + (reviewFilter === 'learning' ? ' active' : '') + '" data-action="filter" data-filter="learning">间隔等待中</button>' +
      '<button class="filter-btn' + (reviewFilter === 'mastered' ? ' active' : '') + '" data-action="filter" data-filter="mastered">已掌握</button>' +
      '<span class="toolbar-spacer"></span>' +
      '<button class="small-btn" data-action="review-start">▶ 开始复习抽卡</button>' +
      '<button class="danger-btn" data-action="clear-records">清空记录</button>' +
      '</div>';

    var pairs = Object.keys(state.records)
      .filter(function (id) { return byId(id) && state.records[id].wrongCount > 0; })
      .map(function (id) { return [id, state.records[id]]; });
    if (reviewFilter === 'due') pairs = pairs.filter(function (p) { return !p[1].mastered && p[1].nextReviewAt <= Date.now(); });
    if (reviewFilter === 'learning') pairs = pairs.filter(function (p) { return !p[1].mastered && p[1].nextReviewAt > Date.now(); });
    if (reviewFilter === 'mastered') pairs = pairs.filter(function (p) { return p[1].mastered; });
    pairs.sort(function (a, b) { return (a[1].nextReviewAt || 0) - (b[1].nextReviewAt || 0); });

    if (!pairs.length) {
      html += '<div class="empty-state"><span class="big">🌻</span>这个分类里还没有题目。<br>答错的题会自动进错题库，也可以手动「加入错题库」。</div>';
    } else {
      html += '<div class="record-list">' + pairs.map(function (p) {
        var q = byId(p[0]), r = p[1];
        var status = r.mastered ? ['已掌握', 'status-mastered']
          : (r.nextReviewAt <= Date.now() ? ['现在该复习', 'status-due'] : ['间隔等待中', 'status-learning']);
        var short = q.text.length > 46 ? q.text.slice(0, 46) + '…' : q.text;
        return '<div class="record-row">' +
          '<div class="record-main"><div class="record-title">' + esc(short) + '</div>' +
          '<div class="record-meta">' + esc(q.scene) + '　|　错 ' + r.wrongCount + ' 次　|　连对 ' + r.correctStreak + ' 次' +
          (r.lastWrongOp ? '　|　上次错在：' + esc(r.lastWrongOp) : '') +
          '<br>上次答错：' + fmtDate(r.lastWrongAt) + '　|　下次复习：' + fmtGap(r.nextReviewAt) +
          '　|　第 ' + r.box + ' 级</div></div>' +
          '<span class="record-status ' + status[1] + '">' + status[0] + '</span>' +
          '<div class="record-actions"><button class="small-btn" data-action="practice-one" data-id="' + q.id + '">再练一次</button></div>' +
          '</div>';
      }).join('') + '</div>';
    }
    html += '</div>';
    $('review-content').innerHTML = html;
    updateHeader();
  }

  /* ---------- 事件 ---------- */
  document.addEventListener('input', function (e) {
    var t = e.target;
    if (t.matches && t.matches('[data-answer]') && current) {
      current.selections[t.dataset.answer + 'Answer'] = t.value;
    }
  });
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-action]');
    if (!btn) return;
    var act = btn.dataset.action;
    switch (act) {
      case 'reset-ask': openResetDialog(); break;
      case 'reset-cancel': closeResetDialog(); break;
      case 'reset-confirm': resetAll(); break;
      case 'mode':
        state.mode = btn.dataset.mode;
        save(); renderHome();
        break;
      case 'select-op':
        if (!current) return;
        current.selections[btn.dataset.slot] = btn.dataset.op;
        var grid = btn.parentElement;
        grid.querySelectorAll('.op-btn').forEach(function (b) {
          b.classList.toggle('selected', b.dataset.op === btn.dataset.op);
        });
        break;
      case 'toggle-hint':
        if (!current) return;
        if (!current.hintUnlocked) {
          toast('先自己想一想，口诀提示马上就来 ⏳');
          return;
        }
        current.hintOpen = !current.hintOpen;
        var hb = $('hint-box');
        if (current.hintOpen && !hb.innerHTML) hb.innerHTML = hintHtml(current.q);
        hb.classList.toggle('hidden', !current.hintOpen);
        btn.textContent = current.hintOpen ? '🔍 收起口诀提示' : '🔍 再看口诀提示';
        break;
      case 'check': checkAnswer(); break;
      case 'next': drawCard({ reviewOnly: current && current.reviewOnly }); break;
      case 'back-home': showView('home'); break;
      case 'add-wrong':
        if (!current) return;
        recordWrong(current.q, '家长手动加入');
        updateHeader();
        toast('已加入错题库，稍后会安排复习 📕');
        break;
      case 'filter':
        reviewFilter = btn.dataset.filter;
        renderReview();
        break;
      case 'review-start': drawCard({ reviewOnly: true }); break;
      case 'practice-one': drawCard({ id: btn.dataset.id }); break;
      case 'clear-records':
        if (window.confirm('确定清空全部错题记录吗？\n记录删除后无法恢复，阳光和徽章进度会保留。')) {
          state.records = {};
          save(); renderReview(); toast('错题记录已清空');
        }
        break;
    }
  });

  document.addEventListener('change', function (e) {
    var t = e.target;
    if (t.id === 'op-pool') { state.mode = t.value; save(); renderHome(); }
    if (t.id === 'theme-pool') { state.theme = t.value; save(); renderHome(); }
  });

  $('btn-draw').addEventListener('click', function () { drawCard({}); });
  $('btn-review').addEventListener('click', function () { showView('review'); });
  $('btn-sound').addEventListener('click', function () {
    state.sound = !state.sound; save(); updateHeader();
    if (state.sound) beep('ok');
  });

  /* 确认层：点遮罩或按 Esc 取消，不误清空 */
  (function () {
    var mask = $('reset-modal');
    if (mask) mask.addEventListener('click', function (e) {
      if (e && e.target === mask) closeResetDialog();
    });
  })();
  document.addEventListener('keydown', function (e) {
    if (e && e.key === 'Escape') closeResetDialog();
  });
  /* 同一浏览器里手机版 / 其他标签页重置了，这里同步回到起点 */
  window.addEventListener('storage', function (e) {
    if (!e || e.key !== KEY) return;
    var before = seenReset;
    state = load();
    seenReset = Number(state.resetCount) || 0;
    if (seenReset !== before) {
      closeResetDialog();
      clearHintTimer();
      current = null;
      showView('home');
      toast('🌱 这个浏览器已重新开始，进度已同步');
      return;
    }
    updateHeader();
    if (view === 'home') renderHome();
    if (view === 'review') renderReview();
  });

  /* ---------- 启动 ---------- */
  function fillPoolSelects() {
    var groups = { 'op-pool': POOLS.op, 'theme-pool': POOLS.theme };
    Object.keys(groups).forEach(function (id) {
      var el = $(id);
      if (!el) return;
      el.innerHTML = groups[id].map(function (p) {
        return '<option value="' + p[0] + '">' + p[1] + '</option>';
      }).join('');
    });
  }
  fillPoolSelects();
  if (state._migrated) {
    delete state._migrated;
    save();
    setTimeout(function () {
      toast('☀️ 计分规则升级：阳光按新口径折算，关卡改看累计阳光；错题记录已保留');
    }, 700);
  }
  updateHeader();
  renderHome();
  showView('home');
})();
