/**
 * V2B.1 shared dev-server + session helpers for HTTP-level contract tests.
 *
 * Follows the V2A.6D pattern: spawns a local Next.js dev server, creates
 * verified wallet sessions by inserting wallet_sessions rows directly
 * (simulating a successful challenge → signature → verify), and sends the
 * votum_session cookie with requests.
 *
 * Usage:
 *   import { startNextDev, stopNextDev, createTestSession, apiPost } from "./v2b1-dev-server";
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { createHash, randomBytes } from "node:crypto";
import { resolve as resolvePath } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import "./load-local-env";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const key = process.env.SUPABASE_SECRET_KEY ?? "";
const TEST_IO_TIMEOUT_MS = 15000;

function requestPath(input: RequestInfo | URL): string {
  try {
    return new URL(input instanceof Request ? input.url : input.toString()).pathname;
  } catch {
    return "<invalid-url>";
  }
}

const fetchWithTimeout: typeof fetch = (input, init) => {
  const timeoutSignal = AbortSignal.timeout(TEST_IO_TIMEOUT_MS);
  const signal = init?.signal
    ? AbortSignal.any([init.signal, timeoutSignal])
    : timeoutSignal;
  const method = init?.method ?? (input instanceof Request ? input.method : "GET");
  const path = requestPath(input);
  console.log(`[dev-server] HTTP ${method} ${path} started`);
  return fetch(input, { ...init, signal }).then(
    (response) => {
      console.log(`[dev-server] HTTP ${method} ${path} response status=${response.status}`);
      return response;
    },
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[dev-server] HTTP ${method} ${path} failed: ${message}`);
      throw error;
    },
  );
};

async function readJsonResponse(
  response: Response,
  method: string,
  path: string,
): Promise<any | null> {
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new Error(`Timed out after ${TEST_IO_TIMEOUT_MS / 1000}s waiting for ${method} ${path} response body`));
    }, TEST_IO_TIMEOUT_MS);
  });

  try {
    return await Promise.race([response.json(), timeout]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[dev-server] response body read failed: ${method} ${path}: ${message}`);
    if (timedOut || (error instanceof Error && error.name === "AbortError")) {
      throw new Error(`Timed out after ${TEST_IO_TIMEOUT_MS / 1000}s waiting for ${method} ${path} response body`);
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export const admin = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  db: { schema: "public" },
  global: { fetch: fetchWithTimeout },
});

export const NEXT_PORT = 3101;
export const NEXT_BASE = `http://127.0.0.1:${NEXT_PORT}`;
export const NEXT_READY_TIMEOUT_MS = 60000;

export interface NextDevLaunchMetadata {
  executable: string;
  args: string[];
  shell: boolean;
  pid: number | null;
  exited: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

let nextProcess: ChildProcess | null = null;
let lastNextDevLaunch: NextDevLaunchMetadata | null = null;

/** Test-only launch evidence; no child process handle or environment is exposed. */
export function getLastNextDevLaunch(): NextDevLaunchMetadata | null {
  return lastNextDevLaunch
    ? { ...lastNextDevLaunch, args: [...lastNextDevLaunch.args] }
    : null;
}

/** Generate a valid Nimiq address as canonical hex (0x01 + 19 random bytes). */
export function randomNimiqHex(): string {
  return "01" + randomBytes(19).toString("hex");
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function startNextDev(): Promise<void> {
  if (nextProcess) {
    return Promise.reject(new Error(`Next.js dev server is already running on port ${NEXT_PORT}`));
  }

  return new Promise((resolve, reject) => {
    const executable = process.execPath;
    const args = [resolvePath(process.cwd(), "node_modules/next/dist/bin/next"), "dev", "--port", String(NEXT_PORT)];
    const shell = false;
    const child = spawn(executable, args, {
      cwd: process.cwd(),
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
      shell,
      windowsHide: true,
    });
    const launch: NextDevLaunchMetadata = {
      executable,
      args: [...args],
      shell,
      pid: child.pid ?? null,
      exited: false,
      exitCode: null,
      signal: null,
    };
    lastNextDevLaunch = launch;
    nextProcess = child;
    console.log(`[dev-server] child spawned pid=${child.pid ?? "unknown"}`);

    let settled = false;
    let pollInFlight = false;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let readinessTimer: ReturnType<typeof setTimeout> | null = null;
    let output = "";

    const cleanup = () => {
      if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
      if (readinessTimer) { clearTimeout(readinessTimer); readinessTimer = null; }
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
    };

    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) {
        stopNextDev();
        reject(error);
      } else {
        resolve();
      }
    };

    const schedulePoll = () => {
      if (settled || pollTimer) return;
      pollTimer = setTimeout(() => {
        pollTimer = null;
        void pollReadiness();
      }, 250);
    };

    const pollReadiness = async () => {
      if (settled || pollInFlight) return;
      pollInFlight = true;
      try {
        const res = await fetchWithTimeout(`${NEXT_BASE}/`);
        console.log(`[dev-server] readiness probe complete status=${res.status}`);
        settle();
      } catch {
        schedulePoll();
      } finally {
        pollInFlight = false;
      }
    };

    const onData = (d: Buffer, target: NodeJS.WriteStream) => {
      const t = d.toString();
      output += t;
      target.write(t);
    };

    const onSignal = (signal: NodeJS.Signals) => {
      settle(new Error(`Next.js dev server test interrupted by ${signal}`));
    };

    child.stdout?.on("data", (d: Buffer) => onData(d, process.stdout));
    child.stderr?.on("data", (d: Buffer) => onData(d, process.stderr));

    child.on("error", (e: Error) => {
      launch.exited = true;
      settle(new Error(`Could not start next dev: ${e.message}`));
    });
    child.on("exit", (code, signal) => {
      console.log(`[dev-server] child exited code=${code} signal=${signal ?? "none"}`);
      launch.exited = true;
      launch.exitCode = code;
      launch.signal = signal;
      if (!settled) {
        settle(new Error(
          `next dev exited before readiness (code ${code}, signal ${signal ?? "none"}). Last output: ${output.slice(-400)}`,
        ));
      } else if (nextProcess === child) {
        nextProcess = null;
      }
    });

    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    console.log("[dev-server] readiness probe started");
    void pollReadiness();
    readinessTimer = setTimeout(() => {
      settle(new Error(
        `Next.js dev server did not become ready within ${NEXT_READY_TIMEOUT_MS / 1000} s. Last output: ${output.slice(-400)}`,
      ));
    }, NEXT_READY_TIMEOUT_MS);
  });
}

export function stopNextDev(): void {
  if (nextProcess && nextProcess.pid) {
    console.log("[dev-server] terminating child");
    const terminateStartedAt = Date.now();
    try {
      execFileSync("taskkill", ["/PID", String(nextProcess.pid), "/T", "/F"], {
        stdio: "ignore",
        timeout: TEST_IO_TIMEOUT_MS,
        windowsHide: true,
      });
      console.log(`[dev-server] terminate command complete elapsed_ms=${Date.now() - terminateStartedAt}`);
    } catch {
      console.log(`[dev-server] terminate command ended elapsed_ms=${Date.now() - terminateStartedAt}`);
    }
    nextProcess = null;
  }
}

/** Insert a verified session row for `addr`; returns the raw cookie token. */
export async function createTestSession(addr: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const hashed = sha256Hex(token);
  console.log("[dev-server] session fixture delete started");
  await admin.from("wallet_sessions").delete().eq("token_hash", hashed);
  console.log("[dev-server] session fixture delete complete");
  console.log("[dev-server] session fixture insert started");
  await admin.from("wallet_sessions").insert({
    token_hash: hashed,
    wallet_address: addr,
    expires_at: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(),
    last_seen_at: new Date().toISOString(),
  });
  console.log("[dev-server] session fixture insert complete");
  return token;
}

export async function deleteTestSession(token: string): Promise<void> {
  console.log("[dev-server] session fixture cleanup started");
  await admin.from("wallet_sessions").delete().eq("token_hash", sha256Hex(token));
  console.log("[dev-server] session fixture cleanup complete");
}

export async function apiPost(
  path: string,
  body: unknown,
  cookie?: string,
): Promise<{ status: number; data: any }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cookie) headers["Cookie"] = `votum_session=${cookie}`;
  console.log(`[dev-server] request started: POST ${path}`);
  try {
    const res = await fetchWithTimeout(`${NEXT_BASE}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    console.log(`[dev-server] response body read started: POST ${path}`);
    const data = await readJsonResponse(res, "POST", path);
    console.log(`[dev-server] response body read complete: POST ${path}`);
    const outcome = data && typeof data === "object"
      ? ` error=${typeof data.error === "string" ? data.error : "none"} stage=${typeof data.stage === "string" ? data.stage : "none"} result=${typeof data.resultKind === "string" ? data.resultKind : "none"}`
      : "";
    console.log(`[dev-server] request complete: POST ${path} status=${res.status}${outcome}`);
    return { status: res.status, data };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[dev-server] request failed: POST ${path}: ${message}`);
    throw error;
  }
}

export async function apiGet(
  path: string,
  cookie?: string,
): Promise<{ status: number; data: any }> {
  const headers: Record<string, string> = {};
  if (cookie) headers["Cookie"] = `votum_session=${cookie}`;
  console.log(`[dev-server] request started: GET ${path}`);
  try {
    const res = await fetchWithTimeout(`${NEXT_BASE}${path}`, { headers });
    console.log(`[dev-server] response body read started: GET ${path}`);
    const data = await readJsonResponse(res, "GET", path);
    console.log(`[dev-server] response body read complete: GET ${path}`);
    const outcome = data && typeof data === "object"
      ? ` error=${typeof data.error === "string" ? data.error : "none"} stage=${typeof data.stage === "string" ? data.stage : "none"} result=${typeof data.resultKind === "string" ? data.resultKind : "none"}`
      : "";
    console.log(`[dev-server] request complete: GET ${path} status=${res.status}${outcome}`);
    return { status: res.status, data };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[dev-server] request failed: GET ${path}: ${message}`);
    throw error;
  }
}
