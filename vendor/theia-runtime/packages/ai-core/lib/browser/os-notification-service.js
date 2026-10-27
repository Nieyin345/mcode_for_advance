"use strict";
// *****************************************************************************
// Copyright (C) 2025 EclipseSource GmbH.
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
exports.OSNotificationService = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("@theia/core/shared/inversify");
const nls_1 = require("@theia/core/lib/common/nls");
const core_1 = require("@theia/core");
const notification_types_1 = require("../common/notification-types");
/**
 * Service to handle OS-level notifications across different platforms
 * Provides fallback mechanisms for environments where notifications are unavailable
 */
let OSNotificationService = class OSNotificationService {
    constructor() {
        this.isElectron = core_1.environment.electron.is();
    }
    /**
     * Show an OS-level notification with the given title and options
     *
     * @param title The notification title
     * @param options Optional notification configuration
     * @returns Promise resolving to the notification result
     */
    async showNotification(title, options = {}, onClickCallback) {
        try {
            if (!this.isNotificationSupported()) {
                return {
                    success: false,
                    error: 'Notifications are not supported in this environment'
                };
            }
            const permission = await this.ensurePermission();
            if (permission !== 'granted') {
                return {
                    success: false,
                    error: `Notification permission ${permission}`
                };
            }
            const notification = await this.createNotification(title, options, onClickCallback);
            return {
                success: true,
                notification
            };
        }
        catch (error) {
            this.logger.error('Failed to show OS notification:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error occurred'
            };
        }
    }
    /**
     * Check if notification permission is granted
     *
     * @returns The current notification permission state
     */
    getPermissionStatus() {
        if (!this.isNotificationSupported()) {
            return 'denied';
        }
        return Notification.permission;
    }
    /**
     * Request notification permission from the user
     *
     * @returns Promise resolving to the permission state
     */
    async requestPermission() {
        if (!this.isNotificationSupported()) {
            return 'denied';
        }
        if (Notification.permission !== 'default') {
            return Notification.permission;
        }
        try {
            const permission = await Notification.requestPermission();
            return permission;
        }
        catch (error) {
            this.logger.error('Failed to request notification permission:', error);
            return 'denied';
        }
    }
    /**
     * Check if OS notifications are supported in the current environment
     *
     * @returns true if notifications are supported, false otherwise
     */
    isNotificationSupported() {
        return typeof window !== 'undefined' && 'Notification' in window;
    }
    /**
     * Show a notification for an agent event (task completed or input needed).
     * This is a convenience method with pre-configured options for agent notifications.
     *
     * @param agentName The name of the agent
     * @param kind Whether the agent completed its task or needs user input
     * @param sessionTitle Optional title of the chat session for identification
     * @param onClickCallback Optional callback to invoke when the notification is clicked
     * @returns Promise resolving to the notification result
     */
    async showAgentNotification(agentName, kind, sessionTitle, onClickCallback) {
        const inputNeeded = kind === notification_types_1.AGENT_NOTIFICATION_KIND_INPUT_NEEDED;
        const title = inputNeeded
            ? nls_1.nls.localize('theia/ai-core/agentInputNeededTitle', 'Agent "{0}" Needs Your Input', agentName)
            : nls_1.nls.localize('theia/ai-core/agentCompletionTitle', 'Agent "{0}" Task Completed', agentName);
        const body = inputNeeded
            ? (sessionTitle
                ? nls_1.nls.localize('theia/ai-core/agentInputNeededMessageWithSession', 'Agent "{0}" needs your input in "{1}".', agentName, sessionTitle)
                : nls_1.nls.localize('theia/ai-core/agentInputNeededMessage', 'Agent "{0}" needs your input.', agentName))
            : (sessionTitle
                ? nls_1.nls.localize('theia/ai-core/agentCompletionMessageWithSession', 'Agent "{0}" has completed its task in "{1}".', agentName, sessionTitle)
                : nls_1.nls.localize('theia/ai-core/agentCompletionMessage', 'Agent "{0}" has completed its task.', agentName));
        return this.showNotification(title, {
            body,
            icon: this.getAgentNotificationIcon(),
            tag: `agent-${kind}-${agentName}-${sessionTitle ?? 'default'}`,
            requireInteraction: false,
            data: {
                type: `agent-${kind}`,
                agentName,
                sessionTitle,
                timestamp: Date.now()
            }
        }, onClickCallback);
    }
    /**
     * Ensure notification permission is granted
     *
     * @returns Promise resolving to the permission state
     */
    async ensurePermission() {
        const currentPermission = this.getPermissionStatus();
        if (currentPermission === 'granted') {
            return currentPermission;
        }
        if (currentPermission === 'denied') {
            return currentPermission;
        }
        return this.requestPermission();
    }
    /**
     * Create a native notification with the given title and options
     *
     * @param title The notification title
     * @param options The notification options
     * @param onClickCallback Optional callback to invoke when the notification is clicked
     * @returns Promise resolving to the created notification
     */
    async createNotification(title, options, onClickCallback) {
        return new Promise((resolve, reject) => {
            try {
                const notificationOptions = {
                    body: options.body,
                    icon: options.icon,
                    silent: options.silent,
                    tag: options.tag,
                    requireInteraction: options.requireInteraction,
                    data: options.data
                };
                const notification = new Notification(title, notificationOptions);
                notification.onshow = () => {
                    this.logger.debug('OS notification shown:', title);
                };
                notification.onerror = error => {
                    this.logger.error('OS notification error:', error);
                    reject(new Error('Failed to show notification'));
                };
                notification.onclick = () => {
                    this.logger.debug('OS notification clicked:', title);
                    this.focusApplicationWindow();
                    if (onClickCallback) {
                        onClickCallback();
                    }
                    notification.close();
                };
                notification.onclose = () => {
                    this.logger.debug('OS notification closed:', title);
                };
                resolve(notification);
            }
            catch (error) {
                reject(error);
            }
        });
    }
    /**
     * Attempt to focus the application window when notification is clicked
     */
    focusApplicationWindow() {
        try {
            if (typeof window !== 'undefined') {
                window.focus();
                if (this.isElectron && window.electronTheiaCore?.focusWindow) {
                    window.electronTheiaCore.focusWindow();
                }
            }
        }
        catch (error) {
            this.logger.debug('Could not focus application window:', error);
        }
    }
    /**
     * Get the icon URL for agent notifications
     *
     * @returns The icon URL or undefined if not available
     */
    getAgentNotificationIcon() {
        // This could return a path to an icon file
        // For now, we'll return undefined to use the default system icon
        return undefined;
    }
};
exports.OSNotificationService = OSNotificationService;
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.ILogger),
    (0, inversify_1.named)('ai-core:OSNotificationService'),
    tslib_1.__metadata("design:type", Object)
], OSNotificationService.prototype, "logger", void 0);
exports.OSNotificationService = OSNotificationService = tslib_1.__decorate([
    (0, inversify_1.injectable)(),
    tslib_1.__metadata("design:paramtypes", [])
], OSNotificationService);
//# sourceMappingURL=os-notification-service.js.map