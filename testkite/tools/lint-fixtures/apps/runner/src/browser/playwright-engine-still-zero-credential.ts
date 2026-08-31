/**
 * DELIBERATE VIOLATION, in the SAME directory shape as the exempt adapter: the playwright
 * override lifts the browser-driver ban and nothing else. A file that is allowed a browser is
 * still not allowed the core app or a DB driver.
 *
 * (The exemption is keyed to the exact adapter path, so this neighbouring file is also proof
 * that it was not written as a directory-wide hole.)
 */
import { chromium } from "playwright-core";
import { Pool } from "pg";

export const smuggled = { chromium, Pool };
