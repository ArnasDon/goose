import type { GooseSessionNotification_unstable } from '@aaif/goose-sdk';
import type { SessionNotification } from '@agentclientprotocol/sdk';
import { AppEvents } from '../constants/events';
import { maybeHandlePlatformEvent } from '../utils/platform_events';
import { isRecord } from './adapter/shared';
import { toolNotificationEvent } from './adapter/toolNotifications';
import { acpChatSessionActions, acpChatSessionStore } from './chatSessionStore';

const fullReloadInvalidations = new Set(['config', 'extension_data']);
const invalidationReloads = new Map<string, Promise<void>>();
const conversationSyncs = new Map<string, Promise<void>>();
const conversationSyncRequests = new Set<string>();
const conversationResetRequests = new Set<string>();

export function handleAcpSessionNotification(notification: SessionNotification): Promise<void> {
  const sessionNameBeforeNotification = acpChatSessionStore.getSnapshot(
    notification.sessionId
  )?.session?.name;
  const updatedName =
    notification.update.sessionUpdate === 'session_info_update'
      ? notification.update.title
      : undefined;
  acpChatSessionActions.applyAcpSessionNotification(notification);
  maybeHandleLivePlatformEvent(notification);
  const invalidations = gooseSessionInvalidations(notification);

  if (invalidations.includes('deleted')) {
    acpChatSessionActions.deleteSnapshot(notification.sessionId);
    window.dispatchEvent(
      new CustomEvent(AppEvents.SESSION_DELETED, {
        detail: { sessionId: notification.sessionId },
      })
    );
    return Promise.resolve();
  }

  if (updatedName && updatedName !== sessionNameBeforeNotification) {
    window.dispatchEvent(
      new CustomEvent(AppEvents.SESSION_RENAMED, {
        detail: { sessionId: notification.sessionId, newName: updatedName },
      })
    );
  }

  if (invalidations.includes('conversation')) {
    void syncSessionConversation(
      notification.sessionId,
      gooseConversationResetRequested(notification)
    );
  }

  if (invalidations.some((scope) => fullReloadInvalidations.has(scope))) {
    void reloadSessionFromInvalidation(notification.sessionId);
  }

  return Promise.resolve();
}

function gooseSessionInvalidations(notification: SessionNotification): string[] {
  const update = notification.update;
  if (update.sessionUpdate !== 'session_info_update' || !isRecord(update._meta)) {
    return [];
  }

  const goose = update._meta.goose;
  if (!isRecord(goose) || !Array.isArray(goose.invalidations)) {
    return [];
  }

  return goose.invalidations.filter((scope): scope is string => typeof scope === 'string');
}

function gooseConversationResetRequested(notification: SessionNotification): boolean {
  const update = notification.update;
  if (update.sessionUpdate !== 'session_info_update' || !isRecord(update._meta)) {
    return false;
  }

  const goose = update._meta.goose;
  return isRecord(goose) && goose.conversationReset === true;
}

function syncSessionConversation(sessionId: string, reset: boolean): Promise<void> {
  if (reset) {
    conversationResetRequests.add(sessionId);
  }

  const pendingSync = conversationSyncs.get(sessionId);
  if (pendingSync) {
    conversationSyncRequests.add(sessionId);
    return pendingSync;
  }

  const sync = (async () => {
    for (;;) {
      conversationSyncRequests.delete(sessionId);
      const shouldReset = conversationResetRequests.delete(sessionId);
      const cursor = shouldReset
        ? 0
        : (acpChatSessionStore.getSnapshot(sessionId)?.conversationCursor ?? 0);
      const { acpFetchSessionConversation } = await import('./sessions');
      const result = await acpFetchSessionConversation(sessionId, cursor);
      acpChatSessionActions.applyFetchedConversation(
        sessionId,
        result.notifications,
        result.nextCursor,
        shouldReset || result.reset === true
      );

      if (
        !conversationSyncRequests.has(sessionId) &&
        !conversationResetRequests.has(sessionId)
      ) {
        break;
      }
    }
  })();

  conversationSyncs.set(sessionId, sync);
  void sync.finally(() => {
    if (conversationSyncs.get(sessionId) === sync) {
      conversationSyncs.delete(sessionId);
    }
  });
  return sync;
}

function reloadSessionFromInvalidation(sessionId: string): Promise<void> {
  const pendingReload = invalidationReloads.get(sessionId);
  if (pendingReload) {
    return pendingReload;
  }

  const reload = (async () => {
    const { acpLoadSession, sessionInfoToSession } = await import('./sessions');
    acpChatSessionActions.startSessionLoad(sessionId);
    try {
      const { sessionInfo, meta } = await acpLoadSession(sessionId);
      acpChatSessionActions.finishSessionLoad(sessionId, sessionInfoToSession(sessionInfo, meta));
    } catch (error) {
      acpChatSessionActions.failSessionLoad(
        sessionId,
        error instanceof Error ? error.message : String(error)
      );
    }
  })();

  invalidationReloads.set(sessionId, reload);
  void reload.finally(() => {
    if (invalidationReloads.get(sessionId) === reload) {
      invalidationReloads.delete(sessionId);
    }
  });
  return reload;
}

function maybeHandleLivePlatformEvent(notification: SessionNotification): void {
  const update = notification.update;
  if (
    update.sessionUpdate !== 'tool_call_update' ||
    update.status === 'completed' ||
    update.status === 'failed'
  ) {
    return;
  }

  const event = toolNotificationEvent(update);
  if (event?.message.method === 'platform_event') {
    maybeHandlePlatformEvent(event.message, notification.sessionId);
  }
}

export function handleAcpGooseSessionNotification(
  notification: GooseSessionNotification_unstable
): Promise<void> {
  acpChatSessionActions.applyAcpGooseSessionNotification(notification);
  return Promise.resolve();
}
