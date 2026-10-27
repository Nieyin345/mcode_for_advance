"use strict";
// *****************************************************************************
// Copyright (C) 2025 EclipseSource GmbH and others.
//
// This program and the accompanying materials are made available under the
// terms of the Eclipse Public License v. 2.0 which is available at
// http://www.eclipse.org/legal/epl-2.0.
//
// This Source Code may also be made available under the following Secondary
// Licenses when the conditions for such availability set forth in the Eclipse
// Public License v. 2.0 are satisfied: GNU General Public License, version 2
// with the GNU Classpath Exception which is available at
// https://www.gnu.org/software/classpath/license.html.
//
// SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
// *****************************************************************************
Object.defineProperty(exports, "__esModule", { value: true });
exports.AgentNotificationService = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("@theia/core/shared/inversify");
const message_service_1 = require("@theia/core/lib/common/message-service");
const nls_1 = require("@theia/core/lib/common/nls");
const ai_core_preferences_1 = require("../common/ai-core-preferences");
const agent_service_1 = require("../common/agent-service");
const settings_service_1 = require("../common/settings-service");
const os_notification_service_1 = require("./os-notification-service");
const window_blink_service_1 = require("./window-blink-service");
const notification_types_1 = require("../common/notification-types");
const core_1 = require("@theia/core");
let AgentNotificationService = class AgentNotificationService {
    /**
     * Show a notification for the specified agent if enabled in preferences.
     *
     * @param agentId The unique identifier of the agent
     * @param kind Whether the agent completed its task or needs user input
     * @param options Optional configuration for the notification
     */
    async showNotification(agentId, kind, options) {
        const notificationType = await this.getNotificationTypeForAgent(agentId);
        if (notificationType === notification_types_1.NOTIFICATION_TYPE_OFF) {
            return;
        }
        // Check if notification should be suppressed (e.g., user is viewing the same session)
        if (options?.shouldSuppress?.()) {
            return;
        }
        try {
            const agentName = this.resolveAgentName(agentId);
            await this.executeNotificationType(agentName, kind, notificationType, options?.onActivate, options?.sessionTitle);
        }
        catch (error) {
            this.logger.error('Failed to show agent notification:', error);
        }
    }
    /**
     * Resolve the display name for an agent by its ID.
     *
     * @param agentId The unique identifier of the agent
     * @returns The agent's display name or the agent ID if not found
     */
    resolveAgentName(agentId) {
        try {
            const agents = this.agentService.getAllAgents();
            const agent = agents.find(a => a.id === agentId);
            return agent?.name || agentId;
        }
        catch (error) {
            this.logger.warn(`Failed to resolve agent name for ID '${agentId}':`, error);
            return agentId;
        }
    }
    /**
     * Get the preferred notification type for a specific agent.
     * If no agent-specific preference is set, returns the global default notification type.
     */
    async getNotificationTypeForAgent(agentId) {
        const agentSettings = await this.settingsService.getAgentSettings(agentId);
        const agentNotificationType = agentSettings?.completionNotification;
        // If agent has no specific setting, use the global default
        if (!agentNotificationType) {
            return this.preferenceService.get(ai_core_preferences_1.PREFERENCE_NAME_DEFAULT_NOTIFICATION_TYPE, notification_types_1.NOTIFICATION_TYPE_OFF);
        }
        return agentNotificationType;
    }
    /**
     * Execute the specified notification type.
     */
    async executeNotificationType(agentName, kind, type, onActivate, sessionTitle) {
        switch (type) {
            case notification_types_1.NOTIFICATION_TYPE_OS_NOTIFICATION:
                await this.showOSNotification(agentName, kind, onActivate, sessionTitle);
                break;
            case notification_types_1.NOTIFICATION_TYPE_MESSAGE:
                await this.showMessageServiceNotification(agentName, kind, onActivate, sessionTitle);
                break;
            case notification_types_1.NOTIFICATION_TYPE_BLINK:
                await this.showBlinkNotification(agentName);
                break;
            default:
                throw new Error(`Unknown notification type: ${type}`);
        }
    }
    /**
     * Show OS notification directly.
     */
    async showOSNotification(agentName, kind, onActivate, sessionTitle) {
        const result = await this.osNotificationService.showAgentNotification(agentName, kind, sessionTitle, onActivate);
        if (!result.success) {
            throw new Error(`OS notification failed: ${result.error}`);
        }
    }
    /**
     * Show MessageService notification.
     */
    async showMessageServiceNotification(agentName, kind, onActivate, sessionTitle) {
        const message = kind === notification_types_1.AGENT_NOTIFICATION_KIND_INPUT_NEEDED
            ? (sessionTitle
                ? nls_1.nls.localize('theia/ai-core/agentInputNeededMessageWithSession', 'Agent "{0}" needs your input in "{1}".', agentName, sessionTitle)
                : nls_1.nls.localize('theia/ai-core/agentInputNeededMessage', 'Agent "{0}" needs your input.', agentName))
            : (sessionTitle
                ? nls_1.nls.localize('theia/ai-core/agentCompletionMessageWithSession', 'Agent "{0}" has completed its task in "{1}".', agentName, sessionTitle)
                : nls_1.nls.localize('theia/ai-core/agentCompletionMessage', 'Agent "{0}" has completed its task.', agentName));
        const showChatAction = nls_1.nls.localize('theia/ai-core/showChat', 'Show Chat');
        const action = await this.messageService.info(message, showChatAction);
        if (action === showChatAction && onActivate) {
            onActivate();
        }
    }
    /**
     * Show window blink notification.
     */
    async showBlinkNotification(agentName) {
        const result = await this.windowBlinkService.blinkWindow(agentName);
        if (!result.success) {
            throw new Error(`Window blink notification failed: ${result.error}`);
        }
    }
    /**
     * Check if OS notifications are supported and enabled.
     */
    isOSNotificationSupported() {
        return this.osNotificationService.isNotificationSupported();
    }
    /**
     * Get the current OS notification permission status.
     */
    getOSNotificationPermission() {
        return this.osNotificationService.getPermissionStatus();
    }
    /**
     * Request OS notification permission from the user.
     */
    async requestOSNotificationPermission() {
        return this.osNotificationService.requestPermission();
    }
};
exports.AgentNotificationService = AgentNotificationService;
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.PreferenceService),
    tslib_1.__metadata("design:type", Object)
], AgentNotificationService.prototype, "preferenceService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(agent_service_1.AgentService),
    tslib_1.__metadata("design:type", Object)
], AgentNotificationService.prototype, "agentService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(settings_service_1.AISettingsService),
    tslib_1.__metadata("design:type", Object)
], AgentNotificationService.prototype, "settingsService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(os_notification_service_1.OSNotificationService),
    tslib_1.__metadata("design:type", os_notification_service_1.OSNotificationService)
], AgentNotificationService.prototype, "osNotificationService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(message_service_1.MessageService),
    tslib_1.__metadata("design:type", message_service_1.MessageService)
], AgentNotificationService.prototype, "messageService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(window_blink_service_1.WindowBlinkService),
    tslib_1.__metadata("design:type", window_blink_service_1.WindowBlinkService)
], AgentNotificationService.prototype, "windowBlinkService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.ILogger),
    (0, inversify_1.named)('ai-core:AgentNotificationService'),
    tslib_1.__metadata("design:type", Object)
], AgentNotificationService.prototype, "logger", void 0);
exports.AgentNotificationService = AgentNotificationService = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], AgentNotificationService);
//# sourceMappingURL=agent-notification-service.js.map