import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  limitsFromMuseProbe,
  museTierLimitFailure,
  museUsageToLimits,
  museUsageToUpdate,
} from "./usageLimits.ts";

const observedAtMs = 1_791_832_901_947;
const windowResetsAtMs = 1_791_850_896_000;
const weeklyResetsAtMs = 1_792_368_000_000;
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

const usage = {
  observedAtMs,
  tier: "27681631238169137",
  window: { usedPercent: 0, resetsAtMs: windowResetsAtMs, windowDurationMins: 300 },
  weekly: { usedPercent: 0, resetsAtMs: weeklyResetsAtMs },
};

describe("museUsageToUpdate", () => {
  it("maps the 5-hour and weekly windows to ISO reset times", () => {
    expect(museUsageToUpdate(usage)).toEqual({
      windows: [
        {
          id: "window",
          kind: "session",
          label: "5-hour",
          usedPercent: 0,
          windowDurationMins: 300,
          resetsAt: iso(windowResetsAtMs),
        },
        {
          id: "weekly",
          kind: "weekly",
          label: "Weekly",
          usedPercent: 0,
          resetsAt: iso(weeklyResetsAtMs),
        },
      ],
    });
    expect(museUsageToLimits(usage, "2026-10-12T00:00:00.000Z").checkedAt).toBe(iso(observedAtMs));
  });

  it("clamps percents and drops a reset instant that is not a time", () => {
    const update = museUsageToUpdate({
      ...usage,
      tier: 12,
      window: { ...usage.window, usedPercent: 140, resetsAtMs: 0 },
      weekly: { usedPercent: -0, resetsAtMs: Number.NaN },
    });
    expect(update.windows[0]).toMatchObject({ usedPercent: 100, label: "5-hour" });
    expect(update.windows[0]).not.toHaveProperty("resetsAt");
    expect(update.windows[1]).toMatchObject({ id: "weekly", usedPercent: 0 });
    expect(update.windows[1]).not.toHaveProperty("resetsAt");
  });
});

describe("museTierLimitFailure", () => {
  it("reads a tier-limit reset and ignores anything else", () => {
    expect(
      museTierLimitFailure({
        message: "limit",
        quota: { limitKind: "tierLimit", resetsAtMs: windowResetsAtMs },
      }),
    ).toEqual({ resetAt: iso(windowResetsAtMs) });
    expect(
      museTierLimitFailure({ quota: { limitKind: "tierLimit", resetsAtMs: "soon" } }),
    ).toBeUndefined();
    expect(
      museTierLimitFailure({
        quota: { limitKind: "spend", resetsAtMs: windowResetsAtMs },
      }),
    ).toBeUndefined();
  });
});

describe("limitsFromMuseProbe", () => {
  const checkedAt = "2026-10-12T00:00:00.000Z";

  it("lists a signed-in account before the first observation", () => {
    expect(
      limitsFromMuseProbe({
        checkedAt,
        probe: { status: "empty" },
        subscriptionLogin: true,
      }),
    ).toEqual({ checkedAt, windows: [] });
  });

  it("publishes nothing for an older host or an API-key process", () => {
    expect(
      limitsFromMuseProbe({
        checkedAt,
        probe: { status: "unsupported" },
        subscriptionLogin: true,
      }),
    ).toBeUndefined();
    expect(
      limitsFromMuseProbe({
        checkedAt,
        probe: { status: "empty" },
        subscriptionLogin: false,
      }),
    ).toBeUndefined();
  });
});
