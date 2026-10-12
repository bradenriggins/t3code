import { MspError } from "@muse-code/sdk";
import type { ProviderUsageLimitsUpdate, ServerProviderUsageLimits } from "@t3tools/contracts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { MuseQuotaDetail, MuseUsageReadResult, type MuseSubscriptionUsage } from "./protocol.ts";

const MuseAuthFile = Schema.Struct({
  providers: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        mechanism: Schema.optional(Schema.String),
      }),
    ),
  ),
});
const decodeAuthFile = Schema.decodeUnknownOption(Schema.fromJsonString(MuseAuthFile));
const decodeUsageRead = Schema.decodeUnknownOption(MuseUsageReadResult);
const decodeQuota = Schema.decodeUnknownOption(MuseQuotaDetail);

class MuseUsageReadError extends Schema.TaggedError<MuseUsageReadError>()("MuseUsageReadError", {
  cause: Schema.Defect(),
}) {}

export type MuseUsageProbe =
  | { readonly status: "observed"; readonly usage: MuseSubscriptionUsage }
  | { readonly status: "empty" }
  | { readonly status: "unsupported" }
  | { readonly status: "failed" };

export function isoFromEpochMs(value: number): string | undefined {
  if (!Number.isFinite(value) || value <= 0) return undefined;
  const parsed = DateTime.make(value);
  return Option.isSome(parsed) ? DateTime.formatIso(parsed.value) : undefined;
}

/** `300` minutes is the 5-hour block Muse reports; other whole hours keep the same shape. */
function sessionWindowLabel(windowDurationMins: number): string {
  if (
    Number.isSafeInteger(windowDurationMins) &&
    windowDurationMins >= 60 &&
    windowDurationMins % 60 === 0
  ) {
    return `${windowDurationMins / 60}-hour`;
  }
  return "Session";
}

export function museUsageToUpdate(usage: MuseSubscriptionUsage): ProviderUsageLimitsUpdate {
  const windowReset = isoFromEpochMs(usage.window.resetsAtMs);
  const weeklyReset = isoFromEpochMs(usage.weekly.resetsAtMs);
  return {
    windows: [
      {
        id: "window",
        kind: "session",
        label: sessionWindowLabel(usage.window.windowDurationMins),
        usedPercent: clampPercent(usage.window.usedPercent),
        windowDurationMins: usage.window.windowDurationMins,
        ...(windowReset ? { resetsAt: windowReset } : {}),
      },
      {
        id: "weekly",
        kind: "weekly",
        label: "Weekly",
        usedPercent: clampPercent(usage.weekly.usedPercent),
        ...(weeklyReset ? { resetsAt: weeklyReset } : {}),
      },
    ],
  };
}

export function museUsageToLimits(
  usage: MuseSubscriptionUsage,
  checkedAt: string,
): ServerProviderUsageLimits {
  return makeUsageLimits({
    checkedAt: isoFromEpochMs(usage.observedAtMs) ?? checkedAt,
    windows: museUsageToUpdate(usage).windows,
  });
}

/**
 * A tier-limit stop, or undefined when this failure is not one.
 * An empty object is still a tier limit: the reset instant was unusable.
 */
export function museTierLimitFailure(error: unknown): { readonly resetAt?: string } | undefined {
  if (typeof error !== "object" || error === null || !("quota" in error)) return undefined;
  const quota = decodeQuota(error.quota);
  if (Option.isNone(quota) || quota.value.limitKind !== "tierLimit") return undefined;
  const resetAt = isoFromEpochMs(quota.value.resetsAtMs);
  return resetAt === undefined ? {} : { resetAt };
}

export function isMuseUsageMethodMissing(cause: unknown): boolean {
  return cause instanceof MspError && (cause.kind === "methodNotFound" || cause.code === -32601);
}

/** One `usage/read`. A missing method is the 1.4.4 host; anything else is a failed read. */
export const readMuseSubscriptionUsage = Effect.fn("readMuseSubscriptionUsage")(function* (
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>,
) {
  const attempted = yield* Effect.tryPromise({
    try: () => request("usage/read", {}),
    catch: (cause) => new MuseUsageReadError({ cause }),
  }).pipe(Effect.timeout("5 seconds"), Effect.result);
  if (attempted._tag === "Failure") {
    const cause =
      attempted.failure._tag === "MuseUsageReadError" ? attempted.failure.cause : attempted.failure;
    return isMuseUsageMethodMissing(cause)
      ? ({ status: "unsupported" } as const)
      : ({ status: "failed" } as const);
  }
  const decoded = decodeUsageRead(attempted.success);
  if (Option.isNone(decoded)) return { status: "failed" } as const;
  return decoded.value.usage
    ? ({ status: "observed", usage: decoded.value.usage } as const)
    : ({ status: "empty" } as const);
});

function metaApiKey(environment: NodeJS.ProcessEnv): boolean {
  return Object.entries(environment).some(
    ([key, value]) => key.toUpperCase() === "META_API_KEY" && Boolean(value?.trim()),
  );
}

function museAuthPath(environment: NodeJS.ProcessEnv, path: Path.Path): string | undefined {
  const home = environment.HOME?.trim() || environment.USERPROFILE?.trim() || "";
  const override = environment.MUSE_AUTH_PATH?.trim();
  if (override) return expandHomePath(override, home);
  const configHome = environment.XDG_CONFIG_HOME?.trim();
  if (configHome) return path.join(expandHomePath(configHome, home), "muse", "auth.json");
  if (!home) return undefined;
  return path.join(home, ".config", "muse", "auth.json");
}

/**
 * True when this process would use a saved Muse login rather than an API key.
 * The file records the CLI login (`mechanism: oauth`). It does not say whether
 * the subscription is active; a pay-as-you-go key is not a subscription account.
 * `muse logout` leaves the file with an empty provider map.
 */
export const museSubscriptionLogin = Effect.fn("museSubscriptionLogin")(function* (
  environment: NodeJS.ProcessEnv,
) {
  if (metaApiKey(environment)) return false;
  const path = yield* Path.Path;
  const authPath = museAuthPath(environment, path);
  if (!authPath) return false;
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs.readFileString(authPath).pipe(
    Effect.catchTags({
      PlatformError: (error) =>
        error.reason._tag === "NotFound" ? Effect.succeed("") : Effect.fail(error),
    }),
    Effect.orElseSucceed(() => ""),
  );
  if (!text.trim()) return false;
  const decoded = decodeAuthFile(text);
  if (Option.isNone(decoded)) return false;
  return decoded.value.providers?.meta?.mechanism?.trim().toLowerCase() === "oauth";
});

/**
 * What a status probe should publish. A fresh host answers `usage/read` with
 * `{}` until a prompt, so a signed-in account gets an empty entry and the
 * Limits view can list it. `unsupported` would drop that entry and refuse the
 * later turn update. A host without the method (Muse 1.4.4) publishes nothing.
 */
export function limitsFromMuseProbe(input: {
  readonly checkedAt: string;
  readonly probe: MuseUsageProbe;
  readonly subscriptionLogin: boolean;
}): ServerProviderUsageLimits | undefined {
  if (input.probe.status === "observed") {
    return museUsageToLimits(input.probe.usage, input.checkedAt);
  }
  if (input.probe.status === "unsupported" || !input.subscriptionLogin) return undefined;
  if (input.probe.status === "failed") {
    return makeUnavailableUsageLimits({
      checkedAt: input.checkedAt,
      reason: "probeFailed",
      message: "Muse could not read usage limits.",
    });
  }
  return makeUsageLimits({ checkedAt: input.checkedAt, windows: [] });
}
