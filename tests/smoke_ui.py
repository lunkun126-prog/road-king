"""浏览器冒烟测试：起一个临时端口的服务 + 独立数据库，headless 真跑三种模式、手机竖屏布局。
用法：py -3.11 tests/smoke_ui.py      截图落在 tmp/smoke/
"""
import os, re, subprocess, sys, time, json, pathlib
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / 'tmp' / 'smoke'
OUT.mkdir(parents=True, exist_ok=True)
DB = ROOT / 'tmp' / 'smoke-db.json'
if DB.exists():
    DB.unlink()

env = dict(os.environ, PORT='0', ROAD_KING_DB=str(DB))
srv = subprocess.Popen(['node', 'server.js'], cwd=ROOT, env=env, stdout=subprocess.PIPE, text=True, encoding='utf-8')
line = srv.stdout.readline()
port = re.search(r':(\d+)', line).group(1)
BASE = f'http://127.0.0.1:{port}'
fails = []


def check(cond, msg):
    print(('PASS ' if cond else 'FAIL ') + msg)
    if not cond:
        fails.append(msg)


def hold(page, key, sec):
    page.keyboard.down(key)
    page.wait_for_timeout(int(sec * 1000))
    page.keyboard.up(key)


try:
    with sync_playwright() as p:
        b = p.chromium.launch(args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
        page = b.new_page(viewport={'width': 1280, 'height': 760})
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('console', lambda m: m.type == 'error' and 'fonts.g' not in m.text and errors.append(m.text))
        page.goto(BASE)
        page.wait_for_function('window.__rk && window.__rk.state === "menu"', timeout=15000)
        page.wait_for_timeout(1500)
        # 每天第一次打开弹签到
        check(page.is_visible('#signin'), '首次打开弹出签到')
        check(page.locator('#signGrid .sday').count() == 7, '签到 7 天格子')
        page.screenshot(path=OUT / '00_signin.png')
        page.click('#signGo')
        page.wait_for_timeout(300)
        prof = page.evaluate('window.__rk.profile()')
        check(prof['coins'] == 100 and prof['gems'] == 2 and prof['sign']['days'] == 1, f'签到第 1 天到账 🪙{prof["coins"]} 💎{prof["gems"]}')
        check(page.is_disabled('#signGo'), '签过后按钮变灰')
        page.click('#signBack')
        page.wait_for_timeout(300)
        page.screenshot(path=OUT / '01_menu.png')
        check(page.is_visible('#menu'), '主菜单显示')
        check('2' == page.inner_text('#menu .gemText'), '主菜单显示钻石')
        check(page.locator('.menu-nav [data-go=music]').count() == 1, '主菜单有 🎵 音乐入口')

        # 公路之王
        page.click('.mode-card[data-mode=king]')
        check(page.is_visible('#setup'), '公路之王先选路线/天气')
        check(page.locator('#mapList .map').count() == 3, '三条路线')
        page.screenshot(path=OUT / '01b_setup.png')
        page.click('#setupGo')
        page.wait_for_function('window.__rk.state === "play"')
        hold(page, 'KeyW', 4)
        v = page.evaluate('window.__rk.game.player.v * 3.6')
        check(v > 12, f'踩油门 4 秒后车速 {v:.0f} km/h（软件渲染帧率低，只验证能加速）')
        page.keyboard.down('KeyW')
        page.keyboard.press('KeyE')
        page.wait_for_timeout(200)
        check(page.evaluate('window.__rk.game.player.signal') == 'R', '按 E 打右转向灯')
        hold(page, 'KeyD', 0.8)
        page.keyboard.up('KeyW')
        page.screenshot(path=OUT / '02_king_fp.png')
        page.keyboard.press('KeyC')
        hold(page, 'KeyW', 2)
        page.screenshot(path=OUT / '03_king_tp.png')
        check(page.is_visible('#minimap'), '右上角小地图')
        speed_txt = page.inner_text('#speed')
        check(int(speed_txt) > 0, f'HUD 车速显示 {speed_txt}')
        page.keyboard.press('Escape')
        page.wait_for_timeout(200)
        check(page.is_visible('#pause'), 'Esc 暂停')
        page.click('#pQuit')
        page.wait_for_timeout(300)
        check(page.is_visible('#menu'), '退回主菜单')

        # 驾考
        page.click('.mode-card[data-mode=exam]')
        check(page.locator('.level.locked').count() == 7, '驾考 8 关只解锁第 1 关')
        page.click('.level >> nth=0')
        check(page.is_visible('#brief'), '关卡说明')
        page.click('#briefGo')
        hold(page, 'KeyW', 2.5)
        check(page.evaluate('window.__rk.game.mode') == 'exam', '驾考开局')
        check(page.is_visible('#limit'), '限速牌显示')
        page.screenshot(path=OUT / '04_exam.png')
        # 直接跳到终点前，确认合格结算和下一关解锁
        page.evaluate('() => { const g = window.__rk.game; g.cars = []; g.player.s = g.lv.dist - 20; g.player.v = 12; }')
        page.wait_for_selector('#result:not([hidden])', timeout=8000)
        check('合格' in page.inner_text('#rTitle'), '驾考到终点结算：' + page.inner_text('#rTitle'))
        page.screenshot(path=OUT / '05_exam_result.png')
        check(page.is_visible('#rNext'), '出现「下一关」')

        # 雪天滨海高速 + 雨天盘山
        for mp, wx, shot in [('highway', 'snow', '06a_highway_snow'), ('mountain', 'rain', '06b_mountain_rain')]:
            page.evaluate(f'() => {{ const p = window.__rk.profile(); p.map = "{mp}"; p.weather = "{wx}"; window.__rk.start("king"); }}')
            hold(page, 'KeyW', 3)
            g = page.evaluate('({map: window.__rk.game.map.id, wx: window.__rk.game.weather.id, v: window.__rk.game.player.v})')
            check(g['map'] == mp and g['wx'] == wx and g['v'] > 5, f'{mp}/{wx} 能开 {g}')
            page.screenshot(path=OUT / f'{shot}.png')
        check(not errors, f'换地图天气无报错 {errors[:3]}')

        # 每款车第一人称都能看到路（新车漏登记视高 → 相机 NaN → 满屏天空）
        from PIL import Image
        for vid in ['sedan', 'quadri', 'stoccarda', 'sport', 'woking', 'toro', 'moto', 'ninja', 'truck']:
            page.evaluate(f'() => {{ const p = window.__rk.profile(); p.vehicle = "{vid}"; p.map = "city"; p.weather = "clear"; p.settings.cam = "fp"; window.__rk.start("king"); }}')
            page.wait_for_timeout(1200)
            shot = OUT / f'07_fp_{vid}.png'
            page.screenshot(path=shot)
            im = Image.open(shot).convert('RGB')
            w, h = im.size
            band = [im.getpixel((x, int(h * 0.56))) for x in range(0, w, 16)]
            spread = max(max(c[i] for c in band) - min(c[i] for c in band) for i in range(3))
            check(spread > 40, f'{vid} 第一人称能看到路面（中下部色差 {spread}）')

        # 大运狂飙
        page.evaluate('window.__rk.start("rampage")')
        page.keyboard.down('KeyW')
        for i in range(8):
            hold(page, 'KeyA' if i % 2 else 'KeyD', 0.7)
        page.keyboard.up('KeyW')
        page.screenshot(path=OUT / '06_rampage.png')
        sm = page.evaluate('window.__rk.game.stats.smash')
        print('  创飞数', sm)
        page.evaluate('window.__rk.game.timeLeft = 0.05')
        page.wait_for_selector('#result:not([hidden])', timeout=8000)
        page.wait_for_timeout(800)
        page.screenshot(path=OUT / '07_rampage_result.png')
        board = json.loads(page.evaluate(f'fetch("{BASE}/api/leaderboard/rampage").then(r => r.text())'))
        check(len(board) == 1, f'成绩进排行榜 {board}')
        prof = page.evaluate('window.__rk.profile()')
        check(prof['coins'] > 0, f'金币入账 {prof["coins"]}')
        check(prof['tasks']['prog'].get('runs', 0) >= 1 or 'runs' not in prof['tasks']['ids'], f'每日任务进度记录 {prof["tasks"]}')

        # 车库 / 排行 / 设置 页能打开
        page.click('#rMenu')
        for go in ['garage', 'board', 'settings', 'help', 'music', 'tasks', 'drivers']:
            page.click(f'.menu-nav [data-go={go}]')
            page.wait_for_timeout(300)
            check(page.is_visible('#' + go), f'{go} 页')
            page.screenshot(path=OUT / f'08_{go}.png')
            page.click(f'#{go} .back')
        # 音乐页能选歌
        page.click('.menu-nav [data-go=music]')
        page.wait_for_timeout(300)
        check(page.locator('#musicList [data-song]').count() > 0, '音乐页列出歌曲')
        page.click('#music .back')
        # 招募车手
        page.evaluate('window.__rk.profile().coins = 20000; window.__rk.profile().gems = 100')
        page.click('.menu-nav [data-go=drivers]')
        page.click('#driverList [data-buy=xue]')
        page.wait_for_timeout(200)
        prof = page.evaluate('window.__rk.profile()')
        check(prof['driver'] == 'xue' and prof['coins'] == 19200, f'招募小雪花 800 金币并出战 {prof["driver"]} {prof["coins"]}')
        page.screenshot(path=OUT / '11_drivers.png')
        page.click('#drivers .back')
        # 改装
        page.click('.menu-nav [data-go=garage]')
        page.click('#carList .car >> nth=0 >> .tune-btn')
        page.wait_for_timeout(200)
        check(page.is_visible('#tune'), '改装页')
        page.click('#tuneList [data-part=engine]')
        page.wait_for_timeout(200)
        prof = page.evaluate('window.__rk.profile()')
        check(prof['upgrades'].get('sedan', {}).get('engine') == 1, f'引擎升到 1 级 {prof["upgrades"]}')
        page.screenshot(path=OUT / '12_tune.png')
        page.click('#tune .back')
        check(page.is_visible('#garage'), '改装页返回车库')
        page.click('#garage .back')
        # 改装 + 车手加成进了对局
        page.evaluate('window.__rk.profile().vehicle = "sedan"; window.__rk.start("king")')
        page.wait_for_function('window.__rk.state === "play"')
        mv = page.evaluate('window.__rk.game.V.maxV * 3.6')
        check(abs(mv - 220 * 1.03 * 1.06) < 0.5, f'开局极速含改装与车手加成 {mv:.1f}')
        page.keyboard.press('Escape')
        page.click('#pQuit')
        check(not errors, f'无 JS 报错 {errors[:3]}')

        # 手机竖屏
        m = b.new_page(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True, device_scale_factor=2)
        m.goto(BASE)
        m.wait_for_function('window.__rk && window.__rk.state === "menu"', timeout=15000)
        m.wait_for_timeout(800)
        check(m.is_visible('#signin'), '手机也弹签到')
        check(m.evaluate('document.querySelector("#signin .card").scrollHeight <= innerHeight'), '手机签到页放得下')
        m.screenshot(path=OUT / '09a_mobile_signin.png')
        m.tap('#signBack')
        m.wait_for_timeout(300)
        m.screenshot(path=OUT / '09_mobile_menu.png')
        check(m.evaluate('document.documentElement.scrollWidth <= innerWidth'), '手机主菜单无横向溢出')
        m.tap('.mode-card[data-mode=king]')
        m.wait_for_timeout(300)
        check(m.evaluate('document.querySelector("#setup .card").scrollHeight <= innerHeight'), '手机选路线页放得下')
        m.screenshot(path=OUT / '09b_mobile_setup.png')
        m.tap('#setupGo')
        m.wait_for_function('window.__rk.state === "play"')
        # 同时按住油门和转动方向盘(两个 pointer)
        m.evaluate('''() => {
          const fire = (el, type, id, x, y) => el.dispatchEvent(new PointerEvent(type, {pointerId: id, bubbles: true, clientX: x, clientY: y, pointerType: 'touch'}));
          const gas = document.querySelector('#pGas'), wh = document.querySelector('#wheel');
          const r = wh.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
          fire(gas, 'pointerdown', 11, 0, 0);
          fire(wh, 'pointerdown', 12, cx, cy - r.height / 2);
          fire(wh, 'pointermove', 12, cx + r.width / 2, cy);
        }''')
        m.wait_for_timeout(2500)
        g = m.evaluate('({v: window.__rk.game.player.v * 3.6, steer: window.__rk.game.player.steer})')
        check(g['v'] > 8 and g['steer'] > 0.3, f'多点触控：油门+方向盘同时生效 {g}')
        m.screenshot(path=OUT / '10_mobile_play.png')
        check(not errors, f'手机页无 JS 报错 {errors[:3]}')
        b.close()
finally:
    srv.terminate()
    if DB.exists():
        DB.unlink()

print(f'\n{"全部通过" if not fails else f"{len(fails)} 项失败"}，截图在 {OUT}')
sys.exit(1 if fails else 0)
