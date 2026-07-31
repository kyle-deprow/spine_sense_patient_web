/**
 * iOS-Safari keyboard clipping regression spec.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS GUARDS
 * ---------------------------------------------------------------------------
 * On iOS Safari the FIRST field of an auth form is clipped at the TOP when the
 * on-screen keyboard opens (registration, profile DOB). The mechanism:
 *
 *   1. Safari ignores `interactive-widget=resizes-content`, so the LAYOUT
 *      viewport (`window.innerHeight`) never shrinks when the keyboard opens.
 *   2. Safari instead PANS the VISUAL viewport (`visualViewport.offsetTop`
 *      becomes positive) to reveal the focused field.
 *   3. The app shell is `html { overflow: hidden }` + `body { position: fixed;
 *      inset: 0 }` + `#root { height: 100% }`, so nothing shrinks to the visual
 *      viewport and nothing cancels the pan.
 *   4. `AuthScaffold` then collapses its header on focus, moving the field up
 *      another ~150-210px — straight out of the top of the panned visual
 *      viewport.
 *
 * The contract this spec pins is the one the fix establishes: **with the
 * keyboard open, the focused field's box is fully inside the VISUAL viewport.**
 *
 * ---------------------------------------------------------------------------
 * SIMULATION APPROACH — READ THIS BEFORE TRUSTING A GREEN RUN
 * ---------------------------------------------------------------------------
 * Playwright's WebKit does NOT raise a real iOS keyboard, and it never will:
 * there is no software keyboard in the headless engine. So a naive "focus the
 * field and check its rect" spec proves nothing — `visualViewport` simply never
 * changes and every assertion passes on the broken shell.
 *
 * `page.setViewportSize()` is equally useless here: it shrinks the LAYOUT and
 * the VISUAL viewport together, which is precisely the behaviour iOS Safari
 * does NOT have. The unfixed shell passes that test too, because `#root` at
 * `height: 100%` of a shrunken layout viewport is already the right size.
 *
 * This spec therefore takes approach (a): it installs a documented **model of
 * iOS Safari's keyboard geometry** into the page before the app boots, and
 * asserts the app shell responds to it. The model:
 *
 *   - shadows `visualViewport.height` / `.offsetTop` / `.pageTop` with
 *     controllable getters on the REAL `VisualViewport` object (identity,
 *     `instanceof` and `addEventListener` are untouched) and dispatches REAL
 *     `resize` + `scroll` events on it;
 *   - leaves `window.innerHeight` alone — reproducing the exact layout/visual
 *     divergence iOS produces and Chromium does not;
 *   - models Safari's worst case for a `position: fixed` body: a pan equal to
 *     the full keyboard height;
 *   - clamps that pan to the room the app shell actually leaves — Safari cannot
 *     pan into space the shell does not occupy, so a shell correctly sized to
 *     the visual viewport drives the modelled pan to 0 on its own;
 *   - AND treats an explicit document scroll-to-top (`window.scrollTo(0, 0)`,
 *     `window.scroll(...)`, `documentElement/body.scrollTop = 0`) as a pan
 *     cancel, which is the mechanism the fix's root visual-viewport controller
 *     is specified to use.
 *
 * WHAT A GREEN RUN PROVES: the app shell honours the visual-viewport contract —
 * it resizes itself to `visualViewport.height`, it does not leave the platform
 * room to pan (or it explicitly cancels the pan), and the focused registration
 * field's real, browser-computed box lands fully inside the visual viewport.
 * The layout reflow being measured is real; only the viewport geometry driving
 * it is modelled.
 *
 * WHAT A GREEN RUN DOES NOT PROVE: that real iOS Safari behaves this way. The
 * real pan magnitude, the keyboard height, the timing of the resize relative to
 * focus, and Safari's `interactive-widget` handling are all approximations. A
 * physical-iPhone check remains the acceptance gate for this fix.
 *
 * THIS SPEC FAILS ON THE UNFIXED SHELL. With `#root { height: 100% }` the
 * modelled pan stays at the full keyboard height forever (nothing cancels it,
 * and the 664px-tall shell leaves 299px of room to pan into), so
 * `visualViewport.offsetTop` never returns to 0 and the shell height never
 * tracks `visualViewport.height`. Both are hard assertions below.
 *
 * ---------------------------------------------------------------------------
 * PREREQUISITES
 * ---------------------------------------------------------------------------
 *   - The WebKit browser binary. There is no `playwright install` target in the
 *     orchestration Makefile, so on a fresh machine run:
 *         pnpm exec playwright install webkit
 *     Without it the run fails with "Executable doesn't exist at ...webkit-*".
 *   - A running patient-web stack (`make patient-web-up`), same as every other
 *     spec here. `PATIENT_WEB_BASE_URL` selects the target.
 *
 * Run with:  pnpm test:e2e:keyboard-ios
 *
 * This spec creates no account and submits no form — it only navigates to
 * /register and focuses a field, so it is safe against any environment the rest
 * of the suite is safe against.
 */
import { expect, test, type Page } from "@playwright/test";

/** testID of the FIRST text field on the registration screen. */
const FIRST_REGISTRATION_FIELD = "register-first-name";

/**
 * Modelled keyboard height as a fraction of the layout viewport. iPhone 14
 * portrait: the QWERTY keyboard plus the predictive bar occupies a little under
 * half the viewport. Must stay comfortably above the app's own
 * `KEYBOARD_MIN_SHRINK_PX = 150` heuristic in `useKeyboardMetrics`.
 */
const IOS_KEYBOARD_FRACTION = 0.45;

/** Sub-pixel slack for layout comparisons on a deviceScaleFactor=3 viewport. */
const PIXEL_SLACK = 1.5;

type KeyboardModelState = {
  layoutHeight: number;
  visualHeight: number;
  visualOffsetTop: number;
  keyboardHeight: number;
  requestedPan: number;
  panCancels: number;
  shellHeight: number;
};

type KeyboardModel = {
  open: (keyboardHeight: number, requestedPan: number) => void;
  close: () => void;
  read: () => KeyboardModelState;
};

type ModelWindow = { __ssIosKeyboard?: KeyboardModel };

type FieldGeometry = KeyboardModelState & {
  /** Field box in LAYOUT-viewport coordinates (what getBoundingClientRect gives). */
  layoutTop: number;
  layoutBottom: number;
  /** Field box translated into VISUAL-viewport coordinates. This is what iOS shows. */
  visualTop: number;
  visualBottom: number;
};

/**
 * Installs the iOS keyboard model. Must run before the app boots so the app's
 * own `visualViewport` listeners see the shadowed getters from their first read
 * (`useKeyboardMetrics` learns its baseline height at mount).
 */
async function installIosKeyboardModel(page: Page) {
  await page.addInitScript(() => {
    const modelWindow = window as unknown as ModelWindow;
    if (modelWindow.__ssIosKeyboard != null) return;

    const viewport = window.visualViewport;
    if (viewport == null) return;

    const viewportProto: object = Object.getPrototypeOf(viewport);
    const realHeight = Object.getOwnPropertyDescriptor(
      viewportProto,
      "height",
    )?.get;
    if (realHeight == null) return;

    const state = {
      keyboardHeight: 0,
      requestedPan: 0,
      panCancels: 0,
    };

    const layoutHeight = (): number => window.innerHeight;
    const trueVisualHeight = (): number => Number(realHeight.call(viewport));
    const modelledVisualHeight = (): number =>
      Math.max(0, trueVisualHeight() - state.keyboardHeight);

    /** Height of the app shell as the browser actually rendered it. */
    const shellHeight = (): number => {
      const shell = document.getElementById("root");
      return shell == null ? 0 : shell.getBoundingClientRect().height;
    };

    /**
     * Safari pans the visual viewport within the layout viewport, but only as
     * far as there is shell content to pan into. A shell sized to the visual
     * viewport leaves nothing, so the pan collapses to 0 — which is exactly
     * what the root visual-viewport controller is supposed to achieve.
     */
    const effectivePan = (): number => {
      if (state.keyboardHeight <= 0) return 0;
      const visual = modelledVisualHeight();
      const occupied = Math.min(
        shellHeight() || layoutHeight(),
        layoutHeight(),
      );
      const room = Math.max(0, occupied - visual);
      return Math.max(0, Math.min(state.requestedPan, room));
    };

    Object.defineProperty(viewport, "height", {
      configurable: true,
      get: modelledVisualHeight,
    });
    Object.defineProperty(viewport, "offsetTop", {
      configurable: true,
      get: effectivePan,
    });
    Object.defineProperty(viewport, "pageTop", {
      configurable: true,
      get: effectivePan,
    });

    const notify = () => {
      viewport.dispatchEvent(new Event("resize"));
      viewport.dispatchEvent(new Event("scroll"));
    };

    /**
     * The shell cancelling Safari's pan. Deferred so a controller that calls
     * this from inside a rAF/scroll handler is not re-entered synchronously.
     */
    const cancelPan = () => {
      if (state.keyboardHeight <= 0 || state.requestedPan === 0) return;
      state.requestedPan = 0;
      state.panCancels += 1;
      setTimeout(notify, 0);
    };

    const scrollsToTop = (args: unknown[]): boolean => {
      const first = args[0];
      if (typeof first === "object" && first != null) {
        const top = (first as { top?: number }).top;
        return top == null || top === 0;
      }
      return (args[1] ?? 0) === 0;
    };

    const nativeScrollTo = window.scrollTo.bind(window);
    const patchedScrollTo = function (...args: unknown[]): void {
      if (scrollsToTop(args)) cancelPan();
      (nativeScrollTo as (...inner: unknown[]) => void)(...args);
    };
    window.scrollTo = patchedScrollTo as typeof window.scrollTo;
    window.scroll = patchedScrollTo as typeof window.scroll;

    const scrollTopDescriptor = Object.getOwnPropertyDescriptor(
      Element.prototype,
      "scrollTop",
    );
    const scrollTopGet = scrollTopDescriptor?.get;
    const scrollTopSet = scrollTopDescriptor?.set;
    if (scrollTopGet != null && scrollTopSet != null) {
      Object.defineProperty(Element.prototype, "scrollTop", {
        configurable: true,
        get(this: Element): unknown {
          return scrollTopGet.call(this);
        },
        set(this: Element, value: unknown) {
          const isDocumentScroller =
            this === document.documentElement || this === document.body;
          if (isDocumentScroller && value === 0) cancelPan();
          scrollTopSet.call(this, value);
        },
      });
    }

    modelWindow.__ssIosKeyboard = {
      open: (keyboardHeight: number, requestedPan: number) => {
        state.keyboardHeight = keyboardHeight;
        state.requestedPan = requestedPan;
        notify();
      },
      close: () => {
        state.keyboardHeight = 0;
        state.requestedPan = 0;
        notify();
      },
      read: () => ({
        layoutHeight: layoutHeight(),
        visualHeight: modelledVisualHeight(),
        visualOffsetTop: effectivePan(),
        keyboardHeight: state.keyboardHeight,
        requestedPan: state.requestedPan,
        panCancels: state.panCancels,
        shellHeight: shellHeight(),
      }),
    };
  });
}

async function readModel(page: Page): Promise<KeyboardModelState> {
  const state = await page.evaluate(() => {
    const model = (window as unknown as ModelWindow).__ssIosKeyboard;
    return model == null ? null : model.read();
  });
  expect(
    state,
    "the iOS keyboard model failed to install — visualViewport was missing or not shadowable, so this spec would prove nothing",
  ).not.toBeNull();
  return state as KeyboardModelState;
}

async function openModelledKeyboard(
  page: Page,
  keyboardHeight: number,
  requestedPan: number,
) {
  await page.evaluate(
    ([height, pan]: [number, number]) => {
      const model = (window as unknown as ModelWindow).__ssIosKeyboard;
      if (model == null) throw new Error("iOS keyboard model not installed");
      model.open(height, pan);
    },
    [keyboardHeight, requestedPan] as [number, number],
  );
}

async function closeModelledKeyboard(page: Page) {
  await page.evaluate(() => {
    const model = (window as unknown as ModelWindow).__ssIosKeyboard;
    if (model == null) throw new Error("iOS keyboard model not installed");
    model.close();
  });
}

async function readFieldGeometry(
  page: Page,
  testId: string,
): Promise<FieldGeometry> {
  return page.evaluate((id: string) => {
    const model = (window as unknown as ModelWindow).__ssIosKeyboard;
    if (model == null) throw new Error("iOS keyboard model not installed");
    const element = document.querySelector(`[data-testid="${id}"]`);
    if (element == null) throw new Error(`no element for testId ${id}`);
    const rect = element.getBoundingClientRect();
    const state = model.read();
    return {
      ...state,
      layoutTop: rect.top,
      layoutBottom: rect.bottom,
      visualTop: rect.top - state.visualOffsetTop,
      visualBottom: rect.bottom - state.visualOffsetTop,
    };
  }, testId);
}

/** PHI-safe: geometry only, no field values, no URLs, no identifiers. */
function describeGeometry(geometry: FieldGeometry): string {
  return [
    `layout=${geometry.layoutHeight.toFixed(0)}`,
    `visual=${geometry.visualHeight.toFixed(0)}`,
    `offsetTop=${geometry.visualOffsetTop.toFixed(0)}`,
    `shell=${geometry.shellHeight.toFixed(0)}`,
    `panCancels=${geometry.panCancels}`,
    `field=[${geometry.visualTop.toFixed(0)}..${geometry.visualBottom.toFixed(0)}]`,
  ].join(" ");
}

async function gotoRegisterScreen(page: Page) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await page.goto("/register", {
        waitUntil: "domcontentloaded",
        timeout: 45_000,
      });
      expect(response?.ok()).toBeTruthy();
      await expect(page.getByTestId("register-screen")).toBeVisible({
        timeout: 30_000,
      });
      await expect(page.getByTestId(FIRST_REGISTRATION_FIELD)).toBeVisible({
        timeout: 30_000,
      });
      return;
    } catch (error) {
      lastError = error;
      if (attempt === 3) break;
      await page.waitForTimeout(2_000);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("/register did not hydrate register-screen");
}

test.describe("patient web iOS keyboard clipping @keyboard-ios", () => {
  test.beforeEach(async ({ page }) => {
    await installIosKeyboardModel(page);
  });

  test("sizes the app shell to the visual viewport when the keyboard opens", async ({
    page,
  }) => {
    await gotoRegisterScreen(page);

    const resting = await readModel(page);
    // Guard the probe itself: if #root stops being the app shell, or the model
    // fails to shadow the viewport, fail here rather than pass vacuously.
    expect(
      resting.layoutHeight,
      "layout viewport should be the emulated iPhone viewport",
    ).toBeGreaterThan(400);
    expect(
      Math.abs(resting.shellHeight - resting.layoutHeight),
      `#root should fill the layout viewport at rest (${resting.shellHeight} vs ${resting.layoutHeight})`,
    ).toBeLessThanOrEqual(PIXEL_SLACK);
    expect(resting.visualOffsetTop, "no pan before the keyboard opens").toBe(0);

    const keyboardHeight = Math.round(
      resting.layoutHeight * IOS_KEYBOARD_FRACTION,
    );
    await openModelledKeyboard(page, keyboardHeight, keyboardHeight);

    await expect(async () => {
      const open = await readModel(page);
      // iOS keeps the LAYOUT viewport tall — that is the whole problem.
      expect(
        Math.abs(open.layoutHeight - resting.layoutHeight),
        "the layout viewport must stay tall, as it does on iOS Safari",
      ).toBeLessThanOrEqual(PIXEL_SLACK);
      expect(
        Math.abs(open.shellHeight - open.visualHeight),
        `the app shell must track visualViewport.height (shell=${open.shellHeight} visual=${open.visualHeight} layout=${open.layoutHeight})`,
      ).toBeLessThanOrEqual(PIXEL_SLACK);
    }).toPass({ timeout: 10_000 });

    await closeModelledKeyboard(page);

    await expect(async () => {
      const closed = await readModel(page);
      expect(
        Math.abs(closed.shellHeight - closed.layoutHeight),
        `the app shell must be restored when the keyboard closes (shell=${closed.shellHeight} layout=${closed.layoutHeight})`,
      ).toBeLessThanOrEqual(PIXEL_SLACK);
    }).toPass({ timeout: 10_000 });
  });

  test("keeps the first registration field fully inside the visual viewport while the keyboard is open", async ({
    page,
  }) => {
    await gotoRegisterScreen(page);

    const resting = await readModel(page);
    const keyboardHeight = Math.round(
      resting.layoutHeight * IOS_KEYBOARD_FRACTION,
    );

    // Real order of events on device: the tap focuses the field (which starts
    // AuthScaffold's 350ms header collapse), then Safari opens the keyboard and
    // pans the visual viewport.
    const field = page.getByTestId(FIRST_REGISTRATION_FIELD);
    await field.click();
    await expect(field).toBeFocused();
    await openModelledKeyboard(page, keyboardHeight, keyboardHeight);

    await expect(async () => {
      const geometry = await readFieldGeometry(page, FIRST_REGISTRATION_FIELD);
      const summary = describeGeometry(geometry);
      // Root cause #2: the repo measures Safari's pan but never resets it.
      expect(
        geometry.visualOffsetTop,
        `nothing cancelled Safari's visual-viewport pan — ${summary}`,
      ).toBe(0);
      // The headline assertion: the field is not clipped off the TOP.
      expect(
        geometry.visualTop,
        `the focused field is clipped above the visual viewport — ${summary}`,
      ).toBeGreaterThanOrEqual(-PIXEL_SLACK);
      // ...and not occluded by the keyboard at the bottom either.
      expect(
        geometry.visualBottom,
        `the focused field is behind the keyboard — ${summary}`,
      ).toBeLessThanOrEqual(geometry.visualHeight + PIXEL_SLACK);
    }).toPass({ timeout: 10_000 });
  });

  test("re-tracks the viewport when the keyboard geometry changes again", async ({
    page,
  }) => {
    await gotoRegisterScreen(page);

    const resting = await readModel(page);
    const keyboardHeight = Math.round(
      resting.layoutHeight * IOS_KEYBOARD_FRACTION,
    );

    const field = page.getByTestId(FIRST_REGISTRATION_FIELD);
    await field.click();
    await expect(field).toBeFocused();
    await openModelledKeyboard(page, keyboardHeight, keyboardHeight);

    await expect(async () => {
      const geometry = await readFieldGeometry(page, FIRST_REGISTRATION_FIELD);
      expect(
        geometry.visualTop,
        `first keyboard geometry already clipped the field — ${describeGeometry(geometry)}`,
      ).toBeGreaterThanOrEqual(-PIXEL_SLACK);
    }).toPass({ timeout: 10_000 });

    // Safari changes the visual viewport again while the field stays focused —
    // the autofill/accessory bar appearing, or a suggestion strip. A one-shot
    // focus assist (the old 300ms setTimeout) never re-runs for this.
    const grownKeyboard = keyboardHeight + 44;
    await openModelledKeyboard(page, grownKeyboard, grownKeyboard);

    await expect(async () => {
      const geometry = await readFieldGeometry(page, FIRST_REGISTRATION_FIELD);
      const summary = describeGeometry(geometry);
      expect(
        Math.abs(geometry.shellHeight - geometry.visualHeight),
        `the app shell must re-track a second visual-viewport change — ${summary}`,
      ).toBeLessThanOrEqual(PIXEL_SLACK);
      expect(
        geometry.visualOffsetTop,
        `the second pan was never cancelled — ${summary}`,
      ).toBe(0);
      expect(
        geometry.visualTop,
        `the focused field is clipped after the second viewport change — ${summary}`,
      ).toBeGreaterThanOrEqual(-PIXEL_SLACK);
      expect(
        geometry.visualBottom,
        `the focused field is behind the grown keyboard — ${summary}`,
      ).toBeLessThanOrEqual(geometry.visualHeight + PIXEL_SLACK);
    }).toPass({ timeout: 10_000 });
  });
});
