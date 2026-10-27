"use strict";
// *****************************************************************************
// Copyright (C) 2019 Red Hat, Inc. and others.
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
exports.ScmDecorationsService = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("@theia/core/shared/inversify");
const core_1 = require("@theia/core");
const dirty_diff_decorator_1 = require("../dirty-diff/dirty-diff-decorator");
const diff_computer_1 = require("../dirty-diff/diff-computer");
const content_lines_1 = require("../dirty-diff/content-lines");
const browser_1 = require("@theia/editor/lib/browser");
const scm_service_1 = require("../scm-service");
const throttle = require("@theia/core/shared/lodash.throttle");
let ScmDecorationsService = class ScmDecorationsService {
    constructor(decorator, scmService, editorManager, resourceProvider) {
        this.decorator = decorator;
        this.scmService = scmService;
        this.editorManager = editorManager;
        this.resourceProvider = resourceProvider;
        this.diffComputer = new diff_computer_1.DiffComputer();
        this.onDirtyDiffUpdateEmitter = new core_1.Emitter();
        this.onDirtyDiffUpdate = this.onDirtyDiffUpdateEmitter.event;
        const updateTasks = new Map();
        this.editorManager.onCreated(editorWidget => {
            const { editor } = editorWidget;
            if (!this.supportsDirtyDiff(editor)) {
                return;
            }
            const toDispose = new core_1.DisposableCollection();
            const updateTask = this.createUpdateTask(editor);
            updateTasks.set(editorWidget, updateTask);
            toDispose.push(editor.onDocumentContentChanged(() => updateTask()));
            toDispose.push(editorWidget.onDidChangeVisibility(visible => {
                if (visible) {
                    updateTask();
                }
            }));
            if (editor.onShouldDisplayDirtyDiffChanged) {
                toDispose.push(editor.onShouldDisplayDirtyDiffChanged(shouldDisplayDirtyDiff => {
                    if (shouldDisplayDirtyDiff) {
                        updateTask();
                    }
                    else {
                        const update = { editor, changes: [] };
                        this.decorator.applyDecorations(update);
                        this.onDirtyDiffUpdateEmitter.fire(update);
                    }
                }));
            }
            editorWidget.disposed.connect(() => {
                updateTask.cancel();
                updateTasks.delete(editorWidget);
                toDispose.dispose();
            });
            updateTask();
        });
        const runUpdateTasks = () => {
            for (const updateTask of updateTasks.values()) {
                updateTask();
            }
        };
        this.scmService.onDidAddRepository(({ provider }) => {
            provider.onDidChange(runUpdateTasks);
            provider.onDidChangeResources?.(runUpdateTasks);
        });
        this.scmService.onDidChangeSelectedRepository(runUpdateTasks);
    }
    async applyEditorDecorations(editor) {
        if (!editor.shouldDisplayDirtyDiff()) {
            return;
        }
        const currentRepo = this.scmService.selectedRepository;
        if (currentRepo) {
            try {
                const uri = currentRepo.toUriAtRef(editor.uri, '');
                const previousResource = await this.resourceProvider(uri);
                try {
                    const previousContent = await previousResource.readContents();
                    if (!editor.shouldDisplayDirtyDiff()) { // check again; it might have changed in the meantime, since this is an async method
                        return;
                    }
                    const previousLines = content_lines_1.ContentLines.fromString(previousContent);
                    const currentLines = content_lines_1.ContentLines.fromTextEditorDocument(editor.document);
                    const dirtyDiff = this.diffComputer.computeDirtyDiff(content_lines_1.ContentLines.arrayLike(previousLines), content_lines_1.ContentLines.arrayLike(currentLines));
                    const update = { editor, previousRevisionUri: uri, ...dirtyDiff };
                    this.decorator.applyDecorations(update);
                    this.onDirtyDiffUpdateEmitter.fire(update);
                }
                finally {
                    previousResource.dispose();
                }
            }
            catch (e) {
                // Scm resource may not be found, do nothing.
            }
        }
    }
    supportsDirtyDiff(editor) {
        return editor.shouldDisplayDirtyDiff() || !!editor.onShouldDisplayDirtyDiffChanged;
    }
    createUpdateTask(editor) {
        return throttle(() => this.applyEditorDecorations(editor), 500);
    }
};
exports.ScmDecorationsService = ScmDecorationsService;
exports.ScmDecorationsService = ScmDecorationsService = tslib_1.__decorate([
    (0, inversify_1.injectable)(),
    tslib_1.__param(0, (0, inversify_1.inject)(dirty_diff_decorator_1.DirtyDiffDecorator)),
    tslib_1.__param(1, (0, inversify_1.inject)(scm_service_1.ScmService)),
    tslib_1.__param(2, (0, inversify_1.inject)(browser_1.EditorManager)),
    tslib_1.__param(3, (0, inversify_1.inject)(core_1.ResourceProvider)),
    tslib_1.__metadata("design:paramtypes", [dirty_diff_decorator_1.DirtyDiffDecorator,
        scm_service_1.ScmService,
        browser_1.EditorManager, Function])
], ScmDecorationsService);
//# sourceMappingURL=scm-decorations-service.js.map