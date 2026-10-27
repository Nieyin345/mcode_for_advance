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
exports.MergeEditorContribution = exports.MergeEditorCommands = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("@theia/core/shared/inversify");
const core_1 = require("@theia/core");
const browser_1 = require("@theia/core/lib/browser");
const color_1 = require("@theia/core/lib/common/color");
const scm_colors_1 = require("../scm-colors");
const merge_editor_1 = require("./merge-editor");
var MergeEditorCommands;
(function (MergeEditorCommands) {
    MergeEditorCommands.MERGE_EDITOR_CATEGORY = 'Merge Editor';
    MergeEditorCommands.ACCEPT_MERGE = core_1.Command.toDefaultLocalizedCommand({
        id: 'mergeEditor.acceptMerge', // don't change: this is an API command
        label: 'Complete Merge',
        category: MergeEditorCommands.MERGE_EDITOR_CATEGORY
    });
    MergeEditorCommands.GO_TO_NEXT_UNHANDLED_CONFLICT = core_1.Command.toDefaultLocalizedCommand({
        id: 'mergeEditor.goToNextUnhandledConflict',
        label: 'Go to Next Unhandled Conflict',
        category: MergeEditorCommands.MERGE_EDITOR_CATEGORY
    });
    MergeEditorCommands.GO_TO_PREVIOUS_UNHANDLED_CONFLICT = core_1.Command.toDefaultLocalizedCommand({
        id: 'mergeEditor.goToPreviousUnhandledConflict',
        label: 'Go to Previous Unhandled Conflict',
        category: MergeEditorCommands.MERGE_EDITOR_CATEGORY
    });
    MergeEditorCommands.SET_MIXED_LAYOUT = core_1.Command.toDefaultLocalizedCommand({
        id: 'mergeEditor.setMixedLayout',
        label: 'Mixed Layout',
        category: MergeEditorCommands.MERGE_EDITOR_CATEGORY
    });
    MergeEditorCommands.SET_COLUMN_LAYOUT = core_1.Command.toDefaultLocalizedCommand({
        id: 'mergeEditor.setColumnLayout',
        label: 'Column Layout',
        category: MergeEditorCommands.MERGE_EDITOR_CATEGORY
    });
    MergeEditorCommands.SHOW_BASE = core_1.Command.toDefaultLocalizedCommand({
        id: 'mergeEditor.showBase',
        label: 'Show Base',
        category: MergeEditorCommands.MERGE_EDITOR_CATEGORY
    });
    MergeEditorCommands.SHOW_BASE_TOP = core_1.Command.toDefaultLocalizedCommand({
        id: 'mergeEditor.showBaseTop',
        label: 'Show Base Top',
        category: MergeEditorCommands.MERGE_EDITOR_CATEGORY
    });
    MergeEditorCommands.SHOW_BASE_CENTER = core_1.Command.toDefaultLocalizedCommand({
        id: 'mergeEditor.showBaseCenter',
        label: 'Show Base Center',
        category: MergeEditorCommands.MERGE_EDITOR_CATEGORY
    });
})(MergeEditorCommands || (exports.MergeEditorCommands = MergeEditorCommands = {}));
let MergeEditorContribution = class MergeEditorContribution {
    onStart() {
        this.settings.load();
    }
    onStop() {
        this.settings.save();
    }
    getMergeEditor(widget = this.shell.currentWidget) {
        return widget instanceof merge_editor_1.MergeEditor ? widget : (widget?.parent ? this.getMergeEditor(widget.parent) : undefined);
    }
    registerCommands(commands) {
        commands.registerCommand(MergeEditorCommands.ACCEPT_MERGE, {
            execute: async (widget) => {
                const editor = this.getMergeEditor(widget);
                if (editor) {
                    let canceled = false;
                    if (editor.model.unhandledMergeRangesCount > 0) {
                        canceled = !(await new browser_1.ConfirmDialog({
                            title: core_1.nls.localizeByDefault('Do you want to complete the merge of {0}?', this.labelProvider.getName(editor.resultUri)),
                            msg: core_1.nls.localizeByDefault('The file contains unhandled conflicts.'),
                            ok: core_1.nls.localizeByDefault('Complete with Conflicts')
                        }).open());
                    }
                    if (!canceled) {
                        await editor.model.resultDocument.save();
                        editor.close();
                        return {
                            successful: true
                        };
                    }
                }
                return {
                    successful: false
                };
            },
            isEnabled: widget => !!this.getMergeEditor(widget),
            isVisible: widget => !!this.getMergeEditor(widget)
        });
        commands.registerCommand(MergeEditorCommands.GO_TO_NEXT_UNHANDLED_CONFLICT, {
            execute: widget => {
                const editor = this.getMergeEditor(widget);
                if (editor) {
                    editor.goToNextMergeRange(mergeRange => !editor.model.isMergeRangeHandled(mergeRange));
                    editor.activate();
                }
            },
            isEnabled: widget => !!this.getMergeEditor(widget),
            isVisible: widget => !!this.getMergeEditor(widget)
        });
        commands.registerCommand(MergeEditorCommands.GO_TO_PREVIOUS_UNHANDLED_CONFLICT, {
            execute: widget => {
                const editor = this.getMergeEditor(widget);
                if (editor) {
                    editor.goToPreviousMergeRange(mergeRange => !editor.model.isMergeRangeHandled(mergeRange));
                    editor.activate();
                }
            },
            isEnabled: widget => !!this.getMergeEditor(widget),
            isVisible: widget => !!this.getMergeEditor(widget)
        });
        commands.registerCommand(MergeEditorCommands.SET_MIXED_LAYOUT, {
            execute: widget => {
                const editor = this.getMergeEditor(widget);
                if (editor) {
                    editor.layoutKind = 'mixed';
                    editor.activate();
                }
            },
            isEnabled: widget => !!this.getMergeEditor(widget),
            isVisible: widget => !!this.getMergeEditor(widget),
            isToggled: widget => this.getMergeEditor(widget)?.layoutKind === 'mixed',
        });
        commands.registerCommand(MergeEditorCommands.SET_COLUMN_LAYOUT, {
            execute: widget => {
                const editor = this.getMergeEditor(widget);
                if (editor) {
                    editor.layoutKind = 'columns';
                    editor.activate();
                }
            },
            isEnabled: widget => !!this.getMergeEditor(widget),
            isVisible: widget => !!this.getMergeEditor(widget),
            isToggled: widget => this.getMergeEditor(widget)?.layoutKind === 'columns'
        });
        commands.registerCommand(MergeEditorCommands.SHOW_BASE, {
            execute: widget => {
                const editor = this.getMergeEditor(widget);
                if (editor) {
                    editor.toggleShowBase();
                    editor.activate();
                }
            },
            isEnabled: widget => this.getMergeEditor(widget)?.layoutKind === 'columns',
            isVisible: widget => this.getMergeEditor(widget)?.layoutKind === 'columns',
            isToggled: widget => !!this.getMergeEditor(widget)?.isShowingBase
        });
        commands.registerCommand(MergeEditorCommands.SHOW_BASE_TOP, {
            execute: widget => {
                const editor = this.getMergeEditor(widget);
                if (editor) {
                    editor.toggleShowBaseTop();
                    editor.activate();
                }
            },
            isEnabled: widget => this.getMergeEditor(widget)?.layoutKind === 'mixed',
            isVisible: widget => this.getMergeEditor(widget)?.layoutKind === 'mixed',
            isToggled: widget => !!this.getMergeEditor(widget)?.isShowingBaseAtTop
        });
        commands.registerCommand(MergeEditorCommands.SHOW_BASE_CENTER, {
            execute: widget => {
                const editor = this.getMergeEditor(widget);
                if (editor) {
                    editor.toggleShowBaseCenter();
                    editor.activate();
                }
            },
            isEnabled: widget => this.getMergeEditor(widget)?.layoutKind === 'mixed',
            isVisible: widget => this.getMergeEditor(widget)?.layoutKind === 'mixed',
            isToggled: widget => {
                const editor = this.getMergeEditor(widget);
                return !!(editor?.isShowingBase && !editor.isShowingBaseAtTop);
            }
        });
    }
    registerMenus(menus) {
    }
    registerToolbarItems(registry) {
        registry.registerItem({
            id: MergeEditorCommands.GO_TO_NEXT_UNHANDLED_CONFLICT.id,
            command: MergeEditorCommands.GO_TO_NEXT_UNHANDLED_CONFLICT.id,
            icon: (0, browser_1.codicon)('arrow-down', true),
            group: 'navigation',
            order: 'a'
        });
        registry.registerItem({
            id: MergeEditorCommands.GO_TO_PREVIOUS_UNHANDLED_CONFLICT.id,
            command: MergeEditorCommands.GO_TO_PREVIOUS_UNHANDLED_CONFLICT.id,
            icon: (0, browser_1.codicon)('arrow-up', true),
            group: 'navigation',
            order: 'b'
        });
        registry.registerItem({
            id: MergeEditorCommands.SET_MIXED_LAYOUT.id,
            command: MergeEditorCommands.SET_MIXED_LAYOUT.id,
            group: '1_merge',
            order: 'a'
        });
        registry.registerItem({
            id: MergeEditorCommands.SET_COLUMN_LAYOUT.id,
            command: MergeEditorCommands.SET_COLUMN_LAYOUT.id,
            group: '1_merge',
            order: 'b'
        });
        registry.registerItem({
            id: MergeEditorCommands.SHOW_BASE.id,
            command: MergeEditorCommands.SHOW_BASE.id,
            group: '2_merge',
            order: 'a'
        });
        registry.registerItem({
            id: MergeEditorCommands.SHOW_BASE_TOP.id,
            command: MergeEditorCommands.SHOW_BASE_TOP.id,
            group: '2_merge',
            order: 'b'
        });
        registry.registerItem({
            id: MergeEditorCommands.SHOW_BASE_CENTER.id,
            command: MergeEditorCommands.SHOW_BASE_CENTER.id,
            group: '2_merge',
            order: 'c'
        });
    }
    registerKeybindings(keybindings) {
    }
    /**
     * It should be aligned with https://code.visualstudio.com/api/references/theme-color#merge-conflicts-colors
     */
    registerColors(colors) {
        colors.register({
            id: 'mergeEditor.change.background',
            description: 'The background color for changes.',
            defaults: { dark: '#9bb95533', light: '#9bb95533', hcDark: '#9bb95533', hcLight: '#9bb95533' }
        }, {
            id: 'mergeEditor.change.word.background',
            description: 'The background color for word changes.',
            defaults: { dark: '#9ccc2c33', light: '#9ccc2c66', hcDark: '#9ccc2c33', hcLight: '#9ccc2c66' }
        }, {
            id: 'mergeEditor.changeBase.background',
            description: 'The background color for changes in base.',
            defaults: { dark: '#4B1818FF', light: '#FFCCCCFF', hcDark: '#4B1818FF', hcLight: '#FFCCCCFF' }
        }, {
            id: 'mergeEditor.changeBase.word.background',
            description: 'The background color for word changes in base.',
            defaults: { dark: '#6F1313FF', light: '#FFA3A3FF', hcDark: '#6F1313FF', hcLight: '#FFA3A3FF' }
        }, {
            id: 'mergeEditor.conflict.unhandledUnfocused.border',
            description: 'The border color of unhandled unfocused conflicts.',
            defaults: { dark: '#ffa6007a', light: '#ffa600FF', hcDark: '#ffa6007a', hcLight: '#ffa6007a' }
        }, {
            id: 'mergeEditor.conflict.unhandledUnfocused.background',
            description: 'The background color of unhandled unfocused conflicts.',
            defaults: {
                dark: color_1.Color.transparent('mergeEditor.conflict.unhandledUnfocused.border', 0.05),
                light: color_1.Color.transparent('mergeEditor.conflict.unhandledUnfocused.border', 0.05)
            }
        }, {
            id: 'mergeEditor.conflict.unhandledFocused.border',
            description: 'The border color of unhandled focused conflicts.',
            defaults: { dark: '#ffa600', light: '#ffa600', hcDark: '#ffa600', hcLight: '#ffa600' }
        }, {
            id: 'mergeEditor.conflict.unhandledFocused.background',
            description: 'The background color of unhandled focused conflicts.',
            defaults: {
                dark: color_1.Color.transparent('mergeEditor.conflict.unhandledFocused.border', 0.05),
                light: color_1.Color.transparent('mergeEditor.conflict.unhandledFocused.border', 0.05)
            }
        }, {
            id: 'mergeEditor.conflict.handledUnfocused.border',
            description: 'The border color of handled unfocused conflicts.',
            defaults: { dark: '#86868649', light: '#86868649', hcDark: '#86868649', hcLight: '#86868649' }
        }, {
            id: 'mergeEditor.conflict.handledUnfocused.background',
            description: 'The background color of handled unfocused conflicts.',
            defaults: {
                dark: color_1.Color.transparent('mergeEditor.conflict.handledUnfocused.border', 0.1),
                light: color_1.Color.transparent('mergeEditor.conflict.handledUnfocused.border', 0.1)
            }
        }, {
            id: 'mergeEditor.conflict.handledFocused.border',
            description: 'The border color of handled focused conflicts.',
            defaults: { dark: '#c1c1c1cc', light: '#c1c1c1cc', hcDark: '#c1c1c1cc', hcLight: '#c1c1c1cc' }
        }, {
            id: 'mergeEditor.conflict.handledFocused.background',
            description: 'The background color of handled focused conflicts.',
            defaults: {
                dark: color_1.Color.transparent('mergeEditor.conflict.handledFocused.border', 0.1),
                light: color_1.Color.transparent('mergeEditor.conflict.handledFocused.border', 0.1)
            }
        }, {
            id: scm_colors_1.ScmColors.handledConflictMinimapOverviewRulerColor,
            description: 'Minimap gutter and overview ruler marker color for handled conflicts.',
            defaults: { dark: '#adaca8ee', light: '#adaca8ee', hcDark: '#adaca8ee', hcLight: '#adaca8ee' }
        }, {
            id: scm_colors_1.ScmColors.unhandledConflictMinimapOverviewRulerColor,
            description: 'Minimap gutter and overview ruler marker color for unhandled conflicts.',
            defaults: { dark: '#fcba03FF', light: '#fcba03FF', hcDark: '#fcba03FF', hcLight: '#fcba03FF' }
        });
    }
};
exports.MergeEditorContribution = MergeEditorContribution;
tslib_1.__decorate([
    (0, inversify_1.inject)(merge_editor_1.MergeEditorSettings),
    tslib_1.__metadata("design:type", merge_editor_1.MergeEditorSettings)
], MergeEditorContribution.prototype, "settings", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_1.ApplicationShell),
    tslib_1.__metadata("design:type", browser_1.ApplicationShell)
], MergeEditorContribution.prototype, "shell", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_1.LabelProvider),
    tslib_1.__metadata("design:type", browser_1.LabelProvider)
], MergeEditorContribution.prototype, "labelProvider", void 0);
exports.MergeEditorContribution = MergeEditorContribution = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], MergeEditorContribution);
//# sourceMappingURL=merge-editor-contribution.js.map