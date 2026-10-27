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
exports.MergeEditorFactory = void 0;
exports.bindMergeEditor = bindMergeEditor;
require("../../../src/browser/style/merge-editor.css");
const inversify_1 = require("@theia/core/shared/inversify");
const core_1 = require("@theia/core");
const tab_bar_toolbar_1 = require("@theia/core/lib/browser/shell/tab-bar-toolbar");
const browser_1 = require("@theia/core/lib/browser");
const color_application_contribution_1 = require("@theia/core/lib/browser/color-application-contribution");
const browser_2 = require("@theia/editor/lib/browser");
const monaco_editor_1 = require("@theia/monaco/lib/browser/monaco-editor");
const merge_editor_model_1 = require("./model/merge-editor-model");
const merge_editor_panes_1 = require("./view/merge-editor-panes");
const diff_spacers_1 = require("./view/diff-spacers");
const merge_editor_view_zones_1 = require("./view/merge-editor-view-zones");
const merge_editor_1 = require("./merge-editor");
const merge_editor_contribution_1 = require("./merge-editor-contribution");
const merge_editor_dev_contribution_1 = require("./merge-editor-dev-contribution");
function bindMergeEditor(bind) {
    bind(merge_editor_1.MergeEditorSettings).toSelf().inSingletonScope();
    bind(diff_spacers_1.DiffSpacerService).toSelf().inSingletonScope();
    bind(merge_editor_view_zones_1.MergeEditorViewZoneComputer).toSelf().inSingletonScope();
    bind(MergeEditorFactory).toDynamicValue(ctx => new MergeEditorFactory(ctx.container)).inSingletonScope();
    bind(browser_1.WidgetFactory).toDynamicValue(ctx => ({
        id: merge_editor_1.MergeEditorOpenHandler.ID,
        createWidget: (options) => ctx.container.get(MergeEditorFactory).createMergeEditor(merge_editor_1.MergeEditorUri.decode(new core_1.URI(options.uri)))
    })).inSingletonScope();
    bind(merge_editor_1.MergeEditorOpenHandler).toSelf().inSingletonScope();
    bind(browser_1.OpenHandler).toService(merge_editor_1.MergeEditorOpenHandler);
    bind(merge_editor_contribution_1.MergeEditorContribution).toSelf().inSingletonScope();
    [browser_1.FrontendApplicationContribution, core_1.CommandContribution, core_1.MenuContribution, tab_bar_toolbar_1.TabBarToolbarContribution, browser_1.KeybindingContribution, color_application_contribution_1.ColorContribution].forEach(serviceIdentifier => bind(serviceIdentifier).toService(merge_editor_contribution_1.MergeEditorContribution));
    bind(merge_editor_dev_contribution_1.MergeEditorDevContribution).toSelf().inSingletonScope();
    bind(core_1.CommandContribution).toService(merge_editor_dev_contribution_1.MergeEditorDevContribution);
}
class MergeEditorFactory {
    constructor(container, editorManager = container.get(browser_2.EditorManager)) {
        this.container = container;
        this.editorManager = editorManager;
    }
    async createMergeEditor({ baseUri, side1Uri, side2Uri, resultUri }) {
        const toDisposeOnError = new core_1.DisposableCollection();
        const createEditorWidget = (uri) => this.createEditorWidget(uri, toDisposeOnError);
        try {
            const [baseEditorWidget, side1EditorWidget, side2EditorWidget, resultEditorWidget] = await Promise.all([
                createEditorWidget(baseUri).catch(e => {
                    console.warn('Base URI resolution failed, using empty fallback:', e);
                    return this.createEmptyFallbackEditorWidget(baseUri, toDisposeOnError);
                }),
                createEditorWidget(side1Uri),
                createEditorWidget(side2Uri),
                createEditorWidget(resultUri)
            ]);
            resultEditorWidget.navigationHistorySupport = true;
            const resultDocument = monaco_editor_1.MonacoEditor.get(resultEditorWidget).document;
            const hasConflictMarkers = resultDocument.textEditorModel.getLinesContent().some(lineContent => lineContent.startsWith('<<<<<<<'));
            return this.createMergeEditorContainer({
                baseEditorWidget,
                side1EditorWidget,
                side2EditorWidget,
                resultEditorWidget,
                options: {
                    resetResult: hasConflictMarkers
                }
            }).get(merge_editor_1.MergeEditor);
        }
        catch (error) {
            toDisposeOnError.dispose();
            throw error;
        }
    }
    /**
     * Creates an editor widget backed by an empty in-memory resource.
     * Used as a fallback when the base URI cannot be resolved, e.g. in BOTH_ADDED
     * merge conflicts where there is no common ancestor (git index stage 1).
     */
    async createEmptyFallbackEditorWidget(originalUri, disposables) {
        const fallbackUri = new core_1.URI().withScheme(core_1.MEMORY_TEXT_READONLY).withPath(`${(0, core_1.generateUuid)()}/${originalUri.path.base}`);
        return this.createEditorWidget(fallbackUri, disposables);
    }
    async createEditorWidget(uri, disposables) {
        const editorWidget = await this.editorManager.createByUri(uri);
        disposables.push(editorWidget);
        const editor = monaco_editor_1.MonacoEditor.get(editorWidget);
        if (!editor) {
            throw new Error('The merge editor only supports Monaco editors as its parts');
        }
        const options = { glyphMargin: false, folding: false, codeLens: false, stickyScroll: { enabled: false }, minimap: { enabled: false } };
        editor.getControl().updateOptions(options);
        editor.getControl().onDidChangeConfiguration(() => editor.getControl().updateOptions(options));
        editor.setShouldDisplayDirtyDiff(false);
        editorWidget.navigationHistorySupport = false;
        return editorWidget;
    }
    createMergeEditorContainer({ baseEditorWidget, side1EditorWidget, side2EditorWidget, resultEditorWidget, options }) {
        const child = new inversify_1.Container({ defaultScope: 'Singleton' });
        child.parent = this.container;
        const [baseEditor, side1Editor, side2Editor, resultEditor] = [baseEditorWidget, side1EditorWidget, side2EditorWidget, resultEditorWidget].map(editorWidget => monaco_editor_1.MonacoEditor.get(editorWidget));
        child.bind(merge_editor_model_1.MergeEditorModelProps).toConstantValue({ baseEditor, side1Editor, side2Editor, resultEditor, options });
        child.bind(merge_editor_model_1.MergeEditorModel).toSelf();
        child.bind(merge_editor_panes_1.MergeEditorPaneHeader).toSelf().inTransientScope();
        child.bind(merge_editor_panes_1.MergeEditorBasePane).toSelf();
        child.bind(merge_editor_panes_1.MergeEditorSide1Pane).toSelf();
        child.bind(merge_editor_panes_1.MergeEditorSide2Pane).toSelf();
        child.bind(merge_editor_panes_1.MergeEditorResultPane).toSelf();
        child.bind(browser_2.EditorWidget).toConstantValue(baseEditorWidget).whenInjectedInto(merge_editor_panes_1.MergeEditorBasePane);
        child.bind(browser_2.EditorWidget).toConstantValue(side1EditorWidget).whenInjectedInto(merge_editor_panes_1.MergeEditorSide1Pane);
        child.bind(browser_2.EditorWidget).toConstantValue(side2EditorWidget).whenInjectedInto(merge_editor_panes_1.MergeEditorSide2Pane);
        child.bind(browser_2.EditorWidget).toConstantValue(resultEditorWidget).whenInjectedInto(merge_editor_panes_1.MergeEditorResultPane);
        child.bind(merge_editor_1.MergeEditor).toSelf();
        return child;
    }
}
exports.MergeEditorFactory = MergeEditorFactory;
//# sourceMappingURL=merge-editor-module.js.map