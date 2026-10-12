import { describe, expect, it } from "@effect/vitest";
import { MUSE_DEFAULT_MODEL, ProviderInstanceId } from "@t3tools/contracts";
import { MuseSettings } from "../settings.ts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { MuseSdkHost } from "./sdk.ts";

import {
  canReuseMuseContextUsage,
  discoverMuseModels,
  museContextWindowTokens,
  museModelCapabilities,
  resolveMuseReasoningEffort,
} from "./modelCatalog.ts";

const settings = Schema.decodeSync(MuseSettings)({});
const host = (catalog: Record<string, unknown>): MuseSdkHost => ({
  connection: {
    request: async () => catalog,
    command: async () => ({}),
    mintCommandId: () => "test",
    onNotification: () => {},
    onServerRequest: () => {},
    onProtocolError: () => {},
    closed: new Promise<void>(() => {}),
  },
  initializeResult: { grantedCapabilities: [] },
  exited: new Promise(() => {}),
  close: async () => {},
});

const row = (modelId: string, extra: Record<string, unknown> = {}) => ({
  modelId,
  displayLabel: modelId,
  providerId: "meta",
  profileId: "tbh",
  isDefault: false,
  contextLimit: 1_000_000,
  ...extra,
});

describe("Muse model catalog", () => {
  it.effect("uses the labels, efforts and defaults that model/list sends", () =>
    Effect.gen(function* () {
      const models = yield* discoverMuseModels(settings, {}, undefined, async () =>
        host({
          providerId: "meta",
          profileId: "tbh",
          source: "providerCatalog",
          models: [
            row("restful-walrus", {
              displayLabel: " Restful Walrus ",
              isDefault: true,
              variants: ["minimal", "low", "high", "future-tier"],
              reasoningEffortVariants: [{ tier: "low", description: "Quick" }],
              defaultReasoningEffort: "high",
            }),
            row("older-host"),
            row("unknown-efforts", { variants: "unknown" }),
            row("no-window", { contextLimit: null }),
            row("bad-window", { contextLimit: "1_048_576" }),
            row("foreign", { providerId: "another" }),
          ],
        }),
      ).pipe(Effect.scoped);
      expect(models.map(({ slug, name, isDefault }) => [slug, name, isDefault])).toEqual([
        ["restful-walrus", "Restful Walrus", true],
        ["older-host", "older-host", false],
        ["unknown-efforts", "unknown-efforts", false],
        ["no-window", "no-window", false],
        ["bad-window", "bad-window", false],
      ]);
      expect(models.map((model) => model.contextWindowTokens ?? null)).toEqual([
        1_000_000,
        1_000_000,
        1_000_000,
        null,
        null,
      ]);
      expect(models[0]?.capabilities?.optionDescriptors).toEqual([
        {
          id: "reasoningEffort",
          label: "Reasoning",
          type: "select",
          currentValue: "high",
          options: [
            { id: "minimal", label: "Minimal" },
            { id: "low", label: "Low", description: "Quick" },
            { id: "high", label: "High", isDefault: true },
          ],
        },
      ]);
      // Older hosts and "unknown" fall back to Muse's documented tiers.
      expect(models[1]?.capabilities).toEqual(museModelCapabilities());
      expect(models[2]?.capabilities).toEqual(museModelCapabilities());
    }),
  );

  it("normalizes saved and implicit efforts against the selected model before dispatch", () => {
    const fallback = museModelCapabilities();
    expect(resolveMuseReasoningEffort(fallback, undefined)).toBe("high");
    expect(resolveMuseReasoningEffort(fallback, "max")).toBe("max");
    expect(resolveMuseReasoningEffort(fallback, "ultra")).toBe("high");
    const restricted = museModelCapabilities({ variants: ["xhigh"] });
    expect(resolveMuseReasoningEffort(restricted, undefined)).toBe("xhigh");
    expect(resolveMuseReasoningEffort(restricted, "low")).toBe("xhigh");
    expect(
      resolveMuseReasoningEffort(museModelCapabilities({ variants: [] }), "max"),
    ).toBeUndefined();
    expect(resolveMuseReasoningEffort(undefined, "max")).toBe("max");
  });

  it("reads the catalog window for the selected model and for the default sentinel", () => {
    const models = [
      { slug: "muse-wonder-1.0", isDefault: true, isCustom: false, contextWindowTokens: 1_048_576 },
      { slug: "muse-spark-1.3", isDefault: false, isCustom: false },
    ];
    expect(museContextWindowTokens(models, "muse-wonder-1.0")).toBe(1_048_576);
    expect(museContextWindowTokens(models, MUSE_DEFAULT_MODEL)).toBe(1_048_576);
    expect(museContextWindowTokens(models, "muse-spark-1.3")).toBeUndefined();
    expect(museContextWindowTokens(models, "missing")).toBeUndefined();
  });

  it("keeps measured usage when only the reasoning effort changes", () => {
    const instanceId = ProviderInstanceId.make("muse");
    const selection = (effort: string) => ({
      instanceId,
      model: "muse-wonder-1.0",
      options: [{ id: "reasoningEffort" as const, value: effort }],
    });
    expect(canReuseMuseContextUsage(selection("high"), selection("max"))).toBe(true);
    expect(
      canReuseMuseContextUsage(selection("high"), { ...selection("high"), model: "other" }),
    ).toBe(false);
  });
});
