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
  requestActiveCronJobCancellation,
} from "../../cron/active-jobs.js";
import { prepareCronPromptRunAdmission } from "../../cron/isolated-agent/run-admission.js";
import { registerActiveCronTaskRun } from "../../cron/service/active-run-cancellation.js";
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

it.each([
  {
    cause: "message authority is durably revoked",
    revokeAt: "provider" as const,
    retire: noteActiveCronJobMessageActionAuthorityMutation,
    accepted: true,
    laterError: "cron message action authority is no longer active",
  },
  {
    cause: "the active job is cancelled",
    revokeAt: "provider" as const,
    retire: (jobId: string) =>
      requestActiveCronJobCancellation(jobId, "Cron job removed by operator."),
    accepted: true,
    laterError: "Message send aborted",
  },
  {
    cause: "message authority closes during provider target lookup",
    revokeAt: "target" as const,
    retire: noteActiveCronJobMessageActionAuthorityMutation,
    accepted: false,
    laterError: "cron message action authority is no longer active",
  },
])(
  "owns scheduled message lifetime when $cause",
  async ({ revokeAt, retire, accepted, laterError }) => {
    const registry = captureActivePluginRegistrySnapshot();
    const source = new AbortController();
    const boundaryEntered = createDeferred();
    const releaseBoundary = createDeferred();
    const jobId = "scheduled-message-lifetime";
    const runId = "scheduled-message-lifetime-run";
    const sessionKey = `agent:main:cron:${jobId}:run:${runId}`;
    const scheduledToolPolicy = { version: 1, mode: "trusted" } as const;
    const marker = markCronJobActive(jobId, { isMessageActionAuthorityCurrent: () => true });
    const releaseCancellation = registerActiveCronTaskRun({
      runId,
      controller: source,
      activeJobMarker: marker,
    });
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
        if (revokeAt === "provider") {
          boundaryEntered.resolve();
          await releaseBoundary.promise;
        }
        return { channel: "discord", messageId: `message-${sends.length}` };
      });
      const listTargetsLive = async () => {
        if (revokeAt === "target") {
          boundaryEntered.resolve();
          await releaseBoundary.promise;
        }
        return [{ id: "channel:100000000000000001", name: "alerts" }];
      };
      const plugin: ChannelPlugin = {
        ...createChannelTestPluginBase({ id: "discord" }),
        actions: { describeMessageTool: () => ({ actions: ["send"] }) },
        outbound: { deliveryMode: "direct", sendText },
        directory: {
          listGroupsLive: listTargetsLive,
          listPeersLive: listTargetsLive,
        },
      };
      setActivePluginRegistry(
        createTestRegistry([{ pluginId: plugin.id, source: "test", plugin }]),
      );

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
        tool.execute(
          callId,
          {
            action: "send",
            channel: "discord",
            target: revokeAt === "target" ? "alerts" : "channel:100000000000000001",
            message,
            ...(gatewayUrl ? { gatewayUrl } : {}),
          },
          source.signal,
        );

      await expect(send("explicit-gateway", "blocked", "ws://127.0.0.1:18789")).rejects.toThrow(
        "Scheduled message actions cannot override Gateway routing",
      );
      expect(sendText).not.toHaveBeenCalled();

      pending = send("accepted-before-revocation", "first");
      void pending.catch(() => undefined);
      await withTestTimeout(
        boundaryEntered.promise,
        5000,
        "Scheduled provider boundary not reached",
      );
      retire(jobId);
      releaseBoundary.resolve();

      if (accepted) {
        await expect(pending).resolves.toMatchObject({
          details: { result: { messageId: "message-1" } },
        });
      } else {
        await expect(pending).rejects.toThrow("cron message action authority is no longer active");
      }
      await expect(send("after-revocation", "second")).rejects.toThrow(laterError);
      expect(sendText).toHaveBeenCalledTimes(accepted ? 1 : 0);
      expect(sends).toEqual(accepted ? ["first"] : []);
    } finally {
      source.abort();
      releaseBoundary.resolve();
      await pending?.catch(() => undefined);
      admission?.close();
      releaseCancellation?.();
      clearCronJobActive(jobId, marker);
      restoreActivePluginRegistrySnapshot(registry);
      clearRuntimeConfigSnapshot();
    }
  },
);
