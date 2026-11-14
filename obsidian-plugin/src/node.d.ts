// The few Node APIs the plugin loads on desktop only (ChatGPT sign-in and requests). Declared here
// instead of pulling all of @types/node into a program that also runs on mobile.

/** Node's require, which Obsidian's desktop app provides to plugins (CommonJS). */
declare function require(id: "node:http"): typeof import("node:http");
declare function require(id: "node:https"): typeof import("node:https");

interface NodeReadable {
  on(event: "data", listener: (chunk: Uint8Array) => void): this;
  on(event: "end", listener: () => void): this;
  on(event: "error", listener: (err: Error) => void): this;
  destroy(): void;
}

declare module "node:http" {
  export interface IncomingMessage extends NodeReadable {
    url?: string;
    statusCode?: number;
  }
  export interface ServerResponse {
    writeHead(status: number, headers?: Record<string, string>): this;
    end(body?: string): void;
  }
  export interface Server {
    listen(port: number, host: string, callback: () => void): this;
    once(event: "error", listener: (err: Error & { code?: string }) => void): this;
    close(): this;
  }
  export function createServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Server;
}

declare module "node:https" {
  import type { IncomingMessage } from "node:http";
  export interface ClientRequest {
    on(event: "error", listener: (err: Error) => void): this;
    end(body?: string): void;
  }
  export function request(
    url: string,
    options: { method: string; headers: Record<string, string> },
    callback: (res: IncomingMessage) => void,
  ): ClientRequest;
}
