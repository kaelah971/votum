import { createConnection } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  NEXT_BASE,
  NEXT_PORT,
  NEXT_READY_TIMEOUT_MS,
  getLastNextDevLaunch,
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

async function waitForChildExit(): Promise<NonNullable<ReturnType<typeof getLastNextDevLaunch>>> {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const launch = getLastNextDevLaunch();
    if (launch?.exited) return launch;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Next.js child did not report exit after cleanup");
}

afterEach(async () => {
  stopNextDev();
  await waitForPortFree();
});

describe("V2B HTTP test server lifecycle", () => {
  it("launches the server without npx shell indirection", async () => {
    const readinessStartedAt = Date.now();
    await startNextDev();
    const launch = getLastNextDevLaunch();
    expect(launch).not.toBeNull();
    if (!launch) throw new Error("Next.js launch metadata was not recorded");

    expect(launch.executable).toBe(process.execPath);
    expect(launch.args[0]).toMatch(/node_modules[\\/]next[\\/]dist[\\/]bin[\\/]next/);
    expect(launch.args.slice(1)).toEqual([
      "dev",
      "--port",
      String(NEXT_PORT),
    ]);
    expect(launch.args.join(" ")).not.toContain("npx");
    expect(launch.shell).toBe(false);
    expect(Date.now() - readinessStartedAt).toBeLessThan(NEXT_READY_TIMEOUT_MS);

    const response = await fetch(`${NEXT_BASE}/`);
    expect(response.status).toBe(200);

    const cleanupStartedAt = Date.now();
    stopNextDev();
    const exited = await waitForChildExit();
    await waitForPortFree();
    expect(exited.exited).toBe(true);
    expect(Date.now() - cleanupStartedAt).toBeLessThan(45000);
  });
});
