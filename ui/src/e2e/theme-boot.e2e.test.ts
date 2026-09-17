import { expect, it } from "vitest";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import {
  controlUiBundledGatewayUrl,
  installMockGateway,
  waitForControlUiRoute,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI theme continuity during startup" });
const profileId = "theme-reader";
const secondSessionKey = "agent:main:dashboard:12345678-90ab-cdef-1234-567890abcdef";
const variants = [
  { system: "light", mode: "dark", saved: true },
  { system: "dark", mode: "light", saved: true },
  { system: "light", mode: "system", saved: true },
  { system: "dark", mode: "system", saved: true },
  { system: "light", mode: "system", saved: false },
  { system: "dark", mode: "system", saved: false },
] as const;

type ThemeFrame = {
  time: number;
  theme: string | undefined;
  mode: string | undefined;
  html: string;
  body: string;
};

declare global {
  interface Window {
    themeBootFrames: ThemeFrame[];
  }
}

suite.define(() => {
  for (const width of [1440, 390]) {
    it.each(variants)(
      `keeps every painted frame at ${width}px for system=$system mode=$mode saved=$saved`,
      async ({ system, mode, saved }) => {
        let releaseAppScripts = () => {};
        await suite.withPage(
          {
            colorScheme: system,
            deviceScaleFactor: 2,
            locale: "en-US",
            serviceWorkers: "block",
            viewport: { width, height: 900 },
          },
          async ({ page }) => {
            const theme = saved ? "rose" : "claw";
            const resolvedMode = mode === "system" ? system : mode;
            const resolvedTheme = saved
              ? resolvedMode === "light"
                ? "rose-light"
                : "rose"
              : resolvedMode;
            const config = saved
              ? { ui: { prefs: { theme: "absolutely", themeMode: system } } }
              : {};
            const profileResponse = {
              status: "ok",
              entries: saved ? { "ui.theme": theme, "ui.themeMode": mode } : {},
            };
            const gateway = await installMockGateway(page, {
              presenceUsers: saved ? [{ id: profileId, name: "Theme Reader", self: true }] : [],
              sessions: [
                { key: "agent:main:main", kind: "direct", label: "Home", updatedAt: 2 },
                {
                  key: secondSessionKey,
                  kind: "direct",
                  label: "Second conversation",
                  updatedAt: 1,
                },
              ],
              deferredMethods: saved ? ["users.prefs.get"] : [],
              historyMessages: [{ role: "assistant", content: "Theme continuity is ready." }],
              methodResponses: {
                "config.get": { config, raw: JSON.stringify(config), hash: "theme-boot" },
                "users.prefs.get": profileResponse,
              },
            });
            await page.addInitScript(
              (seed) => {
                if (!seed.saved || sessionStorage.getItem("theme-boot-seeded")) {
                  return;
                }
                sessionStorage.setItem("theme-boot-seeded", "1");
                localStorage.setItem(
                  `openclaw.control.settings.v1:${seed.gatewayUrl}`,
                  JSON.stringify({
                    gatewayUrl: seed.gatewayUrl,
                    theme: seed.theme,
                    themeMode: seed.mode,
                  }),
                );
                localStorage.setItem(
                  `openclaw.control.serverPrefs.v1:${seed.gatewayUrl}:profile:${seed.profileId}`,
                  JSON.stringify({ theme: seed.theme, themeMode: seed.mode }),
                );
              },
              {
                gatewayUrl: controlUiBundledGatewayUrl(suite.server.baseUrl),
                theme,
                mode,
                saved,
                profileId,
              },
            );
            // Observe the real boot document before module evaluation and retain
            // transient frames that a final-state assertion cannot detect.
            await page.addInitScript({
              content: `
                window.themeBootFrames = [];
                function sampleThemeFrame() {
                  const root = document.documentElement;
                  if (root && document.body) {
                    const html = getComputedStyle(root);
                    window.themeBootFrames.push({
                      time: performance.now(), theme: root.dataset.theme,
                      mode: root.dataset.themeMode, html: html.backgroundColor,
                      body: getComputedStyle(document.body).backgroundColor
                    });
                  }
                  requestAnimationFrame(sampleThemeFrame);
                }
                requestAnimationFrame(sampleThemeFrame);
              `,
            });
            const settleFrames = () =>
              page.evaluate(
                () =>
                  new Promise<void>((resolve) => {
                    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
                  }),
              );
            const assertFrames = async () => {
              await settleFrames();
              const { frames, stable, surfaces } = await page.evaluate(() => {
                const root = document.documentElement;
                const style = getComputedStyle(root);
                // The canvas owner uses --bg and, for narrow chat, --bg-content.
                // Let the browser serialize token colors like computed backgrounds.
                const sample = document.createElement("span");
                sample.style.display = "none";
                document.body.append(sample);
                const surfaceColors = ["--bg", "--bg-content"]
                  .map((token) => style.getPropertyValue(token).trim())
                  .filter(Boolean)
                  .map((color) => {
                    sample.style.backgroundColor = color;
                    return getComputedStyle(sample).backgroundColor;
                  });
                sample.remove();
                return {
                  frames: window.themeBootFrames,
                  stable: { theme: root.dataset.theme, mode: root.dataset.themeMode },
                  surfaces: surfaceColors,
                };
              });
              expect(stable).toEqual({ theme: resolvedTheme, mode: resolvedMode });
              expect(surfaces.length).toBeGreaterThan(0);
              expect(frames.length).toBeGreaterThan(0);
              expect(
                frames.filter(
                  (frame) =>
                    frame.theme !== resolvedTheme ||
                    frame.mode !== resolvedMode ||
                    !surfaces.includes(frame.html) ||
                    !surfaces.includes(frame.body),
                ),
                `Every painted frame must use the resolved palette: ${JSON.stringify({ stable, surfaces })}`,
              ).toEqual([]);
            };
            let appScriptsReady = Promise.resolve();
            const appAssets = new URL("assets/", suite.server.baseUrl);
            await page.route(
              (url) =>
                url.origin === appAssets.origin &&
                url.pathname.startsWith(appAssets.pathname) &&
                url.pathname.endsWith(".js"),
              async (route) => {
                if (route.request().resourceType() === "script") {
                  await appScriptsReady;
                }
                await route.fallback();
              },
            );
            for (const reload of [false, true]) {
              appScriptsReady = new Promise<void>((resolve) => {
                releaseAppScripts = resolve;
              });
              if (reload) {
                await page.reload({ waitUntil: "commit" });
              } else {
                await page.goto(`${suite.server.baseUrl}chat`, { waitUntil: "commit" });
              }
              // Make the pre-module paint observable even on fast runners. A
              // final DOM assertion misses a wrong canvas repaired by app boot.
              await page.waitForFunction(() => window.themeBootFrames.length >= 2);
              releaseAppScripts();
              if (saved) {
                await gateway.waitForRequest("users.prefs.get");
                await page.locator(".agent-chat__composer-combobox textarea").waitFor();
                await settleFrames();
                await gateway.resolveDeferred("users.prefs.get", profileResponse);
              }
              await page.getByText("Theme continuity is ready.", { exact: true }).waitFor();
              await assertFrames();
            }
            if (width !== 1440 || !saved || mode === "system") {
              return;
            }
            await gateway.setOnline(false);
            await page
              .locator(".agent-chat__composer-status-band", { hasText: "Offline" })
              .waitFor();
            await assertFrames();
            await gateway.setOnline(true);
            await waitForControlUiGatewayReady(page);
            await assertFrames();
            await page.evaluate((url) => {
              history.pushState(null, "", url);
              window.dispatchEvent(new PopStateEvent("popstate"));
            }, `${suite.server.baseUrl}settings/appearance`);
            await waitForControlUiRoute(page, {
              pathname: "/settings/appearance",
              routeId: "appearance",
            });
            await assertFrames();
            await page.goBack();
            await page.locator(".agent-chat__composer-combobox textarea").waitFor();
            await assertFrames();
            const newThread = page.locator("openclaw-app-sidebar .sidebar-brand__new-thread");
            await page
              .locator(
                `.sidebar-recent-session[data-session-key="${secondSessionKey}"] a.sidebar-recent-session__link`,
              )
              .click();
            await gateway.waitForRequest("chat.startup", {
              match: { sessionKey: secondSessionKey },
            });
            await assertFrames();
            await newThread.click();
            await page.locator(".new-session-page__message").waitFor();
            await assertFrames();
          },
          async () => releaseAppScripts(),
        );
      },
    );
  }
});
