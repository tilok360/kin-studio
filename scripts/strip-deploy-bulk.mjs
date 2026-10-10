import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

const root = join(process.cwd(), ".vercel/output/static/downloads");
try {
  const names = await readdir(root);
  for (const name of names) {
    if (!name.endsWith(".apk")) continue;
    const file = join(root, name);
    const info = await stat(file);
    await rm(file);
    console.log(`[strip] removed ${name} (${Math.round(info.size / 1e6)}MB) from deploy output`);
  }
} catch (err) {
  if (err && err.code !== "ENOENT") throw err;
}
