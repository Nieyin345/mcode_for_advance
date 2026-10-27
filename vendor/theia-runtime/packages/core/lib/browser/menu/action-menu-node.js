"use strict";
// *****************************************************************************
// Copyright (C) 2022 Ericsson and others.
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
exports.ActionMenuNode = exports.AcceleratorSource = void 0;
const common_1 = require("../../common");
var AcceleratorSource;
(function (AcceleratorSource) {
    function is(node) {
        return (0, common_1.isObject)(node) && typeof node.getAccelerator === 'function';
    }
    AcceleratorSource.is = is;
})(AcceleratorSource || (exports.AcceleratorSource = AcceleratorSource = {}));
/**
 * Node representing an action in the menu tree structure.
 * It's based on {@link MenuAction} for which it tries to determine the
 * best label, icon and sortString with the given data.
 */
class ActionMenuNode {
    constructor(action, commands, keybindingRegistry, contextKeyService) {
        this.action = action;
        this.commands = commands;
        this.keybindingRegistry = keybindingRegistry;
        this.contextKeyService = contextKeyService;
        this.disposables = new common_1.DisposableCollection();
        this.onDidChangeEmitter = new common_1.Emitter();
        this.onDidChange = this.onDidChangeEmitter.event;
        this.commands.getAllHandlers(action.commandId).forEach(handler => {
            if (handler.onDidChangeEnabled) {
                this.disposables.push(handler.onDidChangeEnabled(() => this.onDidChangeEmitter.fire()));
            }
        });
        if (action.when) {
            const contextKeys = new Set();
            this.contextKeyService.parseKeys(action.when)?.forEach(key => contextKeys.add(key));
            if (contextKeys.size > 0) {
                this.disposables.push(this.contextKeyService.onDidChange(change => {
                    if (change.affects(contextKeys)) {
                        this.onDidChangeEmitter.fire();
                    }
                }));
            }
        }
    }
    dispose() {
        this.disposables.dispose();
    }
    isVisible(effeciveMenuPath, contextMatcher, context, ...args) {
        if (!this.commands.isVisible(this.action.commandId, ...args)) {
            return false;
        }
        if (this.action.when) {
            return contextMatcher.match(this.action.when, context);
        }
        return true;
    }
    getAccelerator(context) {
        const bindings = this.keybindingRegistry.getKeybindingsForCommand(this.action.commandId);
        // Only consider the first active keybinding.
        if (bindings.length) {
            const binding = bindings.find(b => this.keybindingRegistry.isEnabledInScope(b, context));
            if (binding) {
                const asciiOnly = common_1.environment.electron.is();
                return this.keybindingRegistry.acceleratorFor(binding, '+', asciiOnly);
            }
        }
        return [];
    }
    isEnabled(effeciveMenuPath, ...args) {
        return this.commands.isEnabled(this.action.commandId, ...args);
    }
    isToggled(effeciveMenuPath, ...args) {
        return this.commands.isToggled(this.action.commandId, ...args);
    }
    async run(effeciveMenuPath, ...args) {
        return this.commands.executeCommand(this.action.commandId, ...args);
    }
    get id() { return this.action.commandId; }
    get when() { return this.action.when; }
    get label() {
        if (this.action.label) {
            return this.action.label;
        }
        const cmd = this.commands.getCommand(this.action.commandId);
        if (!cmd) {
            console.debug(`No label for action menu node: No command "${this.action.commandId}" exists.`);
            return '';
        }
        return cmd.label || cmd.id;
    }
    get icon() {
        if (this.action.icon) {
            return this.action.icon;
        }
        const command = this.commands.getCommand(this.action.commandId);
        return command && command.iconClass;
    }
    get sortString() { return this.action.order || this.label; }
}
exports.ActionMenuNode = ActionMenuNode;
//# sourceMappingURL=action-menu-node.js.map