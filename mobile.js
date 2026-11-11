/* 手机版交互 —— 与桌面版共用题库、同一份 localStorage 记录与 Leitner 间隔复习
 * KEY = pvz-math-cards-v1，state 结构与 app.js 完全一致：
 * 手机和电脑在同一域名下打开，阳光 / 连对 / 错题记录 / 复习进度是互通的。
 * 手机版差异：整页不滚动，只有内容区可滚；口诀墙与速查表收进底部抽屉；
 * 两步混合题改成「一次只做一步」的分步翻页，避免小屏纵向堆叠。
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
  var phase = 'answering';
  var reviewFilter = 'all';
  var sheetTab = 'rules';
  var audioCtx = null;
  var fbTimer = null;
  var toastTimer = null;
  /* 本题口诀提示：抽到卡后先自己想 10 秒，倒计时结束才写入页面 */
  var HINT_TICKS = RULE.hintTicks;
  var hintTimer = null;
  var hintToken = 0;

  /* ---------- 状态（结构与桌面版一致） ---------- */
  function defaults() {
    return {
      sun: 0, streak: 0, bestStreak: 0, correct: 0, answered: 0, mixCorrect: 0,
      round: 1, records: {}, recent: [], mode: 'all', theme: 'all', sound: true,
      ruleVersion: RULE.version, resetCount: 0
    };
  }
  function migrate(d) {
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
      var d = JSON.parse(raw), s = defaults();
      var rawVersion = d ? d.ruleVersion : undefined;
      for (var k in s) if (Object.prototype.hasOwnProperty.call(d, k)) s[k] = d[k];
      if (!s.records || typeof s.records !== 'object') s.records = {};
      if (!Array.isArray(s.recent)) s.recent = [];
      /* 还原存档真实版本，避免默认值把旧档误判为已迁移 */
      s.ruleVersion = rawVersion;
      if (migrate(s)) s._migrated = true;
      return s;
    } catch (e) { return defaults(); }
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* 隐私模式下内存运行 */ }
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
      el.id = 'toast'; el.className = 'toast';
      $('app').appendChild(el);
    }
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 2200);
  }

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

  /* ---------- 错题记录 / 间隔复习（与桌面版同规则） ---------- */
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
    r.wrongCount += 1; r.correctStreak = 0; r.box = 0; r.mastered = false;
    r.lastWrongAt = Date.now(); r.lastWrongOp = wrongOps || null;
    r.nextReviewAt = Date.now() + INTERVALS[0];
    save();
  }
  function recordCorrect(q) {
    var r = state.records[q.id];
    if (!r || !r.wrongCount) return;
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
      q: q, attempts: 0, penalized: false, award: null,
      hintOpen: false, hintUnlocked: false, stepIndex: 0,
      reviewOnly: !!opts.reviewOnly,
      isReview: !!(r && r.wrongCount > 0 && !r.mastered),
      selections: {}
    };
    phase = 'answering';
    renderQuiz();
    showView('quiz');
  }

  /* ---------- 视图 ---------- */
  function showView(v) {
    view = v;
    if (v !== 'quiz') clearHintTimer();
    ['home', 'quiz', 'review'].forEach(function (n) {
      $('v-' + n).classList.toggle('hidden', n !== v);
    });
    $('body').scrollTop = 0;
    closeSheet(); closeFb();
    if (v === 'home') renderHome();
    if (v === 'review') renderReview();
    renderTop(); setMainBtn();
  }
  function setMainBtn() {
    var b = $('main-btn');
    if (view === 'home') b.textContent = '🎴 抽一张卡！';
    else if (view === 'review') b.textContent = '🎴 回到抽卡台';
    else if (phase === 'done') b.textContent = '下一张卡 →';
    else if (current && current.q.level === 2)
      b.textContent = current.stepIndex === 0 ? '➡️ 检查第 1 步' : '✅ 检查第 2 步';
    else b.textContent = '✅ 检查答案';
  }
  function renderTop() {
    $('s-sun').textContent = state.sun;
    $('s-streak').textContent = state.streak;
    $('s-review').textContent = reviewStats().total - reviewStats().mastered;
    $('top-sub').textContent = '第 ' + state.round + ' / ' + RULE.maxLevel + ' 关 · 阳光闯关';
  }
  function renderHome() {
    $('home-level').textContent = '🌿 卡池 ' + poolForMode(state.mode, state.theme).length + ' 张';
    if ($('op-pool')) $('op-pool').value = state.mode;
    if ($('theme-pool')) $('theme-pool').value = state.theme;
    var due = duePairs().length, tip = $('home-tip');
    tip.classList.toggle('hidden', !due);
    if (due) tip.textContent = '📕 今天有 ' + due + ' 张错题到期，抽卡时会优先遇到';
    var prog = RULE.levelProgress(state.sun, state.round);
    $('progress-fill').style.width = prog.pct + '%';
    if ($('progress-note')) {
      $('progress-note').textContent = '第 ' + state.round + ' / ' + RULE.maxLevel + ' 关 · 还差 ' + prog.need +
        ' ☀️ · 已答对 ' + state.correct + ' 题';
    }
    var badges = [
      ['📖 口诀小达人', state.correct >= 5],
      ['🔍 场景侦探', state.bestStreak >= 3],
      ['🧮 两步高手', state.mixCorrect >= 3]
    ];
    $('badge-mini').innerHTML = badges.map(function (b) {
      return '<span class="' + (b[1] ? 'on' : '') + '">' + (b[1] ? '✓ ' : '🔒 ') + b[0] + '</span>';
    }).join('');
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
    phase = 'answering';
    reviewFilter = 'all';
    closeFb();
    try { localStorage.removeItem(KEY); } catch (e) { /* 隐私模式下内存重置 */ }
    state = defaults();
    state.sound = sound;
    state.resetCount = n;
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
  function hintHtml() {
    return '<b>读题三步：</b>① 圈数字　② 想清已知什么、求什么　③ 对上口诀<br>' +
      '<b>这一步的口诀：</b>' + esc(currentMnemonic()) + '<br>' +
      '<b>小提示：</b>' + esc(current.q.hint);
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
      box.innerHTML = hintHtml() +
        (reason ? '<div class="hint-unlock-note">' + esc(reason) + '</div>' : '');
      box.classList.remove('hidden');
      box.classList.add('appear');
    }
    if (current.q.level === 2) {
      var sm = $('step-mnemonic');
      if (sm) {
        sm.textContent = '口诀：' + current.q.steps[current.stepIndex].mnemonic;
        sm.classList.remove('locked');
        sm.classList.add('appear');
      }
    }
  }

  /* ---------- 答题卡 ---------- */
  function opGridHtml(slot) {
    return Object.keys(OP).map(function (op) {
      var sel = current && current.selections[slot] === op ? ' selected' : '';
      return '<button class="op-btn op-' + op + sel + '" data-action="select-op" data-slot="' + slot + '" data-op="' + op + '">' +
        '<span>' + OP[op].symbol + ' ' + OP[op].name + '</span><small>' + OP[op].goal + '</small></button>';
    }).join('');
  }
  function renderQuiz() {
    var q = current.q, lvl2 = q.level === 2;
    $('q-tag').textContent = current.isReview ? '📕 复习卡' : '🎴 新抽到';
    $('q-tag').classList.toggle('review', current.isReview);
    $('q-diff').textContent = lvl2 ? '难度 ★★★' : '难度 ★☆☆';
    $('q-img').src = q.art === 'zombies' ? 'assets/zombies.png' : 'assets/plants.png';
    $('q-scene').textContent = '场景：' + q.scene;
    $('q-text').innerHTML = highlight(q.text, q.keywords);
    $('q-key').textContent = '🧭 圈出已知的数量：' + q.keywords.join('　/　');
    $('q-single').classList.toggle('hidden', lvl2);
    $('q-mix').classList.toggle('hidden', !lvl2);
    var hb = $('hint-box');
    hb.classList.add('hidden');
    hb.classList.remove('appear');
    hb.innerHTML = '';
    var ht = $('hint-toggle');
    ht.disabled = true;
    ht.classList.add('waiting');
    ht.textContent = hintCountdownText(HINT_TICKS);
    var sm0 = $('step-mnemonic');
    sm0.textContent = '';
    sm0.classList.remove('appear');
    sm0.classList.add('locked');
    if (lvl2) renderMixStep();
    else {
      $('op-grid').innerHTML = opGridHtml('main');
      $('ans-main').value = '';
      $('ans-unit').textContent = q.unit;
    }
    closeFb();
    setMainBtn();
    startHintCountdown();
  }
  function renderMixStep() {
    var q = current.q, i = current.stepIndex, st = q.steps[i];
    $('step-bar-1').className = i === 0 ? 'active' : 'done';
    $('step-bar-2').className = i === 1 ? 'active' : '';
    $('step-carry').classList.toggle('hidden', i === 0);
    if (i === 1) $('step-carry').textContent = '✅ 第 1 步算出 ' + q.steps[0].answer + '，把它带进第 2 步';
    $('step-label').textContent = st.label;
    $('op-grid-mix').innerHTML = opGridHtml('mix' + i);
    $('ans-mix').value = current.selections['mix' + i + 'Answer'] || '';
    var sm = $('step-mnemonic');
    if (current.hintUnlocked) {
      sm.textContent = '口诀：' + st.mnemonic;
      sm.classList.remove('locked');
    } else {
      sm.textContent = '🔒 这一步的口诀，先自己想一想';
      sm.classList.remove('appear');
      sm.classList.add('locked');
    }
    if (current.hintUnlocked && current.hintOpen) $('hint-box').innerHTML = hintHtml();
    setMainBtn();
  }
  function currentMnemonic() {
    var q = current.q;
    if (q.level === 2) {
      var st = q.steps[current.stepIndex];
      return st.mnemonic + '（第 ' + (current.stepIndex + 1) + ' 步）';
    }
    return q.mnemonic;
  }
  function toggleHint() {
    if (!current) return;
    if (!current.hintUnlocked) {
      toast('先自己想一想，口诀提示马上就来 ⏳');
      return;
    }
    current.hintOpen = !current.hintOpen;
    var box = $('hint-box');
    box.classList.toggle('hidden', !current.hintOpen);
    $('hint-toggle').textContent = current.hintOpen ? '🔍 收起口诀提示' : '🔍 再看口诀提示';
    if (current.hintOpen) box.innerHTML = hintHtml();
  }

  /* ---------- 判分 ---------- */
  function closeFb() {
    clearTimeout(fbTimer);
    $('fb-layer').classList.add('hidden');
  }
  function renderFeedback(kind, award) {
    var q = current.q, html = '<button class="fb-close" data-action="close-fb">✕</button>';
    if (kind === 'ok') {
      var a = award || current.award || { base: 0, bonus: 0, total: 0, retry: false };
      html += '<div class="fb-title">🎉 答对啦！+' + a.total + ' ☀️</div>' +
        '<div class="sun-detail">' + (a.retry ? '🔁 重试答对 +1' : '✅ 答对基础 +' + a.base) +
        (a.bonus ? '　·　🔥 连对加成 +' + a.bonus : '') + '</div>' +
        '<div class="fb-formula">' + esc(q.formula) + '</div>' +
        '<div class="fb-line">口诀：' + esc(q.mnemonic) + '</div>' +
        '<div class="fb-explain">' + esc(q.explain) + '</div>';
    } else if (kind === 'hint') {
      html += '<div class="fb-title">🤔 差一点点，先别看答案！ −' + RULE.wrongPenalty + ' ☀️</div>' +
        '<div class="fb-explain">再读一遍题目，想想<b>已经知道什么、要求什么</b>，别只盯着一个词。' +
        '口诀提示已经帮你展开啦，对照着再试一次。' +
        (q.level === 2 ? '两步题要一步一步算，别急着跳到第 2 步。' : '') +
        '<br><b>你还有 1 次重试机会，答对可拿回 +' + RULE.retryGain + ' ☀️。</b></div>';
    } else {
      html += '<div class="fb-title">📖 这题先记住这个算式</div>' +
        '<div class="fb-formula">' + esc(q.formula) + '</div>' +
        '<div class="fb-line">口诀：' + esc(q.mnemonic) + '</div>' +
        '<div class="fb-explain">' + esc(q.explain) + '</div>' +
        '<div class="fb-explain">已放进错题库：10 分钟后再遇到，之后按 1/2/4/7/15 天间隔复习。</div>';
    }
    var card = $('fb-card');
    card.className = 'fb-card ' + (kind === 'ok' ? 'ok' : 'bad');
    card.innerHTML = html;
    $('fb-layer').classList.remove('hidden');
    if (kind === 'ok') fbTimer = setTimeout(closeFb, 4000);
  }
  function succeed(q) {
    clearHintTimer();
    state.answered += 1;
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
    state.round = Math.max(state.round, RULE.levelForSun(state.sun));
    current.award = award;
    recordCorrect(q); save();
    phase = 'done';
    renderFeedback('ok', award);
    if (state.round > prevRound) toast('🎉 阳光攒够啦！晋级第 ' + state.round + ' 关');
    renderTop(); setMainBtn(); beep('ok');
  }
  function fail(q, wrongOps) {
    state.streak = 0;
    if (!current.penalized) {
      state.sun = Math.max(RULE.sunFloor, state.sun - RULE.wrongPenalty);
      current.penalized = true;
    }
    current.attempts += 1;
    if (current.attempts === 1) {
      recordWrong(q, wrongOps || '未选运算'); save();
      var inp = q.level === 1 ? $('ans-main') : $('ans-mix');
      inp.value = '';
      if (q.level === 2) current.selections['mix' + current.stepIndex + 'Answer'] = '';
      else current.selections.mainAnswer = '';
      unlockHint('已经认真想过啦，口诀提示提前解锁');
      renderFeedback('hint');
    } else {
      clearHintTimer();
      phase = 'done';
      renderFeedback('answer');
      setMainBtn();
    }
    renderTop(); beep('bad');
  }
  function checkSingle() {
    var q = current.q, s = current.selections;
    var raw = $('ans-main').value, ans = parseInt(raw, 10);
    if (!s.main || raw === '' || isNaN(ans)) { toast('先选好运算，再填上得数哦 ✏️'); return; }
    var wrong = [];
    if (s.main !== q.op) wrong.push(OP[s.main].name);
    if (ans !== q.answer) wrong.push('得数算错');
    if (s.main === q.op && ans === q.answer) succeed(q);
    else fail(q, wrong.join('、'));
  }
  function checkMix() {
    var q = current.q, i = current.stepIndex, st = q.steps[i], s = current.selections;
    var slot = 'mix' + i, raw = $('ans-mix').value, ans = parseInt(raw, 10);
    if (!s[slot] || raw === '' || isNaN(ans)) { toast('先选这一步的运算，再填得数哦 ✏️'); return; }
    var wrong = [];
    if (s[slot] !== st.op) wrong.push('第 ' + (i + 1) + ' 步选了' + OP[s[slot]].name);
    if (ans !== st.answer) wrong.push('第 ' + (i + 1) + ' 步得数算错');
    if (s[slot] === st.op && ans === st.answer) {
      if (i === 0) {
        current.stepIndex = 1;
        renderMixStep();
        toast('第 1 步对啦！把 ' + st.answer + ' 带进第 2 步 ⬇️');
        return;
      }
      succeed(q);
    } else {
      fail(q, wrong.join('、'));
    }
  }

  /* ---------- 错题库 ---------- */
  function renderReview() {
    var s = reviewStats();
    $('rv-stats').innerHTML =
      '<div class="hot"><b>' + s.due + '</b><small>现在该复习</small></div>' +
      '<div><b>' + s.learning + '</b><small>间隔等待中</small></div>' +
      '<div><b>' + s.mastered + '</b><small>已掌握</small></div>' +
      '<div><b>' + s.total + '</b><small>累计错题</small></div>';
    var filters = [['all', '全部'], ['due', '该复习'], ['learning', '等待中'], ['mastered', '已掌握']];
    $('rv-filters').innerHTML = filters.map(function (f) {
      return '<button data-action="filter" data-filter="' + f[0] + '" class="' + (reviewFilter === f[0] ? 'active' : '') + '">' + f[1] + '</button>';
    }).join('');

    var pairs = Object.keys(state.records)
      .filter(function (id) { return byId(id) && state.records[id].wrongCount > 0; })
      .map(function (id) { return [id, state.records[id]]; });
    if (reviewFilter === 'due') pairs = pairs.filter(function (p) { return !p[1].mastered && p[1].nextReviewAt <= Date.now(); });
    if (reviewFilter === 'learning') pairs = pairs.filter(function (p) { return !p[1].mastered && p[1].nextReviewAt > Date.now(); });
    if (reviewFilter === 'mastered') pairs = pairs.filter(function (p) { return p[1].mastered; });
    pairs.sort(function (a, b) { return (a[1].nextReviewAt || 0) - (b[1].nextReviewAt || 0); });

    if (!pairs.length) {
      $('rv-list').innerHTML = '<div class="rv-empty">🌻 这个分类里还没有题目。<br>答错的题会自动进来，也可以手动「加入错题库」。</div>';
    } else {
      $('rv-list').innerHTML = pairs.map(function (p) {
        var q = byId(p[0]), r = p[1];
        var status = r.mastered ? ['已掌握', 'mastered']
          : (r.nextReviewAt <= Date.now() ? ['现在该复习', 'due'] : ['间隔等待中', '']);
        var short = q.text.length > 34 ? q.text.slice(0, 34) + '…' : q.text;
        return '<div class="rv-row"><div class="rv-row-top"><b>' + esc(short) + '</b>' +
          '<span class="rv-status ' + status[1] + '">' + status[0] + '</span></div>' +
          '<p>' + esc(q.scene) + '　|　错 ' + r.wrongCount + ' 次 · 连对 ' + r.correctStreak + ' 次' +
          (r.lastWrongOp ? ' · 上次错在 ' + esc(r.lastWrongOp) : '') +
          '<br>上次答错 ' + fmtDate(r.lastWrongAt) + '　|　下次复习 ' + fmtGap(r.nextReviewAt) + '　|　第 ' + r.box + ' 级</p>' +
          '<button data-action="practice-one" data-id="' + q.id + '">再练一次</button></div>';
      }).join('');
    }
  }

  /* ---------- 底部抽屉 ---------- */
  var RULES = [
    ['add', '＋ 加法 · 求总数', '部分 + 部分 = 总数', '已知两部分，求合起来的总量', '两堆各多少都给了，问合起来是多少'],
    ['sub', '－ 减法 · 求另一部分', '总数 − 部分 = 剩下的部分', '已知总数和其中一部分，求另一部分', '总数已给，问另一部分'],
    ['mul', '× 乘法 · 求总数', '每份个数 × 份数 = 总数', '每份一样多，知道每份个数和份数', '每份几个、共几份都给了'],
    ['div', '÷ 除法 · 求份数或每份', '总数 ÷ 每份个数 = 份数<br>总数 ÷ 份数 = 每份个数', '知道总数，按份数或每份个数去分', '总数已给，要把它分开']
  ];
  function openSheet(tab) {
    sheetTab = tab || 'rules';
    $('sheet').classList.remove('hidden');
    $('sheet-mask').classList.remove('hidden');
    renderSheet();
  }
  function closeSheet() {
    $('sheet').classList.add('hidden');
    $('sheet-mask').classList.add('hidden');
  }
  function renderSheet() {
    var titles = { rules: '口诀记忆墙', cheat: '已知 / 求什么 → 运算', more: '进度 / 更多' };
    $('sheet-title').textContent = titles[sheetTab];
    document.querySelectorAll('#sheet-tabs button').forEach(function (b) {
      b.classList.toggle('active', b.dataset.tab === sheetTab);
    });
    var html = '';
    if (sheetTab === 'rules') {
      html = RULES.map(function (r) {
        return '<div class="rule-card rule-' + r[0] + '"><h3>' + r[1] + '</h3>' +
          '<p>' + r[2] + '</p><small>' + r[3] + '　·　' + r[4] + '</small></div>';
      }).join('') + '<div class="sheet-note">💡 小秘诀：口诀读出声，记得更牢！抽卡前先读一遍。</div>';
    } else if (sheetTab === 'cheat') {
      html = '<div class="cheat-row rule-add"><span>两堆各是多少都给了，求合起来的量</span><em>→ ＋ 加法</em></div>' +
        '<div class="cheat-row rule-sub"><span>总数和其中一部分已知，求另一部分</span><em>→ － 减法</em></div>' +
        '<div class="cheat-row rule-mul"><span>每份一样多，知道每份个数与份数，求总数</span><em>→ × 乘法</em></div>' +
        '<div class="cheat-row rule-div"><span>总数已知，按份数或每份个数去分</span><em>→ ÷ 除法</em></div>' +
        '<div class="sheet-note">⚠️ 别只盯一个词：同一个词在不同题目里可能对应不同运算。先圈数字，再想清<b>已知什么、求什么</b>，最后对上口诀。</div>';
    } else {
      var s = reviewStats();
      var prog = RULE.levelProgress(state.sun, state.round);
      html = '<div class="sheet-block"><h3>🏆 阳光闯关 · 第 ' + state.round + ' / ' + RULE.maxLevel + ' 关</h3>' +
        '<p>累计阳光 ' + state.sun + ' / ' + prog.target + '　·　本关还需 ' + prog.need + ' ☀️<br>' +
        '连对 ' + state.streak + '　·　已答对 ' + state.correct + ' 题　·　已答 ' + state.answered + ' 题</p>' +
        '<p>攒够本关要求的阳光才能进下一关；答对 +2 / 两步题 +4，连对再加 +1～+3，答错 −2 ☀️。</p></div>' +
        '<div class="sheet-block"><h3>📕 错题库 · 间隔复习</h3>' +
        '<p>累计 ' + s.total + ' 题，其中 ' + s.due + ' 题现在该复习、' + s.learning + ' 题在间隔等待、' + s.mastered + ' 题已掌握。答错 10 分钟后重练，之后每答对一次按 1/2/4/7/15 天拉长间隔。</p></div>' +
        '<div class="sheet-block"><h3>👨‍👩‍👧 家长小贴士</h3>' +
        '<p>每天 10 分钟：先读口诀，再抽卡。答错时只给一次重试和提示，不直接说答案。二年级上学期建议只用「单一运算」卡池，两步混合作为和爸爸妈妈一起做的挑战关。</p></div>' +
        '<button class="sheet-link" data-action="toggle-sound">🔊 音效：' + (state.sound ? '开（点击关闭）' : '关（点击开启）') + '</button>' +
        '<button class="sheet-link" data-action="go-desktop">🖥 切换到电脑版（宽屏三栏）</button>' +
        '<button class="sheet-link" data-action="review">📕 打开错题库</button>' +
        '<button class="sheet-link reset" data-action="reset-ask">🔄 重新开始 · 清空本浏览器进度</button>';
    }
    $('sheet-body').innerHTML = html;
    $('sheet-body').scrollTop = 0;
  }

  /* ---------- 事件 ---------- */
  document.addEventListener('input', function (e) {
    if (!current) return;
    var t = e.target;
    if (t.id === 'ans-main') current.selections.mainAnswer = t.value;
    if (t.id === 'ans-mix') current.selections['mix' + current.stepIndex + 'Answer'] = t.value;
  });
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-action]');
    if (!btn) return;
    var act = btn.dataset.action;
    switch (act) {
      case 'main':
        if (view === 'review') { showView('home'); break; }
        if (view === 'home') { drawCard({}); break; }
        if (view === 'quiz') {
          if (phase === 'done') { drawCard({ reviewOnly: current && current.reviewOnly }); break; }
          if (current.q.level === 1) checkSingle(); else checkMix();
        }
        break;
      case 'review': showView('review'); break;
      case 'reset-ask': openResetDialog(); break;
      case 'reset-cancel': closeResetDialog(); break;
      case 'reset-confirm': resetAll(); break;
      case 'mode':
        state.mode = btn.dataset.mode; save(); renderHome();
        break;
      case 'select-op':
        if (!current) return;
        current.selections[btn.dataset.slot] = btn.dataset.op;
        btn.parentElement.querySelectorAll('.op-btn').forEach(function (b) {
          b.classList.toggle('selected', b.dataset.op === btn.dataset.op);
        });
        break;
      case 'hint': if (current) toggleHint(); break;
      case 'add-wrong':
        if (!current) return;
        recordWrong(current.q, '家长手动加入'); renderTop();
        toast('已加入错题库，稍后会安排复习 📕');
        break;
      case 'close-fb': closeFb(); break;
      case 'open-sheet': openSheet(btn.dataset.sheet); break;
      case 'close-sheet': closeSheet(); break;
      case 'sheet-tab': sheetTab = btn.dataset.tab; renderSheet(); break;
      case 'toggle-sound':
        state.sound = !state.sound; save(); renderSheet();
        if (state.sound) beep('ok');
        break;
      case 'go-desktop':
        try { sessionStorage.setItem('pvz-desktop', '1'); } catch (e2) { /* ignore */ }
        /* 切回电脑版时保留原有查询参数 */
        var carry = location.search.replace(/^\?/, '');
        location.href = 'index.html?desktop=1' + (carry ? '&' + carry : '');
        break;
      case 'filter': reviewFilter = btn.dataset.filter; renderReview(); break;
      case 'review-start': drawCard({ reviewOnly: true }); break;
      case 'practice-one': drawCard({ id: btn.dataset.id }); break;
      case 'clear-records':
        if (window.confirm('确定清空全部错题记录吗？\n记录删除后无法恢复，阳光和徽章进度会保留。')) {
          state.records = {}; save(); renderReview(); renderTop();
          toast('错题记录已清空');
        }
        break;
    }
  });
  document.addEventListener('change', function (e) {
    var t = e.target;
    if (t.id === 'op-pool') { state.mode = t.value; save(); renderHome(); }
    if (t.id === 'theme-pool') { state.theme = t.value; save(); renderHome(); }
  });
  $('sheet-mask').addEventListener('click', closeSheet);

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
  // 同一浏览器里电脑版标签页 / 其他标签页改动了记录，这里同步刷新
  window.addEventListener('storage', function (e) {
    if (!e || e.key !== KEY) return;
    var before = seenReset;
    state = load();
    seenReset = Number(state.resetCount) || 0;
    if (seenReset !== before) {
      closeResetDialog();
      clearHintTimer();
      current = null;
      phase = 'answering';
      showView('home');
      toast('🌱 这个浏览器已重新开始，进度已同步');
      return;
    }
    renderTop();
    if (view === 'home') renderHome();
    if (view === 'review') renderReview();
    if (!$('sheet').classList.contains('hidden') && sheetTab === 'more') renderSheet();
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
  renderTop();
  renderHome();
  setMainBtn();
})();
