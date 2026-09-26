# -*- coding: utf-8 -*-
"""把白底的车手照片抠成透明 PNG，并裁一张方形头像。

用法: python scripts/cutout_driver.py tmp/refs/ref_kangaroo.png public/img/kangaroo  (原图放 tmp/refs，不进仓库)
产出: <out>.png(整身透明图, 最长边 640)  <out>_face.png(头部方形头像 256x256)

背景 = 从图片四边连通过来的「低饱和度浅色」像素(白底 + 灰色落地阴影)；
被角色包住的白色(眼白)不连边，所以会保留。
"""
import sys

import numpy as np
from PIL import Image, ImageFilter
from scipy import ndimage


def cutout(src, foot_sat=0.4, crop=True):
    """src: 路径或 PIL 图。foot_sat: 最下面 12% 里饱和度低于它的也算背景(袋鼠脚是很饱和的黄，贴脚的阴影带黄色反光)；
    角色本身颜色浅(饱和度 < 0.4)时传 None 关掉。"""
    im = (Image.open(src) if isinstance(src, str) else src).convert("RGB")
    a = np.asarray(im).astype(np.float32) / 255
    mx, mn = a.max(axis=2), a.min(axis=2)
    sat = (mx - mn) / np.maximum(mx, 1e-3)
    bg_like = (sat < 0.2) & (mx > 0.55)           # 白底、浅灰/米黄的落地阴影(肚皮浅黄饱和度约 0.3，不会被当成背景)
    if foot_sat:
        foot = int(a.shape[0] * 0.88)
        bg_like[foot:] |= (sat[foot:] < foot_sat) & (mx[foot:] > 0.55)
    lab, _ = ndimage.label(bg_like)
    edge = np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]]))
    bg = np.isin(lab, edge[edge > 0])
    fg = ndimage.binary_fill_holes(~bg)             # 角色内部的小空洞补上
    fg = ndimage.binary_opening(fg, iterations=2)   # 去掉零星噪点
    fg = ndimage.binary_erosion(fg, iterations=1)   # 往里收 1px，去掉白边
    alpha = Image.fromarray((fg * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(1.2))
    out = im.convert("RGBA")
    out.putalpha(alpha)
    return out.crop(out.getbbox()) if crop else out


def face_crop(full):
    """头像：取上半身偏上的正方形(胖袋鼠的头在上 45%)。"""
    w, h = full.size
    side = int(min(w, h * 0.62))
    top = int(h * 0.0)
    left = max(0, min(w - side, int(w * 0.30) - side // 2 + int(w * 0.12)))
    return full.crop((left, top, left + side, top + side)).resize((256, 256), Image.LANCZOS)


def main():
    src, out = sys.argv[1], sys.argv[2]
    full = cutout(src)
    k = 640 / max(full.size)
    if k < 1:
        full = full.resize((round(full.width * k), round(full.height * k)), Image.LANCZOS)
    full.save(out + ".png", optimize=True)
    face_crop(full).save(out + "_face.png", optimize=True)
    print("saved", out + ".png", full.size, "and", out + "_face.png")


if __name__ == "__main__":
    main()
