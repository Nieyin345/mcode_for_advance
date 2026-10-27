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
exports.PluginExtToolbarItemArgumentProcessor = void 0;
const tslib_1 = require("tslib");
const browser_1 = require("@theia/core/lib/browser");
const inversify_1 = require("@theia/core/shared/inversify");
/**
 * This processor handles arguments passed to commands that are contributed by plugins and available as toolbar items.
 *
 * When a toolbar item executes a command, it often passes the active widget as an argument. This can lead to
 * serialization problems. To solve this issue, this processor checks if an argument is a Widget instance and if so, it extracts
 * and returns only the widget's ID, which can be safely serialized and used to identify the widget in the plugin host.
 */
let PluginExtToolbarItemArgumentProcessor = class PluginExtToolbarItemArgumentProcessor {
    processArgument(arg) {
        if (arg instanceof browser_1.Widget) {
            return arg.id;
        }
        return arg;
    }
};
exports.PluginExtToolbarItemArgumentProcessor = PluginExtToolbarItemArgumentProcessor;
exports.PluginExtToolbarItemArgumentProcessor = PluginExtToolbarItemArgumentProcessor = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], PluginExtToolbarItemArgumentProcessor);
//# sourceMappingURL=plugin-ext-argument-processor.js.map