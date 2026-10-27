"use strict";
// *****************************************************************************
// Copyright (C) 2025 1C-Soft LLC and others.
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
exports.MonacoEditorContentMenuContribution = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("@theia/core/shared/inversify");
const core_1 = require("@theia/core");
const observable_1 = require("@theia/core/lib/common/observable");
const browser_1 = require("@theia/editor/lib/browser");
const contextkey_1 = require("@theia/monaco-editor-core/esm/vs/platform/contextkey/common/contextkey");
const monaco_context_key_service_1 = require("./monaco-context-key-service");
const monaco_editor_1 = require("./monaco-editor");
const monaco_editor_overlay_button_1 = require("./monaco-editor-overlay-button");
/**
 * Implements {@link EDITOR_CONTENT_MENU} for {@link MonacoEditor}s.
 */
let MonacoEditorContentMenuContribution = class MonacoEditorContentMenuContribution {
    onStart() {
        this.editorManager.onCreated(editorWidget => {
            const editor = monaco_editor_1.MonacoEditor.get(editorWidget);
            if (editor) {
                const disposable = this.createEditorContentMenu(editor, editorWidget);
                editor.onDispose(() => disposable.dispose());
            }
        });
    }
    createEditorContentMenu(editor, editorWidget) {
        const contextKeyService = editor.getControl().invokeWithinContext(// get the editor-scoped context key service
        // get the editor-scoped context key service
        accessor => accessor.get(contextkey_1.IContextKeyService));
        const context = {
            getValue: key => contextKeyService.getContextKeyValue(key),
            onDidChange: core_1.Event.map(contextKeyService.onDidChangeContext, event => ({
                affects: keys => event.affectsSome(keys)
            }))
        };
        const menuNodesObservable = observable_1.ObservableFromEvent.create(this.menus.onDidChange, () => this.getEditorContentMenuNodes(), { isEqual: (a, b) => core_1.ArrayUtils.equals(a, b) });
        return observable_1.ObservableUtils.autorunWithDisposables(({ toDispose }) => {
            const menuNodes = menuNodesObservable.get();
            const firstMatchObservable = observable_1.ObservableFromEvent.create(contextKeyService.onDidChangeContext, () => this.withContext(context, () => menuNodes.find(menuNode => menuNode.isVisible(browser_1.EDITOR_CONTENT_MENU, this.contextKeyService, undefined, editorWidget))));
            // eslint-disable-next-line @typescript-eslint/no-shadow
            toDispose.push(observable_1.ObservableUtils.autorunWithDisposables(({ toDispose }) => {
                const firstMatch = firstMatchObservable.get();
                if (firstMatch) {
                    const button = new monaco_editor_overlay_button_1.MonacoEditorOverlayButton(editor, firstMatch.label);
                    toDispose.push(button);
                    toDispose.push(button.onClick(() => this.withContext(context, () => firstMatch.run(browser_1.EDITOR_CONTENT_MENU, editorWidget))));
                    const handlersObservable = observable_1.ObservableFromEvent.create(this.commands.onCommandsChanged, () => this.commands.getAllHandlers(firstMatch.id), { isEqual: (a, b) => core_1.ArrayUtils.equals(a, b) });
                    // eslint-disable-next-line @typescript-eslint/no-shadow
                    toDispose.push(observable_1.ObservableUtils.autorunWithDisposables(({ toDispose }) => {
                        this.withContext(context, () => {
                            button.enabled = firstMatch.isEnabled(browser_1.EDITOR_CONTENT_MENU, editorWidget);
                            const handlers = handlersObservable.get();
                            for (const handler of handlers) {
                                const { onDidChangeEnabled } = handler;
                                if (onDidChangeEnabled) {
                                    // for handlers with declarative enablement such as those originating from `PluginContributionHandler.registerCommand`,
                                    // the onDidChangeEnabled event is context-dependent, so we need to ensure the subscription is made within `withContext`
                                    toDispose.push(onDidChangeEnabled(() => this.withContext(context, () => button.enabled = firstMatch.isEnabled(browser_1.EDITOR_CONTENT_MENU, editorWidget))));
                                }
                            }
                        });
                    }));
                }
            }));
        });
    }
    getEditorContentMenuNodes() {
        const result = [];
        const children = this.menus.getMenu(browser_1.EDITOR_CONTENT_MENU)?.children ?? [];
        const getCommandMenuNodes = (nodes) => nodes.filter(core_1.CommandMenu.is);
        // inline the special navigation group, if any; the navigation group would always be the first element
        if (children.length && core_1.CompoundMenuNode.isNavigationGroup(children[0])) {
            result.push(...getCommandMenuNodes(children[0].children));
        }
        result.push(...getCommandMenuNodes(children));
        return result;
    }
    withContext(context, callback) {
        return this.contextKeyService.withContext(context, callback);
    }
};
exports.MonacoEditorContentMenuContribution = MonacoEditorContentMenuContribution;
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_1.EditorManager),
    tslib_1.__metadata("design:type", browser_1.EditorManager)
], MonacoEditorContentMenuContribution.prototype, "editorManager", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.MenuModelRegistry),
    tslib_1.__metadata("design:type", core_1.MenuModelRegistry)
], MonacoEditorContentMenuContribution.prototype, "menus", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.CommandRegistry),
    tslib_1.__metadata("design:type", core_1.CommandRegistry)
], MonacoEditorContentMenuContribution.prototype, "commands", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(monaco_context_key_service_1.MonacoContextKeyService),
    tslib_1.__metadata("design:type", monaco_context_key_service_1.MonacoContextKeyService)
], MonacoEditorContentMenuContribution.prototype, "contextKeyService", void 0);
exports.MonacoEditorContentMenuContribution = MonacoEditorContentMenuContribution = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], MonacoEditorContentMenuContribution);
//# sourceMappingURL=monaco-editor-content-menu.js.map