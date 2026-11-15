import type { Server } from "node:http";
import { Platform, requestUrl } from "obsidian";
import { type ChatGptTokens, type FetchLike, startBrowserSignIn } from "./core/chatgpt.js";

/**
 * chatgpt.com answers without CORS headers, so Obsidian's `fetch` can't reach it. Desktop uses
 * Node's https (answers still stream); mobile uses `requestUrl`, which returns the whole answer at once.
 */
export const fetchWithoutCors: FetchLike = (url, init) => (Platform.isDesktopApp ? nodeFetch(url, init) : mobileFetch(url, init));

const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);

async function mobileFetch(...[url, init]: Parameters<FetchLike>): Promise<Response> {
  const res = await requestUrl({ url, method: init.method, headers: init.headers, body: init.body, throw: false });
  return new Response(NULL_BODY_STATUS.has(res.status) ? null : res.arrayBuffer, { status: res.status });
}

async function nodeFetch(...[url, init]: Parameters<FetchLike>): Promise<Response> {
  // Node modules exist on desktop only: required here, behind the check, so mobile never loads them.
  // (Obsidian runs the plugin as CommonJS with Node's `require`; a native import() of `node:` fails there.)
  if (!Platform.isDesktopApp) throw new Error("Node requests need the desktop app");
  const https = require("node:https");
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: init.method, headers: init.headers }, (res) => {
      const status = res.statusCode ?? 502;
      if (NULL_BODY_STATUS.has(status)) {
        res.destroy();
        resolve(new Response(null, { status }));
        return;
      }
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          res.on("data", (chunk) => controller.enqueue(new Uint8Array(chunk)));
          res.on("end", () => controller.close());
          res.on("error", (err) => controller.error(err));
        },
        cancel: () => res.destroy(),
      });
      resolve(new Response(body, { status }));
    });
    req.on("error", reject);
    req.end(init.body);
  });
}

/** Ports the Codex CLI uses for its sign-in redirect; the second one when the first is busy. */
const CALLBACK_PORTS = [1455, 1457];

const PAGE = (message: string) =>
  `<!doctype html><meta charset="utf-8"><title>Yorum</title><body style="font-family:system-ui;text-align:center;padding:4em">${message}</body>`;

/**
 * Desktop sign-in: a one-shot server on 127.0.0.1 receives the browser's redirect, so the user
 * only signs in to ChatGPT in their browser. Rejects when `signal` aborts.
 */
export async function signInWithBrowser(openUrl: (url: string) => void, signal: AbortSignal): Promise<ChatGptTokens> {
  if (!Platform.isDesktopApp) throw new Error("Browser sign-in needs the desktop app; use a code instead");
  const http = require("node:http"); // desktop only, see nodeFetch
  let resolveCode!: (code: string) => void;
  let rejectCode!: (err: Error) => void;
  const codeArrived = new Promise<string>((resolve, reject) => ((resolveCode = resolve), (rejectCode = reject)));
  codeArrived.catch(() => undefined); // a cancel before the browser opens isn't an unhandled rejection
  let expectedState = "";
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/auth/callback") {
      res.writeHead(404).end();
      return;
    }
    const error = url.searchParams.get("error");
    const code = url.searchParams.get("code");
    if (url.searchParams.get("state") !== expectedState) {
      res.writeHead(400, { "content-type": "text/html" }).end(PAGE("This sign-in link is stale. Start again in Obsidian."));
      return;
    }
    if (error || !code) {
      const message = url.searchParams.get("error_description") ?? error ?? "no authorization code";
      res.writeHead(400, { "content-type": "text/html" }).end(PAGE("Sign-in failed. You can close this tab."));
      rejectCode(new Error(`ChatGPT sign-in failed: ${message}`));
      return;
    }
    res.writeHead(200, { "content-type": "text/html" }).end(PAGE("Signed in to Yorum. You can close this tab and return to Obsidian."));
    resolveCode(code);
  });

  const port = await listenOnFirstFree(server, CALLBACK_PORTS);
  const onAbort = () => rejectCode(new Error("Sign-in cancelled"));
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    const flow = await startBrowserSignIn(`http://127.0.0.1:${port}/auth/callback`, fetchWithoutCors);
    expectedState = flow.state;
    if (signal.aborted) throw new Error("Sign-in cancelled");
    openUrl(flow.url);
    return await flow.finish(await codeArrived);
  } finally {
    signal.removeEventListener("abort", onAbort);
    server.close();
  }
}

function listenOnFirstFree(server: Server, ports: number[]): Promise<number> {
  const [port, ...rest] = ports;
  if (port === undefined) {
    return Promise.reject(new Error("Ports 1455 and 1457 are busy (another sign-in running?); use a code instead"));
  }
  return new Promise((resolve, reject) => {
    server.once("error", (err) => {
      if (err.code === "EADDRINUSE") void listenOnFirstFree(server, rest).then(resolve, reject);
      else reject(err);
    });
    server.listen(port, "127.0.0.1", () => resolve(port));
  });
}
