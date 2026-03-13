/**
 * post-build.mjs
 *
 * After Vite builds the React widget, this script reads the generated
 * JS and CSS from dist/ and inlines them into a single self-contained
 * widget.html file that the MCP server can serve as a resource.
 */

import { readFileSync, writeFileSync, readdirSync } from "fs";
import { resolve, join } from "path";

const distDir = resolve("dist");

// Find the built JS and CSS files
const files = readdirSync(distDir);
const jsFile = files.find((f) => f.endsWith(".js") && !f.includes("chunk"));
const cssFile = files.find((f) => f.endsWith(".css"));

const js = jsFile ? readFileSync(join(distDir, jsFile), "utf8") : "";
const css = cssFile ? readFileSync(join(distDir, cssFile), "utf8") : "";

const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Athena Widget</title>
  <style>${css}</style>
</head>
<body>
  <div id="root"></div>
  <script type="module">${js}</script>
</body>
</html>`;

writeFileSync(join(distDir, "widget.html"), html, "utf8");
console.log("✅ widget.html created in dist/");
