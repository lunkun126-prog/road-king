# -*- coding: utf-8 -*-
"""第三位车手「贝利亚」的整身照和头像。原图 tmp/refs/ref_belial.webp 已经是透明底，
但周围散着很多半透明噪点，左下角还有网站水印：只留最大的一整块（角色本身），其余全去掉。
用法: python scripts/make_belial.py  →  public/img/belial.png、public/img/belial_face.png
"""
import numpy as np
from PIL import Image, ImageFilter
from scipy import ndimage

SRC, OUT = 'tmp/refs/ref_belial.webp', 'public/img/belial'
HEAD = (117, 46, 84)   # 头像：原图里头部中心 x, y 和方框边长


def main():
    im = Image.open(SRC).convert('RGBA')
    a = np.asarray(im)
    fg = a[..., 3] > 100
    # 左下角水印贴着左脚：那一块里浅灰色的是字（脚是黑/红的），先抠掉
    rgb = a[..., :3].astype(np.float32) / 255
    mx, mn = rgb.max(2), rgb.min(2)
    wm = np.zeros_like(fg); wm[318:, :62] = True
    fg &= ~(wm & ((mx - mn) / np.maximum(mx, 1e-3) < 0.25) & (mx > 0.4))
    fg = ndimage.binary_opening(fg, iterations=1)          # 去掉零星噪点
    lab, n = ndimage.label(fg)
    if n > 1:                                              # 只留最大的一块（手臂和身体之间本来就是空的，不补洞）
        sizes = ndimage.sum(fg, lab, range(1, n + 1))
        fg = lab == (1 + int(np.argmax(sizes)))
    alpha = Image.fromarray((fg * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(0.6))
    out = im.copy()
    out.putalpha(Image.fromarray(np.minimum(np.asarray(alpha), a[..., 3]).astype(np.uint8)))
    cx, cy, side = HEAD
    head = out.crop((cx - side // 2, max(0, cy - side // 2), cx + side // 2, max(0, cy - side // 2) + side))
    out.crop(out.getbbox()).save(OUT + '.png', optimize=True)
    head.resize((256, 256), Image.LANCZOS).save(OUT + '_face.png', optimize=True)
    print('saved', OUT + '.png', out.getbbox(), 'and', OUT + '_face.png')


if __name__ == '__main__':
    main()
