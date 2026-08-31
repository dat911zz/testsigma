/**
 * VALID, and the ONLY file for which it is valid: this is the driver adapter itself. The
 * override that exempts this path is what turns "the single file that touches Playwright" from
 * a comment into a rule — and the zero-credential ban still applies here, which the sibling
 * fixture `browser/playwright-engine-still-zero-credential.ts` proves.
 */
import { chromium } from "playwright-core";

export const launch = async (): Promise<unknown> => chromium.launch();
