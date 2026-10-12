import * as NodeServices from "@effect/platform-node/NodeServices";
import { MspError } from "@muse-code/sdk";
import { expect, it } from "@effect/vitest";
import { MuseSettings } from "../settings.ts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { vi } from "vite-plus/test";

import { writeFakeCli } from "@t3tools/provider-testing/fakeCli";
import type { MuseSdkHost } from "./sdk.ts";
import { COMPACT_SLASH_COMMAND } from "@t3tools/provider-core/server/snapshotProbe";
import { checkMuseProviderStatus } from "./status.ts";

const settings = Schema.decodeSync(MuseSettings);
const makeHost = (catalog: Record<string, unknown>) => {
  const host: MuseSdkHost = {
    initializeResult: { grantedCapabilities: [] },
    connection: {
      request: vi.fn(async () => catalog),
      command: vi.fn(async () => ({})),
      mintCommandId: () => "test-command",
      onNotification: () => {},
      onServerRequest: () => {},
      onProtocolError: () => {},
      closed: new Promise(() => {}),
    },
    exited: new Promise(() => {}),
    close: vi.fn(async () => {}),
  };
  return host;
};
const metaCatalog = {
  providerId: "meta",
  models: [
    {
      modelId: "muse-discovered",
      displayLabel: "Muse Discovered",
      providerId: "meta",
      isDefault: true,
    },
    {
      modelId: "foreign-model",
      displayLabel: "Another provider",
      providerId: "another",
      isDefault: false,
    },
  ],
};

const fakeCli = (source = 'process.stdout.write("muse 1.0.3-R2198.1\\n");') =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "muse-status-test-" });
    return writeFakeCli({ directory, name: "muse", source });
  });

it.layer(NodeServices.layer)("Muse status", (it) => {
  it.effect("does not start a host when disabled", () =>
    Effect.gen(function* () {
      const createHost = vi.fn(async () => makeHost(metaCatalog));
      const snapshot = yield* checkMuseProviderStatus(settings({}), {}, undefined, createHost);
      expect(snapshot.status).toBe("disabled");
      expect(createHost).not.toHaveBeenCalled();
    }),
  );

  it.effect("gives host-local install and login guidance for a missing binary", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkMuseProviderStatus(
        settings({ enabled: true, binaryPath: "/definitely-missing/muse" }),
      );
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toContain("muse login");
      expect(snapshot.message).toContain("this T3 server host");
    }),
  );

  it.effect("does not expose CLI stderr or start an SDK host after a failed version check", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const binaryPath = yield* fakeCli(
          'process.stderr.write("secret-test-value");process.exit(2);',
        );
        const createHost = vi.fn(async () => makeHost(metaCatalog));
        const snapshot = yield* checkMuseProviderStatus(
          settings({ enabled: true, binaryPath }),
          undefined,
          undefined,
          createHost,
        );
        expect(snapshot.installed).toBe(true);
        expect(snapshot.status).toBe("error");
        expect(snapshot.message).not.toContain("secret-test-value");
        expect(createHost).not.toHaveBeenCalled();
      }),
    ),
  );

  it.effect("discovers the Meta catalog without treating it as authentication proof", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const binaryPath = yield* fakeCli();
        const host = makeHost(metaCatalog);
        const snapshot = yield* checkMuseProviderStatus(
          settings({ enabled: true, binaryPath, customModels: ["muse-custom"] }),
          undefined,
          undefined,
          async () => host,
        );
        expect(snapshot.status).toBe("ready");
        expect(snapshot.message).toBeUndefined();
        expect(snapshot.slashCommands).toEqual([COMPACT_SLASH_COMMAND]);
        expect(snapshot.auth).toEqual({ status: "unknown" });
        expect(snapshot.version).toBe("1.0.3-R2198.1");
        expect(snapshot.models.map((model) => model.slug)).toEqual([
          "muse-discovered",
          "muse-custom",
        ]);
        const descriptor = snapshot.models[0]?.capabilities?.optionDescriptors?.[0];
        expect(
          descriptor?.type === "select" && descriptor.options.map((option) => option.id),
        ).toEqual(["low", "medium", "high", "xhigh", "max"]);
        expect(host.connection.request).toHaveBeenCalledWith("model/list", {});
        expect(host.connection.command).not.toHaveBeenCalled();
        expect(host.close).toHaveBeenCalledOnce();
      }),
    ),
  );

  it.effect("closes the host after malformed metadata and reports unavailable", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const binaryPath = yield* fakeCli();
        const host = makeHost({ providerId: "meta", models: [{ modelId: 1 }] });
        const snapshot = yield* checkMuseProviderStatus(
          settings({ enabled: true, binaryPath }),
          undefined,
          undefined,
          async () => host,
        );
        expect(snapshot.status).toBe("error");
        expect(snapshot.auth.status).toBe("unknown");
        expect(snapshot.models).toEqual([]);
        expect(host.close).toHaveBeenCalledOnce();
      }),
    ),
  );

  it.effect("keeps an empty discovered catalog empty instead of advertising a fallback model", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const binaryPath = yield* fakeCli();
        const host = makeHost({ providerId: "meta", models: [] });
        const snapshot = yield* checkMuseProviderStatus(
          settings({ enabled: true, binaryPath }),
          undefined,
          undefined,
          async () => host,
        );
        expect(snapshot.status).toBe("warning");
        expect(snapshot.models).toEqual([]);
        expect(host.close).toHaveBeenCalledOnce();
      }),
    ),
  );

  it.effect("lists an empty limits entry for a signed-in account before the first turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "muse-auth-" });
        const authPath = path.join(directory, "auth.json");
        yield* fs.writeFileString(
          authPath,
          JSON.stringify({ providers: { meta: { mechanism: "oauth" } } }),
        );
        const binaryPath = yield* fakeCli();
        const usage = {
          observedAtMs: 1_791_832_901_947,
          tier: "27681631238169137",
          window: { usedPercent: 8, resetsAtMs: 1_791_850_896_000, windowDurationMins: 300 },
          weekly: { usedPercent: 1, resetsAtMs: 1_792_368_000_000 },
        };
        const requests: string[] = [];
        const host = makeHost(metaCatalog);
        host.connection.request = vi.fn(async (method: string) => {
          requests.push(method);
          if (method === "usage/read") return {};
          return metaCatalog;
        });
        const environment: NodeJS.ProcessEnv = { ...process.env, MUSE_AUTH_PATH: authPath };
        delete environment.META_API_KEY;
        const snapshot = yield* checkMuseProviderStatus(
          settings({ enabled: true, binaryPath }),
          environment,
          undefined,
          async () => host,
        );
        expect(requests).toEqual(["model/list", "usage/read"]);
        expect(snapshot.usageLimits?.windows).toEqual([]);
        expect(snapshot.usageLimits?.unavailable).toBeUndefined();

        host.connection.request = vi.fn(async (method: string) =>
          method === "usage/read" ? { usage } : metaCatalog,
        );
        const observed = yield* checkMuseProviderStatus(
          settings({ enabled: true, binaryPath }),
          environment,
          undefined,
          async () => host,
        );
        expect(observed.usageLimits?.windows.map((window) => window.id)).toEqual([
          "window",
          "weekly",
        ]);
        expect(observed.usageLimits?.windows[0]).toMatchObject({
          kind: "session",
          label: "5-hour",
          usedPercent: 8,
          windowDurationMins: 300,
        });
      }),
    ),
  );

  it.effect("omits limits when Muse has no usage method or the process uses an API key", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "muse-auth-" });
        const authPath = path.join(directory, "auth.json");
        yield* fs.writeFileString(
          authPath,
          JSON.stringify({ providers: { meta: { mechanism: "oauth" } } }),
        );
        const binaryPath = yield* fakeCli();
        const missing = makeHost(metaCatalog);
        missing.connection.request = vi.fn(async (method: string) => {
          if (method === "usage/read") {
            throw new MspError({
              code: -32601,
              message: "Method not found",
              data: { kind: "methodNotFound" },
            });
          }
          return metaCatalog;
        });
        const inherited: NodeJS.ProcessEnv = { ...process.env, MUSE_AUTH_PATH: authPath };
        delete inherited.META_API_KEY;
        const unsigned = yield* checkMuseProviderStatus(
          settings({ enabled: true, binaryPath }),
          inherited,
          undefined,
          async () => missing,
        );
        expect(unsigned.usageLimits).toBeUndefined();
        expect(unsigned.status).toBe("ready");

        const keyed = makeHost(metaCatalog);
        keyed.connection.request = vi.fn(async (method: string) =>
          method === "usage/read" ? {} : metaCatalog,
        );
        const apiKey = yield* checkMuseProviderStatus(
          settings({ enabled: true, binaryPath }),
          { ...inherited, META_API_KEY: "test-key" },
          undefined,
          async () => keyed,
        );
        expect(apiKey.usageLimits).toBeUndefined();
        expect(keyed.close).toHaveBeenCalledOnce();
      }),
    ),
  );
});
