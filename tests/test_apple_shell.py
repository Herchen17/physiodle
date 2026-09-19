import functools
import http.server
import math
import threading
import unittest
from pathlib import Path

from playwright.sync_api import sync_playwright


PUBLIC_DIR = Path(__file__).resolve().parents[1] / "public"


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, _format, *_args):
        pass


class AppleShellTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        handler = functools.partial(QuietHandler, directory=str(PUBLIC_DIR))
        cls.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base_url = f"http://127.0.0.1:{cls.server.server_port}/index.html"
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.webkit.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=2)

    def open_page(self, width, height, *, color_scheme="light", reduced_motion="no-preference"):
        context = self.browser.new_context(
            viewport={"width": width, "height": height},
            color_scheme=color_scheme,
            reduced_motion=reduced_motion,
        )
        page = context.new_page()
        page.goto(self.base_url, wait_until="domcontentloaded", timeout=10_000)
        page.set_default_timeout(2_000)
        return context, page

    def test_mobile_primary_actions_form_a_safe_area_bottom_toolbar(self):
        """Catches the mobile navigation regressing into crowded header pills."""
        context, page = self.open_page(393, 852)
        try:
            nav = page.locator(".primary-nav")
            self.assertEqual(nav.count(), 1)
            styles = nav.evaluate(
                "el => ({position: getComputedStyle(el).position, bottom: getComputedStyle(el).bottom})"
            )
            self.assertEqual(styles["position"], "fixed")
            self.assertNotEqual(styles["bottom"], "auto")
            nav_box = nav.bounding_box()
            self.assertIsNotNone(nav_box)
            self.assertGreaterEqual(nav_box["y"], 760)
            for button in nav.locator("button").all():
                box = button.bounding_box()
                self.assertIsNotNone(box)
                self.assertGreaterEqual(box["height"], 44)
                self.assertGreaterEqual(box["width"], 44)
        finally:
            context.close()

    def test_light_canvas_is_visibly_mint_not_near_white(self):
        """Catches the branded green canvas being washed out until it reads as white."""
        context, page = self.open_page(393, 852)
        try:
            colour = page.locator("body").evaluate(
                "el => getComputedStyle(el).backgroundColor.match(/\\d+/g).map(Number)"
            )
            red, green, blue = colour[:3]
            distance_from_white = math.sqrt(
                (255 - red) ** 2 + (255 - green) ** 2 + (255 - blue) ** 2
            )
            self.assertGreater(green, red)
            self.assertGreater(green, blue)
            self.assertGreaterEqual(distance_from_white, 40)
            theme_hex = page.locator(
                'meta[name="theme-color"][media="(prefers-color-scheme: light)"]'
            ).get_attribute("content")
            self.assertEqual(
                theme_hex.lower(),
                f"#{red:02x}{green:02x}{blue:02x}",
            )
        finally:
            context.close()

    def test_desktop_actions_remain_in_the_header(self):
        """Catches the mobile dock treatment leaking into desktop browsing."""
        context, page = self.open_page(1280, 900)
        try:
            position = page.locator(".primary-nav").evaluate("el => getComputedStyle(el).position")
            self.assertNotEqual(position, "fixed")
        finally:
            context.close()

    def test_small_tablet_header_does_not_overflow(self):
        """Catches the labelled desktop controls clipping between phone and desktop widths."""
        for width in (641, 768, 900):
            with self.subTest(width=width):
                context, page = self.open_page(width, 900)
                try:
                    metrics = page.evaluate(
                        "() => ({client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth})"
                    )
                    self.assertLessEqual(metrics["scroll"], metrics["client"])
                    position = page.locator(".primary-nav").evaluate(
                        "el => getComputedStyle(el).position"
                    )
                    self.assertNotEqual(position, "fixed")
                    header_box = page.locator(".app-shell-header").bounding_box()
                    nav_box = page.locator(".primary-nav").bounding_box()
                    self.assertIsNotNone(header_box)
                    self.assertIsNotNone(nav_box)
                    self.assertGreaterEqual(nav_box["y"], header_box["y"] + header_box["height"])
                finally:
                    context.close()

    def test_mobile_modal_presents_as_a_bottom_sheet(self):
        """Catches short tasks reverting to centred desktop-style dialogs on iPhone."""
        context, page = self.open_page(393, 852)
        try:
            page.locator("#installModal").evaluate("el => el.classList.add('show')")
            overlay = page.locator("#installModal").evaluate(
                "el => ({align: getComputedStyle(el).alignItems, paddingBottom: getComputedStyle(el).paddingBottom})"
            )
            sheet = page.locator("#installModal .modal").evaluate(
                "el => ({margin: getComputedStyle(el).marginTop, radius: getComputedStyle(el).borderTopLeftRadius})"
            )
            self.assertEqual(overlay["align"], "flex-end")
            self.assertNotEqual(overlay["paddingBottom"], "0px")
            self.assertEqual(sheet["margin"], "0px")
            self.assertGreaterEqual(float(sheet["radius"].replace("px", "")), 20)
        finally:
            context.close()

    def test_clinical_content_remains_opaque(self):
        """Catches Liquid Glass spreading from controls into clinical reading surfaces."""
        context, page = self.open_page(393, 852)
        try:
            page.locator("#cluesContainer").evaluate(
                "el => el.innerHTML = '<article class=\"card clue-card revealed\"><span class=\"clue-text\">Clinical clue</span></article>'"
            )
            styles = page.locator(".clue-card").evaluate(
                "el => ({background: getComputedStyle(el).backgroundColor, backdrop: getComputedStyle(el).backdropFilter})"
            )
            self.assertIn(styles["background"], {"rgb(255, 255, 255)", "rgb(28, 28, 30)"})
            self.assertIn(styles["backdrop"], {"none", ""})
        finally:
            context.close()

    def test_dark_mode_uses_a_dark_clinical_surface(self):
        """Catches dark mode falling back to the light canvas or low-contrast clue text."""
        context, page = self.open_page(393, 852, color_scheme="dark")
        try:
            page.locator("#cluesContainer").evaluate(
                "el => el.innerHTML = '<article class=\"card clue-card revealed\"><span class=\"clue-text\">Clinical clue</span></article>'"
            )
            styles = page.locator(".clue-card").evaluate(
                "el => ({background: getComputedStyle(el).backgroundColor, color: getComputedStyle(el.querySelector(\'.clue-text\')).color})"
            )
            self.assertEqual(styles["background"], "rgb(28, 28, 30)")
            self.assertEqual(styles["color"], "rgb(242, 242, 247)")
        finally:
            context.close()

    def test_dark_mode_overrides_legacy_inline_welcome_colours(self):
        """Catches the first-run message retaining low-contrast legacy grey in dark mode."""
        context, page = self.open_page(393, 852, color_scheme="dark")
        try:
            colour = page.locator("#loginPromptOverlay p").evaluate("el => getComputedStyle(el).color")
            self.assertEqual(colour, "rgb(174, 183, 180)")
        finally:
            context.close()

    def test_dark_mode_account_panels_use_semantic_surfaces(self):
        """Catches legacy light profile and rank cards appearing inside the dark account sheet."""
        context, page = self.open_page(393, 852, color_scheme="dark")
        try:
            rank = page.locator("#accountRankBadge").evaluate(
                "el => ({background: getComputedStyle(el).backgroundColor, label: getComputedStyle(el.querySelector('.account-rank-label')).color})"
            )
            panels = page.locator(".account-panel").evaluate_all(
                "els => els.map(el => getComputedStyle(el).backgroundColor)"
            )
            self.assertEqual(rank["background"], "rgb(37, 42, 41)")
            self.assertEqual(rank["label"], "rgb(174, 183, 180)")
            self.assertTrue(panels)
            self.assertTrue(all(colour == "rgb(37, 42, 41)" for colour in panels))
        finally:
            context.close()

    def test_interactive_chrome_keeps_44px_hit_targets(self):
        """Catches visually compact controls shrinking their actual tappable area."""
        context, page = self.open_page(393, 852)
        try:
            page.locator("#installModal").evaluate("el => el.classList.add('show')")
            for selector in (".header-btn", ".modal-close", ".sibling-popout-dismiss"):
                for button in page.locator(f"{selector}:visible").all():
                    box = button.bounding_box()
                    self.assertIsNotNone(box)
                    self.assertGreaterEqual(box["height"], 44, selector)
                    self.assertGreaterEqual(box["width"], 44, selector)
        finally:
            context.close()

    def test_reduced_motion_disables_sheet_animation(self):
        """Catches decorative sheet motion ignoring the user's Reduce Motion setting."""
        context, page = self.open_page(393, 852, reduced_motion="reduce")
        try:
            page.locator("#installModal").evaluate("el => el.classList.add('show')")
            animation = page.locator("#installModal .modal").evaluate("el => getComputedStyle(el).animationName")
            self.assertEqual(animation, "none")
        finally:
            context.close()


if __name__ == "__main__":
    unittest.main()
