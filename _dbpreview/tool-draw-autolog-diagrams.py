#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
生成「流水自动触发」方案的脑图 + 流程图（2026-11-18）。

为什么用 Pillow 手绘而不用 graphviz/matplotlib：本机没装那两个库，
而 Pillow 有、且足够画框图。不为此联网装包。

产物：
  docs/设计方案-流水自动触发-脑图.png
  docs/设计方案-流水自动触发-流程图.png
"""

from PIL import Image, ImageDraw, ImageFont
import os

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'docs')
os.makedirs(OUT_DIR, exist_ok=True)

# 字体：Windows 自带，优先中文
FONT_CANDIDATES = [
    r'C:\Windows\Fonts\msyh.ttc',
    r'C:\Windows\Fonts\msyhl.ttc',
    r'C:\Windows\Fonts\simhei.ttf',
    r'C:\Windows\Fonts\simsun.ttc',
]


def load_font(size):
    for p in FONT_CANDIDATES:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                continue
    return ImageFont.load_default()


F_TITLE = load_font(30)
F_H = load_font(20)
F_BODY = load_font(16)
F_SMALL = load_font(14)

# 配色
C_BG = (250, 251, 253)
C_NOW = (255, 235, 235)        # 现状（有问题）
C_NOW_B = (214, 96, 96)
C_STEP = (232, 244, 255)       # 正常步骤
C_STEP_B = (92, 148, 200)
C_FIX = (232, 250, 238)        # 改动点
C_FIX_B = (74, 168, 110)
C_SAFE = (255, 248, 226)       # 降级/兜底
C_SAFE_B = (206, 166, 72)
C_TEXT = (40, 44, 52)
C_DIM = (110, 116, 128)


def rounded(draw, box, radius, fill, outline, width=2):
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def wrap(draw, text, font, max_w):
    """按像素宽度折行（中英混排）。"""
    lines, cur = [], ''
    for ch in text:
        if ch == '\n':
            lines.append(cur)
            cur = ''
            continue
        trial = cur + ch
        if draw.textlength(trial, font=font) > max_w and cur:
            lines.append(cur)
            cur = ch
        else:
            cur = trial
    if cur:
        lines.append(cur)
    return lines


def cell(draw, x, y, w, title, body, fill, border, title_font=F_H, body_font=F_BODY,
         pad=14, min_h=0):
    """画一个带标题的卡片，返回高度。"""
    lines = wrap(draw, body, body_font, w - pad * 2) if body else []
    th = 0
    if title:
        th = title_font.size + 8
    bh = len(lines) * (body_font.size + 6)
    h = max(min_h, pad * 2 + th + bh)
    rounded(draw, (x, y, x + w, y + h), 10, fill, border, 2)
    cy = y + pad
    if title:
        draw.text((x + pad, cy), title, font=title_font, fill=C_TEXT)
        cy += th
    for ln in lines:
        draw.text((x + pad, cy), ln, font=body_font, fill=C_TEXT)
        cy += body_font.size + 6
    return h


def arrow(draw, p1, p2, color=C_STEP_B, width=3, dash=False):
    import math
    if dash:
        x1, y1 = p1
        x2, y2 = p2
        total = math.hypot(x2 - x1, y2 - y1)
        if total < 1:
            return
        seg = 10
        n = int(total // seg)
        for i in range(0, n, 2):
            a = i / n
            b = min((i + 1) / n, 1.0)
            draw.line([(x1 + (x2 - x1) * a, y1 + (y2 - y1) * a),
                       (x1 + (x2 - x1) * b, y1 + (y2 - y1) * b)],
                      fill=color, width=width)
    else:
        draw.line([p1, p2], fill=color, width=width)
    # 箭头
    ang = math.atan2(p2[1] - p1[1], p2[0] - p1[0])
    L = 12
    draw.polygon([
        (p2[0], p2[1]),
        (p2[0] - L * math.cos(ang - 0.4), p2[1] - L * math.sin(ang - 0.4)),
        (p2[0] - L * math.cos(ang + 0.4), p2[1] - L * math.sin(ang + 0.4)),
    ], fill=color)


# =====================================================================
# 脑图
# =====================================================================
def draw_mindmap():
    W, H = 1720, 980
    img = Image.new('RGB', (W, H), C_BG)
    d = ImageDraw.Draw(img)

    d.text((40, 28), '写流水自动触发 · 方案脑图', font=F_TITLE, fill=C_TEXT)
    d.text((40, 70), '2026-11-18 · 依据：turn/end 每轮必到（实测 299 次 / 296 轮）',
           font=F_SMALL, fill=C_DIM)

    # 中心
    cx, cy = W // 2, 175
    cw, ch = 340, 76
    rounded(d, (cx - cw // 2, cy - ch // 2, cx + cw // 2, cy + ch // 2), 14,
            (235, 238, 250), (98, 110, 190), 3)
    d.text((cx - 118, cy - 18), '流水由程序保证存在', font=F_H, fill=C_TEXT)
    d.text((cx - 78, cy + 8), '模型只负责内容', font=F_SMALL, fill=C_DIM)

    # 四个分支
    branches = [
        ('① 为什么现在会漏', C_NOW, C_NOW_B, [
            '触发点在模型侧（要我自己想起）',
            '实测触发率 ≈ 50%',
            '漏了无任何提示（兜底已关）',
        ]),
        ('② 程序侧可靠的什么', C_STEP, C_STEP_B, [
            'turn/end 每轮必到（299 次）',
            'archive 原文完整落库',
            'emotion 已走通同一条路',
        ]),
        ('③ 怎么补上这一环', C_FIX, C_FIX_B, [
            'turn/end 时写「待总结」占位',
            'writer=plugin-auto 标明来源',
            '下一轮注入提示模型补写',
        ]),
        ('④ 失败怎么办', C_SAFE, C_SAFE_B, [
            '占位永不删除 = 漏记可见',
            '补写失败保留原文指针',
            '不 steer，不改本轮行为',
        ]),
    ]

    bw, gap = 380, 44
    total = len(branches) * bw + (len(branches) - 1) * gap
    x0 = (W - total) // 2
    top = 290

    for i, (title, fill, border, items) in enumerate(branches):
        x = x0 + i * (bw + gap)
        h = cell(d, x, top, bw, title, '', fill, border, min_h=58)
        # 中心 → 分支
        arrow(d, (cx, cy + ch // 2), (x + bw // 2, top - 6), border)
        yy = top + h + 14
        for it in items:
            ih = cell(d, x, yy, bw, '', '· ' + it, (255, 255, 255), border, min_h=0)
            yy += ih + 10

    # 底部：设计红线
    by = 560
    rounded(d, (60, by, W - 60, by + 300), 12, (247, 247, 250), (180, 184, 196), 2)
    d.text((84, by + 16), '设计红线（必须同时满足，缺一条就不可接受）', font=F_H, fill=C_TEXT)
    red = [
        ('不给用户添干扰', '不 steer、不在本轮多跑一步（此前「打嗝 8 秒」的教训）'),
        ('不冒充模型口吻', '占位条 writer=plugin-auto，界面可辨；模型补写后才算「结论层」'),
        ('不破坏检索', '占位条不进默认 /search，补写完成后才可检索（避免机械摘要污染结论层）'),
        ('漏了必须看得见', '占位条若 24h 未被补写，日志与 GUI 都要显式标红'),
        ('纯增量', '默认关闭，开关常量控制；关闭时行为与今天完全一致'),
    ]
    ry = by + 56
    for k, (t1, t2) in enumerate(red):
        d.text((88, ry), f'{k+1}.', font=F_BODY, fill=C_DIM)
        d.text((112, ry), t1, font=F_BODY, fill=C_TEXT)
        d.text((320, ry), '— ' + t2, font=F_SMALL, fill=C_DIM)
        ry += 46

    p = os.path.join(OUT_DIR, '设计方案-流水自动触发-脑图.png')
    img.save(p)
    return p


# =====================================================================
# 流程图
# =====================================================================
def draw_flow():
    W, H = 1700, 1080
    img = Image.new('RGB', (W, H), C_BG)
    d = ImageDraw.Draw(img)

    d.text((40, 26), '写流水自动触发 · 流程图（现状 vs 改后）', font=F_TITLE, fill=C_TEXT)
    d.text((40, 66), '左：今天的路径（断点在第 5 步）   右：改后的路径（turn/end 兜住）',
           font=F_SMALL, fill=C_DIM)

    # ---------- 左列：现状 ----------
    lx, lw = 70, 700
    d.text((lx, 108), '【现状】断点：没有任何人负责「开始写」', font=F_H, fill=C_NOW_B)

    steps_now = [
        ('1 你发消息', 'DSH 事件：user-message', C_STEP, C_STEP_B),
        ('2 注入层', 'injectedBytes ≈ 7635，含「必须写流水」', C_STEP, C_STEP_B),
        ('3 我思考并回答', 'archive 逐步落库；收尾语正常', C_STEP, C_STEP_B),
        ('4 我「想起来」写流水？', '← 这里是概率事件，实测约 50%', C_NOW, C_NOW_B),
        ('5 执行 log.ps1 → POST /log', '写入链路本身健康（隔离测试 18/18）', C_STEP, C_STEP_B),
        ('6 入库 logs 表', 'id / ts / topic / summary 齐全', C_STEP, C_STEP_B),
    ]
    y = 150
    prev_bottom = None
    for title, body, fill, border in steps_now:
        h = cell(d, lx, y, lw, title, body, fill, border, min_h=0)
        if prev_bottom is not None:
            arrow(d, (lx + lw // 2, prev_bottom), (lx + lw // 2, y - 6),
                  C_NOW_B if fill is C_NOW else C_STEP_B)
        prev_bottom = y + h
        y += h + 34

    # 现状的失败出口
    fy = prev_bottom + 30
    h = cell(d, lx, fy, lw, '× 走到这里 = 这一轮没有流水',
             '静默消失：无提示、无标记、无人知道（WRITE_FAIL_NUDGE_ENABLED=false）',
             C_NOW, C_NOW_B)
    arrow(d, (lx + lw // 2, prev_bottom), (lx + lw // 2, fy - 6), C_NOW_B, 3, dash=True)

    # ---------- 右列：改后 ----------
    rx, rw = 900, 700
    d.text((rx, 108), '【改后】turn/end 兜住，占位条保证「存在」', font=F_H, fill=C_FIX_B)

    steps_new = [
        ('1-3 同上（不变）', '消息 → 注入 → 思考回答', C_STEP, C_STEP_B),
        ('4a turn/end 到达【新】', '每轮必到（实测 299 次），程序在这里做事', C_FIX, C_FIX_B),
        ('5a 写一条「待总结」占位【新】', 'writer=plugin-auto；带 archive 指针；不可检索', C_FIX, C_FIX_B),
        ('6a 下一轮注入提示【新】', '「上轮有未总结记录，原文在 archive id=N」', C_FIX, C_FIX_B),
        ('7a 模型补写 summary/正文', '结论层此时才是「我写的」', C_FIX, C_FIX_B),
        ('8a 占位转为正式流水', 'writer=model；进入检索与索引', C_STEP, C_STEP_B),
    ]
    y = 150
    prev_bottom = None
    for title, body, fill, border in steps_new:
        h = cell(d, rx, y, rw, title, body, fill, border, min_h=0)
        if prev_bottom is not None:
            arrow(d, (rx + rw // 2, prev_bottom), (rx + rw // 2, y - 6), C_FIX_B if fill is C_FIX else C_STEP_B)
        prev_bottom = y + h
        y += h + 30

    # 改后的「未补写」分支
    gy = prev_bottom + 34
    h = cell(d, rx, gy, rw, '× 模型一直没补写',
             '占位条保留并标红（≥24h）→ 漏记变成「看得见的欠账」，不再静默丢失',
             C_SAFE, C_SAFE_B)
    arrow(d, (rx + rw // 2, prev_bottom), (rx + rw // 2, gy - 6), C_SAFE_B, 3, dash=True)

    # 底部对比
    by = max(fy + 120, gy + 120)
    rounded(d, (70, by, W - 70, by + 128), 12, (247, 247, 250), (180, 184, 196), 2)
    d.text((94, by + 14), '两者差别只有一句话', font=F_H, fill=C_TEXT)
    d.text((94, by + 52),
           '现状：漏记 = 这一轮从记忆里消失（无痕）',
           font=F_BODY, fill=C_NOW_B)
    d.text((94, by + 84),
           '改后：漏记 = 多出一条带标记的欠账（有痕，可补）',
           font=F_BODY, fill=C_FIX_B)

    p = os.path.join(OUT_DIR, '设计方案-流水自动触发-流程图.png')
    img.save(p)
    return p


if __name__ == '__main__':
    a = draw_mindmap()
    b = draw_flow()
    for p in (a, b):
        print(f'{p}  ({os.path.getsize(p)} bytes)')
