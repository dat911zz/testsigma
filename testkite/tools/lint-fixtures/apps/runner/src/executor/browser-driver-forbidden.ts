/**
 * DELIBERATE VIOLATION: exactly ONE file in the runner may touch a browser driver —
 * `src/browser/playwright-engine.ts`. Everything else drives the browser through the
 * `BrowserEngine` port, so that swapping the driver (or faking it) stays a one-file change and
 * no second place learns what chromium's API looks like (docs/SYSTEM_DESIGN.md §5).
 *
 * All three specifier shapes are here on purpose: the scoped package is the one a name-anchored
 * pattern misses.
 */
import { chromium } from "playwright-core";
import test from "@playwright/test";
import puppeteer from "puppeteer";

export const smuggled = { chromium, test, puppeteer };
