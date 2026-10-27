"use strict";
// *****************************************************************************
// Copyright (C) 2023 TypeFox and others.
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
exports.updateActivationEvents = updateActivationEvents;
const utils_1 = require("./utils");
const manifest_types_1 = require("./manifest-types");
/**
 * Most activation events can be automatically deduced from the package manifest.
 * This function will update the manifest based on the plugin contributions.
 */
function updateActivationEvents(manifest) {
    if (!(0, utils_1.isObject)(manifest) || !(0, utils_1.isObject)(manifest.contributes) || !manifest.contributes) {
        return;
    }
    const activationEvents = new Set((0, utils_1.isStringArray)(manifest.activationEvents) ? manifest.activationEvents : []);
    const contributes = (0, manifest_types_1.rawContributes)(manifest);
    if (contributes.commands) {
        const commands = Array.isArray(contributes.commands) ? contributes.commands : [contributes.commands];
        updateCommandsContributions(commands, activationEvents);
    }
    if ((0, utils_1.isObject)(contributes.views) && !Array.isArray(contributes.views)) {
        const views = (0, utils_1.flatten)(Object.values(contributes.views));
        updateViewsContribution(views, activationEvents);
    }
    if (Array.isArray(contributes.customEditors)) {
        updateCustomEditorsContribution(contributes.customEditors, activationEvents);
    }
    if (Array.isArray(contributes.authentication)) {
        updateAuthenticationProviderContributions(contributes.authentication, activationEvents);
    }
    if (Array.isArray(contributes.languages)) {
        updateLanguageContributions(contributes.languages, activationEvents);
    }
    if (Array.isArray(contributes.notebooks)) {
        updateNotebookContributions(contributes.notebooks, activationEvents);
    }
    manifest.activationEvents = Array.from(activationEvents);
}
function updateViewsContribution(views, activationEvents) {
    for (const view of views) {
        if ((0, utils_1.isObject)(view) && typeof view.id === 'string') {
            activationEvents.add(`onView:${view.id}`);
        }
    }
}
function updateCustomEditorsContribution(customEditors, activationEvents) {
    for (const customEditor of customEditors) {
        if ((0, utils_1.isObject)(customEditor) && typeof customEditor.viewType === 'string') {
            activationEvents.add(`onCustomEditor:${customEditor.viewType}`);
        }
    }
}
function updateCommandsContributions(commands, activationEvents) {
    for (const command of commands) {
        if ((0, utils_1.isObject)(command) && typeof command.command === 'string') {
            activationEvents.add(`onCommand:${command.command}`);
        }
    }
}
function updateAuthenticationProviderContributions(authProviders, activationEvents) {
    for (const authProvider of authProviders) {
        if ((0, utils_1.isObject)(authProvider) && typeof authProvider.id === 'string') {
            activationEvents.add(`onAuthenticationRequest:${authProvider.id}`);
        }
    }
}
function updateLanguageContributions(languages, activationEvents) {
    for (const language of languages) {
        if ((0, utils_1.isObject)(language) && typeof language.id === 'string') {
            activationEvents.add(`onLanguage:${language.id}`);
        }
    }
}
function updateNotebookContributions(notebooks, activationEvents) {
    for (const notebook of notebooks) {
        if ((0, utils_1.isObject)(notebook) && typeof notebook.type === 'string') {
            activationEvents.add(`onNotebookSerializer:${notebook.type}`);
        }
    }
}
//# sourceMappingURL=plugin-activation-events.js.map