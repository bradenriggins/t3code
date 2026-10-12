import type { SendUserTurnOptions } from "@muse-code/sdk";
import {
  MUSE_DEFAULT_MODEL,
  ModelCapabilities,
  ServerProviderModel,
  type ModelSelection,
} from "@t3tools/contracts";
import { MuseSettings } from "../settings.ts";
import {
  createModelCapabilities,
  getProviderOptionDescriptors,
  modelSelectionsEqual,
} from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { createMuseSdkHost, createMuseSdkHostEffect, type MuseSdkHost } from "./sdk.ts";

type MuseReasoningEffort = NonNullable<SendUserTurnOptions<never>["reasoningEffort"]>;

const REASONING_EFFORT_LABELS = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
  ultra: "Ultra",
} satisfies Record<MuseReasoningEffort, string>;

const isMuseReasoningEffort = (tier: string): tier is MuseReasoningEffort =>
  Object.hasOwn(REASONING_EFFORT_LABELS, tier);

/** Used when Muse does not report a model's efforts (custom slugs, older hosts, "unknown"). */
const FALLBACK_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
/** Muse's own CLI default. */
const FALLBACK_DEFAULT_EFFORT = "high";

const ModelCatalogEntry = Schema.Struct({
  modelId: Schema.NonEmptyString,
  displayLabel: Schema.String,
  providerId: Schema.String,
  isDefault: Schema.Boolean,
  variants: Schema.optional(Schema.Union([Schema.Array(Schema.String), Schema.Literal("unknown")])),
  defaultReasoningEffort: Schema.optional(Schema.String),
  reasoningEffortVariants: Schema.optional(
    Schema.Array(
      Schema.Struct({ tier: Schema.String, description: Schema.optional(Schema.String) }),
    ),
  ),
});
const decodeModelList = Schema.decodeUnknownEffect(
  Schema.Struct({ providerId: Schema.String, models: Schema.Array(ModelCatalogEntry) }),
);

/** Builds the reasoning picker from a `model/list` row, or the fallback when called without one. */
export function museModelCapabilities(
  model?: Pick<
    typeof ModelCatalogEntry.Type,
    "variants" | "defaultReasoningEffort" | "reasoningEffortVariants"
  >,
): ModelCapabilities {
  const reported = model?.variants !== undefined && model.variants !== "unknown";
  const efforts = (reported ? model.variants : FALLBACK_EFFORTS).filter(isMuseReasoningEffort);
  const preferredDefault = reported ? model?.defaultReasoningEffort : FALLBACK_DEFAULT_EFFORT;
  const defaultValue = efforts.find((tier) => tier === preferredDefault) ?? efforts[0];
  if (!defaultValue) return createModelCapabilities({ optionDescriptors: [] });
  return createModelCapabilities({
    optionDescriptors: [
      {
        id: "reasoningEffort",
        label: "Reasoning",
        type: "select",
        currentValue: defaultValue,
        options: efforts.map((id) => {
          const description = model?.reasoningEffortVariants?.find(
            (variant) => variant.tier === id,
          )?.description;
          return {
            id,
            label: REASONING_EFFORT_LABELS[id],
            ...(id === defaultValue ? { isDefault: true } : {}),
            ...(description ? { description } : {}),
          };
        }),
      },
    ],
  });
}

/** A positive catalog `contextLimit`. Anything else means the host declared no window. */
function positiveContextLimit(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** `contextLimit` by model id from the raw `model/list` payload. Invalid values are skipped. */
function contextLimitsByModelId(result: unknown): ReadonlyMap<string, number> {
  const limits = new Map<string, number>();
  if (typeof result !== "object" || result === null || !("models" in result)) return limits;
  const models = result.models;
  if (!Array.isArray(models)) return limits;
  for (const row of models) {
    if (typeof row !== "object" || row === null || !("modelId" in row)) continue;
    const modelId = row.modelId;
    if (typeof modelId !== "string" || limits.has(modelId)) continue;
    const limit = "contextLimit" in row ? positiveContextLimit(row.contextLimit) : undefined;
    if (limit !== undefined) limits.set(modelId, limit);
  }
  return limits;
}

/** The catalog window for a picker model. The `default` sentinel selects the catalog default row. */
export function museContextWindowTokens(
  models: ReadonlyArray<
    Pick<ServerProviderModel, "slug" | "isDefault" | "isCustom" | "contextWindowTokens">
  >,
  model: string,
): number | undefined {
  const selected =
    model === MUSE_DEFAULT_MODEL
      ? models.find((entry) => entry.isDefault === true && !entry.isCustom)
      : models.find((entry) => entry.slug === model);
  const tokens = selected?.contextWindowTokens;
  return tokens !== undefined && tokens > 0 ? tokens : undefined;
}

/**
 * Reasoning effort does not change Muse's context window, so a switch that
 * keeps the same model can keep the measured usage.
 */
export function canReuseMuseContextUsage(previous: ModelSelection, next: ModelSelection): boolean {
  const withoutEffort = (selection: ModelSelection) => ({
    ...selection,
    options: (selection.options ?? []).filter((option) => option.id !== "reasoningEffort"),
  });
  return modelSelectionsEqual(withoutEffort(previous), withoutEffort(next));
}

/** Apply the advertised model choices to saved, remembered and implicit efforts at dispatch. */
export function resolveMuseReasoningEffort(
  capabilities: ModelCapabilities | null | undefined,
  effort: string | undefined,
): string | undefined {
  if (!capabilities) return effort;
  const descriptor = getProviderOptionDescriptors({
    caps: capabilities,
    selections: effort ? [{ id: "reasoningEffort", value: effort }] : undefined,
  }).find((descriptor) => descriptor.id === "reasoningEffort");
  if (descriptor?.type !== "select") return undefined;
  return descriptor.options.find((option) => option.id === descriptor.currentValue)?.id;
}

class MuseCatalogError extends Schema.TaggedError<MuseCatalogError>()("MuseCatalogError", {
  detail: Schema.String,
}) {}

export const discoverMuseModels = Effect.fn("discoverMuseModels")(function* (
  settings: MuseSettings,
  environment: NodeJS.ProcessEnv | undefined,
  cwd?: string,
  createHost: typeof createMuseSdkHost = createMuseSdkHost,
) {
  const host = yield* Effect.acquireRelease(
    createMuseSdkHostEffect(
      {
        binaryPath: settings.binaryPath,
        ...(environment ? { environment } : {}),
        ...(cwd ? { cwd } : {}),
        readOnly: true,
        startupTimeoutMs: 8_000,
      },
      createHost,
    ),
    (host: MuseSdkHost) => Effect.promise(() => host.close()),
    { interruptible: true },
  );
  const result = yield* Effect.tryPromise(() => host.connection.request("model/list", {}));
  const catalog = yield* decodeModelList(result);
  if (catalog.providerId !== "meta") {
    return yield* new MuseCatalogError({ detail: "Muse returned a catalog for another provider." });
  }
  const contextLimits = contextLimitsByModelId(result);
  const seen = new Set<string>();
  return catalog.models.flatMap((model): ServerProviderModel[] => {
    if (model.providerId !== "meta" || seen.has(model.modelId)) return [];
    seen.add(model.modelId);
    const contextWindowTokens = contextLimits.get(model.modelId);
    return [
      {
        slug: model.modelId,
        name: model.displayLabel.trim() || model.modelId,
        isCustom: false,
        isDefault: model.isDefault,
        ...(contextWindowTokens === undefined ? {} : { contextWindowTokens }),
        capabilities: museModelCapabilities(model),
      },
    ];
  });
});
