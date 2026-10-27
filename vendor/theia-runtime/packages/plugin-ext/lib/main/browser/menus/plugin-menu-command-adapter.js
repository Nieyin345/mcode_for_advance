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
exports.PluginMenuCommandAdapter = void 0;
const tslib_1 = require("tslib");
const core_1 = require("@theia/core");
const resource_context_key_1 = require("@theia/core/lib/browser/resource-context-key");
const inversify_1 = require("@theia/core/shared/inversify");
const vscode_uri_1 = require("@theia/core/shared/vscode-uri");
const tree_widget_selection_1 = require("@theia/core/lib/browser/tree/tree-widget-selection");
const scm_repository_1 = require("@theia/scm/lib/browser/scm-repository");
const scm_service_1 = require("@theia/scm/lib/browser/scm-service");
const dirty_diff_widget_1 = require("@theia/scm/lib/browser/dirty-diff/dirty-diff-widget");
const diff_computer_1 = require("@theia/scm/lib/browser/dirty-diff/diff-computer");
const common_1 = require("../../../common");
const test_types_1 = require("../../../common/test-types");
const scm_main_1 = require("../scm-main");
const tree_view_widget_1 = require("../view/tree-view-widget");
const vscode_theia_menu_mappings_1 = require("./vscode-theia-menu-mappings");
const test_service_1 = require("@theia/test/lib/browser/test-service");
function identity(...args) {
    return args;
}
let PluginMenuCommandAdapter = class PluginMenuCommandAdapter {
    constructor() {
        this.argumentAdapters = new Map();
        /* eslint-enable @typescript-eslint/no-explicit-any */
    }
    init() {
        const toCommentArgs = (...args) => this.toCommentArgs(...args);
        const toTestMessageArgs = (...args) => this.toTestMessageArgs(...args);
        const firstArgOnly = (...args) => [args[0]];
        const noArgs = () => [];
        const toScmArgs = (...args) => this.toScmArgs(...args);
        const selectedResource = () => this.getSelectedResources();
        const widgetURI = widget => vscode_theia_menu_mappings_1.CodeEditorWidgetUtil.is(widget) ? [vscode_theia_menu_mappings_1.CodeEditorWidgetUtil.getResourceUri(widget)] : [];
        [
            ['comments/comment/context', toCommentArgs],
            ['comments/comment/title', toCommentArgs],
            ['comments/commentThread/context', toCommentArgs],
            ['debug/callstack/context', firstArgOnly],
            ['debug/variables/context', firstArgOnly],
            ['debug/toolBar', noArgs],
            ['editor/context', selectedResource],
            ['editor/content', widgetURI],
            ['editor/title', widgetURI],
            ['editor/title/context', selectedResource],
            ['editor/title/run', widgetURI],
            ['explorer/context', selectedResource],
            ['scm/resourceFolder/context', toScmArgs],
            ['scm/resourceGroup/context', toScmArgs],
            ['scm/resourceState/context', toScmArgs],
            ['scm/repository', toScmArgs],
            ['scm/history/title', () => [this.toScmArg(this.scmService.selectedRepository)]],
            ['scm/historyItem/context', (...args) => this.toScmHistoryArgs(...args)],
            ['scm/historyItemRef/context', (...args) => this.toScmHistoryArgs(...args)],
            ['scm/title', () => [this.toScmArg(this.scmService.selectedRepository)]],
            ['scm/sourceControl', toScmArgs],
            ['scm/sourceControl/title', () => [this.toScmArg(this.scmService.selectedRepository)]],
            ['testing/message/context', toTestMessageArgs],
            ['testing/profiles/context', noArgs],
            ['scm/change/title', (...args) => this.toScmChangeArgs(...args)],
            ['timeline/item/context', (...args) => this.toTimelineArgs(...args)],
            ['view/item/context', (...args) => this.toTreeArgs(...args)],
            ['view/title', noArgs],
            ['webview/context', firstArgOnly],
            ['extension/context', noArgs],
            ['terminal/context', noArgs],
            ['terminal/title/context', noArgs],
        ].forEach(([contributionPoint, adapter]) => {
            this.argumentAdapters.set(contributionPoint, adapter);
        });
    }
    getArgumentAdapter(menuPath) {
        for (const [contributionPoint, menuPaths] of vscode_theia_menu_mappings_1.codeToTheiaMappings) {
            for (const theiaPath of menuPaths) {
                if (this.isPrefixOf(theiaPath, menuPath)) {
                    return this.argumentAdapters.get(contributionPoint) || identity;
                }
            }
        }
        return identity;
    }
    isPrefixOf(candidate, menuPath) {
        if (candidate.length > menuPath.length) {
            return false;
        }
        for (let i = 0; i < candidate.length; i++) {
            if (candidate[i] !== menuPath[i]) {
                return false;
            }
        }
        return true;
    }
    /* eslint-disable @typescript-eslint/no-explicit-any */
    toCommentArgs(...args) {
        const arg = args[0];
        if ('text' in arg) {
            if ('commentUniqueId' in arg) {
                return [{
                        commentControlHandle: arg.thread.controllerHandle,
                        commentThreadHandle: arg.thread.commentThreadHandle,
                        text: arg.text,
                        commentUniqueId: arg.commentUniqueId
                    }];
            }
            return [{
                    commentControlHandle: arg.thread.controllerHandle,
                    commentThreadHandle: arg.thread.commentThreadHandle,
                    text: arg.text
                }];
        }
        return [{
                commentControlHandle: arg.thread.controllerHandle,
                commentThreadHandle: arg.thread.commentThreadHandle,
                commentUniqueId: arg.commentUniqueId
            }];
    }
    toScmArgs(...args) {
        const scmArgs = [];
        for (const arg of args) {
            const scmArg = this.toScmArg(arg);
            if (scmArg) {
                scmArgs.push(scmArg);
            }
        }
        return scmArgs;
    }
    toScmHistoryArgs(...args) {
        const result = [];
        for (const arg of args) {
            if (common_1.ScmHistoryItemCommandArg.is(arg) || common_1.ScmCommandArg.is(arg)) {
                result.push(arg);
            }
        }
        return result;
    }
    toScmArg(arg) {
        if (arg instanceof scm_repository_1.ScmRepository && arg.provider instanceof scm_main_1.PluginScmProvider) {
            return {
                sourceControlHandle: arg.provider.handle
            };
        }
        if (arg instanceof scm_main_1.PluginScmResourceGroup) {
            return {
                sourceControlHandle: arg.provider.handle,
                resourceGroupHandle: arg.handle
            };
        }
        if (arg instanceof scm_main_1.PluginScmResource) {
            return {
                sourceControlHandle: arg.group.provider.handle,
                resourceGroupHandle: arg.group.handle,
                resourceStateHandle: arg.handle
            };
        }
    }
    toScmChangeArgs(...args) {
        const arg = args[0];
        if (arg instanceof dirty_diff_widget_1.DirtyDiffWidget) {
            const toIChange = (change) => {
                const convert = (range) => {
                    let startLineNumber;
                    let endLineNumber;
                    if (!diff_computer_1.LineRange.isEmpty(range)) {
                        startLineNumber = range.start + 1;
                        endLineNumber = range.end;
                    }
                    else {
                        startLineNumber = range.start;
                        endLineNumber = 0;
                    }
                    return [startLineNumber, endLineNumber];
                };
                const { previousRange, currentRange } = change;
                const [originalStartLineNumber, originalEndLineNumber] = convert(previousRange);
                const [modifiedStartLineNumber, modifiedEndLineNumber] = convert(currentRange);
                return {
                    originalStartLineNumber,
                    originalEndLineNumber,
                    modifiedStartLineNumber,
                    modifiedEndLineNumber
                };
            };
            return [
                arg.uri['codeUri'],
                arg.changes.map(toIChange),
                arg.currentChangeIndex
            ];
        }
        return [];
    }
    toTimelineArgs(...args) {
        const timelineArgs = [];
        const arg = args[0];
        timelineArgs.push(this.toTimelineArg(arg));
        timelineArgs.push(vscode_uri_1.URI.parse(arg.uri));
        timelineArgs.push(arg.source ?? '');
        return timelineArgs;
    }
    toTestMessageArgs(...args) {
        let testItem;
        let testMessage;
        for (const arg of args) {
            if (test_service_1.TestItem.is(arg)) {
                testItem = arg;
            }
            else if (Array.isArray(arg) && test_service_1.TestMessage.is(arg[0])) {
                testMessage = arg[0];
            }
        }
        if (testMessage) {
            const testItemReference = (testItem && testItem.controller) ? test_types_1.TestItemReference.create(testItem.controller.id, testItem.path) : undefined;
            const testMessageDTO = {
                message: testMessage.message,
                actual: testMessage.actual,
                expected: testMessage.expected,
                contextValue: testMessage.contextValue,
                location: testMessage.location,
                stackTrace: testMessage.stackTrace
            };
            return [test_types_1.TestMessageArg.create(testItemReference, testMessageDTO)];
        }
        return [];
    }
    toTimelineArg(arg) {
        return {
            timelineHandle: arg.handle,
            source: arg.source,
            uri: arg.uri
        };
    }
    toTreeArgs(...args) {
        const treeArgs = [];
        for (const arg of args) {
            if (common_1.TreeViewItemReference.is(arg)) {
                treeArgs.push(arg);
            }
            else if (Array.isArray(arg)) {
                treeArgs.push(arg.filter(common_1.TreeViewItemReference.is));
            }
        }
        return treeArgs;
    }
    getSelectedResources() {
        const selection = this.selectionService.selection;
        const resourceKey = this.resourceContextKey.get();
        const resourceUri = resourceKey ? vscode_uri_1.URI.parse(resourceKey) : undefined;
        const firstMember = tree_widget_selection_1.TreeWidgetSelection.is(selection) && selection.source instanceof tree_view_widget_1.TreeViewWidget && selection[0]
            ? selection.source.toTreeViewItemReference(selection[0])
            : core_1.UriSelection.getUri(selection)?.['codeUri'] ?? resourceUri;
        const secondMember = tree_widget_selection_1.TreeWidgetSelection.is(selection)
            ? core_1.UriSelection.getUris(selection).map(uri => uri['codeUri'])
            : undefined;
        return [firstMember, secondMember];
    }
};
exports.PluginMenuCommandAdapter = PluginMenuCommandAdapter;
tslib_1.__decorate([
    (0, inversify_1.inject)(scm_service_1.ScmService),
    tslib_1.__metadata("design:type", scm_service_1.ScmService)
], PluginMenuCommandAdapter.prototype, "scmService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.SelectionService),
    tslib_1.__metadata("design:type", core_1.SelectionService)
], PluginMenuCommandAdapter.prototype, "selectionService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(resource_context_key_1.ResourceContextKey),
    tslib_1.__metadata("design:type", resource_context_key_1.ResourceContextKey)
], PluginMenuCommandAdapter.prototype, "resourceContextKey", void 0);
tslib_1.__decorate([
    (0, inversify_1.postConstruct)(),
    tslib_1.__metadata("design:type", Function),
    tslib_1.__metadata("design:paramtypes", []),
    tslib_1.__metadata("design:returntype", void 0)
], PluginMenuCommandAdapter.prototype, "init", null);
exports.PluginMenuCommandAdapter = PluginMenuCommandAdapter = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], PluginMenuCommandAdapter);
//# sourceMappingURL=plugin-menu-command-adapter.js.map