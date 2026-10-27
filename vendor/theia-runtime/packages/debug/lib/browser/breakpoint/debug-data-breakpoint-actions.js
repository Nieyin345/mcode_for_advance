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
exports.AddOrEditDataBreakpointAddress = void 0;
const tslib_1 = require("tslib");
const core_1 = require("@theia/core");
const inversify_1 = require("@theia/core/shared/inversify");
const debug_view_model_1 = require("../view/debug-view-model");
const source_tree_1 = require("@theia/core/lib/browser/source-tree");
const debug_data_breakpoint_1 = require("../model/debug-data-breakpoint");
const breakpoint_marker_1 = require("./breakpoint-marker");
const breakpoint_manager_1 = require("./breakpoint-manager");
const browser_1 = require("@theia/core/lib/browser");
const debug_breakpoints_widget_1 = require("../view/debug-breakpoints-widget");
// Adapted from https://github.com/microsoft/vscode/blob/9c883243a89e7ec3b730d3746fbb1e836d5e4f52/src/vs/workbench/contrib/debug/browser/breakpointsView.ts#L1506-L1625
let AddOrEditDataBreakpointAddress = class AddOrEditDataBreakpointAddress {
    isEnabled(node) {
        return !!this.viewModel.currentSession?.capabilities.supportsDataBreakpoints
            && this.viewModel.currentSession?.capabilities.supportsDataBreakpointBytes !== false
            && this.isAddressBreakpointOrDebugWidget(node);
    }
    isVisible(node) {
        return this.isEnabled(node);
    }
    isAddressBreakpointOrDebugWidget(candidate) {
        return !candidate ? true // Probably command palette
            : browser_1.TreeNode.is(candidate) && source_tree_1.TreeElementNode.is(candidate)
                ? candidate.element instanceof debug_data_breakpoint_1.DebugDataBreakpoint && candidate.element.origin.source.type === 1 /* DataBreakpointSourceType.Address */
                : candidate instanceof browser_1.Widget
                    ? candidate instanceof debug_breakpoints_widget_1.DebugBreakpointsWidget
                    : false;
    }
    async execute(node) {
        const existingBreakpoint = source_tree_1.TreeElementNode.is(node) && node.element instanceof debug_data_breakpoint_1.DebugDataBreakpoint ? node.element : undefined;
        const session = this.viewModel.currentSession;
        if (!session) {
            return;
        }
        let defaultValue = undefined;
        if (existingBreakpoint?.origin.source.type === 1 /* DataBreakpointSourceType.Address */) {
            defaultValue = `${existingBreakpoint.origin.source.address} + ${existingBreakpoint.origin.source.bytes}`;
        }
        const quickInput = this.quickInputService;
        const range = await this.getRange(defaultValue);
        if (!range) {
            return;
        }
        const info = await session.sendRequest('dataBreakpointInfo', { asAddress: true, name: range.address, bytes: range.bytes })
            .then(({ body }) => body)
            .catch(e => { this.messageService.error(core_1.nls.localizeByDefault('Failed to set data breakpoint at {0}: {1}', range.address, e.message)); });
        if (!info?.dataId) {
            return;
        }
        let accessType = 'write';
        if (info.accessTypes && info.accessTypes?.length > 1) {
            const accessTypes = info.accessTypes.map(type => ({ label: type }));
            const selectedAccessType = await quickInput.pick(accessTypes, { placeHolder: core_1.nls.localizeByDefault('Select the access type to monitor') });
            if (!selectedAccessType) {
                return;
            }
            accessType = selectedAccessType.label;
        }
        const src = { type: 1 /* DataBreakpointSourceType.Address */, ...range };
        if (existingBreakpoint) {
            this.breakpointManager.removeDataBreakpoint(existingBreakpoint);
        }
        this.breakpointManager.addDataBreakpoint(breakpoint_marker_1.DataBreakpoint.create({ dataId: info.dataId, accessType }, { ...info, canPersist: true }, src));
    }
    getRange(defaultValue) {
        return new Promise(resolve => {
            const disposables = new core_1.DisposableCollection();
            const addDisposable = (disposable) => {
                disposables.push(disposable);
                return disposable;
            };
            const input = addDisposable(this.quickInputService.createInputBox());
            input.prompt = core_1.nls.localizeByDefault('Enter a memory range in which to break');
            input.placeholder = core_1.nls.localizeByDefault('Absolute range (0x1234 - 0x1300) or range of bytes after an address (0x1234 + 0xff)');
            if (defaultValue) {
                input.value = defaultValue;
                input.valueSelection = [0, defaultValue.length];
            }
            addDisposable(input.onDidChangeValue(e => {
                const err = this.parseAddress(e, false);
                input.validationMessage = err?.error;
            }));
            addDisposable(input.onDidAccept(() => {
                const r = this.parseAddress(input.value ?? '', true);
                if ('error' in r) {
                    input.validationMessage = r.error;
                }
                else {
                    resolve(r);
                }
                input.dispose();
            }));
            addDisposable(input.onDidHide(() => {
                resolve(undefined);
                disposables.dispose();
            }));
            input.ignoreFocusOut = true;
            input.show();
        });
    }
    parseAddress(range, isFinal) {
        const parts = /^(\S+)\s*(?:([+-])\s*(\S+))?/.exec(range);
        if (!parts) {
            return { error: core_1.nls.localizeByDefault('Address should be a range of numbers the form "[Start] - [End]" or "[Start] + [Bytes]"') };
        }
        const isNum = (e) => isFinal ? /^0x[0-9a-f]*|[0-9]*$/i.test(e) : /^0x[0-9a-f]+|[0-9]+$/i.test(e);
        const [, startStr, sign = '+', endStr = '1'] = parts;
        for (const n of [startStr, endStr]) {
            if (!isNum(n)) {
                return { error: core_1.nls.localizeByDefault('Number must be a decimal integer or hex value starting with \"0x\", got {0}', n) };
            }
        }
        if (!isFinal) {
            return;
        }
        const start = BigInt(startStr);
        const end = BigInt(endStr);
        const address = `0x${start.toString(16)}`;
        if (sign === '-') {
            return { address, bytes: Number(start - end) };
        }
        return { address, bytes: Number(end) };
    }
};
exports.AddOrEditDataBreakpointAddress = AddOrEditDataBreakpointAddress;
tslib_1.__decorate([
    (0, inversify_1.inject)(debug_view_model_1.DebugViewModel),
    tslib_1.__metadata("design:type", debug_view_model_1.DebugViewModel)
], AddOrEditDataBreakpointAddress.prototype, "viewModel", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.QuickInputService),
    tslib_1.__metadata("design:type", Object)
], AddOrEditDataBreakpointAddress.prototype, "quickInputService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.MessageService),
    tslib_1.__metadata("design:type", core_1.MessageService)
], AddOrEditDataBreakpointAddress.prototype, "messageService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(breakpoint_manager_1.BreakpointManager),
    tslib_1.__metadata("design:type", breakpoint_manager_1.BreakpointManager)
], AddOrEditDataBreakpointAddress.prototype, "breakpointManager", void 0);
exports.AddOrEditDataBreakpointAddress = AddOrEditDataBreakpointAddress = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], AddOrEditDataBreakpointAddress);
//# sourceMappingURL=debug-data-breakpoint-actions.js.map