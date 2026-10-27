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
var DebugHoverWidget_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.DebugHoverWidget = void 0;
exports.createDebugHoverWidgetContainer = createDebugHoverWidgetContainer;
const tslib_1 = require("tslib");
const debounce = require("@theia/core/shared/lodash.debounce");
const browser_1 = require("@theia/core/lib/browser");
const source_tree_1 = require("@theia/core/lib/browser/source-tree");
const disposable_1 = require("@theia/core/lib/common/disposable");
const widgets_1 = require("@theia/core/shared/@lumino/widgets");
const inversify_1 = require("@theia/core/shared/inversify");
const vscode_uri_1 = require("@theia/core/shared/vscode-uri");
const monaco = require("@theia/monaco-editor-core");
const standaloneServices_1 = require("@theia/monaco-editor-core/esm/vs/editor/standalone/browser/standaloneServices");
const configuration_1 = require("@theia/monaco-editor-core/esm/vs/platform/configuration/common/configuration");
const debug_console_items_1 = require("../console/debug-console-items");
const debug_session_manager_1 = require("../debug-session-manager");
const debug_editor_1 = require("./debug-editor");
const debug_expression_provider_1 = require("./debug-expression-provider");
const debug_hover_source_1 = require("./debug-hover-source");
function createDebugHoverWidgetContainer(parent, editor) {
    const child = source_tree_1.SourceTreeWidget.createContainer(parent, {
        contextMenuPath: DebugHoverWidget.CONTEXT_MENU,
        virtualized: false
    });
    child.bind(debug_editor_1.DebugEditor).toConstantValue(editor);
    child.bind(debug_hover_source_1.DebugHoverSource).toSelf();
    child.unbind(source_tree_1.SourceTreeWidget);
    child.bind(DebugHoverWidget).toSelf();
    return child;
}
let DebugHoverWidget = class DebugHoverWidget extends source_tree_1.SourceTreeWidget {
    constructor() {
        super(...arguments);
        this.allowEditorOverflow = true;
        this.suppressEditorHoverToDispose = new disposable_1.DisposableCollection();
        this.domNode = document.createElement('div');
        this.titleNode = document.createElement('div');
        this.contentNode = document.createElement('div');
        this.doSchedule = debounce((fn) => fn(), 300);
    }
    static { DebugHoverWidget_1 = this; }
    static { this.CONTEXT_MENU = ['debug-hover-context-menu']; }
    static { this.EDIT_MENU = [...DebugHoverWidget_1.CONTEXT_MENU, 'a_edit']; }
    static { this.WATCH_MENU = [...DebugHoverWidget_1.CONTEXT_MENU, 'b_watch']; }
    static { this.ID = 'debug.editor.hover'; }
    getId() {
        return DebugHoverWidget_1.ID;
    }
    getDomNode() {
        return this.domNode;
    }
    init() {
        super.init();
        this.domNode.className = 'theia-debug-hover';
        this.titleNode.className = 'theia-debug-hover-title';
        this.domNode.appendChild(this.titleNode);
        this.contentNode.className = 'theia-debug-hover-content';
        this.domNode.appendChild(this.contentNode);
        // for stopping scroll events from contentNode going to the editor
        this.contentNode.addEventListener('wheel', e => e.stopPropagation());
        this.editor.getControl().addContentWidget(this);
        this.source = this.hoverSource;
        this.toDispose.pushAll([
            this.hoverSource,
            disposable_1.Disposable.create(() => this.editor.getControl().removeContentWidget(this)),
            disposable_1.Disposable.create(() => this.hide()),
            this.sessions.onDidChange(() => {
                if (!this.isEditorFrame()) {
                    this.hide();
                }
            })
        ]);
    }
    dispose() {
        this.suppressEditorHoverToDispose.dispose();
        this.toDispose.dispose();
    }
    show(options) {
        this.schedule(() => this.doShow(options), options && options.immediate);
    }
    hide(options) {
        this.schedule(() => this.doHide(), options && options.immediate);
    }
    schedule(fn, immediate = true) {
        if (immediate) {
            this.doSchedule.cancel();
            fn();
        }
        else {
            this.doSchedule(fn);
        }
    }
    doHide() {
        if (!this.isVisible) {
            return;
        }
        this.suppressEditorHoverToDispose.dispose();
        if (this.domNode.contains(document.activeElement)) {
            this.editor.getControl().focus();
        }
        if (this.isAttached) {
            widgets_1.Widget.detach(this);
        }
        this.hoverSource.reset();
        super.hide();
        this.options = undefined;
        this.editor.getControl().layoutContentWidget(this);
    }
    async doShow(options = this.options) {
        if (!this.isEditorFrame()) {
            this.hide();
            return;
        }
        if (!options) {
            this.hide();
            return;
        }
        if (this.options && this.options.selection.equalsRange(options.selection)) {
            return;
        }
        if (!this.isAttached) {
            widgets_1.Widget.attach(this, this.contentNode);
        }
        this.options = options;
        const result = await this.expressionProvider.getEvaluatableExpression(this.editor, options.selection);
        if (!result?.matchingExpression) {
            this.hide();
            return;
        }
        this.options.selection = monaco.Range.lift(result.range);
        const toFocus = new disposable_1.DisposableCollection();
        if (this.options.focus === true) {
            toFocus.push(this.model.onNodeRefreshed(() => {
                toFocus.dispose();
                this.activate();
            }));
        }
        const expression = await this.hoverSource.evaluate(result.matchingExpression);
        if (!expression) {
            toFocus.dispose();
            this.hide();
            return;
        }
        this.contentNode.hidden = false;
        ['number', 'boolean', 'string'].forEach(token => this.titleNode.classList.remove(token));
        this.domNode.classList.remove('complex-value');
        if (expression.hasElements) {
            this.domNode.classList.add('complex-value');
        }
        else {
            this.contentNode.hidden = true;
            if (expression.type === 'number' || expression.type === 'boolean' || expression.type === 'string') {
                this.titleNode.classList.add(expression.type);
            }
            else if (!isNaN(+expression.value)) {
                this.titleNode.classList.add('number');
            }
            else if (debug_console_items_1.DebugVariable.booleanRegex.test(expression.value)) {
                this.titleNode.classList.add('boolean');
            }
            else if (debug_console_items_1.DebugVariable.stringRegex.test(expression.value)) {
                this.titleNode.classList.add('string');
            }
        }
        this.suppressEditorHover();
        super.show();
        await new Promise(resolve => {
            setTimeout(() => window.requestAnimationFrame(() => {
                this.editor.getControl().layoutContentWidget(this);
                resolve();
            }), 0);
        });
    }
    /**
     * Suppress the default editor-contribution hover from Code.
     * Otherwise, both `textdocument/hover` and the debug hovers are visible
     * at the same time when hovering over a symbol.
     * This will priorize the debug hover over the editor hover.
     */
    suppressEditorHover() {
        const codeEditor = this.editor.getControl();
        codeEditor.updateOptions({ hover: { enabled: 'off' } });
        this.suppressEditorHoverToDispose.push(disposable_1.Disposable.create(() => {
            const model = codeEditor.getModel();
            const overrides = {
                resource: vscode_uri_1.URI.parse(this.editor.getResourceUri().toString()),
                overrideIdentifier: model?.getLanguageId(),
            };
            const { enabled, delay, sticky } = standaloneServices_1.StandaloneServices.get(configuration_1.IConfigurationService).getValue('editor.hover', overrides);
            codeEditor.updateOptions({
                hover: {
                    enabled,
                    delay,
                    sticky
                }
            });
        }));
    }
    isEditorFrame() {
        return this.sessions.isCurrentEditorFrame(this.editor.getResourceUri());
    }
    getPosition() {
        if (!this.isVisible) {
            return undefined;
        }
        const position = this.options && this.options.selection.getStartPosition();
        return position
            ? {
                position: new monaco.Position(position.lineNumber, position.column),
                preference: [
                    monaco.editor.ContentWidgetPositionPreference.ABOVE,
                    monaco.editor.ContentWidgetPositionPreference.BELOW,
                ],
            }
            : undefined;
    }
    onUpdateRequest(msg) {
        super.onUpdateRequest(msg);
        const { expression } = this.hoverSource;
        const value = expression && expression.value || '';
        this.titleNode.textContent = value;
        this.titleNode.title = value;
    }
    onAfterAttach(msg) {
        super.onAfterAttach(msg);
        this.addKeyListener(this.domNode, browser_1.Key.ESCAPE, () => this.hide());
    }
};
exports.DebugHoverWidget = DebugHoverWidget;
tslib_1.__decorate([
    (0, inversify_1.inject)(debug_editor_1.DebugEditor),
    tslib_1.__metadata("design:type", Object)
], DebugHoverWidget.prototype, "editor", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(debug_session_manager_1.DebugSessionManager),
    tslib_1.__metadata("design:type", debug_session_manager_1.DebugSessionManager)
], DebugHoverWidget.prototype, "sessions", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(debug_hover_source_1.DebugHoverSource),
    tslib_1.__metadata("design:type", debug_hover_source_1.DebugHoverSource)
], DebugHoverWidget.prototype, "hoverSource", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(debug_expression_provider_1.DebugExpressionProvider),
    tslib_1.__metadata("design:type", debug_expression_provider_1.DebugExpressionProvider)
], DebugHoverWidget.prototype, "expressionProvider", void 0);
tslib_1.__decorate([
    (0, inversify_1.postConstruct)(),
    tslib_1.__metadata("design:type", Function),
    tslib_1.__metadata("design:paramtypes", []),
    tslib_1.__metadata("design:returntype", void 0)
], DebugHoverWidget.prototype, "init", null);
exports.DebugHoverWidget = DebugHoverWidget = DebugHoverWidget_1 = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], DebugHoverWidget);
//# sourceMappingURL=debug-hover-widget.js.map