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
var NotebookEditorWidgetFactory_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.NotebookEditorWidgetFactory = void 0;
const tslib_1 = require("tslib");
const core_1 = require("@theia/core");
const browser_1 = require("@theia/core/lib/browser");
const inversify_1 = require("@theia/core/shared/inversify");
const notebook_editor_widget_1 = require("./notebook-editor-widget");
const notebook_service_1 = require("./service/notebook-service");
const notebook_model_resolver_service_1 = require("./service/notebook-model-resolver-service");
const promise_util_1 = require("@theia/core/lib/common/promise-util");
let NotebookEditorWidgetFactory = NotebookEditorWidgetFactory_1 = class NotebookEditorWidgetFactory {
    constructor() {
        this.id = notebook_editor_widget_1.NotebookEditorWidget.ID;
    }
    static createID(uri, counter) {
        return notebook_editor_widget_1.NOTEBOOK_EDITOR_ID_PREFIX
            + uri.toString()
            + (counter !== undefined ? `:${counter}` : '');
    }
    async createWidget(options) {
        if (!options) {
            throw new Error('no options found for widget. Need at least uri and notebookType');
        }
        const uri = new core_1.URI(options.uri);
        await this.notebookService.willOpenNotebook(options.notebookType);
        const editor = await this.createEditor(uri, options.notebookType);
        // Set the widget ID with counter to support multiple instances
        editor.id = NotebookEditorWidgetFactory_1.createID(uri, options.counter);
        this.setLabels(editor, uri);
        const labelListener = this.labelProvider.onDidChange(event => {
            if (event.affects(uri)) {
                this.setLabels(editor, uri);
            }
        });
        editor.onDidDispose(() => labelListener.dispose());
        return editor;
    }
    async createEditor(uri, notebookType) {
        const notebookData = new promise_util_1.Deferred();
        const resolverError = new promise_util_1.Deferred();
        this.notebookModelResolver.resolve(uri, notebookType).then(model => {
            notebookData.resolve(model);
        }).catch((reason) => {
            resolverError.resolve(reason.message);
        });
        return this.createNotebookEditorWidget({
            uri,
            notebookType,
            notebookData: notebookData.promise,
            error: resolverError.promise
        });
    }
    setLabels(editor, uri) {
        editor.title.caption = uri.path.fsPath();
        if (editor.model?.readOnly) {
            editor.title.caption += ` • ${core_1.nls.localizeByDefault('Read-only')}`;
        }
        const icon = this.labelProvider.getIcon(uri);
        editor.title.label = this.labelProvider.getName(uri);
        editor.title.iconClass = icon + ' file-icon';
    }
};
exports.NotebookEditorWidgetFactory = NotebookEditorWidgetFactory;
tslib_1.__decorate([
    (0, inversify_1.inject)(notebook_service_1.NotebookService),
    tslib_1.__metadata("design:type", notebook_service_1.NotebookService)
], NotebookEditorWidgetFactory.prototype, "notebookService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(notebook_model_resolver_service_1.NotebookModelResolverService),
    tslib_1.__metadata("design:type", notebook_model_resolver_service_1.NotebookModelResolverService)
], NotebookEditorWidgetFactory.prototype, "notebookModelResolver", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_1.LabelProvider),
    tslib_1.__metadata("design:type", browser_1.LabelProvider)
], NotebookEditorWidgetFactory.prototype, "labelProvider", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(notebook_editor_widget_1.NotebookEditorWidgetContainerFactory),
    tslib_1.__metadata("design:type", Function)
], NotebookEditorWidgetFactory.prototype, "createNotebookEditorWidget", void 0);
exports.NotebookEditorWidgetFactory = NotebookEditorWidgetFactory = NotebookEditorWidgetFactory_1 = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], NotebookEditorWidgetFactory);
//# sourceMappingURL=notebook-editor-widget-factory.js.map