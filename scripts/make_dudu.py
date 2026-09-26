# -*- coding: utf-8 -*-
"""第一位车手「豆豆」的整身照和头像。原图 tmp/refs/ref_dudu.jpg 是举起左手招手的样子，这里改成两只手都垂着：
1. 去掉底部「抖音号」水印：压在两只脚上的字用周围的黄色补上，压在白底上的字直接涂白
2. 白底抠成透明（cutout_driver.cutout）
3. 左边举起的手那一块，换成右半边的镜像（身体轮廓 + 右边垂着的手），接缝羽化
用法: python scripts/make_dudu.py  →  public/img/dudu.png、public/img/dudu_face.png
"""
import cv2
import numpy as np
from PIL import Image

from cutout_driver import cutout

SRC, OUT = 'tmp/refs/ref_dudu.jpg', 'public/img/dudu'
AXIS = 632            # 身体左右对称轴（两眼中点）
Y0, Y1 = 290, 860     # 换成镜像的行范围（举起的手 y≈340~780，右边垂着的手 y≈600~800）
XCUT, FEATHER = 420, 36
WM = (355, 1140, 915, 1230)   # 水印框 x0,y0,x1,y1


def remove_watermark(rgb):
    x0, y0, x1, y1 = WM
    f = rgb.astype(np.float32) / 255
    mx, mn = f.max(2), f.min(2)
    sat = (mx - mn) / np.maximum(mx, 1e-3)
    yellow = (sat > 0.35) & (mx > 0.6)                  # 身体/脚的饱和度约 0.5；字的半透明边缘低于它
    # 字的半透明深色投影叠在黄脚上还是「黄」，另外按亮度认：字的笔画细，脚的明暗是渐变的，跟中值模糊比差得多的就是字
    lum = (f.mean(2) * 255).astype(np.uint8)
    thin = np.abs(lum.astype(np.int16) - cv2.medianBlur(lum, 21)) > 8
    text = np.zeros(rgb.shape[:2], np.uint8)
    text[y0:y1, x0:x1] = ~yellow[y0:y1, x0:x1] | thin[y0:y1, x0:x1]   # 白字、灰描边、投影、白底
    text = cv2.dilate(text, np.ones((3, 3), np.uint8), iterations=2)
    # 每个字的像素是在脚上还是在背景上：把「黄=255、白=0」的轮廓图在字的位置按周围补齐，再看补出来是黄还是白
    sil = np.where(yellow & (text == 0), 255, 0).astype(np.uint8)
    on_leg = (cv2.inpaint(sil, text * 255, 7, cv2.INPAINT_TELEA) > 127) & (text > 0)
    out = rgb.copy()
    out[(text > 0) & ~on_leg] = 255                     # 背景上的字：涂白，抠图时当背景去掉
    return cv2.inpaint(out, on_leg.astype(np.uint8) * 255, 9, cv2.INPAINT_TELEA)   # 脚上的字：用周围的黄色补


def arms_down(rgba):
    a = np.asarray(rgba).astype(np.float32)
    h, w = a.shape[:2]
    src = 2 * AXIS - np.arange(w)
    ok = (src >= 0) & (src < w)
    mir = np.zeros_like(a)
    mir[:, ok] = a[:, src[ok]]
    x, y = np.arange(w)[None, :], np.arange(h)[:, None]
    wx = np.clip((XCUT - x) / FEATHER, 0, 1)
    wy = np.clip(np.minimum(y - Y0, Y1 - y) / FEATHER, 0, 1)
    k = (wx * wy)[..., None]
    # 按预乘 alpha 混合，接缝处不会出白边
    pa, pm = a[..., :3] * a[..., 3:] / 255, mir[..., :3] * mir[..., 3:] / 255
    al = a[..., 3:] * (1 - k) + mir[..., 3:] * k
    rgb = (pa * (1 - k) + pm * k) / np.maximum(al / 255, 1e-3)
    out = np.concatenate([np.clip(rgb, 0, 255), al], 2).astype(np.uint8)
    return Image.fromarray(out, 'RGBA')


def main():
    rgb = np.asarray(Image.open(SRC).convert('RGB'))
    clean = Image.fromarray(remove_watermark(rgb))
    full = arms_down(cutout(clean, foot_sat=None, crop=False))
    head = full.crop((AXIS - 270, 0, AXIS + 270, 540))   # 头像：脑袋 + 一点肩膀
    full = full.crop(full.getbbox())
    k = 640 / max(full.size)
    full = full.resize((round(full.width * k), round(full.height * k)), Image.LANCZOS)
    full.save(OUT + '.png', optimize=True)
    head.resize((256, 256), Image.LANCZOS).save(OUT + '_face.png', optimize=True)
    print('saved', OUT + '.png', full.size, 'and', OUT + '_face.png')


if __name__ == '__main__':
    main()
