/** DELIBERATE VIOLATION: ai is an edge module — core never imports an edge module. */
import { MODULE } from "../ai/index.js";

export const edgeInward = MODULE;
