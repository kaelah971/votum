import { execFileSync } from "node:child_process";
import { createConnection } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  NEXT_PORT,
  startNextDev,
  stopNextDev,
} from "@/lib/api/v2b1-dev-server";

function isPortListening(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port: NEXT_PORT });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 1000);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

async function waitForPortFree(): Promise<void> {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (!(await isPortListening())) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Port ${NEXT_PORT} remained occupied after test-server shutdown`);
}

function npxServerProcessCount(): number {
  const output = execFileSync("powershell", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `(Get-CimInstance Win32_Process | Where-Object { $_.Name -notlike 'powershell*' -and $_.CommandLine -like '*npx-cli.js*next dev --port ${NEXT_PORT}*' } | Measure-Object).Count`,
  ], { encoding: "utf8", timeout: 15000 });
  return Number.parseInt(output.trim(), 10) || 0;
}

afterEach(async () => {
  stopNextDev();
  await waitForPortFree();
});

describe("V2B HTTP test server lifecycle", () => {
  it("launches the server without npx shell indirection", async () => {
    await startNextDev();
    expect(npxServerProcessCount()).toBe(0);
  });
});
