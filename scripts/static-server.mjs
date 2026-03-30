import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "dist");
const port = Number(process.env.PORT || 3000);

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8"
};

const sendFile = (filePath, response) => {
  const extension = path.extname(filePath).toLowerCase();
  response.writeHead(200, {
    "Content-Type": mimeTypes[extension] || "application/octet-stream",
    "Cache-Control": extension === ".html" ? "no-cache" : "public, max-age=31536000, immutable"
  });
  fs.createReadStream(filePath).pipe(response);
};

const server = http.createServer((request, response) => {
  const requestPath = decodeURIComponent((request.url || "/").split("?")[0]);
  const safePath = path.normalize(requestPath).replace(/^(\.\.[/\\])+/, "");
  let filePath = path.join(rootDir, safePath === "/" ? "index.html" : safePath);

  if (!filePath.startsWith(rootDir)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    sendFile(filePath, response);
    return;
  }

  filePath = path.join(rootDir, "index.html");
  if (fs.existsSync(filePath)) {
    sendFile(filePath, response);
    return;
  }

  response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  response.end("Not Found");
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Local server is running at http://localhost:${port}`);
  console.log("Press Ctrl+C to stop.");
});
