"use strict";
// *****************************************************************************
// Copyright (C) 2018 Red Hat, Inc. and others.
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
/* eslint-disable @typescript-eslint/no-explicit-any */
Object.defineProperty(exports, "__esModule", { value: true });
exports.QuickOpenMainImpl = void 0;
const plugin_api_rpc_1 = require("../../common/plugin-api-rpc");
const browser_1 = require("@theia/core/lib/browser");
const disposable_1 = require("@theia/core/lib/common/disposable");
const severity_1 = require("@theia/core/lib/common/severity");
const monaco_quick_input_service_1 = require("@theia/monaco/lib/browser/monaco-quick-input-service");
const types_impl_1 = require("../../plugin/types-impl");
const themables_1 = require("@theia/monaco-editor-core/esm/vs/base/common/themables");
const plugin_shared_style_1 = require("./plugin-shared-style");
class QuickOpenMainImpl {
    constructor(rpc, container) {
        this.items = {};
        this.toDispose = new disposable_1.DisposableCollection();
        this.sessions = new Map();
        this.proxy = rpc.getProxy(plugin_api_rpc_1.MAIN_RPC_CONTEXT.QUICK_OPEN_EXT);
        this.delegate = container.get(monaco_quick_input_service_1.MonacoQuickInputService);
        this.quickInputService = container.get(browser_1.QuickInputService);
        this.sharedStyle = container.get(plugin_shared_style_1.PluginSharedStyle);
    }
    dispose() {
        this.toDispose.dispose();
    }
    async $show(instance, options, token) {
        const contents = new Promise((resolve, reject) => {
            this.items[instance] = { resolve, reject };
        });
        const activeItem = await options.activeItem;
        const transformedOptions = {
            ...options,
            onDidFocus: (el) => {
                if (el) {
                    this.proxy.$onItemSelected(Number.parseInt(el.id));
                }
            },
            activeItem: this.isItem(activeItem) ? this.toQuickPickItem(activeItem) : undefined
        };
        const result = await this.delegate.pick(contents, transformedOptions, token);
        if (Array.isArray(result)) {
            return result.map(({ id }) => Number.parseInt(id));
        }
        else if (result) {
            return Number.parseInt(result.id);
        }
        return undefined;
    }
    isItem(item) {
        return item?.kind === 'item';
    }
    toIconClasses(path) {
        const iconClasses = [];
        if (themables_1.ThemeIcon.isThemeIcon(path)) {
            const codicon = (0, browser_1.codiconArray)(path.id);
            iconClasses.push(...codicon);
        }
        else if (path) {
            const iconReference = this.sharedStyle.toIconClass(path);
            this.toDispose.push(iconReference);
            iconClasses.push(iconReference.object.iconClass);
        }
        return iconClasses;
    }
    toIconClass(path) {
        return this.toIconClasses(path).join(' ');
    }
    toQuickPickItem(item) {
        if (!item) {
            return undefined;
        }
        else if (item.kind === 'separator') {
            return {
                type: 'separator',
                label: item.label
            };
        }
        return {
            type: 'item',
            id: item.handle.toString(),
            label: item.label,
            description: item.description,
            detail: item.detail,
            alwaysShow: item.alwaysShow,
            iconClasses: this.toIconClasses(item.iconUrl),
            buttons: item.buttons ? this.convertToQuickInputButtons(item.buttons) : undefined
        };
    }
    $setItems(instance, items) {
        if (this.items[instance]) {
            this.items[instance].resolve(items.map(item => this.toQuickPickItem(item)));
            delete this.items[instance];
        }
        return Promise.resolve();
    }
    $setError(instance, error) {
        if (this.items[instance]) {
            this.items[instance].reject(error);
            delete this.items[instance];
        }
        return Promise.resolve();
    }
    $input(options, validateInput, token) {
        const inputOptions = Object.create(null);
        if (options) {
            inputOptions.title = options.title;
            inputOptions.password = options.password;
            inputOptions.placeHolder = options.placeHolder;
            inputOptions.valueSelection = options.valueSelection;
            inputOptions.prompt = options.prompt;
            inputOptions.value = options.value;
            inputOptions.ignoreFocusLost = options.ignoreFocusOut;
        }
        if (validateInput) {
            inputOptions.validateInput = (val) => this.proxy.$validateInput(val);
        }
        return this.quickInputService?.input(inputOptions, token);
    }
    async $showInputBox(options, validateInput) {
        return new Promise((resolve, reject) => {
            const sessionId = options.id;
            const toDispose = new disposable_1.DisposableCollection();
            const inputBox = this.quickInputService?.createInputBox();
            inputBox.prompt = options.prompt;
            inputBox.placeholder = options.placeHolder;
            inputBox.value = options.value;
            if (options.busy) {
                inputBox.busy = options.busy;
            }
            if (options.enabled) {
                inputBox.enabled = options.enabled;
            }
            inputBox.ignoreFocusOut = options.ignoreFocusOut;
            inputBox.contextKey = options.contextKey;
            if (options.password) {
                inputBox.password = options.password;
            }
            inputBox.step = options.step;
            inputBox.title = options.title;
            inputBox.description = options.description;
            inputBox.totalSteps = options.totalSteps;
            inputBox.buttons = options.buttons ? this.convertToQuickInputButtons(options.buttons) : [];
            inputBox.validationMessage = options.validationMessage;
            if (options.validationMessage) {
                inputBox.severity = options.severity ?? severity_1.Severity.Error;
            }
            if (validateInput) {
                options.validateInput = (val) => this.proxy.$validateInput(val);
            }
            toDispose.push(inputBox.onDidAccept(() => {
                this.proxy.$acceptOnDidAccept(sessionId);
                resolve(inputBox.value);
            }));
            toDispose.push(inputBox.onDidChangeValue(async (value) => {
                this.proxy.$acceptDidChangeValue(sessionId, value);
                if (options.validateInput) {
                    const result = await options.validateInput(value);
                    if (!result || typeof result === 'string') {
                        inputBox.validationMessage = result || undefined;
                        inputBox.severity = result ? severity_1.Severity.Error : severity_1.Severity.Ignore;
                    }
                    else {
                        inputBox.validationMessage = result.content;
                        inputBox.severity = result.severity;
                    }
                }
            }));
            toDispose.push(inputBox.onDidTriggerButton((button) => {
                this.proxy.$acceptOnDidTriggerButton(sessionId, button);
            }));
            toDispose.push(inputBox.onDidHide(() => {
                if (toDispose.disposed) {
                    return;
                }
                this.proxy.$acceptOnDidHide(sessionId);
                toDispose.dispose();
                resolve(undefined);
            }));
            this.toDispose.push(toDispose);
            inputBox.show();
        });
    }
    $createOrUpdate(params) {
        const sessionId = params.id;
        let session;
        const candidate = this.sessions.get(sessionId);
        if (!candidate) {
            if (params.type === 'quickPick') {
                const quickPick = this.quickInputService.createQuickPick();
                quickPick.onDidAccept(() => {
                    this.proxy.$acceptOnDidAccept(sessionId);
                });
                quickPick.onDidChangeActive((items) => {
                    this.proxy.$onDidChangeActive(sessionId, items.map(item => Number.parseInt(item.id)));
                });
                quickPick.onDidChangeSelection((items) => {
                    this.proxy.$onDidChangeSelection(sessionId, items.map(item => Number.parseInt(item.id)));
                });
                quickPick.onDidTriggerButton((button) => {
                    this.proxy.$acceptOnDidTriggerButton(sessionId, button);
                });
                quickPick.onDidTriggerItemButton(e => {
                    this.proxy.$onDidTriggerItemButton(sessionId, Number.parseInt(e.item.id), e.button.handle);
                });
                quickPick.onDidChangeValue((value) => {
                    this.proxy.$acceptDidChangeValue(sessionId, value);
                });
                quickPick.onDidHide(() => {
                    this.proxy.$acceptOnDidHide(sessionId);
                });
                session = {
                    input: quickPick,
                    handlesToItems: new Map()
                };
            }
            else {
                const inputBox = this.quickInputService.createInputBox();
                inputBox.onDidAccept(() => {
                    this.proxy.$acceptOnDidAccept(sessionId);
                });
                inputBox.onDidTriggerButton((button) => {
                    this.proxy.$acceptOnDidTriggerButton(sessionId, button);
                });
                inputBox.onDidChangeValue((value) => {
                    this.proxy.$acceptDidChangeValue(sessionId, value);
                });
                inputBox.onDidHide(() => {
                    this.proxy.$acceptOnDidHide(sessionId);
                });
                session = {
                    input: inputBox,
                    handlesToItems: new Map()
                };
            }
            this.sessions.set(sessionId, session);
        }
        else {
            session = candidate;
        }
        if (session) {
            const { input, handlesToItems } = session;
            for (const param in params) {
                if (param === 'id' || param === 'type') {
                    continue;
                }
                if (param === 'visible') {
                    if (params.visible) {
                        input.show();
                    }
                    else {
                        input.hide();
                    }
                }
                else if (param === 'items') {
                    handlesToItems.clear();
                    const items = [];
                    params[param].forEach((transferItem) => {
                        const item = this.toQuickPickItem(transferItem);
                        items.push(item);
                        handlesToItems.set(transferItem.handle, item);
                    });
                    input[param] = items;
                }
                else if (param === 'activeItems' || param === 'selectedItems') {
                    input[param] = params[param]
                        .filter((handle) => handlesToItems.has(handle))
                        .map((handle) => handlesToItems.get(handle));
                }
                else if (param === 'buttons') {
                    input[param] = params.buttons.map(button => {
                        if (button.handle === -1) {
                            return this.quickInputService.backButton;
                        }
                        const { iconUrl, tooltip, handle, location, toggle } = button;
                        return {
                            tooltip,
                            handle,
                            iconClass: this.toIconClass(iconUrl),
                            location,
                            toggle,
                        };
                    });
                }
                else {
                    input[param] = params[param];
                }
            }
        }
        return Promise.resolve(undefined);
    }
    $hide() {
        this.delegate.hide();
    }
    $dispose(sessionId) {
        const session = this.sessions.get(sessionId);
        if (session) {
            session.input.dispose();
            this.sessions.delete(sessionId);
        }
        return Promise.resolve(undefined);
    }
    convertToQuickInputButtons(buttons) {
        return buttons.map((button, i) => ({
            iconClass: this.toIconClass(button.iconUrl),
            tooltip: button.tooltip,
            handle: button === types_impl_1.QuickInputButtons.Back ? -1 : i,
            location: button.location,
            toggle: button.toggle,
        }));
    }
}
exports.QuickOpenMainImpl = QuickOpenMainImpl;
//# sourceMappingURL=quick-open-main.js.map