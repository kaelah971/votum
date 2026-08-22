import { describe, it, expect, afterEach } from "vitest";
import {
  isLocalSupabaseUrl,
  assertLocalSupabaseForTests,
} from "@/lib/rewards/test-env";

const ORIGINAL = process.env.NEXT_PUBLIC_SUPABASE_URL;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  else process.env.NEXT_PUBLIC_SUPABASE_URL = ORIGINAL;
});

describe("local Supabase test guard", () => {
  it("accepts localhost", () => {
    expect(isLocalSupabaseUrl("http://localhost:54321")).toBe(true);
  });

  it("accepts 127.0.0.1", () => {
    expect(isLocalSupabaseUrl("http://127.0.0.1:54321")).toBe(true);
  });

  it("rejects hosted supabase.co", () => {
    expect(isLocalSupabaseUrl("https://jujwxtbffcvnedvqkgry.supabase.co")).toBe(false);
  });

  it("rejects unset / empty", () => {
    expect(isLocalSupabaseUrl(undefined)).toBe(false);
    expect(isLocalSupabaseUrl("")).toBe(false);
  });

  it("assertLocalSupabaseForTests throws for a hosted URL", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://anything.supabase.co";
    expect(() => assertLocalSupabaseForTests()).toThrow(/local Supabase/);
  });

  it("assertLocalSupabaseForTests returns the local URL without throwing", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:54321";
    expect(() => assertLocalSupabaseForTests()).not.toThrow();
    expect(assertLocalSupabaseForTests()).toBe("http://127.0.0.1:54321");
  });
});
