"use strict";
// *****************************************************************************
// Copyright (C) 2026 STMicroelectronics and others.
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
const jsdom_1 = require("@theia/core/lib/browser/test/jsdom");
let disableJSDOM = (0, jsdom_1.enableJSDOM)();
const frontend_application_config_provider_1 = require("@theia/core/lib/browser/frontend-application-config-provider");
frontend_application_config_provider_1.FrontendApplicationConfigProvider.set({});
const chai_1 = require("chai");
const notifications_manager_1 = require("./notifications-manager");
const notification_content_renderer_1 = require("./notification-content-renderer");
disableJSDOM();
describe('NotificationManager', () => {
    const DEFAULT_TIMEOUT = 30000;
    class TestableNotificationManager extends notifications_manager_1.NotificationManager {
        testGetTimeout(plainMessage) {
            return this.getTimeout(plainMessage);
        }
    }
    function createNotificationManager(preferenceTimeout = DEFAULT_TIMEOUT) {
        const manager = new TestableNotificationManager();
        manager.preferences = {
            'notification.timeout': preferenceTimeout
        };
        manager.contentRenderer = new notification_content_renderer_1.NotificationContentRenderer();
        return manager;
    }
    before(() => {
        disableJSDOM = (0, jsdom_1.enableJSDOM)();
    });
    after(() => {
        disableJSDOM();
    });
    describe('getTimeout', () => {
        let manager = createNotificationManager();
        it('should return preference timeout when no options are provided', () => {
            const message = { text: 'Test message' };
            (0, chai_1.expect)(manager.testGetTimeout(message)).to.equal(DEFAULT_TIMEOUT);
        });
        it('should return preference timeout when options are provided without timeout', () => {
            const message = { text: 'Test message', options: {} };
            (0, chai_1.expect)(manager.testGetTimeout(message)).to.equal(DEFAULT_TIMEOUT);
        });
        it('should return explicit timeout when provided', () => {
            const message = { text: 'Test message', options: { timeout: 5000 } };
            (0, chai_1.expect)(manager.testGetTimeout(message)).to.equal(5000);
        });
        it('should return 0 when timeout is explicitly set to 0', () => {
            const message = { text: 'Test message', options: { timeout: 0 } };
            (0, chai_1.expect)(manager.testGetTimeout(message)).to.equal(0);
        });
        it('should return 0 when actions are present regardless of timeout', () => {
            const message = { text: 'Test message', actions: ['OK'], options: { timeout: 5000 } };
            (0, chai_1.expect)(manager.testGetTimeout(message)).to.equal(0);
        });
        it('should return 0 when actions are present and no timeout is set', () => {
            const message = { text: 'Test message', actions: ['OK', 'Cancel'] };
            (0, chai_1.expect)(manager.testGetTimeout(message)).to.equal(0);
        });
        it('should return negative timeout when explicitly set', () => {
            const message = { text: 'Test message', options: { timeout: -1 } };
            (0, chai_1.expect)(manager.testGetTimeout(message)).to.equal(-1);
        });
        it('should return explicit timeout even if custom preference timeout is available', () => {
            const customTimeout = 60000;
            manager = createNotificationManager(customTimeout);
            const message = { text: 'Test message', options: { timeout: 5000 } };
            (0, chai_1.expect)(manager.testGetTimeout(message)).to.equal(5000);
        });
        it('should return custom preference timeout if no timeout is set', () => {
            const customTimeout = 60000;
            manager = createNotificationManager(customTimeout);
            const message = { text: 'Test message' };
            (0, chai_1.expect)(manager.testGetTimeout(message)).to.equal(customTimeout);
        });
    });
});
//# sourceMappingURL=notifications-manager.spec.js.map