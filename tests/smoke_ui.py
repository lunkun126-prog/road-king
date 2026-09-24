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
        page.screenshot(path=OUT / '01_menu.png')
        check(page.is_visible('#menu'), '主菜单显示')

        # 公路之王
        page.click('.mode-card[data-mode=king]')
        check(page.is_visible('#setup'), '公路之王先选路线/天气')
        check(page.locator('#mapList .map').count() == 3, '三条路线')
        page.screenshot(path=OUT / '01b_setup.png')
        page.click('#setupGo')
        page.wait_for_function('window.__rk.state === "play"')
        hold(page, 'KeyW', 4)
        v = page.evaluate('window.__rk.game.player.v * 3.6')
        check(v > 30, f'踩油门 4 秒后车速 {v:.0f} km/h')
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

        # 车库 / 排行 / 设置 页能打开
        page.click('#rMenu')
        for go in ['garage', 'board', 'settings', 'help']:
            page.click(f'.menu-nav [data-go={go}]')
            page.wait_for_timeout(300)
            check(page.is_visible('#' + go), f'{go} 页')
            page.screenshot(path=OUT / f'08_{go}.png')
            page.click(f'#{go} .back')
        check(not errors, f'无 JS 报错 {errors[:3]}')

        # 手机竖屏
        m = b.new_page(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True, device_scale_factor=2)
        m.goto(BASE)
        m.wait_for_function('window.__rk && window.__rk.state === "menu"', timeout=15000)
        m.wait_for_timeout(800)
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
        check(g['v'] > 20 and g['steer'] > 0.3, f'多点触控：油门+方向盘同时生效 {g}')
        m.screenshot(path=OUT / '10_mobile_play.png')
        check(not errors, f'手机页无 JS 报错 {errors[:3]}')
        b.close()
finally:
    srv.terminate()
    if DB.exists():
        DB.unlink()

print(f'\n{"全部通过" if not fails else f"{len(fails)} 项失败"}，截图在 {OUT}')
sys.exit(1 if fails else 0)
