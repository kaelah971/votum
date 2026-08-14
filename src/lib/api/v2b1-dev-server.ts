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
import { createClient } from "@supabase/supabase-js";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import "./load-local-env";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const key = process.env.SUPABASE_SECRET_KEY ?? "";

export const admin = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  db: { schema: "public" },
});

export const NEXT_PORT = 3101;
export const NEXT_BASE = `http://127.0.0.1:${NEXT_PORT}`;

let nextProcess: ChildProcess | null = null;

/** Generate a valid Nimiq address as canonical hex (0x01 + 19 random bytes). */
export function randomNimiqHex(): string {
  return "01" + randomBytes(19).toString("hex");
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function startNextDev(): Promise<void> {
  return new Promise((resolve, reject) => {
    nextProcess = spawn(
      "npx", ["next", "dev", "--port", String(NEXT_PORT)],
      {
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
        shell: true,
        windowsHide: true,
      },
    );

    let started = false;
    let polling = false;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let failTimer: ReturnType<typeof setTimeout> | null = null;
    let output = "";

    const cleanup = () => {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      if (failTimer) { clearTimeout(failTimer); failTimer = null; }
      polling = false;
    };

    const onData = (d: Buffer) => {
      const t = d.toString();
      output += t;
      if ((t.includes("Local:") || t.includes("Ready in")) && !started && !polling) {
        started = true;
        polling = true;

        pollTimer = setInterval(async () => {
          try {
            const res = await fetch(`${NEXT_BASE}/`, { signal: AbortSignal.timeout(5000) });
            if (res.status < 500) {
              cleanup();
              resolve();
            }
          } catch {
            // not ready yet
          }
        }, 1000);

        failTimer = setTimeout(() => {
          cleanup();
          reject(new Error(
            `Next.js dev server did not become ready within 60 s. Last output: ${output.slice(-400)}`,
          ));
        }, 60000);
      }
    };

    nextProcess.stdout?.on("data", onData);
    nextProcess.stderr?.on("data", onData);

    nextProcess.on("error", (e: Error) => { cleanup(); reject(e); });
    nextProcess.on("exit", (code) => {
      if (!started) {
        cleanup();
        reject(new Error(`next dev exited with code ${code}`));
      }
    });

    failTimer = setTimeout(() => {
      if (!started) {
        cleanup();
        reject(new Error("next dev did not produce 'Local:' output within 60 s"));
      }
    }, 60000);
  });
}

export function stopNextDev(): void {
  if (nextProcess && nextProcess.pid) {
    try {
      execSync(`taskkill /PID ${nextProcess.pid} /T /F 2>nul`, { stdio: "ignore" });
    } catch {
      /* already gone */
    }
    nextProcess = null;
  }
}

/** Insert a verified session row for `addr`; returns the raw cookie token. */
export async function createTestSession(addr: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const hashed = sha256Hex(token);
  await admin.from("wallet_sessions").delete().eq("token_hash", hashed);
  await admin.from("wallet_sessions").insert({
    token_hash: hashed,
    wallet_address: addr,
    expires_at: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(),
    last_seen_at: new Date().toISOString(),
  });
  return token;
}

export async function deleteTestSession(token: string): Promise<void> {
  await admin.from("wallet_sessions").delete().eq("token_hash", sha256Hex(token));
}

export async function apiPost(
  path: string,
  body: unknown,
  cookie?: string,
): Promise<{ status: number; data: any }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cookie) headers["Cookie"] = `votum_session=${cookie}`;
  const res = await fetch(`${NEXT_BASE}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  let data: any = null;
  try { data = await res.json(); } catch { /* ok */ }
  return { status: res.status, data };
}

export async function apiGet(
  path: string,
  cookie?: string,
): Promise<{ status: number; data: any }> {
  const headers: Record<string, string> = {};
  if (cookie) headers["Cookie"] = `votum_session=${cookie}`;
  const res = await fetch(`${NEXT_BASE}${path}`, { headers });
  let data: any = null;
  try { data = await res.json(); } catch { /* ok */ }
  return { status: res.status, data };
}
