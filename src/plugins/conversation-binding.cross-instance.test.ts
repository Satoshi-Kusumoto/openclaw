import { expectDefined } from "@openclaw/normalization-core";
import { beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { testing as sessionBindingTesting } from "../infra/outbound/session-binding-service.js";
import {
  createPluginStateKeyedStoreV2ForTests,
  resetPluginStateStoreForTests,
} from "../plugin-sdk/plugin-state-test-runtime.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  bindConversationNow,
  detachPluginConversationBinding,
  requestPluginConversationBinding,
} from "./conversation-binding.js";
import { getPluginInstance } from "./plugin-instance-scope.js";
import { PluginInstance } from "./plugin-instance.js";
import {
  isPluginRecordActive,
  markPluginRegistryActive,
  markPluginRegistryRetired,
} from "./registry-lifecycle.js";
import { createPluginRegistry } from "./registry.js";
import type { PluginRuntime } from "./runtime/types.js";
import { createPluginRecord } from "./status.test-helpers.js";

type TelegramStoreOptions = Parameters<PluginRuntime["state"]["openKeyedStoreV2"]>[0];
type StoredTelegramBinding = {
  accountId: string;
  conversationId: string;
  metadata?: Record<string, unknown>;
};
type RegistrationStore<Value> = ReturnType<typeof createPluginStateKeyedStoreV2ForTests<Value>>;
type TelegramStore = RegistrationStore<StoredTelegramBinding>;
type TelegramThreadBindingManager = {
  stop: () => Promise<void>;
};
type CreateTelegramThreadBindingManager = (params: {
  cfg: { channels: { telegram: { botToken: string } } };
  accountId: string;
  persist: boolean;
  enableSweeper: boolean;
}) => Promise<TelegramThreadBindingManager>;

const telegramConfig = {
  channels: { telegram: { botToken: "test-token" } },
};
const conversation = {
  channel: "telegram",
  accountId: "default",
  conversationId: "-10099:topic:42",
  parentConversationId: "-10099",
  threadId: "42",
};
const codexIdentity = {
  pluginId: "codex",
  pluginName: "Codex",
  pluginRoot: "/plugins/codex-a",
};
// The observer store uses this no-op authority; Telegram's runtime store runs production checks.
const storeAuthority = {
  assertCurrent() {},
};

let setTelegramRuntime: (runtime: PluginRuntime) => void;
let createTelegramThreadBindingManager: CreateTelegramThreadBindingManager;

beforeAll(async () => {
  ({ createTelegramThreadBindingManager, setTelegramRuntime } = await loadBundledPluginFacade<{
    createTelegramThreadBindingManager: CreateTelegramThreadBindingManager;
    setTelegramRuntime: (runtime: PluginRuntime) => void;
  }>({ pluginId: "telegram", artifactBasename: "runtime-api.js" }));
});

function createRegistrationGate<Value>() {
  const entered = createDeferred();
  const release = createDeferred();
  let armed = false;

  return {
    entered,
    release,
    arm() {
      // Both channels reopen their store for every write, so callers arm only after the seed write.
      armed = true;
    },
    intercept(store: RegistrationStore<Value>) {
      if (!armed) {
        return;
      }
      armed = false;
      const register = store.register.bind(store);
      vi.spyOn(store, "register").mockImplementationOnce(async (...args) => {
        entered.resolve();
        await release.promise;
        return await register(...args);
      });
    },
  };
}

async function readStoredTarget(store: TelegramStore): Promise<StoredTelegramBinding | undefined> {
  const row = (await store.entries()).find(
    (entry) =>
      entry.value.accountId === conversation.accountId &&
      entry.value.conversationId === conversation.conversationId,
  );
  return row ? structuredClone(row.value) : undefined;
}

async function createRegistryRuntimeFixture() {
  const state = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-conversation-binding-registry-",
  });
  onTestFinished(() => state.cleanup());
  resetPluginStateStoreForTests();
  onTestFinished(() => resetPluginStateStoreForTests());
  sessionBindingTesting.resetSessionBindingAdaptersForTests();
  onTestFinished(() => sessionBindingTesting.resetSessionBindingAdaptersForTests());
  const codex = new PluginInstance("codex");
  onTestFinished(async () => expect((await codex.dispose()).errors).toEqual([]));
  const gate = createRegistrationGate<StoredTelegramBinding>();

  const { createPluginRuntime } = await import("./runtime/index.js");
  const builder = createPluginRegistry({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    runtime: createPluginRuntime(),
    activateGlobalSideEffects: false,
  });
  const record = createPluginRecord({ id: "telegram", origin: "bundled" });
  const api = builder.createApi(record, {
    config: telegramConfig,
    registrationMode: "full",
  });
  const telegram = expectDefined(getPluginInstance(record), "registered Telegram plugin instance");
  onTestFinished(async () => expect((await telegram.dispose()).errors).toEqual([]));

  builder.registry.plugins.push(record);
  markPluginRegistryActive(builder.registry);
  onTestFinished(() => markPluginRegistryRetired(builder.registry));

  const openedStore: { options?: TelegramStoreOptions } = {};
  const gatedRuntime = new Proxy(api.runtime, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property !== "state") {
        return value;
      }
      const runtimeState = value as PluginRuntime["state"];
      return {
        ...runtimeState,
        // SAFETY: This fixture serves only Telegram's thread-binding namespace and record type.
        openKeyedStoreV2: ((options: TelegramStoreOptions) => {
          openedStore.options = options;
          const store = runtimeState.openKeyedStoreV2<StoredTelegramBinding>(options);
          gate.intercept(store);
          return store;
        }) as PluginRuntime["state"]["openKeyedStoreV2"],
      };
    },
  });

  // The manager starts inside Telegram's instance, as channel startup does.
  const manager = await telegram.run(async () => {
    setTelegramRuntime(gatedRuntime);
    return await createTelegramThreadBindingManager({
      cfg: telegramConfig,
      accountId: "default",
      persist: true,
      enableSweeper: false,
    });
  });
  onTestFinished(() => manager.stop());
  await telegram.run(() =>
    bindConversationNow({ identity: codexIdentity, conversation, summary: "original" }),
  );

  const storeOptions = expectDefined(
    openedStore.options,
    "Telegram registry binding store options",
  );
  const observer = createPluginStateKeyedStoreV2ForTests<StoredTelegramBinding>(
    "telegram",
    storeOptions,
    storeAuthority,
  );
  const snapshot = expectDefined(
    await readStoredTarget(observer),
    "seeded registry-owned Telegram binding",
  );

  return {
    codex,
    gate,
    builder,
    record,
    observer,
    snapshot,
  };
}

describe("plugin conversation bindings across plugin instances", () => {
  it("lets the owning plugin root refresh a Telegram binding across plugin instances", async () => {
    const fixture = await createRegistryRuntimeFixture();
    const result = await fixture.codex.run(() =>
      requestPluginConversationBinding({
        ...codexIdentity,
        conversation,
        binding: { summary: "refreshed" },
      }),
    );
    expect(result).toMatchObject({ status: "bound" });
    expect(await readStoredTarget(fixture.observer)).toMatchObject({
      metadata: {
        pluginRoot: "/plugins/codex-a",
        summary: "refreshed",
      },
    });
  });

  it("lets the owning plugin root detach a Telegram binding across plugin instances", async () => {
    const fixture = await createRegistryRuntimeFixture();
    const result = await fixture.codex.run(() =>
      detachPluginConversationBinding({
        pluginRoot: "/plugins/codex-a",
        conversation,
      }),
    );
    expect(result).toEqual({ removed: true });
    expect(await readStoredTarget(fixture.observer)).toBeUndefined();
  });

  it("rejects a queued Telegram write when its registry owner is retired", async ({ signal }) => {
    const fixture = await createRegistryRuntimeFixture();
    fixture.gate.arm();
    const request = fixture.codex.run(() =>
      requestPluginConversationBinding({
        ...codexIdentity,
        conversation,
        binding: { summary: "refreshed" },
      }),
    );
    onTestFinished(async () => {
      fixture.gate.release.resolve();
      await Promise.allSettled([request]);
    });

    await withinTest(
      awaitGateBeforeSettlement(
        fixture.gate.entered.promise,
        request,
        "Telegram binding request settled before reaching the registry-owned queued write",
      ),
      signal,
    );

    expect(isPluginRecordActive(fixture.builder.registry, fixture.record)).toBe(true);
    markPluginRegistryRetired(fixture.builder.registry);
    expect(isPluginRecordActive(fixture.builder.registry, fixture.record)).toBe(false);
    fixture.gate.release.resolve();

    await expect(request).rejects.toThrow('Plugin "telegram" runtime is no longer active.');
    expect(await readStoredTarget(fixture.observer)).toEqual(fixture.snapshot);
  });
});

type DiscordStoreOptions = Parameters<PluginRuntime["state"]["openKeyedStoreV2"]>[0];
type StoredDiscordBinding = {
  accountId: string;
  threadId: string;
  targetSessionKey: string;
  idleTimeoutMs?: number;
  metadata?: Record<string, unknown>;
};
type DiscordStore = RegistrationStore<StoredDiscordBinding>;
type DiscordThreadBindingManager = {
  isStopping: () => boolean;
  bindTarget: (params: {
    threadId: string;
    channelId: string;
    targetKind: "acp";
    targetSessionKey: string;
    agentId: string;
    boundBy: string;
    metadata: Record<string, unknown>;
  }) => Promise<unknown>;
  stop: () => Promise<void>;
};
type CreateDiscordThreadBindingManager = (params: {
  cfg: typeof discordConfig;
  accountId: string;
  persist: boolean;
  enableSweeper: boolean;
}) => Promise<DiscordThreadBindingManager>;
type DiscordSessionIdleParams = {
  targetSessionKey: string;
  accountId: string;
  idleTimeoutMs: number;
};
type DiscordSessionUnbindParams = {
  targetSessionKey: string;
  accountId: string;
  reason: string;
  sendFarewell: boolean;
};

const discordConfig = {};
const discordConversation = {
  channel: "discord",
  accountId: "default",
  conversationId: "user:101",
};

let setDiscordRuntime: (runtime: PluginRuntime) => void;
let createDiscordThreadBindingManager: CreateDiscordThreadBindingManager;
let setDiscordIdleTimeoutBySessionKeyAsync: (params: DiscordSessionIdleParams) => Promise<unknown>;
let setDiscordIdleTimeoutBySessionKey: (params: DiscordSessionIdleParams) => unknown;
let unbindDiscordThreadBindingsBySessionKey: (params: DiscordSessionUnbindParams) => unknown;
let resetDiscordThreadBindingsForTests: () => Promise<void>;

beforeAll(async () => {
  const discordRuntime = await loadBundledPluginFacade<{
    createThreadBindingManager: CreateDiscordThreadBindingManager;
    setDiscordRuntime: (runtime: PluginRuntime) => void;
    setThreadBindingIdleTimeoutBySessionKeyAsync: (
      params: DiscordSessionIdleParams,
    ) => Promise<unknown>;
    setThreadBindingIdleTimeoutBySessionKey: (params: DiscordSessionIdleParams) => unknown;
    unbindThreadBindingsBySessionKey: (params: DiscordSessionUnbindParams) => unknown;
  }>({ pluginId: "discord", artifactBasename: "runtime-api.js" });
  createDiscordThreadBindingManager = discordRuntime.createThreadBindingManager;
  setDiscordRuntime = discordRuntime.setDiscordRuntime;
  setDiscordIdleTimeoutBySessionKeyAsync =
    discordRuntime.setThreadBindingIdleTimeoutBySessionKeyAsync;
  setDiscordIdleTimeoutBySessionKey = discordRuntime.setThreadBindingIdleTimeoutBySessionKey;
  unbindDiscordThreadBindingsBySessionKey = discordRuntime.unbindThreadBindingsBySessionKey;
  ({ resetThreadBindingsForTests: resetDiscordThreadBindingsForTests } =
    await loadBundledPluginFacade<{
      resetThreadBindingsForTests: () => Promise<void>;
    }>({ pluginId: "discord", artifactBasename: "test-api.js" }));
});

async function readStoredDiscordTarget(
  store: DiscordStore,
  target: typeof discordConversation,
): Promise<StoredDiscordBinding | undefined> {
  const row = (await store.entries()).find(
    (entry) =>
      entry.value.accountId === target.accountId && entry.value.threadId === target.conversationId,
  );
  return row ? structuredClone(row.value) : undefined;
}

async function createRegisteredDiscordPlugin(instanceDescription: string) {
  const { createPluginRuntime } = await import("./runtime/index.js");
  const builder = createPluginRegistry({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    runtime: createPluginRuntime(),
    activateGlobalSideEffects: false,
  });
  const record = createPluginRecord({ id: "discord", origin: "bundled" });
  const api = builder.createApi(record, {
    config: discordConfig,
    registrationMode: "full",
  });
  const discord = expectDefined(getPluginInstance(record), instanceDescription);
  onTestFinished(async () => expect((await discord.dispose()).errors).toEqual([]));

  builder.registry.plugins.push(record);
  markPluginRegistryActive(builder.registry);
  onTestFinished(() => markPluginRegistryRetired(builder.registry));

  return { builder, record, api, discord };
}

async function createDiscordRuntimeFixture() {
  await resetDiscordThreadBindingsForTests();
  onTestFinished(() => resetDiscordThreadBindingsForTests());
  // Make detach's farewell message fail locally without touching the network;
  // thread-bindings' discord-api helper swallows the error.
  vi.stubEnv("DISCORD_BOT_TOKEN", "");

  const state = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-discord-conversation-binding-registry-",
  });
  onTestFinished(() => state.cleanup());
  resetPluginStateStoreForTests();
  onTestFinished(() => resetPluginStateStoreForTests());
  sessionBindingTesting.resetSessionBindingAdaptersForTests();
  onTestFinished(() => sessionBindingTesting.resetSessionBindingAdaptersForTests());

  const codex = new PluginInstance("codex");
  onTestFinished(async () => expect((await codex.dispose()).errors).toEqual([]));

  const { builder, record, api, discord } = await createRegisteredDiscordPlugin(
    "registered Discord plugin instance",
  );

  const gate = createRegistrationGate<StoredDiscordBinding>();
  const openedStore: { options?: DiscordStoreOptions } = {};
  const gatedRuntime = new Proxy(api.runtime, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property !== "state") {
        return value;
      }
      const runtimeState = value as PluginRuntime["state"];
      return {
        ...runtimeState,
        // SAFETY: This fixture serves only Discord's thread-binding namespace and record type.
        openKeyedStoreV2: ((options: DiscordStoreOptions) => {
          openedStore.options = options;
          const store = runtimeState.openKeyedStoreV2<StoredDiscordBinding>(options);
          gate.intercept(store);
          return store;
        }) as PluginRuntime["state"]["openKeyedStoreV2"],
      };
    },
  });

  // The manager starts inside Discord's instance, as channel startup does.
  const manager = await discord.run(async () => {
    setDiscordRuntime(gatedRuntime);
    return await createDiscordThreadBindingManager({
      cfg: discordConfig,
      accountId: "default",
      persist: true,
      enableSweeper: false,
    });
  });
  onTestFinished(() => manager.stop());
  await discord.run(() =>
    bindConversationNow({
      identity: codexIdentity,
      conversation: discordConversation,
      summary: "original",
    }),
  );

  const storeOptions = expectDefined(openedStore.options, "Discord registry binding store options");
  const observer = createPluginStateKeyedStoreV2ForTests<StoredDiscordBinding>(
    "discord",
    storeOptions,
    storeAuthority,
  );
  const snapshot = expectDefined(
    await readStoredDiscordTarget(observer, discordConversation),
    "seeded registry-owned Discord binding",
  );

  return {
    codex,
    discord,
    gate,
    builder,
    record,
    observer,
    manager,
    snapshot,
  };
}

// Before the fix, one cross-instance store failure disabled Discord persistence process-wide, leaving later writes memory-only.
// Require a later write in Discord's own instance to persist so stale bindings cannot revive after restart.
async function expectDiscordFollowupWritePersists(
  fixture: Awaited<ReturnType<typeof createDiscordRuntimeFixture>>,
  conversationId: string,
  summary: string,
) {
  const followup = { ...discordConversation, conversationId };
  await fixture.discord.run(() =>
    bindConversationNow({ identity: codexIdentity, conversation: followup, summary }),
  );
  expect(
    await readStoredDiscordTarget(fixture.observer, followup),
    `Discord persistence should remain available ${summary}`,
  ).toMatchObject({
    metadata: { summary },
  });
}

const MODULE_WRITER_IDLE_TIMEOUT_MS = 234_000;
const discordSessionWriterCases = [
  {
    name: "async session idle update",
    write: async (targetSessionKey: string) => {
      await setDiscordIdleTimeoutBySessionKeyAsync({
        targetSessionKey,
        accountId: "default",
        idleTimeoutMs: MODULE_WRITER_IDLE_TIMEOUT_MS,
      });
    },
    expectedStored: expect.objectContaining({
      idleTimeoutMs: MODULE_WRITER_IDLE_TIMEOUT_MS,
    }),
    followupConversationId: "user:104",
    summary: "after async session idle update",
  },
  {
    name: "deprecated sync session idle update",
    write: (targetSessionKey: string) => {
      setDiscordIdleTimeoutBySessionKey({
        targetSessionKey,
        accountId: "default",
        idleTimeoutMs: MODULE_WRITER_IDLE_TIMEOUT_MS,
      });
    },
    expectedStored: expect.objectContaining({
      idleTimeoutMs: MODULE_WRITER_IDLE_TIMEOUT_MS,
    }),
    followupConversationId: "user:105",
    summary: "after deprecated sync session idle update",
  },
  {
    name: "deprecated sync session unbind",
    write: (targetSessionKey: string) => {
      unbindDiscordThreadBindingsBySessionKey({
        targetSessionKey,
        accountId: "default",
        reason: "test",
        sendFarewell: false,
      });
    },
    expectedStored: undefined,
    followupConversationId: "user:106",
    summary: "after deprecated sync session unbind",
  },
] as const;

describe("Discord thread bindings across plugin instances", () => {
  it("lets the owning plugin root refresh a Discord binding across plugin instances", async () => {
    const fixture = await createDiscordRuntimeFixture();
    const result = await fixture.codex.run(() =>
      requestPluginConversationBinding({
        ...codexIdentity,
        conversation: discordConversation,
        binding: { summary: "refreshed" },
      }),
    );

    expect(result).toMatchObject({ status: "bound" });
    expect(
      await readStoredDiscordTarget(fixture.observer, discordConversation),
      "Discord refresh should update the persisted binding",
    ).toMatchObject({
      metadata: {
        pluginRoot: "/plugins/codex-a",
        summary: "refreshed",
      },
    });

    await expectDiscordFollowupWritePersists(fixture, "user:102", "after refresh");
  });

  it("lets the owning plugin root detach a Discord binding across plugin instances", async () => {
    const fixture = await createDiscordRuntimeFixture();
    const result = await fixture.codex.run(() =>
      detachPluginConversationBinding({
        pluginRoot: codexIdentity.pluginRoot,
        conversation: discordConversation,
      }),
    );

    expect(result).toEqual({ removed: true });
    expect(
      await readStoredDiscordTarget(fixture.observer, discordConversation),
      "Discord detach should delete the persisted binding",
    ).toBeUndefined();

    await expectDiscordFollowupWritePersists(fixture, "user:103", "after detach");
  });

  it("keeps a retired Discord runtime from writing the persistent binding", async ({ signal }) => {
    const fixture = await createDiscordRuntimeFixture();
    fixture.gate.arm();
    const request = fixture.codex.run(() =>
      requestPluginConversationBinding({
        ...codexIdentity,
        conversation: discordConversation,
        binding: { summary: "refreshed" },
      }),
    );
    onTestFinished(async () => {
      fixture.gate.release.resolve();
      await Promise.allSettled([request]);
    });

    await withinTest(
      awaitGateBeforeSettlement(
        fixture.gate.entered.promise,
        request,
        "Discord binding request settled before reaching the registry-owned queued write",
      ),
      signal,
    );

    expect(isPluginRecordActive(fixture.builder.registry, fixture.record)).toBe(true);
    markPluginRegistryRetired(fixture.builder.registry);
    expect(isPluginRecordActive(fixture.builder.registry, fixture.record)).toBe(false);
    fixture.gate.release.resolve();

    await Promise.allSettled([request]);
    // Discord persistence swallows the store-layer retirement rejection, so the request still returns "bound".
    // Assert only that the retired runtime did not rewrite persistent storage.
    expect(await readStoredDiscordTarget(fixture.observer, discordConversation)).toEqual(
      fixture.snapshot,
    );
  });

  it.each(discordSessionWriterCases)(
    "lets the owning Discord plugin persist the $name across plugin instances",
    async ({ write, expectedStored, followupConversationId, summary }) => {
      const fixture = await createDiscordRuntimeFixture();
      // A caller without a Discord runtime must not replace the owner's runtime.
      const reused = await fixture.codex.run(() =>
        createDiscordThreadBindingManager({
          cfg: discordConfig,
          accountId: "default",
          persist: true,
          enableSweeper: false,
        }),
      );
      expect(reused).toBe(fixture.manager);

      await fixture.codex.run(() => write(fixture.snapshot.targetSessionKey));
      const stored = await readStoredDiscordTarget(fixture.observer, discordConversation);
      expect(stored).toStrictEqual(expectedStored);

      await expectDiscordFollowupWritePersists(fixture, followupConversationId, summary);
    },
  );

  it("replaces the owner runtime when a new Discord provider reuses a live manager", async () => {
    const fixture = await createDiscordRuntimeFixture();
    expect(fixture.manager.isStopping()).toBe(false);
    expect(isPluginRecordActive(fixture.builder.registry, fixture.record)).toBe(true);
    markPluginRegistryRetired(fixture.builder.registry);
    expect(isPluginRecordActive(fixture.builder.registry, fixture.record)).toBe(false);

    const { api: replacementApi, discord: replacementDiscord } =
      await createRegisteredDiscordPlugin("replacement Discord plugin instance");

    const replacementManager = await replacementDiscord.run(async () => {
      setDiscordRuntime(replacementApi.runtime);
      return await createDiscordThreadBindingManager({
        cfg: discordConfig,
        accountId: "default",
        persist: true,
        enableSweeper: false,
      });
    });
    expect(replacementManager).toBe(fixture.manager);

    await replacementDiscord.run(() =>
      setDiscordIdleTimeoutBySessionKeyAsync({
        targetSessionKey: fixture.snapshot.targetSessionKey,
        accountId: "default",
        idleTimeoutMs: MODULE_WRITER_IDLE_TIMEOUT_MS,
      }),
    );
    expect(await readStoredDiscordTarget(fixture.observer, discordConversation)).toMatchObject({
      idleTimeoutMs: MODULE_WRITER_IDLE_TIMEOUT_MS,
    });

    await replacementDiscord.run(() =>
      replacementManager.bindTarget({
        threadId: "user:107",
        channelId: "user:107",
        targetKind: "acp",
        targetSessionKey: fixture.snapshot.targetSessionKey,
        agentId: "main",
        boundBy: "plugin",
        metadata: {
          pluginBindingOwner: "plugin",
          pluginRoot: codexIdentity.pluginRoot,
          summary: "after owner replacement",
        },
      }),
    );

    expect(
      await readStoredDiscordTarget(fixture.observer, {
        ...discordConversation,
        conversationId: "user:107",
      }),
    ).toMatchObject({ metadata: { summary: "after owner replacement" } });
  });
});
