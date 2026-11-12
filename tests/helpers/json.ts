import { readFileSync } from "node:fs";

// A plain writeFile truncates before it writes, so a concurrent reader can see an empty or partial file.
export function readWholeJson(path: string): any {
  let text: string;
  try { text = readFileSync(path, "utf8"); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw e; }
  try { return JSON.parse(text); }
  catch (e) { if (e instanceof SyntaxError) return undefined; throw e; }
}
