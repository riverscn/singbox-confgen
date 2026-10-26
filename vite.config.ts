import path from "node:path";
import { createServer, defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The page makes no network requests and loads nothing from other origins. In production builds
// the browser enforces that: only same-origin scripts, styles and fonts load, and `fetch`/XHR/
// WebSocket are blocked outright. Inline styles are allowed: UI libraries (Base UI, CodeMirror) set
// them, and with no way to send data out (connect/img/font limited to self) and no HTML injection
// point, CSS injection has nothing to exfiltrate through. Not applied to the dev server, whose hot
// reload needs a WebSocket.
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data:",
  "connect-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

const contentSecurityPolicy = (): Plugin => ({
  name: "content-security-policy",
  apply: "build",
  transformIndexHtml: () => [{ tag: "meta", attrs: { "http-equiv": "Content-Security-Policy", content: CSP }, injectTo: "head-prepend" }],
});

// Search engines that don't run JavaScript (Baidu, Sogou, 360) would see an empty #root: render the
// app's first screen into index.html at build time. The app renders over it on load.
const prerender = (): Plugin => ({
  name: "prerender",
  apply: "build",
  async transformIndexHtml(html) {
    const server = await createServer({
      configFile: false,
      root: __dirname,
      appType: "custom",
      logLevel: "error",
      server: { middlewareMode: true, hmr: false },
      resolve: { alias },
    });
    try {
      const { render } = await server.ssrLoadModule("/src/prerender.tsx");
      const root = '<div id="root"></div>';
      if (!html.includes(root)) throw new Error(`prerender: ${root} not found in index.html`);
      return html.replace(root, `<div id="root">${render()}</div>`);
    } finally {
      await server.close();
    }
  },
});

const alias = { "@": path.resolve(__dirname, "./src") };

// Relative base so the built `dist/` works from any path or straight from disk-backed static hosting.
export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss(), contentSecurityPolicy(), prerender()],
  resolve: { alias },
});
