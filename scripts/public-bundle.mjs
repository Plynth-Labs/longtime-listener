// Build an explicit, key-free bundle of the client for a static host. Only the
// three files the page needs are copied, so nothing else in the repo can leak.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [destination, apiBase, basePath = "/"] = process.argv.slice(2);
if (!destination || !apiBase) throw new Error("Usage: node scripts/public-bundle.mjs OUTPUT_DIR HTTPS_API_BASE [BASE_PATH]");
if (!/^\/([a-zA-Z0-9_-]+\/)*$/.test(basePath)) throw new Error("BASE_PATH must look like / or /some/path/");
const api = new URL(apiBase);
if (api.protocol !== "https:" || api.username || api.password || api.search || api.hash || !api.pathname.endsWith("/api/")) {
  throw new Error("API base must be a credential-free HTTPS URL ending in /api/");
}
const publicDir = fileURLToPath(new URL("../public/", import.meta.url));
const output = path.resolve(destination);
await fs.mkdir(output, { recursive: true });
if ((await fs.readdir(output)).length) throw new Error("Output directory must be empty");
for (const name of ["index.html", "styles.css", "app.js"]) {
  let content = await fs.readFile(path.join(publicDir, name), "utf8");
  if (name === "index.html") {
    const marker = '<meta name="newscast-api-base" content="" />';
    if (!content.includes(marker)) throw new Error("Missing API configuration marker");
    const escaped = api.href.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
    content = content.replace(marker, `<meta name="newscast-api-base" content="${escaped}" />`);
    // A static host may serve the page at both /path and /path/. Pin relative
    // assets to the published directory even without the final slash. The
    // source HTML stays relative so local and proxied mounts keep working.
    content = content.replace("<head>", `<head>\n    <base href="${basePath}" />`);
  }
  await fs.writeFile(path.join(output, name), content);
}
console.log(output);
