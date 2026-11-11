# -*- coding: utf-8 -*-
"""
生成「植物大战僵尸 · 二年级数学抽卡训练营」题库 questions.js
目标：加 / 减 / 乘 / 除 / 两步混合 各 120 题，合计 600 题。
设计要点：
  1) 严格沿用用户给定四句口诀（加法/减法/乘法/除法两条口径）。
  2) 题干措辞大量变式，不依赖「一共 / 还剩 / 平均分」这类固定触发词。
  3) 约 1/3 题目刻意植入「诱饵词」（减法题里出现「一共」、加法题里出现「每」等），
     但数学结构不变；explain 里逐题点破，训练「看已知什么、求什么」而不是看词猜运算。
  4) keywords 字段改存题干里真实出现的「数量短语」，只用于高亮圈数字，不泄露运算。
  5) 每题带 theme（场景主题），支持运算类型 + 场景双维度卡池。
"""
import json
import os
import random
import re

random.seed(20261110)

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'questions.js')
# 逐题人工润色后的最终题干 / 数量短语 / 解析 / 答案单位覆盖表。
# 模板只负责生成数字与结构；面向孩子的文字一律以覆盖表为准。
# 注意：不要改动下面的模板措辞——模板文本参与去重，改动会让 random 序列漂移，
# 导致题号对应的数字变化、覆盖表与算式对不上。
OVERRIDES = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'text_overrides.json')
PER_TYPE = 120

THEMES = {
    'lawn':   dict(name='草坪',   place='草坪上',   container='花坛',   actor='植物小队', u='株', items=['向日葵', '豌豆射手', '坚果墙', '寒冰射手']),
    'zombie': dict(name='僵尸',   place='小路尽头', container='队伍',   actor='僵尸小队', u='只', items=['普通僵尸', '路障僵尸', '铁桶僵尸', '旗帜僵尸']),
    'sun':    dict(name='阳光',   place='阳光架旁', container='阳光袋', actor='收集员',   u='颗', items=['金色阳光', '普通阳光', '大颗阳光']),
    'pool':   dict(name='泳池',   place='泳池里',   container='浮板',   actor='水路小队', u='片', items=['睡莲叶', '浮萍', '荷叶']),
    'night':  dict(name='夜晚',   place='夜幕下的草坪', container='小花盆', actor='夜班小队', u='朵', items=['小蘑菇', '喷射蘑菇', '胆小菇']),
    'roof':   dict(name='屋顶',   place='屋顶上',   container='瓦盆',   actor='屋顶小队', u='盆', items=['投手盆栽', '藤蔓盆栽', '多肉盆栽']),
    'tool':   dict(name='道具',   place='道具箱里', container='工具格', actor='园丁',     u='个', items=['樱桃炸弹', '小铲子', '肥料包']),
    'card':   dict(name='卡包',   place='卡包里',   container='卡格',   actor='整理员',   u='张', items=['植物卡', '僵尸卡', '道具卡']),
}
THEME_KEYS = list(THEMES.keys())

OP_INFO = {
    'add': dict(symbol='＋', name='加法', goal='求总数',
                mnemonic='部分 + 部分 = 总数', clue='已知两部分，求合起来的总量',
                bg='#FFF3C4', fg='#8A5A0C'),
    'sub': dict(symbol='－', name='减法', goal='求另一部分',
                mnemonic='总数 − 部分 = 剩下的部分', clue='已知总数和其中一部分，求另一部分',
                bg='#DCEEFF', fg='#1D5B96'),
    'mul': dict(symbol='×', name='乘法', goal='求总数',
                mnemonic='每份个数 × 份数 = 总数', clue='每份一样多，知道每份个数和份数，求总数',
                bg='#EADFFF', fg='#6A3F9E'),
    'div': dict(symbol='÷', name='除法', goal='求份数或每份',
                mnemonic='总数 ÷ 每份个数 = 份数；总数 ÷ 份数 = 每份个数',
                clue='知道总数，按份数或每份个数去分', bg='#DFF5E4', fg='#1F7A45'),
}

POOL_GROUPS = {
    'op': [['all', '全部题型'], ['single', '单一运算'], ['add', '加法专项'],
           ['sub', '减法专项'], ['mul', '乘法专项'], ['div', '除法专项'], ['mix', '两步混合']],
    'theme': [['all', '全部场景']] + [[k, THEMES[k]['name']] for k in THEME_KEYS],
}

# ---------------------------------------------------------------- 模板工具
def T(text, clues, decoy=None, note=None):
    return dict(text=text, clues=clues, decoy=decoy, note=note)


def nums(kind):
    """按二年级表内范围生成一组数字占位符。"""
    a = random.randint(2, 45)
    b = random.randint(2, 45)
    n = random.randint(2, 9)
    m = random.randint(2, 9)
    c = random.randint(1, 9)
    t = random.randint(12, 96)
    if kind == 'add':
        while a + b > 98:
            a, b = random.randint(2, 45), random.randint(2, 45)
        t = a + b
    elif kind == 'sub':
        b = random.randint(1, t - 1)
        a = t - b
    elif kind in ('mul', 'div'):
        t = n * m
        a, b = m, n
    return dict(a=a, b=b, t=t, n=n, m=m, c=c)


def ctx_for(theme_key, num):
    th = THEMES[theme_key]
    pair = random.sample(th['items'], 2)
    d = dict(num)
    d.update(place=th['place'], container=th['container'], actor=th['actor'],
             u=th['u'], A=pair[0], B=pair[1], name=th['name'])
    return d


def fmt(s, c):
    return s.format(**c)


def clean_text(s):
    """收紧数字短语与中文连接词之间多余的空格，让题干读起来自然。"""
    return s.replace(' 和 ', '和').replace(' 是', '是').replace(' 的', '的')


def choose_tpl(templates, decoy_rate=0.35):
    """让含诱饵词的模板稳定占约三分之一，保证反定势训练的密度。"""
    decoys = [t for t in templates if t.get('decoy')]
    plains = [t for t in templates if not t.get('decoy')]
    if decoys and random.random() < decoy_rate:
        return random.choice(decoys)
    return random.choice(plains or templates)


def scene_for(theme_key):
    """场景标签只描述场景。

    早期版本写成「卡包 · 减法情境」「泳池 · 先加后除 · 求每份」，
    等于在答题前直接公布该用哪种运算，与「看已知什么、求什么」的训练目标冲突。
    桌面版题库头、错题库记录、手机版都直接显示 scene，因此必须从数据层去掉。
    """
    return THEMES[theme_key]['name']


def apply_overrides(bank):
    """套用逐题润色终稿（题干 / 数量短语 / 解析 / 答案单位）。"""
    with open(OVERRIDES, encoding='utf-8') as f:
        data = json.load(f)
    missing = [q['id'] for q in bank if q['id'] not in data]
    if missing:
        raise RuntimeError('覆盖表缺题：' + ','.join(missing[:10]))
    for q in bank:
        q.update(data[q['id']])
    return bank

# ---------------------------------------------------------------- 单一运算模板
ADD_T = [
    T('{place}摆着 {a} {u}{A}，旁边又添了 {b} {u}{B}，两样并在一起是多少{u}？', ['{a} {u}{A}', '{b} {u}{B}']),
    T('上午收了 {a} {u}{A}，下午又收了 {b} {u}{B}，这一天总共收进多少{u}？', ['{a} {u}{A}', '{b} {u}{B}']),
    T('{container}左边有 {a} {u}{A}，右边有 {b} {u}{B}，把两边合到一处，一共有几{u}？', ['{a} {u}{A}', '{b} {u}{B}']),
    T('先摆好 {b} {u}{B}，随后补上 {a} {u}{A}，算上原先那些，现在是多少{u}？', ['{b} {u}{B}', '{a} {u}{A}']),
    T('袋里装着 {a} {u}{A} 和 {b} {u}{B}，全倒进{container}后，里面有几{u}？', ['{a} {u}{A}', '{b} {u}{B}']),
    T('第一堆放 {a} {u}，第二堆放 {b} {u}，两堆并成一堆是几{u}？', ['{a} {u}', '{b} {u}']),
    T('{actor}先带来 {a} {u}{A}，后来又送来 {b} {u}{B}，前后加起来有几{u}？', ['{a} {u}{A}', '{b} {u}{B}']),
    T('{place}数了数，{A}有 {a} {u}，{B}有 {b} {u}，这两类一共是多少{u}？', ['{a} {u}', '{b} {u}']),
    T('把 {a} {u}{A} 和 {b} {u}{B} 装进同一个{container}，这个{container}里有几{u}？', ['{a} {u}{A}', '{b} {u}{B}']),
    T('每{u}{A}都贴好了标签，{place}点清了 {a} {u}{A} 和 {b} {u}{B}，这两样合起来有几{u}？',
      ['{a} {u}{A}', '{b} {u}{B}'], decoy='每', note='「每」只是说每{u}{A}都贴了标签，题目并没有给出「每份几个、一共几份」，两堆各是多少都写明白了，求合起来的量用加法。'),
    T('还剩 {a} {u}{A} 没安排，仓库又补发 {b} {u}{B}，现在能安排的是多少{u}？',
      ['{a} {u}{A}', '{b} {u}{B}'], decoy='还剩', note='「还剩」说的是原来留着的那一份，并没有谁被拿走；这里是把留下的和新补的合起来，用加法。'),
    T('{a} {u}{A} 已经就位，{b} {u}{B} 跟着到位，{actor}手上一共有几{u}？',
      ['{a} {u}{A}', '{b} {u}{B}']),
]

SUB_T = [
    T('{place}一共有 {t} {u}{A}和{B}混放着，数出 {b} {u} 是{B}，那{A}有几{u}？',
      ['{t} {u}{A}', '{b} {u}'], decoy='一共', note='这里的「一共」说的是总数已经知道，不是让你把两部分加起来；要求的是另一部分，用减法。'),
    T('收了 {t} {u}{A}，种下时用掉 {b} {u}，还留下多少{u}？', ['{t} {u}{A}', '{b} {u}']),
    T('{container}里原本有 {t} {u}，取走 {b} {u} 之后，里面还有几{u}？', ['{t} {u}', '{b} {u}']),
    T('{t} {u}{A} 里，有 {b} {u} 已经交给了{actor}，没交出去的是几{u}？', ['{t} {u}{A}', '{b} {u}']),
    T('{place}站着 {t} {u}僵尸，被打退 {b} {u}，仍站在原地的还有多少{u}？', ['{t} {u}僵尸', '{b} {u}']),
    T('一共 {t} {u}卡，植物卡占 {b} {u}，僵尸卡有多少{u}？',
      ['{t} {u}卡', '{b} {u}'], decoy='一共', note='这里的「一共」是告诉你总张数，问题是求其中一类，所以要从总数里去掉已知的一类，用减法。'),
    T('篮子里装了 {t} {u}，分给同伴 {b} {u}，自己留下几{u}？', ['{t} {u}', '{b} {u}']),
    T('计划摆 {t} {u}，已经摆好 {b} {u}，还差多少{u}没摆？', ['{t} {u}', '{b} {u}']),
    T('每排都摆得一样多，{t} {u}{A} 里挑出 {b} {u} 坏的，好的还剩几{u}？',
      ['{t} {u}{A}', '{b} {u}'], decoy='每排', note='「每排」只是说摆得整齐，题目既没给份数也没给每份个数；已知总数和去掉的一部分，求另一部分用减法。'),
    T('{t} {u}{A} 摆成一堆，{b} {u} 被{actor}借走，堆里剩几{u}？', ['{t} {u}{A}', '{b} {u}']),
    T('总共有 {t} {u}，{A}占 {b} {u}，归{B}的是几{u}？', ['{t} {u}', '{b} {u}']),
    T('{place}原有 {t} {u}，清走 {b} {u} 后，需要重新补上的空位是多少{u}？', ['{t} {u}', '{b} {u}']),
]

MUL_T = [
    T('{place}摆了 {n} 排{A}，每排 {m} {u}，全部一共是多少{u}？', ['{n} 排', '{m} {u}']),
    T('{n} 个{container}，每个装 {m} {u}{A}，合起来有几{u}？', ['{n} 个{container}', '{m} {u}{A}']),
    T('{actor}分成 {n} 队，每队 {m} {u}，总共是多少{u}？', ['{n} 队', '{m} {u}']),
    T('每天收 {m} {u}{A}，连着收了 {n} 天，一共收进几{u}？', ['{m} {u}{A}', '{n} 天']),
    T('{container}每格放 {m} {u}{A}，{n} 个格子都放满，一共是几{u}？', ['{m} {u}{A}', '{n} 个格子']),
    T('{n} 个花盘，每盘 {m} {u}，把这些花盘都装满，需要几{u}？', ['{n} 个花盘', '{m} {u}']),
    T('还剩 {n} 排没补种，每排补 {m} {u}，一共要补多少{u}？',
      ['{n} 排', '{m} {u}'], decoy='还剩', note='「还剩」说的是没补种的排数，不是从总数里拿走东西；每份一样多、知道份数求总数，用乘法。'),
    T('{place}每个角落摆 {m} {u}，一共 {n} 个角落，算下来是几{u}？', ['{m} {u}', '{n} 个角落']),
    T('把 {m} {u}{A} 装成一份，这样的份数有 {n} 份，总共有多少{u}？', ['{m} {u}{A}', '{n} 份']),
    T('{n} 名{actor}，每人拿 {m} {u}，大家手里加起来有几{u}？', ['{n} 名', '{m} {u}']),
    T('一排 {m} {u}，照这样摆 {n} 排，最后一共有几{u}？', ['{m} {u}', '{n} 排']),
    T('每袋装 {m} {u}{A}，装了 {n} 袋，柜子里一共放进多少{u}？', ['{m} {u}{A}', '{n} 袋']),
]

DIV_PER_T = [  # 已知总数与份数，求每份个数
    T('{t} {u}{A}，平均装进 {n} 个{container}，每个{container}装几{u}？', ['{t} {u}{A}', '{n} 个{container}']),
    T('{actor}把 {t} {u} 平分给 {n} 名队员，每人拿到几{u}？', ['{t} {u}', '{n} 名']),
    T('{t} {u}{A} 平均摆成 {n} 排，每排摆几{u}？', ['{t} {u}{A}', '{n} 排']),
    T('一共 {t} {u}，平均分到 {n} 处，每处是几{u}？',
      ['{t} {u}', '{n} 处'], decoy='一共', note='「一共」只说明总数已知，题目要把它按份数分开，求每份个数用除法。'),
    T('每袋装得一样多，{t} {u} 正好装满 {n} 袋，每袋有几{u}？',
      ['{t} {u}', '{n} 袋'], decoy='每', note='这里「每」问的正是每份个数，而份数也给了，用除法；别因为看到「每」就想到乘法。'),
    T('{t} {u}{A} 由 {n} 个{container}平均分，一个{container}分到几{u}？', ['{t} {u}{A}', '{n} 个{container}']),
]
DIV_GROUP_T = [  # 已知总数与每份个数，求份数
    T('{t} {u}{A}，每个{container}装 {m} {u}，能装满几个{container}？', ['{t} {u}{A}', '{m} {u}']),
    T('把 {t} {u} 按每 {m} {u} 一组分开，可以分出几组？', ['{t} {u}', '{m} {u}']),
    T('{t} {u}{A} 摆成每排 {m} {u}，一共能摆几排？', ['{t} {u}{A}', '{m} {u}']),
    T('还剩 {t} {u}要装箱，每箱 {m} {u}，需要几个箱子？',
      ['{t} {u}', '{m} {u}'], decoy='还剩', note='「还剩」只是说明还没摆放的总量，题目问的是按每份个数能分几份，用除法。'),
    T('{actor}每趟运 {m} {u}，{t} {u} 要运几趟？', ['{m} {u}', '{t} {u}']),
    T('{t} {u}{A}，每 {m} {u} 扎成一束，能扎多少束？', ['{t} {u}{A}', '{m} {u}']),
]

# ---------------------------------------------------------------- 两步混合模板
def mix_struct(key, label, ops, templates, build):
    return dict(key=key, label=label, ops=ops, templates=templates, build=build)


def build_add_div_per(c):
    # 先定份数与每份个数，反推总数，保证一定能整除
    n = random.randint(2, 9)
    q = random.randint(2, 9)
    s = n * q
    a = random.randint(1, s - 1)
    b = s - a
    c.update(a=a, b=b, n=n, s=s, q=q)
    return q, '({a} + {b}) ÷ {n} = {q}（{u}）', [
        dict(op='add', answer=s, formula='{a} + {b} = {s}（{u}）'),
        dict(op='div', answer=q, formula='{s} ÷ {n} = {q}（{u}）')]


def build_add_div_group(c):
    m = random.randint(2, 9)
    q = random.randint(2, 9)
    s = m * q
    a = random.randint(1, s - 1)
    b = s - a
    c.update(a=a, b=b, m=m, s=s, q=q)
    return q, '({a} + {b}) ÷ {m} = {q}（组）', [
        dict(op='add', answer=s, formula='{a} + {b} = {s}（{u}）'),
        dict(op='div', answer=q, formula='{s} ÷ {m} = {q}（组）')]


def build_sub_div(c):
    n = random.randint(2, 9)
    q = random.randint(2, 9)
    s = n * q
    b = random.randint(1, 20)
    t = s + b
    c.update(t=t, b=b, n=n, s=s, q=q)
    return q, '({t} − {b}) ÷ {n} = {q}（{u}）', [
        dict(op='sub', answer=s, formula='{t} − {b} = {s}（{u}）'),
        dict(op='div', answer=q, formula='{s} ÷ {n} = {q}（{u}）')]


def build_mul_add(c):
    n, m, k = c['n'], c['m'], c['c']
    s, q = n * m, n * m + k
    c.update(s=s, q=q)
    return q, '{m} × {n} + {c} = {q}（{u}）', [
        dict(op='mul', answer=s, formula='{m} × {n} = {s}（{u}）'),
        dict(op='add', answer=q, formula='{s} + {c} = {q}（{u}）')]


def build_mul_sub(c):
    n, m = c['n'], c['m']
    s = n * m
    k = random.randint(1, max(1, s - 1))
    q = s - k
    c.update(c=k, s=s, q=q)
    return q, '{m} × {n} − {c} = {q}（{u}）', [
        dict(op='mul', answer=s, formula='{m} × {n} = {s}（{u}）'),
        dict(op='sub', answer=q, formula='{s} − {c} = {q}（{u}）')]


def build_div_add(c):
    n, m = c['n'], c['m']
    t, q1, k = n * m, m, c['c']
    q = q1 + k
    c.update(t=t, q1=q1, q=q)
    return q, '{t} ÷ {n} + {c} = {q}（{u}）', [
        dict(op='div', answer=q1, formula='{t} ÷ {n} = {q1}（{u}）'),
        dict(op='add', answer=q, formula='{q1} + {c} = {q}（{u}）')]


def build_div_sub(c):
    n, m = c['n'], c['m']
    t, q1 = n * m, m
    q = t - q1
    c.update(t=t, q1=q1, q=q)
    return q, '{t} − {t} ÷ {n} = {q}（{u}）', [
        dict(op='div', answer=q1, formula='{t} ÷ {n} = {q1}（{u}）'),
        dict(op='sub', answer=q, formula='{t} − {q1} = {q}（{u}）')]


def build_add_sub(c):
    a, b = c['a'], c['b']
    s = a + b
    k = random.randint(1, max(1, s - 1))
    q = s - k
    c.update(c=k, s=s, q=q)
    return q, '{a} + {b} − {c} = {q}（{u}）', [
        dict(op='add', answer=s, formula='{a} + {b} = {s}（{u}）'),
        dict(op='sub', answer=q, formula='{s} − {c} = {q}（{u}）')]


MIX_STRUCTS = [
    mix_struct('add_div_per', '先加后除 · 求每份', ['add', 'div'], [
        T('先来了 {a} {u}{A}，又来了 {b} {u}{B}，把它们平均分成 {n} 队，每队有几{u}？', ['{a} {u}{A}', '{b} {u}{B}']),
        T('{container}里已有 {a} {u}{A}，再放进去 {b} {u}{B}，现在平均装进 {n} 个{container}，每个装几{u}？', ['{a} {u}{A}', '{b} {u}{B}']),
        T('{actor}收到 {a} {u}{A} 和 {b} {u}{B}，合在一起后平分给 {n} 名队员，每人几{u}？', ['{a} {u}{A}', '{b} {u}{B}']),
    ], build_add_div_per),
    mix_struct('add_div_group', '先加后除 · 求份数', ['add', 'div'], [
        T('收集到 {a} {u}{A}，后来又添 {b} {u}{B}，每 {m} {u} 装一袋，能装满几袋？', ['{a} {u}{A}', '{b} {u}{B}']),
        T('{place}有 {a} {u}{A} 和 {b} {u}{B}，按每 {m} {u} 一组分开，可以分几组？', ['{a} {u}{A}', '{b} {u}{B}']),
        T('前后共收了 {a} {u} 与 {b} {u}，每 {m} {u} 摆一排，能摆几排？', ['{a} {u}', '{b} {u}']),
    ], build_add_div_group),
    mix_struct('sub_div', '先减后除', ['sub', 'div'], [
        T('收了 {t} {u}{A}，用掉 {b} {u}，余下的平均装进 {n} 个{container}，每个装几{u}？', ['{t} {u}{A}', '{b} {u}']),
        T('一共 {t} {u}，挑出 {b} {u} 放在一边，剩下的 {n} 名{actor}平分，每人几{u}？',
          ['{t} {u}', '{b} {u}'], decoy='一共', note='第一步的「一共」是知道总数后去掉一部分，用减法；第二步才是平均分。'),
        T('{place}原有 {t} {u}{A}，撤走 {b} {u}，留下的平均装进 {n} 个{container}，每个装几{u}？', ['{t} {u}{A}', '{b} {u}']),
    ], build_sub_div),
    mix_struct('mul_add', '先乘后加', ['mul', 'add'], [
        T('{place}摆了 {n} 排{A}，每排 {m} {u}，后来又补了 {c} {u}，现在一共多少{u}？', ['{n} 排', '{m} {u}', '{c} {u}']),
        T('{n} 个{container}各装 {m} {u}{A}，{actor}另外送来 {c} {u}，总共有几{u}？', ['{n} 个{container}', '{m} {u}{A}', '{c} {u}']),
        T('每天收 {m} {u}，收了 {n} 天，第 {n} 天又额外捡到 {c} {u}，一共是几{u}？', ['{m} {u}', '{n} 天', '{c} {u}']),
    ], build_mul_add),
    mix_struct('mul_sub', '先乘后减', ['mul', 'sub'], [
        T('{n} 排每排 {m} {u}{A}，其中 {c} {u} 被移走，还留下多少{u}？', ['{n} 排', '{m} {u}{A}', '{c} {u}']),
        T('每个{container}放 {m} {u}，摆了 {n} 个{container}，后来拿走 {c} {u}，共有几{u}剩下？', ['{m} {u}', '{n} 个{container}', '{c} {u}']),
        T('{actor}按每队 {m} {u} 站成 {n} 队，走掉 {c} {u} 后，场上还有几{u}？', ['{m} {u}', '{n} 队', '{c} {u}']),
    ], build_mul_sub),
    mix_struct('div_add', '先除后加', ['div', 'add'], [
        T('{t} {u}{A} 平均装进 {n} 个{container}，随后又收了 {c} {u}，现在一共几{u}？', ['{t} {u}{A}', '{n} 个{container}', '{c} {u}']),
        T('把 {t} {u} 平分给 {n} 名{actor}，每人那份先记下，再加上新得的 {c} {u}，合起来几{u}？', ['{t} {u}', '{n} 名', '{c} {u}']),
        T('{t} {u}{A} 摆成 {n} 排，每排的数量算出来后又添 {c} {u}，总数是多少{u}？', ['{t} {u}{A}', '{n} 排', '{c} {u}']),
    ], build_div_add),
    mix_struct('div_sub', '先除后减', ['div', 'sub'], [
        T('{t} {u}{A} 平均装进 {n} 个{container}，用掉其中一{container}后，还剩几{u}？', ['{t} {u}{A}', '{n} 个{container}']),
        T('{t} {u} 平分给 {n} 名{actor}，有一名把那份交了回去，实际留下几{u}？', ['{t} {u}', '{n} 名']),
        T('{t} {u}{A} 摆成 {n} 排，撤掉一排后，余下的是几{u}？', ['{t} {u}{A}', '{n} 排']),
    ], build_div_sub),
    mix_struct('add_sub', '先加后减', ['add', 'sub'], [
        T('先有 {a} {u}{A}，又送来 {b} {u}{B}，随后用掉 {c} {u}，现在还有几{u}？', ['{a} {u}{A}', '{b} {u}{B}', '{c} {u}']),
        T('{container}里放进 {a} {u} 和 {b} {u}，{actor}取走 {c} {u}，剩下多少{u}？', ['{a} {u}', '{b} {u}', '{c} {u}']),
        T('{place}来了 {a} {u}{A} 与 {b} {u}{B}，其中 {c} {u} 被调走，留在原地的有几{u}？', ['{a} {u}{A}', '{b} {u}{B}', '{c} {u}']),
    ], build_add_sub),
]

# 追加混合题诱饵模板：让两步题也覆盖「看词猜运算」的陷阱
MIX_DECOYS = [
    ('add_div_per', T('一共来了 {a} {u}{A}，随后又到 {b} {u}{B}，把这些平分给 {n} 名{actor}，每人几{u}？',
                      ['{a} {u}{A}', '{b} {u}{B}'], decoy='一共',
                      note='「一共」说的是先到的那一批，不是把两批加起来就完事；先加出总量，再按人数平均分，第一步加法、第二步除法。')),
    ('mul_add', T('还剩 {n} 排没摆，每排 {m} {u}，后来又补 {c} {u}，现在有多少{u}？',
                  ['{n} 排', '{m} {u}', '{c} {u}'], decoy='还剩',
                  note='「还剩」说的是没摆的排数，不是从总数里拿走东西；先按每份一样多求出总数用乘法，再加上补上的，两步不能合并。')),
    ('div_add', T('每{container}装得一样多，{t} {u}{A} 平均装进 {n} 个{container}，之后又收 {c} {u}，现在一共几{u}？',
                  ['{t} {u}{A}', '{n} 个{container}', '{c} {u}'], decoy='每',
                  note='「每」在这里问的是每个容器装多少，第一步是除法；别看到「每」就选乘法，要看清题目求的是每份个数。')),
    ('add_sub', T('一共 {a} {u}{A}，又添 {b} {u}{B}，随后用掉 {c} {u}，现在还有几{u}？',
                  ['{a} {u}{A}', '{b} {u}{B}', '{c} {u}'], decoy='一共',
                  note='「一共」只描述开头那一批，后面还有添上和用掉两步；按顺序先加后减，别看到一个词就定运算。')),
    ('div_sub', T('一共 {t} {u}{A} 平均装进 {n} 个{container}，拿走其中一{container}后，还剩几{u}？',
                  ['{t} {u}{A}', '{n} 个{container}'], decoy='一共',
                  note='「一共」是告诉你总数已知；第一步按份数求每份用除法，第二步再从总数里去掉这一份。')),
]
for _key, _tpl in MIX_DECOYS:
    for _st in MIX_STRUCTS:
        if _st['key'] == _key:
            _st['templates'].append(_tpl)

# ---------------------------------------------------------------- 题目组装
MN = dict(add='部分 + 部分 = 总数', sub='总数 − 部分 = 剩下的部分',
          mul='每份个数 × 份数 = 总数', div_per='总数 ÷ 份数 = 每份个数',
          div_group='总数 ÷ 每份个数 = 份数')

HINT = dict(
    add='题目把两堆各是多少都告诉你了，先圈出这两个数，再想问的是把它们怎么样。',
    sub='先找找哪个数是总数、哪个数是其中一部分，问题问的是另一部分。',
    mul='看看是不是每一份都一样多，份数和每份个数都找到了吗？',
    div_per='总数和要分成几份都知道了，问题问的是一份里有多少。',
    div_group='总数和每份是多少都知道了，问题问的是能分成几份。',
)
EXPLAIN = dict(
    add='已知两部分，求合起来的总量，用加法：部分 + 部分 = 总数。',
    sub='已知总数和其中一部分，求另一部分，用减法：总数 − 部分 = 剩下的部分。',
    mul='每份一样多，知道每份个数和份数，求总数用乘法：每份个数 × 份数 = 总数。',
    div_per='知道总数与份数，求每份个数，用除法：总数 ÷ 份数 = 每份个数。',
    div_group='知道总数与每份个数，求能分成几份，用除法：总数 ÷ 每份个数 = 份数。',
)


def make_single(kind, variant, templates, idx):
    """生成一道单一运算题。"""
    struct_key = kind if not variant else variant
    hint_key = struct_key
    for _ in range(80):
        th = random.choice(THEME_KEYS)
        tpl = choose_tpl(templates)
        c = ctx_for(th, nums(kind))
        # 保证乘法/除法数字与题意一致
        if kind in ('mul', 'div'):
            c['t'] = c['n'] * c['m']
        if kind == 'sub':
            c['t'] = c['a'] + c['b']
        answer, formula = None, None
        if kind == 'add':
            answer = c['a'] + c['b']
            formula = '{a} + {b} = %d（{u}）' % answer
        elif kind == 'sub':
            answer = c['a']
            formula = '{t} − {b} = %d（{u}）' % answer
        elif kind == 'mul':
            answer = c['m'] * c['n']
            formula = '{m} × {n} = %d（{u}）' % answer
        elif kind == 'div' and variant == 'div_per':
            answer = c['m']
            formula = '{t} ÷ {n} = %d（{u}）' % answer
        elif kind == 'div' and variant == 'div_group':
            answer = c['n']
            formula = '{t} ÷ {m} = %d（组）' % answer
        text = clean_text(fmt(tpl['text'], c))
        clues = [fmt(x, c) for x in tpl['clues']]
        if any(x not in text for x in clues):
            continue
        explain = EXPLAIN[hint_key]
        if tpl.get('decoy'):
            explain += ' ⚠️ 别只盯一个词：题目里的「%s」不是运算信号，%s' % (tpl['decoy'], fmt(tpl['note'], c))
        else:
            explain += ' 判断依据是「已知什么、求什么」，不是某个固定的词。'
        q = dict(
            id='', level=1, op=kind, theme=th,
            art='zombies' if th in ('zombie', 'night') else 'plants',
            scene=scene_for(th),
            text=text, keywords=clues, mnemonic=MN[hint_key],
            formula=fmt(formula, c), answer=answer, unit=c['u'],
            hint=HINT[hint_key], explain=explain,
            decoy=tpl.get('decoy') or '',
        )
        return q
    raise RuntimeError('无法生成单一题：' + kind)


def make_mix(st, idx):
    for _ in range(80):
        th = random.choice(THEME_KEYS)
        tpl = choose_tpl(st['templates'])
        c = ctx_for(th, nums('mix'))
        answer, formula, raw_steps = st['build'](c)
        if answer is None or answer < 0:
            continue
        text = clean_text(fmt(tpl['text'], c))
        clues = [fmt(x, c) for x in tpl['clues']]
        if any(x not in text for x in clues):
            continue
        steps = []
        for i, s in enumerate(raw_steps):
            m2 = '部分 + 部分 = 总数' if s['op'] == 'add' else (
                '总数 − 部分 = 剩下的部分' if s['op'] == 'sub' else (
                    '每份个数 × 份数 = 总数' if s['op'] == 'mul' else '总数 ÷ 份数 = 每份个数'))
            steps.append(dict(
                op=s['op'],
                label='第 %d 步 · %s' % (i + 1, '先算出中间的总量' if i == 0 else '再用它算出答案'),
                keyword='先想清楚这一步已知什么、求什么',
                formula=fmt(s['formula'], c),
                answer=s['answer'], mnemonic=m2))
        mn = steps[0]['mnemonic'] + '　→　' + steps[1]['mnemonic']
        explain = ('这是两步题：先%s，再%s。先把中间那个数算出来，第二步才有得用。'
                   % (OP_INFO[st['ops'][0]]['name'], OP_INFO[st['ops'][1]]['name']))
        if tpl.get('decoy'):
            explain += ' ⚠️ 题目里的「%s」容易让人直接选运算，%s' % (tpl['decoy'], fmt(tpl['note'], c))
        else:
            explain += ' 别靠某个词猜，按「已知什么、求什么」一步一步走。'
        q = dict(
            id='', level=2, op='mix', ops=st['ops'], theme=th,
            art='zombies' if th in ('zombie', 'night') else 'plants',
            scene=scene_for(th),
            text=text, keywords=clues, mnemonic=mn,
            formula=fmt(formula, c), answer=answer, unit=c['u'],
            hint='这题要算两步：先找出必须先算出来的中间数量，再完成第二步。',
            explain=explain, decoy=tpl.get('decoy') or '', steps=steps,
        )
        return q
    raise RuntimeError('无法生成混合题：' + st['key'])


def build_bank():
    bank = []
    seen_text = set()
    plan = [
        ('add', None, ADD_T, 'a'),
        ('sub', None, SUB_T, 's'),
        ('mul', None, MUL_T, 'm'),
        ('div', 'div_per', DIV_PER_T, 'd'),
        ('div', 'div_group', DIV_GROUP_T, 'g'),
    ]
    # 五种题型各 120 题；除法两个口径各 60 题
    for kind, variant, templates, prefix in plan:
        count = PER_TYPE // 2 if kind == 'div' else PER_TYPE
        made = 0
        tries = 0
        while made < count and tries < count * 40:
            tries += 1
            q = make_single(kind, variant, templates, made)
            if q['text'] in seen_text:
                continue
            seen_text.add(q['text'])
            q['id'] = '%s%03d' % (prefix, made + 1)
            bank.append(q)
            made += 1
        if made < count:
            raise RuntimeError('%s 只生成了 %d 题' % (kind + (variant or ''), made))
    # 两步混合 120 题，8 种结构按序轮转（主题独立随机，不与结构绑定）
    made = 0
    tries = 0
    while made < PER_TYPE and tries < PER_TYPE * 40:
        tries += 1
        st = MIX_STRUCTS[made % len(MIX_STRUCTS)]
        q = make_mix(st, made)
        if q['text'] in seen_text:
            continue
        seen_text.add(q['text'])
        q['id'] = 'x%03d' % (made + 1)
        bank.append(q)
        made += 1
    if made < PER_TYPE:
        raise RuntimeError('混合题只生成了 %d 题' % made)
    return apply_overrides(bank)


# ---------------------------------------------------------------- 自检
def verify(bank):
    assert len(bank) == 600, '总题数不是 600：%d' % len(bank)
    ids = [q['id'] for q in bank]
    assert len(set(ids)) == len(ids), 'ID 重复'
    assert len(set(q['text'] for q in bank)) == len(bank), '题干重复'
    by_op = {}
    for q in bank:
        by_op[q['op']] = by_op.get(q['op'], 0) + 1
        assert q['answer'] > 0 and isinstance(q['answer'], int), '答案异常：' + q['id']
        assert q['keywords'] and all(k in q['text'] for k in q['keywords']), '数量短语不在题干：' + q['id']
        assert q['mnemonic'] and q['hint'] and q['explain'] and q['formula'], '字段缺失：' + q['id']
        assert q['theme'] in THEMES, '主题异常：' + q['id']
        # 场景标签不得泄露运算（桌面题库头 / 错题库 / 手机版都会直接显示 scene）
        for leak in ('加法', '减法', '乘法', '除法', '情境', '先加', '先减', '先乘', '先除'):
            assert leak not in q['scene'], '场景标签泄露运算：' + q['id']
        # 题干数字必须能在算式里找到，保证润色没有把数量关系改掉
        fn = re.findall(r'\d+', q['formula'])
        for num in re.findall(r'\d+', q['text']):
            assert num in fn, '题干数字与算式对不上：%s / %s / %s' % (q['id'], num, q['formula'])
        # 求份数的题，答案单位要数「排 / 组 / 个」，不能数物体
        if re.search(r'(?:几排|几组|几个花盆|几个格子)？$', q['text']):
            assert q['unit'] in ('排', '组', '个'), '答案单位与问句不符：' + q['id']
        for bad in ('阳光袋', '浮板', '小花盆', '仓库', '补发', '装箱',
                    '贴好了标签', '坏的', '全倒进', '花盘', '投手盆栽'):
            assert bad not in q['text'], '题干含违和设定：%s / %s' % (q['id'], bad)
        if q['level'] == 2:
            assert len(q['steps']) == 2, '混合题步数不是 2：' + q['id']
            assert q['answer'] == q['steps'][1]['answer'], '混合题最终答案与第 2 步不一致：' + q['id']
            assert q['ops'] == [s['op'] for s in q['steps']], 'ops 与 steps 不一致：' + q['id']
        else:
            assert q['op'] in ('add', 'sub', 'mul', 'div'), '单一题 op 异常'
        # 校验 formula 里的算式结果（提取等号右侧数字）
        tail = re.findall(r'=\s*(\d+)', q['formula'])
        assert tail and int(tail[-1]) == q['answer'], '算式与答案不符：%s / %s' % (q['id'], q['formula'])
    for k in ('add', 'sub', 'mul', 'div', 'mix'):
        assert by_op.get(k, 0) >= 100, '%s 不足 100 题：%d' % (k, by_op.get(k, 0))
    decoys = sum(1 for q in bank if q['decoy'])
    assert decoys >= 180, '诱饵题太少：%d' % decoys
    theme_counts = {k: sum(1 for q in bank if q['theme'] == k) for k in THEME_KEYS}
    assert all(v >= 50 for v in theme_counts.values()), '主题分布不均：%s' % theme_counts
    mix_shapes = set(tuple(q['ops']) for q in bank if q['level'] == 2)
    assert len(mix_shapes) >= 6, '混合结构覆盖不足：%d' % len(mix_shapes)
    return dict(total=len(bank), by_op=by_op, decoys=decoys,
                themes=theme_counts, mix_shapes=len(mix_shapes))


# ---------------------------------------------------------------- 输出
RULES_JS = r"""window.GAME_RULES = {
  version: 2,
  base: { 1: 2, 2: 4 },
  wrongPenalty: 2,
  retryGain: 1,
  sunFloor: 0,
  maxLevel: 10,
  hintTicks: 10,
  migrateDivisor: 12,
  streakBonus: function (n) { return n <= 1 ? 0 : Math.min(n - 1, 3); },
  award: function (q, isRetry, streakAfter) {
    if (isRetry) return { base: 1, bonus: 0, total: 1, retry: true };
    var base = q.level === 2 ? 4 : 2;
    var bonus = this.streakBonus(streakAfter);
    return { base: base, bonus: bonus, total: base + bonus, retry: false };
  },
  levelTarget: function (n) { return 3 * n * (n + 3); },
  levelForSun: function (sun) {
    var n = 1;
    while (n < this.maxLevel && sun >= this.levelTarget(n)) n++;
    return n;
  },
  levelProgress: function (sun, round) {
    var prev = round > 1 ? this.levelTarget(round - 1) : 0;
    var target = this.levelTarget(round);
    return {
      prev: prev, target: target,
      pct: Math.max(0, Math.min(100, (sun - prev) / (target - prev) * 100)),
      need: Math.max(0, target - sun)
    };
  },
  mixRate: function (round) {
    if (round <= 2) return 0;
    return Math.min(0.6, 0.2 + (round - 3) * 0.055);
  }
};"""

HEADER = r"""/* 植物大战僵尸 · 二年级数学抽卡训练营 — 题库（自动生成，请勿手改）
 * 口径严格沿用用户给定四句口诀：
 *   加法：部分 + 部分 = 总数
 *   减法：总数 − 部分 = 剩下的部分
 *   乘法：每份个数 × 份数 = 总数
 *   除法：总数 ÷ 每份个数 = 份数；总数 ÷ 份数 = 每份个数
 * 反定势设计：题干措辞大量变式，约三分之一题目含「诱饵词」但数学结构不变，
 *   explain 逐题点破；keywords 存的是数量短语，只用于圈数字，不提示运算。
 * theme 为场景主题，配合 op 支持双维度卡池。
 */"""


def main():
    bank = build_bank()
    stat = verify(bank)
    lines = [
        HEADER,
        'window.OP_INFO = ' + json.dumps(OP_INFO, ensure_ascii=False, separators=(',', ':')) + ';',
        '',
        'window.THEME_INFO = ' + json.dumps(
            {k: dict(name=v['name'], place=v['place']) for k, v in THEMES.items()},
            ensure_ascii=False, separators=(',', ':')) + ';',
        '',
        'window.POOL_GROUPS = ' + json.dumps(POOL_GROUPS, ensure_ascii=False, separators=(',', ':')) + ';',
        '',
        RULES_JS,
        '',
        'window.QUESTION_BANK = [',
    ]
    for i, q in enumerate(bank):
        comma = ',' if i < len(bank) - 1 else ''
        lines.append('  ' + json.dumps(q, ensure_ascii=False, separators=(',', ':')) + comma)
    lines.append('];')
    lines.append('')
    with open(OUT, 'w', encoding='utf-8', newline='\n') as f:
        f.write('\n'.join(lines))
    print('已生成：%s' % OUT)
    print('总题数：%d，分布：%s' % (stat['total'], stat['by_op']))
    print('诱饵题：%d 道（%.0f%%）' % (stat['decoys'], 100.0 * stat['decoys'] / stat['total']))
    print('主题分布：%s' % stat['themes'])
    print('文件大小：%.1f KB' % (os.path.getsize(OUT) / 1024.0))


if __name__ == '__main__':
    main()
