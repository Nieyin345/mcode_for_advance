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
exports.AGENT_NOTIFICATION_KIND_INPUT_NEEDED = exports.AGENT_NOTIFICATION_KIND_COMPLETED = exports.NOTIFICATION_TYPE_DESCRIPTIONS = exports.NOTIFICATION_TYPE_LABELS = exports.NOTIFICATION_TYPES = exports.NOTIFICATION_TYPE_BLINK = exports.NOTIFICATION_TYPE_MESSAGE = exports.NOTIFICATION_TYPE_OS_NOTIFICATION = exports.NOTIFICATION_TYPE_OFF = void 0;
const core_1 = require("@theia/core");
exports.NOTIFICATION_TYPE_OFF = 'off';
exports.NOTIFICATION_TYPE_OS_NOTIFICATION = 'os-notification';
exports.NOTIFICATION_TYPE_MESSAGE = 'message';
exports.NOTIFICATION_TYPE_BLINK = 'blink';
exports.NOTIFICATION_TYPES = [
    exports.NOTIFICATION_TYPE_OFF,
    exports.NOTIFICATION_TYPE_OS_NOTIFICATION,
    exports.NOTIFICATION_TYPE_MESSAGE,
    exports.NOTIFICATION_TYPE_BLINK,
];
exports.NOTIFICATION_TYPE_LABELS = {
    [exports.NOTIFICATION_TYPE_OFF]: core_1.nls.localizeByDefault('Off'),
    [exports.NOTIFICATION_TYPE_OS_NOTIFICATION]: core_1.nls.localize('theia/ai/core/notification/osNotification', 'OS Notification'),
    [exports.NOTIFICATION_TYPE_MESSAGE]: core_1.nls.localizeByDefault('Message'),
    [exports.NOTIFICATION_TYPE_BLINK]: core_1.nls.localize('theia/ai/core/notification/windowBlink', 'Window Blink'),
};
exports.NOTIFICATION_TYPE_DESCRIPTIONS = {
    [exports.NOTIFICATION_TYPE_OFF]: core_1.nls.localize('theia/ai/core/notification/off/description', 'Disable all notifications'),
    [exports.NOTIFICATION_TYPE_OS_NOTIFICATION]: core_1.nls.localize('theia/ai/core/notification/osNotification/description', 'Show native OS notifications'),
    [exports.NOTIFICATION_TYPE_MESSAGE]: core_1.nls.localize('theia/ai/core/notification/message/description', 'Show a notification message inside the application'),
    [exports.NOTIFICATION_TYPE_BLINK]: core_1.nls.localize('theia/ai/core/notification/windowBlink/description', 'Blink the application title to attract attention'),
};
/**
 * The event that triggered an agent notification. Drives the notification wording while
 * sharing the same delivery channel and user preference.
 */
exports.AGENT_NOTIFICATION_KIND_COMPLETED = 'completed';
exports.AGENT_NOTIFICATION_KIND_INPUT_NEEDED = 'inputNeeded';
//# sourceMappingURL=notification-types.js.map