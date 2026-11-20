#!/usr/bin/env python3
"""生成 256x256 RGBA 应用图标（纯标准库，无需 Pillow）。

用法：python3 ictrek.app/scripts/make-icon.py [输出路径]
默认输出 ictrek.app/src/icon.png。
"""
import math
import struct
import sys
import zlib
from pathlib import Path

SIZE = 256
SS = 2  # 超采样倍数

C1 = (107, 149, 255)  # #6B95FF
C2 = (62, 207, 142)   # #3ECF8E
CHECK = [(72, 132), (112, 172), (186, 88)]
CHECK_WIDTH = 20.0


def _dist_point_segment(px, py, ax, ay, bx, by):
    vx, vy = bx - ax, by - ay
    wx, wy = px - ax, py - ay
    t = (wx * vx + wy * vy) / (vx * vx + vy * vy)
    t = max(0.0, min(1.0, t))
    dx, dy = px - (ax + t * vx), py - (ay + t * vy)
    return math.hypot(dx, dy)


def _inside_rounded(x, y, size, inset=8, radius=56):
    left = top = inset
    right = bottom = size - inset
    qx = max(left + radius - x, 0.0, x - (right - radius))
    qy = max(top + radius - y, 0.0, y - (bottom - radius))
    return math.hypot(qx, qy) <= radius


def _on_check(x, y):
    for (ax, ay), (bx, by) in zip(CHECK, CHECK[1:]):
        if _dist_point_segment(x, y, ax, ay, bx, by) <= CHECK_WIDTH / 2:
            return True
    return False


def render():
    n = SIZE * SS
    pixels = bytearray()
    for y in range(n):
        pixels.append(0)  # PNG filter: none
        for x in range(n):
            # 归一到 256 坐标系，用于形状判断
            fx = (x + 0.5) / SS
            fy = (y + 0.5) / SS
            if not _inside_rounded(fx, fy, SIZE):
                pixels.extend((0, 0, 0, 0))
                continue
            t = (fx + fy) / (2 * (SIZE - 1))
            r = round(C1[0] + (C2[0] - C1[0]) * t)
            g = round(C1[1] + (C2[1] - C1[1]) * t)
            b = round(C1[2] + (C2[2] - C1[2]) * t)
            if _on_check(fx, fy):
                r = g = b = 255
            pixels.extend((r, g, b, 255))

    # 2x2 下采样，得到抗锯齿后的 256x256 RGBA
    out = bytearray()
    row_len = n * 4
    for y in range(SIZE):
        out.append(0)
        for x in range(SIZE):
            acc = [0, 0, 0, 0]
            for dy in range(SS):
                base = (y * SS + dy) * (row_len + 1) + 1 + x * SS * 4
                for dx in range(SS):
                    o = base + dx * 4
                    for c in range(4):
                        acc[c] += pixels[o + c]
            div = SS * SS
            out.extend(tuple(v // div for v in acc))
    return bytes(out)


def png(width, height, rgba_rows):
    def chunk(kind, data):
        body = kind + data
        return struct.pack('>I', len(data)) + body + struct.pack('>I', zlib.crc32(body) & 0xFFFFFFFF)

    header = struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0)
    return (
        b'\x89PNG\r\n\x1a\n'
        + chunk(b'IHDR', header)
        + chunk(b'IDAT', zlib.compress(rgba_rows, 9))
        + chunk(b'IEND', b'')
    )


def main():
    root = Path(__file__).resolve().parents[2]
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else root / 'ictrek.app' / 'src' / 'icon.png'
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(png(SIZE, SIZE, render()))
    print(f'[icon] wrote {out} ({out.stat().st_size} bytes)')


if __name__ == '__main__':
    main()
