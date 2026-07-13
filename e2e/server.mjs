import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath, URL } from "node:url";

const fixtureRoot = resolve(
  fileURLToPath(new URL("./fixtures/", import.meta.url)),
);
const host = "127.0.0.1";
const port = 4173;
const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
]);

const server = createServer(async (request, response) => {
  const requestUrl = new URL(
    request.url ?? "/",
    `http://${request.headers.host ?? `${host}:${String(port)}`}`,
  );
  const relativePath =
    requestUrl.pathname === "/"
      ? "static-article.html"
      : decodeURIComponent(requestUrl.pathname.slice(1));
  const filePath = resolve(fixtureRoot, relativePath);

  if (!filePath.startsWith(`${fixtureRoot}${sep}`)) {
    response.writeHead(403).end("Forbidden");
    return;
  }

  try {
    const file = await stat(filePath);
    if (!file.isFile()) {
      response.writeHead(404).end("Not found");
      return;
    }

    response.writeHead(200, {
      "cache-control": "no-store",
      "content-type":
        contentTypes.get(extname(filePath)) ?? "application/octet-stream",
    });
    createReadStream(filePath).pipe(response);
  } catch {
    response.writeHead(404).end("Not found");
  }
});

server.listen(port, host);

globalThis.process.once("SIGTERM", () => {
  server.close();
});
