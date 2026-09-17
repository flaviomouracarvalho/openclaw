import { expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../../test/helpers/promise.js";
import type { ChannelOutboundContext } from "../../channels/plugins/outbound.types.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  bindCronJobAdmittedRun,
  clearCronJobActive,
  markCronJobActive,
  noteActiveCronJobMessageActionAuthorityMutation,
} from "../../cron/active-jobs.js";
import { prepareCronPromptRunAdmission } from "../../cron/isolated-agent/run-admission.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { resolveConversationCapabilityProfile } from "../conversation-capability-profile.js";
import { createEmbeddedMessageInvocationPolicy } from "../scheduled-message-invocation.js";
import { createMessageTool } from "./message-tool-execution.js";

it("fences later scheduled sends while preserving an accepted send", async () => {
  const registry = captureActivePluginRegistrySnapshot();
  const source = new AbortController();
  const sendEntered = createDeferred();
  const releaseSend = createDeferred();
  const jobId = "scheduled-message-lifetime";
  const runId = "scheduled-message-lifetime-run";
  const sessionKey = `agent:main:cron:${jobId}:run:${runId}`;
  const scheduledToolPolicy = { version: 1, mode: "trusted" } as const;
  const marker = markCronJobActive(jobId, { isMessageActionAuthorityCurrent: () => true });
  let pending: ReturnType<ReturnType<typeof createMessageTool>["execute"]> | undefined;
  let admission: ReturnType<typeof prepareCronPromptRunAdmission> | undefined;
  try {
    const config: OpenClawConfig = {
      agents: { entries: { main: {} } },
      tools: { allow: ["message"] },
      channels: { discord: { token: "synthetic-token" } },
    };
    setRuntimeConfigSnapshot(config, config);
    const sends: string[] = [];
    const sendText = vi.fn(async ({ text }: ChannelOutboundContext) => {
      sends.push(text);
      sendEntered.resolve();
      await releaseSend.promise;
      return { channel: "discord", messageId: `message-${sends.length}` };
    });
    const plugin: ChannelPlugin = {
      ...createChannelTestPluginBase({ id: "discord" }),
      actions: { describeMessageTool: () => ({ actions: ["send"] }) },
      outbound: { deliveryMode: "direct", sendText },
    };
    setActivePluginRegistry(createTestRegistry([{ pluginId: plugin.id, source: "test", plugin }]));

    admission = prepareCronPromptRunAdmission({
      cfg: config,
      agentId: "main",
      runId,
      sessionKey,
      jobId,
      toolsAllow: ["message"],
      scheduledToolPolicy,
    });
    bindCronJobAdmittedRun(
      marker,
      await admission.preparedRunAdmission.admit("embedded"),
      source.signal,
    );
    const catalog: ReturnType<typeof createMessageTool>[] = [];
    const invocationPolicy = createEmbeddedMessageInvocationPolicy({
      config,
      capabilityProfile: resolveConversationCapabilityProfile({
        config,
        agentId: "main",
        runId,
        sessionId: runId,
        sessionKey,
        scheduledToolPolicy,
      }),
      runtimeProfileAlsoAllow: ["message"],
      toolSearchControlAllowlist: [],
      scheduledToolPolicy,
      catalog: () => ({ tools: catalog }),
      isAvailable: () => catalog.some((tool) => tool.name === "message"),
    });
    const tool = createMessageTool({
      config,
      agentId: "main",
      runId,
      sessionId: runId,
      agentSessionKey: sessionKey,
      agentAccountId: "default",
      messageActionTurnCapability: admission.messageActionTurnCapability,
      admitScheduledInvocation: invocationPolicy.admit,
      resolveCommandSecretRefsViaGateway: async ({ config: resolvedConfig }) => ({
        resolvedConfig,
        diagnostics: [],
        targetStatesByPath: {},
        hadUnresolvedTargets: false,
      }),
    });
    catalog.push(tool);
    const send = (callId: string, message: string, gatewayUrl?: string) =>
      tool.execute(callId, {
        action: "send",
        channel: "discord",
        target: "channel:100000000000000001",
        message,
        ...(gatewayUrl ? { gatewayUrl } : {}),
      });

    await expect(send("explicit-gateway", "blocked", "ws://127.0.0.1:18789")).rejects.toThrow(
      "Scheduled message actions cannot override Gateway routing",
    );
    expect(sendText).not.toHaveBeenCalled();

    pending = send("accepted-before-revocation", "first");
    void pending.catch(() => undefined);
    await withTestTimeout(sendEntered.promise, 5000, "Scheduled provider send did not start");
    noteActiveCronJobMessageActionAuthorityMutation(jobId);
    releaseSend.resolve();

    await expect(pending).resolves.toMatchObject({
      details: { result: { messageId: "message-1" } },
    });
    await expect(send("after-revocation", "second")).rejects.toThrow(
      "cron message action authority is no longer active",
    );
    expect(sendText).toHaveBeenCalledOnce();
    expect(sends).toEqual(["first"]);
  } finally {
    source.abort();
    releaseSend.resolve();
    await pending?.catch(() => undefined);
    admission?.close();
    clearCronJobActive(jobId, marker);
    restoreActivePluginRegistrySnapshot(registry);
    clearRuntimeConfigSnapshot();
  }
});
