"use strict";
// *****************************************************************************
// Copyright (C) 2018 Ericsson and others.
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
exports.MonacoFrontendApplicationContribution = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("@theia/core/shared/inversify");
const browser_1 = require("@theia/core/lib/browser");
const monaco_snippet_suggest_provider_1 = require("./monaco-snippet-suggest-provider");
const monaco = require("@theia/monaco-editor-core");
const suggest_1 = require("@theia/monaco-editor-core/esm/vs/editor/contrib/suggest/browser/suggest");
const monaco_text_model_service_1 = require("./monaco-text-model-service");
const monaco_theming_service_1 = require("./monaco-theming-service");
const theme_1 = require("@theia/core/lib/common/theme");
const editorOptions_1 = require("@theia/monaco-editor-core/esm/vs/editor/common/config/editorOptions");
const core_1 = require("@theia/core");
const editor_generated_preference_schema_1 = require("@theia/editor/lib/common/editor-generated-preference-schema");
const workspace_file_service_1 = require("@theia/workspace/lib/common/workspace-file-service");
const standaloneServices_1 = require("@theia/monaco-editor-core/esm/vs/editor/standalone/browser/standaloneServices");
const standaloneTheme_1 = require("@theia/monaco-editor-core/esm/vs/editor/standalone/common/standaloneTheme");
const secondary_window_service_1 = require("@theia/core/lib/browser/window/secondary-window-service");
const dom_1 = require("@theia/monaco-editor-core/esm/vs/base/browser/dom");
let MonacoFrontendApplicationContribution = class MonacoFrontendApplicationContribution {
    constructor() {
        this.windowsById = new Map();
        this.nextWindowId = 2; // the main window has the id "1"
    }
    init() {
        this.addAdditionalPreferenceValidations();
        // Monaco registers certain quick access providers (e.g. QuickCommandAccess) at import time, but we want to use our own.
        this.quickAccessRegistry.clear();
        /**
         * @monaco-uplift.Should be guaranteed to work.
         * Incomparable enums prevent TypeScript from believing that public ITextModel satisfied private ITextModel
         */
        (0, suggest_1.setSnippetSuggestSupport)(this.snippetSuggestProvider);
        for (const language of monaco.languages.getLanguages()) {
            this.preferenceSchema.registerOverrideIdentifier(language.id);
        }
        const registerLanguage = monaco.languages.register.bind(monaco.languages);
        monaco.languages.register = language => {
            // first register override identifier, because monaco will immediately update already opened documents and then initialize with bad preferences.
            this.preferenceSchema.registerOverrideIdentifier(language.id);
            registerLanguage(language);
        };
        this.monacoThemingService.initialize();
    }
    initialize() {
        const workspaceExtensions = this.workspaceFileService.getWorkspaceFileExtensions();
        monaco.languages.register({
            id: 'jsonc',
            'aliases': [
                'JSON with Comments'
            ],
            'extensions': workspaceExtensions.map(ext => `.${ext}`)
        });
    }
    onStart() {
        // Monaco exposes its theme colors as `--vscode-*` CSS variables only through the `monaco-colors`
        // stylesheet that `registerEditorContainer` injects. That stylesheet is otherwise created lazily,
        // when the first standalone editor is opened, so popups that rely on those variables (e.g. the chat
        // input's suggest widget) are unstyled until then. Register the main window up front so the variables
        // are available document-wide from launch; `_updateCSS` keeps the stylesheet in sync on theme changes.
        this.standaloneThemeService.registerEditorContainer(document.body);
        this.secondaryWindowService.onWindowLoaded(window => {
            const codeWindow = window;
            codeWindow.vscodeWindowId = this.nextWindowId++;
            const toDispose = new core_1.DisposableCollection();
            toDispose.push((0, dom_1.registerWindow)(codeWindow));
            // Inject Monaco's theme stylesheet (`monaco-colors`, defining the `--vscode-*`
            // variables and token colors) into the new window's document. Without it, Monaco
            // editors in secondary windows have no theme colors: invisible cursor and
            // selection, unstyled suggest widget. Registering the document body covers all
            // widgets moved to this window, e.g. the AI chat view with its input editor.
            // See https://github.com/eclipse-theia/theia/issues/15164
            toDispose.push(this.standaloneThemeService.registerEditorContainer(codeWindow.document.body));
            this.windowsById.set(codeWindow.vscodeWindowId, toDispose);
        });
        this.secondaryWindowService.onWindowClosed(window => {
            const codeWindow = window;
            this.windowsById.get(codeWindow.vscodeWindowId)?.dispose();
            this.windowsById.delete(codeWindow.vscodeWindowId);
        });
    }
    /**
     * Theia's {@link MonacoStandaloneThemeService} override, which creates the `monaco-colors`
     * stylesheet in the target node's own document. The upstream `StandaloneThemeService` would
     * only ever create a single global stylesheet in the main document and silently no-op for
     * nodes in other documents, so this contribution depends on the Theia override being bound
     * (see `monaco-init.ts`).
     */
    get standaloneThemeService() {
        return standaloneServices_1.StandaloneServices.get(standaloneTheme_1.IStandaloneThemeService);
    }
    registerThemeStyle(theme, collector) {
        if ((0, theme_1.isHighContrast)(theme.type)) {
            const focusBorder = theme.getColor('focusBorder');
            const contrastBorder = theme.getColor('contrastBorder');
            if (focusBorder) {
                // Quick input
                collector.addRule(`
                    .quick-input-list .monaco-list-row {
                        outline-offset: -1px;
                    }
                    .quick-input-list .monaco-list-row.focused {
                        outline: 1px dotted ${focusBorder};
                    }
                    .quick-input-list .monaco-list-row:hover {
                        outline: 1px dashed ${focusBorder};
                    }
                `);
                // Input box always displays an outline, even when unfocused
                collector.addRule(`
                    .monaco-editor .find-widget .monaco-inputbox {
                        outline: var(--theia-border-width) solid;
                        outline-offset: calc(-1 * var(--theia-border-width));
                        outline-color: var(--theia-focusBorder);
                    }
                `);
            }
            if (contrastBorder) {
                collector.addRule(`
                    .quick-input-widget {
                        outline: 1px solid ${contrastBorder};
                        outline-offset: -1px;
                    }
                `);
            }
        }
        else {
            collector.addRule(`
                .quick-input-widget {
                    box-shadow: rgb(0 0 0 / 36%) 0px 0px 8px 2px;
                }
            `);
        }
    }
    /**
     * For reasons that are unclear, while most preferences that apply in editors are validated, a few are not.
     * There is a utility in `examples/api-samples/src/browser/monaco-editor-preferences/monaco-editor-preference-extractor.ts` to help determine which are not.
     * Check `src/vs/editor/common/config/editorOptions.ts` for constructor arguments and to make sure that the preference names used to extract constructors are still accurate.
     */
    addAdditionalPreferenceValidations() {
        let editorIntConstructor;
        let editorBoolConstructor;
        let editorStringEnumConstructor;
        for (const validator of editorOptions_1.editorOptionsRegistry) {
            /* eslint-disable @typescript-eslint/no-explicit-any,max-len */
            if (editorIntConstructor && editorBoolConstructor && editorStringEnumConstructor) {
                break;
            }
            if (validator.name === 'acceptSuggestionOnCommitCharacter') {
                editorBoolConstructor = validator.constructor;
            }
            else if (validator.name === 'acceptSuggestionOnEnter') {
                editorStringEnumConstructor = validator.constructor;
            }
            else if (validator.name === 'accessibilityPageSize') {
                editorIntConstructor = validator.constructor;
            }
            /* eslint-enable @typescript-eslint/no-explicit-any */
        }
        if (editorIntConstructor && editorBoolConstructor && editorStringEnumConstructor) {
            let id = 200; // Needs to be bigger than the biggest index in the EditorOption enum.
            editorOptions_1.editorOptionsRegistry.push(new editorIntConstructor(id++, 'tabSize', 4, 1, core_1.MAX_SAFE_INTEGER, editor_generated_preference_schema_1.editorGeneratedPreferenceProperties['editor.tabSize']), new editorBoolConstructor(id++, 'insertSpaces', true, editor_generated_preference_schema_1.editorGeneratedPreferenceProperties['editor.insertSpaces']), new editorBoolConstructor(id++, 'detectIndentation', true, editor_generated_preference_schema_1.editorGeneratedPreferenceProperties['editor.detectIndentation']), new editorBoolConstructor(id++, 'trimAutoWhitespace', true, editor_generated_preference_schema_1.editorGeneratedPreferenceProperties['editor.trimAutoWhitespace']), new editorBoolConstructor(id++, 'largeFileOptimizations', true, editor_generated_preference_schema_1.editorGeneratedPreferenceProperties['editor.largeFileOptimizations']), new editorStringEnumConstructor(id++, 'wordBasedSuggestions', 'matchingDocuments', editor_generated_preference_schema_1.editorGeneratedPreferenceProperties['editor.wordBasedSuggestions'].enum, editor_generated_preference_schema_1.editorGeneratedPreferenceProperties['editor.wordBasedSuggestions']), new editorBoolConstructor(id++, 'stablePeek', false, editor_generated_preference_schema_1.editorGeneratedPreferenceProperties['editor.stablePeek']), new editorIntConstructor(id++, 'maxTokenizationLineLength', 20000, 1, core_1.MAX_SAFE_INTEGER, editor_generated_preference_schema_1.editorGeneratedPreferenceProperties['editor.maxTokenizationLineLength']));
        }
    }
};
exports.MonacoFrontendApplicationContribution = MonacoFrontendApplicationContribution;
tslib_1.__decorate([
    (0, inversify_1.inject)(monaco_text_model_service_1.MonacoTextModelService),
    tslib_1.__metadata("design:type", monaco_text_model_service_1.MonacoTextModelService)
], MonacoFrontendApplicationContribution.prototype, "textModelService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(monaco_snippet_suggest_provider_1.MonacoSnippetSuggestProvider),
    tslib_1.__metadata("design:type", monaco_snippet_suggest_provider_1.MonacoSnippetSuggestProvider)
], MonacoFrontendApplicationContribution.prototype, "snippetSuggestProvider", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.PreferenceSchemaService),
    tslib_1.__metadata("design:type", Object)
], MonacoFrontendApplicationContribution.prototype, "preferenceSchema", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_1.QuickAccessRegistry),
    tslib_1.__metadata("design:type", Object)
], MonacoFrontendApplicationContribution.prototype, "quickAccessRegistry", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(monaco_theming_service_1.MonacoThemingService),
    tslib_1.__metadata("design:type", monaco_theming_service_1.MonacoThemingService)
], MonacoFrontendApplicationContribution.prototype, "monacoThemingService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(workspace_file_service_1.WorkspaceFileService),
    tslib_1.__metadata("design:type", workspace_file_service_1.WorkspaceFileService)
], MonacoFrontendApplicationContribution.prototype, "workspaceFileService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(secondary_window_service_1.SecondaryWindowService),
    tslib_1.__metadata("design:type", Object)
], MonacoFrontendApplicationContribution.prototype, "secondaryWindowService", void 0);
tslib_1.__decorate([
    (0, inversify_1.postConstruct)(),
    tslib_1.__metadata("design:type", Function),
    tslib_1.__metadata("design:paramtypes", []),
    tslib_1.__metadata("design:returntype", void 0)
], MonacoFrontendApplicationContribution.prototype, "init", null);
exports.MonacoFrontendApplicationContribution = MonacoFrontendApplicationContribution = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], MonacoFrontendApplicationContribution);
//# sourceMappingURL=monaco-frontend-application-contribution.js.map