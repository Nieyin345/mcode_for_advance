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
exports.WindowBlinkService = void 0;
const tslib_1 = require("tslib");
const core_1 = require("@theia/core");
const inversify_1 = require("@theia/core/shared/inversify");
const window_title_service_1 = require("@theia/core/lib/browser/window/window-title-service");
const secondary_window_service_1 = require("@theia/core/lib/browser/window/secondary-window-service");
const frontend_application_config_provider_1 = require("@theia/core/lib/browser/frontend-application-config-provider");
/** Element ID used for the custom titlebar in Electron. Matches the ID set in electron-menu-contribution.ts. */
const CUSTOM_TITLE_ELEMENT_ID = 'theia-custom-title';
/**
 * Service for blinking/flashing the application window to get user attention.
 */
let WindowBlinkService = class WindowBlinkService {
    constructor() {
        this.originalSecondaryTitles = new Map();
        this.isElectron = core_1.environment.electron.is();
    }
    /**
     * Blink/flash the window to get user attention.
     * The implementation varies depending on the platform and environment.
     *
     * @param agentName Optional name of the agent to include in the blink notification
     */
    async blinkWindow(agentName) {
        try {
            if (this.isElectron) {
                await this.blinkElectronWindow(agentName);
            }
            else {
                await this.blinkBrowserWindow(agentName);
            }
            return { success: true };
        }
        catch (error) {
            this.logger.warn('Failed to blink window:', error);
            try {
                if (document.hidden) {
                    this.focusWindow();
                }
                return { success: true };
            }
            catch (fallbackError) {
                return {
                    success: false,
                    error: error instanceof Error ? error.message : 'Failed to blink window'
                };
            }
        }
    }
    async blinkElectronWindow(agentName) {
        await this.blinkDocumentTitle(agentName);
    }
    async blinkBrowserWindow(agentName) {
        await this.blinkDocumentTitle(agentName);
        this.blinkWithVisibilityAPI();
        if (document.hidden) {
            this.focusWindow();
        }
    }
    async blinkDocumentTitle(agentName) {
        // Clear any existing blink interval to prevent concurrent title animations
        if (this.activeBlinkInterval) {
            clearInterval(this.activeBlinkInterval);
            this.activeBlinkInterval = undefined;
        }
        const originalTitle = this.windowTitleService?.title ?? document.title;
        const appName = frontend_application_config_provider_1.FrontendApplicationConfigProvider.get().applicationName;
        const alertTitle = '🔔 ' + (agentName
            ? core_1.nls.localize('theia/ai/core/blinkTitle/namedAgentCompleted', '{0} - Agent "{1}" Completed', appName, agentName)
            : core_1.nls.localize('theia/ai/core/blinkTitle/agentCompleted', '{0} - Agent Completed', appName));
        // Save original titles of secondary windows
        this.originalSecondaryTitles.clear();
        const secondaryWindows = this.secondaryWindowService?.getWindows() ?? [];
        for (const win of secondaryWindows) {
            if (!win.closed) {
                this.originalSecondaryTitles.set(win, win.document.title);
            }
        }
        let blinkCount = 0;
        const maxBlinks = 6;
        this.activeBlinkInterval = setInterval(() => {
            if (blinkCount >= maxBlinks) {
                clearInterval(this.activeBlinkInterval);
                this.activeBlinkInterval = undefined;
                this.setTitle(originalTitle);
                this.restoreSecondaryWindowTitles();
                return;
            }
            const title = blinkCount % 2 === 0 ? alertTitle : originalTitle;
            this.setTitle(title);
            this.setSecondaryWindowTitles(blinkCount % 2 === 0 ? alertTitle : undefined);
            blinkCount++;
        }, 500);
    }
    /**
     * Set the window title directly on document.title and the custom titlebar element.
     * This bypasses WindowTitleService to avoid corrupting the title template state.
     */
    setTitle(title) {
        document.title = title;
        // Also update the custom titlebar element directly if it exists
        const customTitleElement = document.getElementById(CUSTOM_TITLE_ELEMENT_ID);
        if (customTitleElement) {
            customTitleElement.textContent = title;
        }
    }
    /**
     * Set the alert title on all secondary windows, or restore their original titles.
     */
    setSecondaryWindowTitles(alertTitle) {
        for (const [win, originalTitle] of this.originalSecondaryTitles) {
            if (!win.closed) {
                win.document.title = alertTitle ?? originalTitle;
            }
        }
    }
    /**
     * Restore original titles on all secondary windows.
     */
    restoreSecondaryWindowTitles() {
        for (const [win, originalTitle] of this.originalSecondaryTitles) {
            if (!win.closed) {
                win.document.title = originalTitle;
            }
        }
        this.originalSecondaryTitles.clear();
    }
    blinkWithVisibilityAPI() {
        // This method provides visual attention-getting behavior without creating notifications
        // as notifications are handled by the OSNotificationService to avoid duplicates
        if (!this.isElectron && typeof document.hidden !== 'undefined') {
            // Focus the window if it's hidden to get user attention
            if (document.hidden) {
                this.focusWindow();
            }
        }
    }
    focusWindow() {
        try {
            window.focus();
            // Try to scroll to top to create some visual movement
            if (document.body.scrollTop > 0 || document.documentElement.scrollTop > 0) {
                const currentScroll = document.documentElement.scrollTop || document.body.scrollTop;
                window.scrollTo(0, 0);
                setTimeout(() => {
                    window.scrollTo(0, currentScroll);
                }, 100);
            }
        }
        catch (error) {
            this.logger.debug('Could not focus window:', error);
        }
    }
};
exports.WindowBlinkService = WindowBlinkService;
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.ILogger),
    (0, inversify_1.named)('ai-core:WindowBlinkService'),
    tslib_1.__metadata("design:type", Object)
], WindowBlinkService.prototype, "logger", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(window_title_service_1.WindowTitleService),
    (0, inversify_1.optional)(),
    tslib_1.__metadata("design:type", window_title_service_1.WindowTitleService)
], WindowBlinkService.prototype, "windowTitleService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(secondary_window_service_1.SecondaryWindowService),
    (0, inversify_1.optional)(),
    tslib_1.__metadata("design:type", Object)
], WindowBlinkService.prototype, "secondaryWindowService", void 0);
exports.WindowBlinkService = WindowBlinkService = tslib_1.__decorate([
    (0, inversify_1.injectable)(),
    tslib_1.__metadata("design:paramtypes", [])
], WindowBlinkService);
//# sourceMappingURL=window-blink-service.js.map