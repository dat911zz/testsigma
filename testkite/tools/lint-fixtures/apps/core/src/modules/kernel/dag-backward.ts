/** DELIBERATE VIOLATION: kernel is the DAG's root, it may not import any module. */
import { MODULE } from "../identity/index.js";

export const backward = MODULE;
