import { LlmError } from "./errors.js";
import { sseData } from "./sse.js";
import type { ChatMessage, CompleteOptions, LlmClient, LlmReply } from "./types.js";

/*
 * "Sign in with ChatGPT": the OAuth flow and model endpoint the Codex CLI uses, so a ChatGPT
 * plan (Plus, Pro, Business…) pays for answers instead of an API key.
 */

const ISSUER = "https://auth.openai.com";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
/**
 * The plan's model catalog, as the Codex CLI reads it. The backend may hide models newer than
 * `client_version`; this is the Codex CLI release current when it was written (models it doesn't
 * list can still be typed).
 */
const MODELS_URL = "https://chatgpt.com/backend-api/codex/models?client_version=0.169.0";
/** Where the user enters a device code. */
export const CHATGPT_DEVICE_PAGE = `${ISSUER}/codex/device`;
/** Shown as the request destination (context inspector). */
export const CHATGPT_ENDPOINT = new URL(RESPONSES_URL).host;
const REFRESH_MARGIN_MS = 60_000;
const DEVICE_CODE_TIMEOUT_MS = 15 * 60_000;

/**
 * The subset of `fetch` the ChatGPT code needs. Always passed in: chatgpt.com sends no CORS
 * headers, so in Obsidian requests have to go around the window's `fetch`.
 */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<Response>;

export interface ChatGptTokens {
  access: string;
  refresh: string;
  /** Access token expiry, ms since epoch. */
  expires: number;
  /** ChatGPT account (workspace) the requests are billed to. */
  accountId: string;
  email: string | null;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
}

function jwtClaims(token: string | undefined): Record<string, unknown> {
  const payload = token?.split(".")[1];
  if (!payload) return {};
  try {
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Tokens from a token endpoint response; `previous` fills what a refresh doesn't return. */
function tokensFrom(res: TokenResponse, previous?: ChatGptTokens): ChatGptTokens {
  const refresh = res.refresh_token ?? previous?.refresh;
  if (!res.access_token || !refresh) throw new LlmError("ChatGPT sign-in returned no tokens");
  const access = jwtClaims(res.access_token);
  const id = jwtClaims(res.id_token);
  const auth = (access["https://api.openai.com/auth"] ?? id["https://api.openai.com/auth"]) as
    | { chatgpt_account_id?: string }
    | undefined;
  const accountId = auth?.chatgpt_account_id ?? previous?.accountId;
  if (!accountId) throw new LlmError("This sign-in has no ChatGPT account; sign in with a ChatGPT account");
  const profile = access["https://api.openai.com/profile"] as { email?: string } | undefined;
  const email = (typeof id.email === "string" ? id.email : profile?.email) ?? previous?.email ?? null;
  const exp = typeof access.exp === "number" ? access.exp * 1000 : Date.now() + 60 * 60_000;
  return { access: res.access_token, refresh, expires: exp, accountId, email };
}

/** Parses tokens kept by the host app; null when absent or not ours. */
export function parseTokens(stored: string | null): ChatGptTokens | null {
  if (!stored) return null;
  try {
    const t = JSON.parse(stored) as Partial<ChatGptTokens>;
    return typeof t.access === "string" && typeof t.refresh === "string" && typeof t.accountId === "string"
      ? { access: t.access, refresh: t.refresh, accountId: t.accountId, expires: Number(t.expires) || 0, email: t.email ?? null }
      : null;
  } catch {
    return null;
  }
}

async function errorText(res: Response): Promise<string> {
  const text = await res.text();
  try {
    const body = JSON.parse(text) as { error?: { message?: string } | string; error_description?: string; detail?: string };
    const message =
      (typeof body.error === "object" ? body.error.message : undefined) ??
      body.error_description ??
      body.detail ??
      (typeof body.error === "string" ? body.error : undefined);
    if (message) return message;
  } catch {
    // not JSON
  }
  return text.slice(0, 300);
}

async function postToken(fetchFn: FetchLike, body: string, contentType: string, previous?: ChatGptTokens) {
  const res = await fetchFn(`${ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "content-type": contentType },
    body,
  });
  if (!res.ok) throw new LlmError(`ChatGPT sign-in failed (${res.status}): ${await errorText(res)}`);
  return tokensFrom((await res.json()) as TokenResponse, previous);
}

/* ---------- browser sign-in (authorization code + PKCE, loopback redirect) ---------- */

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export interface BrowserSignIn {
  /** Open this in the user's browser. */
  url: string;
  state: string;
  /** Trade the `code` from the redirect for tokens. */
  finish(code: string): Promise<ChatGptTokens>;
}

/** `redirectUri` is a loopback URL (`http://127.0.0.1:<port>/auth/callback`) the caller listens on. */
export async function startBrowserSignIn(redirectUri: string, fetchFn: FetchLike): Promise<BrowserSignIn> {
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const state = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const url = new URL(`${ISSUER}/oauth/authorize`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    scope: "openid profile email offline_access",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
  }).toString();
  return {
    url: url.toString(),
    state,
    finish: (code) => exchangeCode(code, redirectUri, verifier, fetchFn),
  };
}

function exchangeCode(code: string, redirectUri: string, verifier: string, fetchFn: FetchLike): Promise<ChatGptTokens> {
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: CLIENT_ID,
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });
  return postToken(fetchFn, form.toString(), "application/x-www-form-urlencoded");
}

/* ---------- device code sign-in (no local server; works on mobile) ---------- */

export interface DeviceCode {
  userCode: string;
  deviceAuthId: string;
  intervalMs: number;
}

export async function requestDeviceCode(fetchFn: FetchLike): Promise<DeviceCode> {
  const res = await fetchFn(`${ISSUER}/api/accounts/deviceauth/usercode`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: CLIENT_ID }),
  });
  if (!res.ok) throw new LlmError(`Couldn't get a ChatGPT sign-in code (${res.status}): ${await errorText(res)}`);
  const body = (await res.json()) as { device_auth_id: string; user_code?: string; usercode?: string; interval?: string };
  return {
    userCode: body.user_code ?? body.usercode ?? "",
    deviceAuthId: body.device_auth_id,
    intervalMs: Math.max(1, Number(body.interval) || 5) * 1000,
  };
}

/** Waits until the user entered the code on {@link CHATGPT_DEVICE_PAGE}; rejects when `signal` aborts. */
export async function waitForDeviceCode(
  code: DeviceCode,
  signal: AbortSignal,
  fetchFn: FetchLike,
): Promise<ChatGptTokens> {
  const deadline = Date.now() + DEVICE_CODE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    // Sleep one interval; aborting the sign-in ends the wait at once.
    const tick = AbortSignal.timeout(code.intervalMs);
    await new Promise<void>((resolve, reject) => {
      const done = () => (signal.removeEventListener("abort", cancel), resolve());
      const cancel = () => (tick.removeEventListener("abort", done), reject(new LlmError("Sign-in cancelled")));
      if (signal.aborted) return cancel();
      tick.addEventListener("abort", done, { once: true });
      signal.addEventListener("abort", cancel, { once: true });
    });
    const res = await fetchFn(`${ISSUER}/api/accounts/deviceauth/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_auth_id: code.deviceAuthId, user_code: code.userCode }),
    });
    // 403/404: the user hasn't entered the code yet.
    if (res.status === 403 || res.status === 404) continue;
    if (!res.ok) throw new LlmError(`ChatGPT sign-in failed (${res.status}): ${await errorText(res)}`);
    const body = (await res.json()) as { authorization_code: string; code_verifier: string };
    return exchangeCode(body.authorization_code, `${ISSUER}/deviceauth/callback`, body.code_verifier, fetchFn);
  }
  throw new LlmError("The sign-in code expired; start again");
}

/* ---------- session and model client ---------- */

/** Keeps the access token fresh; `onRefresh` persists rotated tokens (refresh tokens are single-use). */
export class ChatGptSession {
  private pending: Promise<ChatGptTokens> | null = null;

  constructor(
    private tokens: ChatGptTokens,
    private readonly onRefresh: (tokens: ChatGptTokens) => void,
    private readonly fetchFn: FetchLike,
  ) {}

  current(): Promise<ChatGptTokens> {
    if (this.tokens.expires - Date.now() > REFRESH_MARGIN_MS) return Promise.resolve(this.tokens);
    // One refresh at a time: a second use of the old refresh token would be rejected.
    this.pending ??= postToken(
      this.fetchFn,
      JSON.stringify({ client_id: CLIENT_ID, grant_type: "refresh_token", refresh_token: this.tokens.refresh }),
      "application/json",
      this.tokens,
    )
      .then((tokens) => {
        this.tokens = tokens;
        this.onRefresh(tokens);
        return tokens;
      })
      .catch((err: unknown) => {
        throw new LlmError(`ChatGPT sign-in expired; sign in again in settings (${(err as Error).message})`);
      })
      .finally(() => {
        this.pending = null;
      });
    return this.pending;
  }
}

export interface ChatGptConfig {
  model: string;
  session: ChatGptSession;
  fetch: FetchLike;
}

/** Answers through the ChatGPT plan's Codex endpoint (OpenAI Responses API, streamed). */
export class ChatGptClient implements LlmClient {
  constructor(private readonly config: ChatGptConfig) {}

  async complete(messages: ChatMessage[], { onDelta, fast = false }: CompleteOptions = {}): Promise<LlmReply> {
    const { access, accountId } = await this.config.session.current();
    const instructions = messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");
    const input = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        type: "message",
        role: m.role,
        content: [{ type: m.role === "assistant" ? "output_text" : "input_text", text: m.content }],
      }));
    const res = await this.config.fetch(RESPONSES_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        authorization: `Bearer ${access}`,
        "chatgpt-account-id": accountId,
      },
      body: JSON.stringify({
        model: this.config.model,
        instructions,
        input,
        store: false,
        stream: true,
        ...(fast ? { reasoning: { effort: "low" } } : {}),
      }),
    });
    if (!res.ok || !res.body) {
      const hint = res.status === 401 ? " — sign in to ChatGPT again in settings" : "";
      throw new LlmError(`ChatGPT request failed (${res.status}): ${await errorText(res)}${hint}`);
    }
    let content = "";
    for await (const data of sseData(res.body)) {
      const event = JSON.parse(data) as {
        type?: string;
        delta?: string;
        message?: string;
        response?: { error?: { message?: string }; incomplete_details?: { reason?: string } };
      };
      if (event.type === "response.output_text.delta" && event.delta) {
        content += event.delta;
        onDelta?.(event.delta);
      } else if (event.type === "response.failed" || event.type === "error") {
        throw new LlmError(`ChatGPT stream failed: ${event.response?.error?.message ?? event.message ?? data.slice(0, 300)}`);
      } else if (event.type === "response.incomplete" && !content.trim()) {
        throw new LlmError(`ChatGPT stopped early: ${event.response?.incomplete_details?.reason ?? "unknown reason"}`);
      } else if (event.type === "response.completed") {
        break;
      }
    }
    if (!content.trim()) throw new LlmError("ChatGPT returned an empty response");
    return { content: content.trim(), sources: [] };
  }
}

/** Model slugs the signed-in plan offers in Codex (hidden ones left out), sorted, for the settings picker. */
export async function listChatGptModels(session: ChatGptSession, fetchFn: FetchLike): Promise<string[]> {
  const { access, accountId } = await session.current();
  const res = await fetchFn(MODELS_URL, {
    method: "GET",
    headers: { accept: "application/json", authorization: `Bearer ${access}`, "chatgpt-account-id": accountId },
  });
  if (!res.ok) {
    const hint = res.status === 401 ? " — sign in to ChatGPT again" : "";
    throw new LlmError(`Listing ChatGPT models failed (${res.status}): ${await errorText(res)}${hint}`);
  }
  const body = (await res.json()) as { models?: { slug?: unknown; visibility?: unknown }[] };
  if (!Array.isArray(body.models)) throw new LlmError("ChatGPT's model list has an unexpected format");
  const slugs = body.models
    .filter((m) => m.visibility === undefined || m.visibility === "list")
    .map((m) => m.slug)
    .filter((slug): slug is string => typeof slug === "string" && slug !== "");
  return [...new Set(slugs)].sort((a, b) => a.localeCompare(b));
}
