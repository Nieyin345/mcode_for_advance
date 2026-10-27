"use strict";
// *****************************************************************************
// Copyright (C) 2018 TypeFox and others.
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
var MonacoEditorProvider_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.MonacoEditorProvider = exports.SAVE_PARTICIPANT_DEFAULT_ORDER = exports.SaveParticipant = exports.MonacoEditorFactory = void 0;
const tslib_1 = require("tslib");
/* eslint-disable @typescript-eslint/no-explicit-any */
const uri_1 = require("@theia/core/lib/common/uri");
const diff_uris_1 = require("@theia/core/lib/browser/diff-uris");
const inversify_1 = require("@theia/core/shared/inversify");
const common_1 = require("@theia/core/lib/common");
const monaco_diff_editor_1 = require("./monaco-diff-editor");
const monaco_diff_navigator_factory_1 = require("./monaco-diff-navigator-factory");
const monaco_editor_1 = require("./monaco-editor");
const monaco_editor_model_1 = require("./monaco-editor-model");
const monaco_workspace_1 = require("./monaco-workspace");
const core_1 = require("@theia/core");
const browser_1 = require("@theia/core/lib/browser");
const monaco_resolved_keybinding_1 = require("./monaco-resolved-keybinding");
const monaco_to_protocol_converter_1 = require("./monaco-to-protocol-converter");
const protocol_to_monaco_converter_1 = require("./protocol-to-monaco-converter");
const monaco = require("@theia/monaco-editor-core");
const standaloneServices_1 = require("@theia/monaco-editor-core/esm/vs/editor/standalone/browser/standaloneServices");
const opener_1 = require("@theia/monaco-editor-core/esm/vs/platform/opener/common/opener");
const keybinding_1 = require("@theia/monaco-editor-core/esm/vs/platform/keybinding/common/keybinding");
const contextView_1 = require("@theia/monaco-editor-core/esm/vs/platform/contextview/browser/contextView");
const event_1 = require("@theia/monaco-editor-core/esm/vs/base/common/event");
const keybindings_1 = require("@theia/monaco-editor-core/esm/vs/base/common/keybindings");
const contextkey_1 = require("@theia/monaco-editor-core/esm/vs/platform/contextkey/common/contextkey");
const resolverService_1 = require("@theia/monaco-editor-core/esm/vs/editor/common/services/resolverService");
const markdown_rendering_1 = require("@theia/core/lib/common/markdown-rendering");
const simple_monaco_editor_1 = require("./simple-monaco-editor");
const promise_util_1 = require("@theia/core/lib/common/promise-util");
const common_2 = require("@theia/filesystem/lib/common");
const monaco_utilities_1 = require("./monaco-utilities");
const editor_preferences_1 = require("@theia/editor/lib/common/editor-preferences");
exports.MonacoEditorFactory = Symbol('MonacoEditorFactory');
exports.SaveParticipant = Symbol('SaveParticipant');
exports.SAVE_PARTICIPANT_DEFAULT_ORDER = 0;
let MonacoEditorProvider = class MonacoEditorProvider {
    static { MonacoEditorProvider_1 = this; }
    /**
     * Returns the last focused MonacoEditor.
     * It takes into account inline editors as well.
     * If you are interested only in standalone editors then use `MonacoEditor.getCurrent(EditorManager)`
     */
    get current() {
        return this._current;
    }
    constructor(m2p, p2m, workspace, editorPreferences, diffNavigatorFactory) {
        this.m2p = m2p;
        this.p2m = p2m;
        this.workspace = workspace;
        this.editorPreferences = editorPreferences;
        this.diffNavigatorFactory = diffNavigatorFactory;
    }
    async getModel(uri, toDispose) {
        const reference = await standaloneServices_1.StandaloneServices.get(resolverService_1.ITextModelService).createModelReference(monaco.Uri.from(uri.toComponents()));
        // if document is invalid makes sure that all events from underlying resource are processed before throwing invalid model
        if (!reference.object.valid) {
            await reference.object.sync();
        }
        if (!reference.object.valid) {
            reference.dispose();
            throw Object.assign(new Error(`'${uri.toString()}' is invalid`), { code: 'MODEL_IS_INVALID' });
        }
        toDispose.push(reference);
        return reference.object;
    }
    async get(uri) {
        await this.editorPreferences.ready;
        return this.doCreateEditor(uri, (override, toDispose) => this.createEditor(uri, override, toDispose));
    }
    async doCreateEditor(uri, factory) {
        const domNode = document.createElement('div');
        const contextKeyService = standaloneServices_1.StandaloneServices.get(contextkey_1.IContextKeyService).createScoped(domNode);
        standaloneServices_1.StandaloneServices.get(opener_1.IOpenerService).registerOpener({
            open: (u, options) => this.interceptOpen(u, options)
        });
        const overrides = [
            [contextkey_1.IContextKeyService, contextKeyService],
        ];
        const toDispose = new common_1.DisposableCollection();
        const editor = await factory(overrides, toDispose);
        editor.onDispose(() => toDispose.dispose());
        if (editor instanceof monaco_editor_1.MonacoEditor) {
            this.injectKeybindingResolver(editor);
            toDispose.push(editor.onFocusChanged(focused => {
                if (focused) {
                    this._current = editor;
                }
            }));
            toDispose.push(common_1.Disposable.create(() => {
                if (this._current === editor) {
                    this._current = undefined;
                }
            }));
        }
        return editor;
    }
    /**
     * Intercept internal Monaco open calls and delegate to OpenerService.
     */
    async interceptOpen(monacoUri, monacoOptions) {
        let options = undefined;
        if (monacoOptions) {
            if ('openToSide' in monacoOptions && monacoOptions.openToSide) {
                options = Object.assign(options || {}, {
                    widgetOptions: {
                        mode: 'split-right'
                    }
                });
            }
            if ('openExternal' in monacoOptions && monacoOptions.openExternal) {
                options = Object.assign(options || {}, {
                    openExternal: true
                });
            }
        }
        const uri = new uri_1.default(monacoUri.toString());
        try {
            await (0, browser_1.open)(this.openerService, uri, options);
            return true;
        }
        catch (e) {
            this.logger.error(`Fail to open '${uri.toString()}':`, e);
            return false;
        }
    }
    injectKeybindingResolver(editor) {
        const keybindingService = standaloneServices_1.StandaloneServices.get(keybinding_1.IKeybindingService);
        keybindingService.resolveKeybinding = keybinding => [new monaco_resolved_keybinding_1.MonacoResolvedKeybinding(monaco_resolved_keybinding_1.MonacoResolvedKeybinding.keySequence(keybinding.chords), this.keybindingRegistry)];
        keybindingService.resolveKeyboardEvent = keyboardEvent => {
            const keybinding = new keybindings_1.KeyCodeChord(keyboardEvent.ctrlKey, keyboardEvent.shiftKey, keyboardEvent.altKey, keyboardEvent.metaKey, keyboardEvent.keyCode);
            return new monaco_resolved_keybinding_1.MonacoResolvedKeybinding(monaco_resolved_keybinding_1.MonacoResolvedKeybinding.keySequence([keybinding]), this.keybindingRegistry);
        };
    }
    createEditor(uri, override, toDispose) {
        if (diff_uris_1.DiffUris.isDiffUri(uri)) {
            return this.createMonacoDiffEditor(uri, override, toDispose);
        }
        return this.createMonacoEditor(uri, override, toDispose);
    }
    get preferencePrefixes() {
        return ['editor.'];
    }
    async createMonacoEditor(uri, override, toDispose) {
        const model = await this.getModel(uri, toDispose);
        const options = this.createMonacoEditorOptions(model);
        const factory = this.factories.getContributions().find(({ scheme }) => uri.scheme === scheme);
        const editor = factory
            ? await factory.create(model, options, override)
            : await monaco_editor_1.MonacoEditor.create(uri, model, document.createElement('div'), this.services, options, override);
        toDispose.push(this.editorPreferences.onPreferenceChanged(event => {
            if (event.affects(uri.toString(), model.languageId)) {
                this.updateMonacoEditorOptions(editor, event);
            }
        }));
        toDispose.push(editor.onLanguageChanged(() => this.updateMonacoEditorOptions(editor)));
        toDispose.push(editor.onDidChangeReadOnly(() => this.updateReadOnlyMessage(options, model.readOnly)));
        toDispose.push(editor.document.onModelWillSaveModel(e => this.runSaveParticipants(editor, e.token, e.options)));
        return editor;
    }
    updateReadOnlyMessage(options, readOnly) {
        options.readOnlyMessage = markdown_rendering_1.MarkdownString.is(readOnly) ? readOnly : undefined;
    }
    createMonacoEditorOptions(model) {
        const options = this.createOptions(this.preferencePrefixes, model.uri, model.languageId);
        // eslint-disable-next-line no-null/no-null
        options.model = null; // explicitly set to null to avoid creating an initial model automatically
        options.readOnly = model.readOnly;
        this.updateReadOnlyMessage(options, model.readOnly);
        options.lineNumbersMinChars = model.lineNumbersMinChars;
        return options;
    }
    updateMonacoEditorOptions(editor, event) {
        if (event) {
            const preferenceName = event.preferenceName;
            const overrideIdentifier = editor.document.languageId;
            const newValue = this.editorPreferences.get({ preferenceName, overrideIdentifier }, undefined, editor.uri.toString());
            editor.getControl().updateOptions(this.setOption(preferenceName, newValue, this.preferencePrefixes));
        }
        else {
            const options = this.createMonacoEditorOptions(editor.document);
            delete options.model;
            editor.getControl().updateOptions(options);
        }
    }
    get diffPreferencePrefixes() {
        return [...this.preferencePrefixes, 'diffEditor.'];
    }
    async createMonacoDiffEditor(uri, override, toDispose) {
        const [original, modified] = diff_uris_1.DiffUris.decode(uri);
        const [originalModel, modifiedModel] = await Promise.all([this.getModel(original, toDispose), this.getModel(modified, toDispose)]);
        const options = this.createMonacoDiffEditorOptions(originalModel, modifiedModel);
        const editor = new monaco_diff_editor_1.MonacoDiffEditor(uri, document.createElement('div'), originalModel, modifiedModel, this.services, this.diffNavigatorFactory, options, override);
        toDispose.push(this.editorPreferences.onPreferenceChanged(event => {
            const originalFileUri = original.withoutQuery().withScheme('file').toString();
            if (event.affects(originalFileUri, editor.document.languageId)) {
                this.updateMonacoDiffEditorOptions(editor, event, originalFileUri);
            }
        }));
        toDispose.push(editor.onLanguageChanged(() => this.updateMonacoDiffEditorOptions(editor)));
        return editor;
    }
    createMonacoDiffEditorOptions(original, modified) {
        const options = this.createOptions(this.diffPreferencePrefixes, modified.uri, modified.languageId);
        options.originalEditable = !original.readOnly;
        options.readOnly = modified.readOnly;
        options.readOnlyMessage = markdown_rendering_1.MarkdownString.is(modified.readOnly) ? modified.readOnly : undefined;
        return options;
    }
    updateMonacoDiffEditorOptions(editor, event, resourceUri) {
        if (event) {
            const preferenceName = event.preferenceName;
            const overrideIdentifier = editor.document.languageId;
            const newValue = this.editorPreferences.get({ preferenceName, overrideIdentifier }, undefined, resourceUri);
            editor.diffEditor.updateOptions(this.setOption(preferenceName, newValue, this.diffPreferencePrefixes));
        }
        else {
            const options = this.createMonacoDiffEditorOptions(editor.originalModel, editor.modifiedModel);
            editor.diffEditor.updateOptions(options);
        }
    }
    createOptions(prefixes, uri, overrideIdentifier) {
        const flat = {};
        for (const preferenceName of Object.keys(this.editorPreferences)) {
            flat[preferenceName] = this.editorPreferences.get({ preferenceName, overrideIdentifier }, undefined, uri);
        }
        return Object.entries(flat).reduce((tree, [preferenceName, value]) => this.setOption(preferenceName, (0, common_1.deepClone)(value), prefixes, tree), {});
    }
    setOption(preferenceName, value, prefixes, options = {}) {
        const optionName = this.toOptionName(preferenceName, prefixes);
        this.doSetOption(options, value, optionName.split('.'));
        return options;
    }
    toOptionName(preferenceName, prefixes) {
        for (const prefix of prefixes) {
            if (preferenceName.startsWith(prefix)) {
                return preferenceName.substring(prefix.length);
            }
        }
        return preferenceName;
    }
    doSetOption(obj, value, names) {
        for (let i = 0; i < names.length - 1; i++) {
            const name = names[i];
            if (obj[name] === undefined) {
                obj = obj[name] = {};
            }
            else if (typeof obj[name] !== 'object' || obj[name] === null) { // eslint-disable-line no-null/no-null
                this.logger.warn(`Preference (diff)editor.${names.join('.')} conflicts with another preference name.`);
                obj = obj[name] = {};
            }
            else {
                obj = obj[name];
            }
        }
        obj[names[names.length - 1]] = value;
    }
    getDiffNavigator(editor) {
        if (editor instanceof monaco_diff_editor_1.MonacoDiffEditor) {
            return editor.diffNavigator;
        }
        return monaco_diff_navigator_factory_1.MonacoDiffNavigatorFactory.nullNavigator;
    }
    /**
     * Creates an instance of the standard MonacoEditor with a StandaloneCodeEditor as its Monaco delegate.
     * Among other differences, these editors execute basic actions like typing or deletion via commands that may be overridden by extensions.
     * @deprecated Most use cases for inline editors should be served by `createSimpleInline` instead.
     */
    async createInline(uri, node, options) {
        return this.doCreateEditor(uri, async (override, toDispose) => {
            const overrides = override ? Array.from(override) : [];
            overrides.push([contextView_1.IContextMenuService, { showContextMenu: () => { }, onDidShowContextMenu: event_1.Event.None, onDidHideContextMenu: event_1.Event.None }]);
            const document = await this.getModel(uri, toDispose);
            document.suppressOpenEditorWhenDirty = true;
            const model = (await document.load()).textEditorModel;
            return await monaco_editor_1.MonacoEditor.create(uri, document, node, this.services, Object.assign({
                model,
                autoSizing: false,
                minHeight: 1,
                maxHeight: 1
            }, MonacoEditorProvider_1.inlineOptions, options), overrides);
        });
    }
    /**
     * Creates an instance of the standard MonacoEditor with a CodeEditorWidget as its Monaco delegate.
     * In addition to the service customizability of the StandaloneCodeEditor,This editor allows greater customization the editor contributions active in the widget.
     * See {@link ICodeEditorWidgetOptions.contributions}.
     */
    async createSimpleInline(uri, node, options, widgetOptions) {
        return this.doCreateEditor(uri, async (override, toDispose) => {
            const overrides = override ? Array.from(override) : [];
            overrides.push([contextView_1.IContextMenuService, { showContextMenu: () => { }, onDidShowContextMenu: event_1.Event.None, onDidHideContextMenu: event_1.Event.None }]);
            const document = await this.getModel(uri, toDispose);
            document.suppressOpenEditorWhenDirty = true;
            const model = (await document.load()).textEditorModel;
            const baseOptions = {
                model,
                autoSizing: false,
                minHeight: 1,
                maxHeight: 1
            };
            const editorOptions = {
                ...baseOptions,
                ...MonacoEditorProvider_1.inlineOptions,
                ...options
            };
            return new simple_monaco_editor_1.SimpleMonacoEditor(uri, document, node, this.services, editorOptions, overrides, { isSimpleWidget: true, ...widgetOptions });
        });
    }
    static { this.inlineOptions = {
        wordWrap: 'on',
        overviewRulerLanes: 0,
        glyphMargin: false,
        lineNumbers: 'off',
        folding: false,
        selectOnLineNumbers: false,
        hideCursorInOverviewRuler: true,
        selectionHighlight: false,
        scrollbar: {
            horizontal: 'hidden'
        },
        lineDecorationsWidth: 0,
        overviewRulerBorder: false,
        scrollBeyondLastLine: false,
        renderLineHighlight: 'none',
        fixedOverflowWidgets: true,
        acceptSuggestionOnEnter: 'smart',
        minimap: {
            enabled: false
        }
    }; }
    async createEmbeddedDiffEditor(parentEditor, node, originalUri, modifiedUri = parentEditor.uri, options) {
        options = {
            scrollBeyondLastLine: true,
            overviewRulerLanes: 2,
            fixedOverflowWidgets: true,
            minimap: { enabled: false },
            renderSideBySide: false,
            readOnly: false,
            renderIndicators: false,
            diffAlgorithm: 'advanced',
            stickyScroll: { enabled: false },
            ...options,
            scrollbar: {
                verticalScrollbarSize: 14,
                horizontal: 'auto',
                useShadows: true,
                verticalHasArrows: false,
                horizontalHasArrows: false,
                ...options?.scrollbar
            }
        };
        const uri = diff_uris_1.DiffUris.encode(originalUri, modifiedUri);
        return await this.doCreateEditor(uri, async (override, toDispose) => new monaco_diff_editor_1.MonacoDiffEditor(uri, node, await this.getModel(originalUri, toDispose), await this.getModel(modifiedUri, toDispose), this.services, this.diffNavigatorFactory, options, override, parentEditor));
    }
    init() {
        this.saveParticipants = this.saveProviderContributions.getContributions().slice().sort((left, right) => left.order - right.order);
        this.registerSaveParticipant({
            order: 1000,
            applyChangesOnSave: (editor, cancellationToken, options) => this.formatOnSave(editor, editor.document, cancellationToken, options)
        });
    }
    registerSaveParticipant(saveParticipant) {
        if (this.saveParticipants.find(value => value === saveParticipant)) {
            throw new Error('Save participant already registered');
        }
        this.saveParticipants.push(saveParticipant);
        this.saveParticipants.sort((left, right) => left.order - right.order);
        return common_1.Disposable.create(() => {
            const index = this.saveParticipants.indexOf(saveParticipant);
            if (index >= 0) {
                this.saveParticipants.splice(index, 1);
            }
        });
    }
    shouldFormat(model, options) {
        if (options.saveReason !== monaco_editor_model_1.TextDocumentSaveReason.Manual) {
            return false;
        }
        switch (options.formatType) {
            case 1 /* FormatType.ON */: return true;
            case 2 /* FormatType.OFF */: return false;
            case 3 /* FormatType.DIRTY */: return model.dirty;
        }
        return true;
    }
    async runSaveParticipants(editor, cancellationToken, options) {
        const initialState = editor.document.createSnapshot();
        for (const participant of this.saveParticipants) {
            if (cancellationToken.isCancellationRequested) {
                break;
            }
            const snapshot = editor.document.createSnapshot();
            try {
                await participant.applyChangesOnSave(editor, cancellationToken, options);
            }
            catch (e) {
                this.logger.error(e);
                editor.document.applySnapshot(snapshot);
            }
        }
        if (cancellationToken.isCancellationRequested) {
            editor.document.applySnapshot(initialState);
        }
    }
    async formatOnSave(editor, model, cancellationToken, options) {
        if (!this.shouldFormat(model, options)) {
            return;
        }
        const overrideIdentifier = model.languageId;
        const uri = model.uri.toString();
        const formatOnSave = this.editorPreferences.get({ preferenceName: 'editor.formatOnSave', overrideIdentifier }, undefined, uri);
        if (formatOnSave) {
            const formatOnSaveTimeout = this.editorPreferences.get({ preferenceName: 'editor.formatOnSaveTimeout', overrideIdentifier }, undefined, uri);
            await Promise.race([
                (0, promise_util_1.timeoutReject)(formatOnSaveTimeout, `Aborted format on save after ${formatOnSaveTimeout}ms`),
                await editor.runAction('editor.action.formatDocument')
            ]);
        }
        const shouldRemoveWhiteSpace = this.filePreferences.get({ preferenceName: 'files.trimTrailingWhitespace', overrideIdentifier }, undefined, uri);
        if (shouldRemoveWhiteSpace) {
            await editor.runAction('editor.action.trimTrailingWhitespace');
        }
        const shouldInsertFinalNewline = this.filePreferences.get({ preferenceName: 'files.insertFinalNewline', overrideIdentifier }, undefined, uri);
        if (shouldInsertFinalNewline) {
            this.insertFinalNewline(model);
        }
    }
    insertFinalNewline(editorModel) {
        (0, monaco_utilities_1.insertFinalNewline)(editorModel);
    }
};
exports.MonacoEditorProvider = MonacoEditorProvider;
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.ContributionProvider),
    (0, inversify_1.named)(exports.MonacoEditorFactory),
    tslib_1.__metadata("design:type", Object)
], MonacoEditorProvider.prototype, "factories", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(monaco_editor_1.MonacoEditorServices),
    tslib_1.__metadata("design:type", monaco_editor_1.MonacoEditorServices)
], MonacoEditorProvider.prototype, "services", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_1.KeybindingRegistry),
    tslib_1.__metadata("design:type", browser_1.KeybindingRegistry)
], MonacoEditorProvider.prototype, "keybindingRegistry", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_1.OpenerService),
    tslib_1.__metadata("design:type", Object)
], MonacoEditorProvider.prototype, "openerService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.ContributionProvider),
    (0, inversify_1.named)(exports.SaveParticipant),
    tslib_1.__metadata("design:type", Object)
], MonacoEditorProvider.prototype, "saveProviderContributions", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(common_2.FileSystemPreferences),
    tslib_1.__metadata("design:type", Object)
], MonacoEditorProvider.prototype, "filePreferences", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.ILogger),
    (0, inversify_1.named)('monaco:MonacoEditorProvider'),
    tslib_1.__metadata("design:type", Object)
], MonacoEditorProvider.prototype, "logger", void 0);
tslib_1.__decorate([
    (0, inversify_1.postConstruct)(),
    tslib_1.__metadata("design:type", Function),
    tslib_1.__metadata("design:paramtypes", []),
    tslib_1.__metadata("design:returntype", void 0)
], MonacoEditorProvider.prototype, "init", null);
exports.MonacoEditorProvider = MonacoEditorProvider = MonacoEditorProvider_1 = tslib_1.__decorate([
    (0, inversify_1.injectable)(),
    tslib_1.__param(0, (0, inversify_1.inject)(monaco_to_protocol_converter_1.MonacoToProtocolConverter)),
    tslib_1.__param(1, (0, inversify_1.inject)(protocol_to_monaco_converter_1.ProtocolToMonacoConverter)),
    tslib_1.__param(2, (0, inversify_1.inject)(monaco_workspace_1.MonacoWorkspace)),
    tslib_1.__param(3, (0, inversify_1.inject)(editor_preferences_1.EditorPreferences)),
    tslib_1.__param(4, (0, inversify_1.inject)(monaco_diff_navigator_factory_1.MonacoDiffNavigatorFactory)),
    tslib_1.__metadata("design:paramtypes", [monaco_to_protocol_converter_1.MonacoToProtocolConverter,
        protocol_to_monaco_converter_1.ProtocolToMonacoConverter,
        monaco_workspace_1.MonacoWorkspace, Object, monaco_diff_navigator_factory_1.MonacoDiffNavigatorFactory])
], MonacoEditorProvider);
//# sourceMappingURL=monaco-editor-provider.js.map