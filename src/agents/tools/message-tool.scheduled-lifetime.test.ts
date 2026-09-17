import { expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../../test/helpers/promise.js";
import type { ChannelOutboundContext } from "../../channels/plugins/outbound.types.js";
import type { ChannelPollContext } from "../../channels/plugins/types.core.js";
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
import { recoverPendingDeliveries } from "../../infra/outbound/delivery-queue-recovery.js";
import { loadUnfinishedDeliveries } from "../../infra/outbound/delivery-queue-storage.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { resolveConversationCapabilityProfile } from "../conversation-capability-profile.js";
import { createEmbeddedMessageInvocationPolicy } from "../scheduled-message-invocation.js";
import { createMessageTool } from "./message-tool-execution.js";

it.each([
  {
    cause: "message authority is durably revoked",
    revokeAt: "provider" as const,
    action: "send" as const,
    retire: noteActiveCronJobMessageActionAuthorityMutation,
    accepted: true,
    laterError: "cron message action authority is no longer active",
  },
  {
    cause: "the active job is cancelled",
    revokeAt: "provider" as const,
    action: "send" as const,
    retire: (jobId: string) =>
      requestActiveCronJobCancellation(jobId, "Cron job removed by operator."),
    accepted: true,
    laterError: "Message send aborted",
  },
  {
    cause: "message authority closes during provider target lookup",
    revokeAt: "target" as const,
    action: "send" as const,
    retire: noteActiveCronJobMessageActionAuthorityMutation,
    accepted: false,
    laterError: "cron message action authority is no longer active",
  },
  {
    cause: "the active job is cancelled after a generic mutation is accepted",
    revokeAt: "action" as const,
    action: "set-presence" as const,
    retire: (jobId: string) =>
      requestActiveCronJobCancellation(jobId, "Cron job removed by operator."),
    accepted: true,
    laterError: "Message send aborted",
  },
  {
    cause: "message authority closes before a refused write retry",
    revokeAt: "retry" as const,
    action: "send" as const,
    retire: noteActiveCronJobMessageActionAuthorityMutation,
    accepted: false,
    laterError: "cron message action authority is no longer active",
  },
  {
    cause: "message authority closes before a poll provider retry",
    revokeAt: "poll-retry" as const,
    action: "poll" as const,
    retire: noteActiveCronJobMessageActionAuthorityMutation,
    accepted: false,
    laterError: "cron message action authority is no longer active",
  },
])(
  "owns scheduled message lifetime when $cause",
  async ({ revokeAt, action, retire, accepted, laterError }) => {
    const registry = captureActivePluginRegistrySnapshot();
    const state = await createOpenClawTestState();
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
        agents: { entries: { main: {} }, defaults: { workspace: state.workspaceDir } },
        tools: { allow: ["message"] },
        channels: { discord: { token: "synthetic-token" } },
      };
      setRuntimeConfigSnapshot(config, config);
      const sends: string[] = [];
      const queueIds: Array<string | undefined> = [];
      const mutations: string[] = [];
      const pollRequests: string[] = [];
      const sendText = vi.fn(
        async ({ text, deliveryQueueId, onPlatformSendDispatch }: ChannelOutboundContext) => {
          sends.push(text);
          queueIds.push(deliveryQueueId);
          if (revokeAt === "provider") {
            boundaryEntered.resolve();
            await releaseBoundary.promise;
          }
          if (revokeAt === "retry") {
            boundaryEntered.resolve();
            await releaseBoundary.promise;
            await onPlatformSendDispatch?.();
          }
          return { channel: "discord", messageId: `message-${sends.length}` };
        },
      );
      const listTargetsLive = async () => {
        if (revokeAt === "target") {
          boundaryEntered.resolve();
          await releaseBoundary.promise;
        }
        return [{ kind: "group" as const, id: "channel:100000000000000001", name: "alerts" }];
      };
      const sendPoll = vi.fn(async ({ assertDirectAdapterHandoff }: ChannelPollContext) => {
        pollRequests.push("initial");
        if (revokeAt === "poll-retry") {
          boundaryEntered.resolve();
          await releaseBoundary.promise;
          assertDirectAdapterHandoff?.();
          pollRequests.push("retry");
        }
        return { channel: "discord", messageId: "poll-1" };
      });
      const plugin: ChannelPlugin = {
        ...createChannelTestPluginBase({ id: "discord" }),
        actions: {
          describeMessageTool: () => ({ actions: ["send", "poll", "set-presence"] }),
          supportsAction: ({ action: requestedAction }) => requestedAction === "set-presence",
          handleAction: async ({ action: requestedAction }) => {
            if (requestedAction !== "set-presence") {
              throw new Error(`Unexpected plugin action: ${requestedAction}`);
            }
            mutations.push(requestedAction);
            if (revokeAt === "action") {
              boundaryEntered.resolve();
              await releaseBoundary.promise;
            }
            return { content: [{ type: "text", text: '{"ok":true}' }], details: { ok: true } };
          },
        },
        outbound: { deliveryMode: "direct", sendText, sendPoll },
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
      const execute = (callId: string) =>
        action === "send"
          ? send(callId, "first")
          : tool.execute(
              callId,
              {
                action,
                channel: "discord",
                ...(action === "poll"
                  ? {
                      target: "channel:100000000000000001",
                      pollQuestion: "Ship?",
                      pollOption: ["Yes", "No"],
                    }
                  : {}),
              },
              source.signal,
            );

      await expect(send("explicit-gateway", "blocked", "ws://127.0.0.1:18789")).rejects.toThrow(
        "Scheduled message actions cannot override Gateway routing",
      );
      expect(sendText).not.toHaveBeenCalled();

      pending = execute("accepted-before-revocation");
      void pending.catch(() => undefined);
      await withTestTimeout(
        Promise.race([
          boundaryEntered.promise,
          pending.then(
            () => {
              throw new Error("Scheduled message action completed before its provider boundary");
            },
            (error: unknown) => {
              throw error;
            },
          ),
        ]),
        5000,
        "Scheduled provider boundary not reached",
      );
      retire(jobId);
      releaseBoundary.resolve();

      if (accepted) {
        await expect(pending).resolves.toMatchObject(
          action === "send"
            ? { details: { result: { messageId: "message-1" } } }
            : { details: { ok: true } },
        );
      } else {
        await expect(pending).rejects.toThrow("cron message action authority is no longer active");
      }
      await expect(execute("after-revocation")).rejects.toThrow(laterError);
      const sendAttempts = action === "send" && revokeAt !== "target" ? 1 : 0;
      expect(sendText).toHaveBeenCalledTimes(sendAttempts);
      expect(sends).toEqual(sendAttempts ? ["first"] : []);
      expect(queueIds).toEqual(sendAttempts ? [undefined] : []);
      expect(mutations).toEqual(accepted && action === "set-presence" ? ["set-presence"] : []);
      expect(pollRequests).toEqual(action === "poll" ? ["initial"] : []);
      if (revokeAt === "retry") {
        expect(await loadUnfinishedDeliveries(state.stateDir)).toEqual([]);
        const replay = vi.fn();
        await recoverPendingDeliveries({
          deliver: replay,
          log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
          cfg: config,
          stateDir: state.stateDir,
        });
        expect(replay).not.toHaveBeenCalled();
      }
    } finally {
      source.abort();
      releaseBoundary.resolve();
      await pending?.catch(() => undefined);
      admission?.close();
      releaseCancellation?.();
      clearCronJobActive(jobId, marker);
      restoreActivePluginRegistrySnapshot(registry);
      clearRuntimeConfigSnapshot();
      await state.cleanup();
    }
  },
);
