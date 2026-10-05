"""End-to-end UI check + documentation screenshots (Playwright, headless Chromium).
Flow: admin login -> buildings -> building tabs -> edit a POI in the POI manager -> route tester -> publish
      -> viewer (served by the API) must show the edited POI and route to it.
Usage: python tools/e2e_screens.py [BASE_URL] [SLUG]    (admin password from $WF_ADMIN_PASSWORD or var/dev_admin_password)
Writes docs/img/*.png and exits non-zero if a check fails."""
import asyncio, os, sys, pathlib
from playwright.async_api import async_playwright

ROOT = pathlib.Path(__file__).resolve().parents[1]
BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8780"
SLUG = sys.argv[2] if len(sys.argv) > 2 else "greenland"
EMAIL = os.environ.get("WF_ADMIN_EMAIL", "admin@local")
PW = os.environ.get("WF_ADMIN_PASSWORD") or (ROOT / "var/dev_admin_password").read_text().strip()
IMG = ROOT / "docs/img"; IMG.mkdir(parents=True, exist_ok=True)
NEW_NAME = "Pastor's Office"
GL = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]


async def main():
    fails, logs = [], []
    async with async_playwright() as pw:
        br = await pw.chromium.launch(args=GL)
        pg = await (await br.new_context(viewport={"width": 1440, "height": 900})).new_page()
        pg.on("pageerror", lambda e: logs.append(f"PAGEERROR {e}"))
        shot = lambda n: pg.screenshot(path=str(IMG / f"{n}.png"))
        # ---- admin ----
        await pg.goto(BASE + "/admin/"); await pg.wait_for_selector("input[type=password]"); await shot("admin_01_login")
        await pg.fill("input[autocomplete=username]", EMAIL); await pg.fill("input[type=password]", PW)
        await pg.click("form button"); await pg.wait_for_selector(f"a[href='#/b/{SLUG}']"); await pg.wait_for_timeout(800); await shot("admin_02_buildings")
        await pg.goto(BASE + "/admin/#/new"); await pg.wait_for_timeout(1000); await shot("admin_03_add_building_wizard")
        for tab, wait in [("overview", 1500), ("georef", 6000), ("floors", 1000)]:
            await pg.goto(BASE + f"/admin/#/b/{SLUG}/{tab}"); await pg.wait_for_timeout(wait); await shot(f"admin_04_{tab}")
        # POI manager: edit Room F1-01
        await pg.goto(BASE + f"/admin/#/b/{SLUG}/pois"); await pg.wait_for_timeout(5000)
        item = pg.locator(".poilist li", has_text="Room F1-01")  # first run; later runs find the renamed POI
        if await item.count() == 0: item = pg.locator(".poilist li", has_text=NEW_NAME)
        await item.first.click(); await pg.wait_for_timeout(600)
        card = pg.locator(".card", has=pg.locator("text=Opening hours"))
        await card.locator("input").first.fill(NEW_NAME)
        await card.locator("input[placeholder^='e.g.']").fill("Mon–Fri 9:00–15:00")
        await card.locator("button.primary", has_text="Save").click(); await pg.wait_for_timeout(1500); await shot("admin_05_pois_edit")
        # route tester
        await pg.goto(BASE + f"/admin/#/b/{SLUG}/routes"); await pg.wait_for_timeout(4000)
        sels = pg.locator("select")
        n = await sels.count()
        opts_from = await sels.nth(n - 2).locator("option").all_inner_texts()
        await sels.nth(n - 2).select_option(label=next(o for o in opts_from if o.startswith("Parking")))
        await sels.nth(n - 1).select_option(label=next(o for o in opts_from if o.startswith(NEW_NAME)))
        await pg.click("button:has-text('Route')"); await pg.wait_for_timeout(2500); await shot("admin_06_route_tester")
        # publish
        await pg.goto(BASE + f"/admin/#/b/{SLUG}/publish"); await pg.wait_for_timeout(1200)
        await pg.click("button.primary:has-text('Publish')"); await pg.wait_for_timeout(4000); await shot("admin_07_publish")
        await pg.goto(BASE + f"/admin/#/b/{SLUG}/jobs"); await pg.wait_for_timeout(1200); await shot("admin_08_jobs")
        # ---- viewer ----
        await pg.goto(BASE + f"/?b={SLUG}")
        await pg.wait_for_function("window.wfUI && window.wf", timeout=120000); await pg.wait_for_timeout(6000); await shot("viewer_01_home")
        await pg.click("#q"); await pg.keyboard.type("pastor", delay=50); await pg.wait_for_timeout(800); await shot("viewer_02_search")
        txt = await pg.inner_text("#acList")
        if NEW_NAME not in txt: fails.append("viewer search does not show the edited POI")
        await pg.keyboard.press("ArrowDown"); await pg.keyboard.press("Enter"); await pg.wait_for_timeout(3000); await shot("viewer_03_place")
        await pg.click("#pDir"); await pg.wait_for_timeout(6000); await shot("viewer_04_directions")
        body = await pg.inner_text("body")
        if "min" not in body: fails.append("viewer directions show no ETA")
        await br.close()
    for l in logs: print(l)
    print("FAILS:", fails or "none"); return 1 if fails or logs else 0

sys.exit(asyncio.run(main()))
