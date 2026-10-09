#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
生成 iOS 应用图标与启动图（纯标准库，不依赖 Pillow / cairo 等任何第三方库）。

产出：
  assets/icon.png    1024x1024   App 图标（iOS 会自动裁圆角，因此做成满幅方图）
  assets/splash.png  2732x2732   启动图（居中 Logo + 纯色底）

用法：
  python scripts/make-assets.py            # 默认品牌蓝
  python scripts/make-assets.py --top "#6B7CFF" --bottom "#3A46D8" --bg "#FFFFFF"

图形：几何方式绘制「¥」记号（两条上斜臂 + 竖干 + 两道横杠），
      全程 2 倍超采样再降采样，边缘平滑无锯齿。
"""

import argparse
import math
import os
import struct
import zlib

# ---------------------------------------------------------------- PNG 编码


def write_png(path, width, height, rgb):
    """rgb: bytearray(length = width*height*3)"""
    raw = bytearray()
    stride = width * 3
    for y in range(height):
        raw.append(0)  # filter type 0
        raw += rgb[y * stride : (y + 1) * stride]

    def chunk(tag, data):
        c = struct.pack('>I', len(data)) + tag + data
        return c + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF)

    png = b'\x89PNG\r\n\x1a\n'
    png += chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress(bytes(raw), 9))
    png += chunk(b'IEND', b'')
    with open(path, 'wb') as f:
        f.write(png)


# ---------------------------------------------------------------- 几何工具


def _seg_dist(px, py, x1, y1, x2, y2):
    dx, dy = x2 - x1, y2 - y1
    L2 = dx * dx + dy * dy
    if L2 == 0:
        return math.hypot(px - x1, py - y1)
    t = ((px - x1) * dx + (py - y1) * dy) / L2
    t = 0.0 if t < 0 else (1.0 if t > 1 else t)
    return math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))


def make_mask(size, ss=2):
    """
    生成「¥」的 alpha 掩码，返回 float 列表（长度 size*size，取值 0~1）。
    以 1024 为设计基准，内部按 size 等比缩放。
    """
    S = size * ss
    k = S / 1024.0  # 设计基准 → 采样基准的缩放系数
    W = max(1.0, 74 * k)  # 笔画粗细

    def bar(x1, y1, x2, y2):
        return (x1 * k, y1 * k, x2 * k, y2 * k)

    shapes_seg = [
        bar(336, 306, 512, 470),  # 左臂
        bar(688, 306, 512, 470),  # 右臂
        bar(512, 470, 512, 706),  # 竖干
    ]
    shapes_rect = [
        bar(370, 470, 654, 470 + 56),  # 上横杠
        bar(370, 592, 654, 592 + 56),  # 下横杠
    ]
    hw = W / 2.0

    # 计算包围盒，避免遍历整幅画面
    xs = [s[0] for s in shapes_seg] + [s[0] for s in shapes_rect] + [s[2] for s in shapes_seg] + [s[2] for s in shapes_rect]
    ys = [s[1] for s in shapes_seg] + [s[1] for s in shapes_rect] + [s[3] for s in shapes_seg] + [s[3] for s in shapes_rect]
    x0 = max(0, int(min(xs) - hw - 2))
    x1 = min(S - 1, int(max(xs) + hw + 2))
    y0 = max(0, int(min(ys) - hw - 2))
    y1 = min(S - 1, int(max(ys) + hw + 2))

    hi = bytearray(S * S)  # 0 / 1
    for yy in range(y0, y1 + 1):
        py = yy + 0.5
        row = yy * S
        for xx in range(x0, x1 + 1):
            px = xx + 0.5
            hit = False
            for sx1, sy1, sx2, sy2 in shapes_seg:
                if _seg_dist(px, py, sx1, sy1, sx2, sy2) <= hw:
                    hit = True
                    break
            if not hit:
                for rx1, ry1, rx2, ry2 in shapes_rect:
                    if rx1 <= px <= rx2 and ry1 <= py <= ry2:
                        hit = True
                        break
            if hit:
                hi[row + xx] = 1

    # 降采样：每 ss*ss 个高分辨率样本求平均
    out = [0.0] * (size * size)
    inv = 1.0 / (ss * ss)
    for y in range(size):
        base = y * size
        for x in range(size):
            acc = 0
            for dy in range(ss):
                r = (y * ss + dy) * S + x * ss
                for dx in range(ss):
                    acc += hi[r + dx]
            out[base + x] = acc * inv
    return out


def _hex(c):
    c = c.lstrip('#')
    return int(c[0:2], 16), int(c[2:4], 16), int(c[4:6], 16)


def _lerp(a, b, t):
    return a + (b - a) * t


# ---------------------------------------------------------------- 绘制


def render(size, top, bottom, rounded=False, ss=2):
    """返回 (rgb bytearray, alpha list)；rounded 时四角裁圆角（用于启动图 Logo）。"""
    r1, g1, b1 = _hex(top)
    r2, g2, b2 = _hex(bottom)
    mask = make_mask(size, ss=ss)
    rgb = bytearray(size * size * 3)
    radius = size * 0.225
    for y in range(size):
        ty = y / (size - 1.0)
        base = y * size
        for x in range(size):
            tx = x / (size - 1.0)
            t = min(1.0, max(0.0, tx * 0.32 + ty * 0.68))
            r = _lerp(r1, r2, t)
            g = _lerp(g1, g2, t)
            b = _lerp(b1, b2, t)
            # 左上角柔和提亮，避免纯平的塑料感
            d = math.hypot(tx - 0.28, ty - 0.16)
            hi = max(0.0, 1.0 - d * 1.55)
            r += 26 * hi
            g += 26 * hi
            b += 30 * hi

            a = mask[base + x]
            if rounded:
                dx = max(radius - x, x - (size - 1 - radius), 0.0)
                dy = max(radius - y, y - (size - 1 - radius), 0.0)
                if dx or dy:
                    dd = math.hypot(dx, dy)
                    if dd > radius:
                        a = 0.0
                    elif dd > radius - 1.5:
                        a *= (radius - dd) / 1.5
            if a > 0:
                r = _lerp(r, 255.0, a)
                g = _lerp(g, 255.0, a)
                b = _lerp(b, 255.0, a)
            i = base * 3 + x * 3
            rgb[i] = int(max(0, min(255, r)))
            rgb[i + 1] = int(max(0, min(255, g)))
            rgb[i + 2] = int(max(0, min(255, b)))
    return rgb


def render_splash(size, bg, top, bottom, logo_ratio=0.365):
    r0, g0, b0 = _hex(bg)
    rgb = bytearray((r0 << 16 | g0 << 8 | b0) .to_bytes(3, 'big') * (size * size))
    logo = int(size * logo_ratio)
    mark = render(logo, top, bottom, rounded=True, ss=2)
    ox = (size - logo) // 2
    oy = (size - logo) // 2
    for y in range(logo):
        src = y * logo * 3
        dst = ((oy + y) * size + ox) * 3
        rgb[dst : dst + logo * 3] = mark[src : src + logo * 3]
    return rgb


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--top', default='#6B7CFF')
    ap.add_argument('--bottom', default='#3A46D8')
    ap.add_argument('--bg', default='#FFFFFF')
    args = ap.parse_args()

    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out = os.path.join(root, 'assets')
    os.makedirs(out, exist_ok=True)

    icon = os.path.join(out, 'icon.png')
    splash = os.path.join(out, 'splash.png')

    print('绘制图标 1024x1024 ...')
    write_png(icon, 1024, 1024, render(1024, args.top, args.bottom))
    print('绘制启动图 2732x2732 ...')
    write_png(splash, 2732, 2732, render_splash(2732, args.bg, args.top, args.bottom))

    for p in (icon, splash):
        print('  -> %s  %.1f KB' % (p, os.path.getsize(p) / 1024.0))


if __name__ == '__main__':
    main()
