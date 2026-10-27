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
var DebugEditorModel_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.DebugEditorModel = exports.DebugEditorModelFactory = void 0;
const tslib_1 = require("tslib");
const debounce = require("p-debounce");
const inversify_1 = require("@theia/core/shared/inversify");
const monaco = require("@theia/monaco-editor-core");
const uri_1 = require("@theia/core/lib/common/uri");
const core_1 = require("@theia/core");
const browser_1 = require("@theia/core/lib/browser");
const breakpoint_manager_1 = require("../breakpoint/breakpoint-manager");
const debug_session_manager_1 = require("../debug-session-manager");
const breakpoint_marker_1 = require("../breakpoint/breakpoint-marker");
const debug_editor_1 = require("./debug-editor");
const debug_hover_widget_1 = require("./debug-hover-widget");
const debug_breakpoint_widget_1 = require("./debug-breakpoint-widget");
const debug_exception_widget_1 = require("./debug-exception-widget");
const debug_inline_value_decorator_1 = require("./debug-inline-value-decorator");
exports.DebugEditorModelFactory = Symbol('DebugEditorModelFactory');
let DebugEditorModel = class DebugEditorModel {
    constructor() {
        this.toDispose = new core_1.DisposableCollection();
        this.toDisposeOnUpdate = new core_1.DisposableCollection();
        this.breakpointDecorations = [];
        this.breakpointRanges = new Map();
        this.currentBreakpointDecorations = [];
        this.editorDecorations = [];
        /**
         * Set during `render()` to prevent `onDidChangeDecorations` → `updateBreakpoints()`
         * from reading back the decoration positions we just wrote, which would produce
         * a spurious or circular `setBreakpoints` call.
         */
        this.ignoreDecorationsChangedEvent = false;
        /**
         * Set during `updateBreakpoints()` to prevent the resulting
         * `onDidChangeBreakpoints` from re-entering `render()`.
         */
        this.ignoreBreakpointsChangeEvent = false;
        this.toDisposeOnModelChange = new core_1.DisposableCollection();
        this.update = debounce(async () => {
            if (this.toDispose.disposed) {
                return;
            }
            this.toDisposeOnUpdate.dispose();
            this.toggleExceptionWidget();
            await this.updateEditorDecorations();
        }, 100);
        this.hintDecorations = [];
    }
    static { DebugEditorModel_1 = this; }
    static createContainer(parent, editor) {
        const child = (0, debug_hover_widget_1.createDebugHoverWidgetContainer)(parent, editor);
        child.bind(DebugEditorModel_1).toSelf();
        child.bind(debug_breakpoint_widget_1.DebugBreakpointWidget).toSelf();
        child.bind(debug_exception_widget_1.DebugExceptionWidget).toSelf();
        return child;
    }
    static createModel(parent, editor) {
        return DebugEditorModel_1.createContainer(parent, editor).get(DebugEditorModel_1);
    }
    static { this.CONTEXT_MENU = ['debug-editor-context-menu']; }
    init() {
        this.uri = new uri_1.default(this.editor.getResourceUri().toString());
        this.toDispose.pushAll([
            this.hover,
            this.breakpointWidget,
            this.exceptionWidget,
            this.editor.getControl().onMouseDown(event => this.handleMouseDown(event)),
            this.editor.getControl().onMouseMove(event => this.handleMouseMove(event)),
            this.editor.getControl().onMouseLeave(event => this.handleMouseLeave(event)),
            this.editor.getControl().onKeyDown(() => this.hover.hide({ immediate: false })),
            this.editor.getControl().onDidChangeModelContent(() => this.update()),
            this.editor.getControl().onDidChangeModel(e => this.updateModel()),
            this.editor.onDidResize(e => this.breakpointWidget.inputSize = e),
            this.sessions.onDidChange(() => this.update()),
            this.toDisposeOnUpdate,
            core_1.Disposable.create(() => this.toDisposeOnModelChange.dispose()),
            this.breakpoints.onDidChangeBreakpoints(event => {
                if (!this.ignoreBreakpointsChangeEvent) {
                    this.render();
                }
                this.closeBreakpointIfAffected(event);
            }),
        ]);
        this.updateModel();
    }
    updateModel() {
        this.toDisposeOnModelChange.dispose();
        this.toDisposeOnModelChange = new core_1.DisposableCollection();
        const model = this.editor.getControl().getModel();
        if (model) {
            this.toDisposeOnModelChange.push(model.onDidChangeDecorations(() => this.updateBreakpoints()));
        }
        this.update();
        this.render();
    }
    dispose() {
        this.toDispose.dispose();
    }
    async updateEditorDecorations() {
        const [newFrameDecorations, inlineValueDecorations] = await Promise.all([
            this.createFrameDecorations(),
            this.createInlineValueDecorations()
        ]);
        const codeEditor = this.editor.getControl();
        codeEditor.removeDecorations([debug_inline_value_decorator_1.INLINE_VALUE_DECORATION_KEY]);
        codeEditor.setDecorationsByType('Inline debug decorations', debug_inline_value_decorator_1.INLINE_VALUE_DECORATION_KEY, inlineValueDecorations);
        this.editorDecorations = this.deltaDecorations(this.editorDecorations, newFrameDecorations);
    }
    async createInlineValueDecorations() {
        if (!this.sessions.isCurrentEditorFrame(this.uri)) {
            return [];
        }
        const { currentFrame } = this.sessions;
        return this.inlineValueDecorator.calculateDecorations(this, currentFrame);
    }
    createFrameDecorations() {
        const { currentFrame, topFrame } = this.sessions;
        if (!currentFrame || !topFrame) {
            return [];
        }
        if (!currentFrame.thread.stopped) {
            return [];
        }
        const decorations = [];
        const isTopFrameInEditor = topFrame.source && new uri_1.default(topFrame.source.uri.toString()).isEqual(this.uri);
        const isCurrentFrameInEditor = this.sessionManager.isCurrentEditorFrame(this.uri);
        if (isTopFrameInEditor) {
            const columnUntilEOLRange = new monaco.Range(topFrame.raw.line, topFrame.raw.column, topFrame.raw.line, 1 << 30);
            const range = new monaco.Range(topFrame.raw.line, topFrame.raw.column, topFrame.raw.line, topFrame.raw.column + 1);
            decorations.push({
                options: DebugEditorModel_1.TOP_STACK_FRAME_MARGIN,
                range
            });
            decorations.push({
                options: DebugEditorModel_1.TOP_STACK_FRAME_DECORATION,
                range: columnUntilEOLRange
            });
            const firstNonWhitespaceColumn = this.editor.document.textEditorModel.getLineFirstNonWhitespaceColumn(topFrame.raw.line);
            if (firstNonWhitespaceColumn !== 0 && topFrame.raw.column > firstNonWhitespaceColumn) {
                decorations.push({
                    options: DebugEditorModel_1.TOP_STACK_FRAME_INLINE_DECORATION,
                    range: columnUntilEOLRange
                });
            }
        }
        if (isCurrentFrameInEditor && topFrame !== currentFrame) {
            const columnUntilEOLRange = new monaco.Range(currentFrame.raw.line, currentFrame.raw.column, currentFrame.raw.line, 1 << 30);
            const range = new monaco.Range(currentFrame.raw.line, currentFrame.raw.column, currentFrame.raw.line, currentFrame.raw.column + 1);
            decorations.push({
                options: DebugEditorModel_1.FOCUSED_STACK_FRAME_MARGIN,
                range
            });
            decorations.push({
                options: DebugEditorModel_1.FOCUSED_STACK_FRAME_DECORATION,
                range: columnUntilEOLRange
            });
        }
        return decorations;
    }
    async toggleExceptionWidget() {
        const { currentFrame } = this.sessions;
        if (!currentFrame) {
            return;
        }
        if (!this.sessions.isCurrentEditorFrame(this.uri)) {
            this.exceptionWidget.hide();
            return;
        }
        const info = await currentFrame.thread.getExceptionInfo();
        if (!info) {
            this.exceptionWidget.hide();
            return;
        }
        this.exceptionWidget.show({
            info,
            lineNumber: currentFrame.raw.line,
            column: currentFrame.raw.column
        });
    }
    render() {
        this.ignoreDecorationsChangedEvent = true;
        try {
            this.renderBreakpoints();
            this.renderCurrentBreakpoints();
        }
        finally {
            this.ignoreDecorationsChangedEvent = false;
        }
    }
    renderBreakpoints() {
        const breakpoints = this.breakpoints.getBreakpoints(this.uri);
        const decorations = this.createBreakpointDecorations(breakpoints);
        this.breakpointDecorations = this.deltaDecorations(this.breakpointDecorations, decorations);
        this.updateBreakpointRanges(breakpoints);
    }
    createBreakpointDecorations(breakpoints) {
        return breakpoints.map(breakpoint => this.createBreakpointDecoration(breakpoint));
    }
    createBreakpointDecoration(breakpoint) {
        const lineNumber = breakpoint.line;
        const column = breakpoint.column || this.editor.getControl().getModel()?.getLineFirstNonWhitespaceColumn(lineNumber) || 1;
        const range = new monaco.Range(lineNumber, column, lineNumber, column + 1);
        return {
            range,
            options: {
                stickiness: DebugEditorModel_1.STICKINESS
            }
        };
    }
    updateBreakpointRanges(breakpoints) {
        this.breakpointRanges.clear();
        for (let i = 0; i < this.breakpointDecorations.length; i++) {
            const decoration = this.breakpointDecorations[i];
            const breakpoint = breakpoints[i];
            const range = this.editor.getControl().getModel()?.getDecorationRange(decoration);
            if (range) {
                this.breakpointRanges.set(decoration, [range, breakpoint]);
            }
        }
    }
    renderCurrentBreakpoints() {
        const decorations = this.createCurrentBreakpointDecorations();
        this.currentBreakpointDecorations = this.deltaDecorations(this.currentBreakpointDecorations, decorations);
    }
    createCurrentBreakpointDecorations() {
        const breakpoints = this.breakpoints.getBreakpoints(this.uri);
        // Deduplicate by rendered position: when multiple breakpoints resolve
        // to the same (line, column) — e.g. via source-map collapsing — only
        // create one decoration to avoid double dots in the editor.
        const seen = new Set();
        const result = [];
        for (const bp of breakpoints) {
            const key = `${bp.line}:${bp.column ?? 0}`;
            if (seen.has(key)) {
                continue;
            }
            seen.add(key);
            result.push(this.createCurrentBreakpointDecoration(bp));
        }
        return result;
    }
    createCurrentBreakpointDecoration(breakpoint) {
        const lineNumber = breakpoint.line;
        const column = breakpoint.column;
        const range = typeof column === 'number' ? new monaco.Range(lineNumber, column, lineNumber, column + 1) : new monaco.Range(lineNumber, 1, lineNumber, 1);
        const { className, message } = breakpoint.getDecoration();
        const renderInline = typeof column === 'number' && (column > (this.editor.getControl().getModel()?.getLineFirstNonWhitespaceColumn(lineNumber) || 0));
        return {
            range,
            options: {
                glyphMarginClassName: className,
                glyphMarginHoverMessage: message.map(value => ({ value })),
                stickiness: DebugEditorModel_1.STICKINESS,
                beforeContentClassName: renderInline ? `theia-debug-breakpoint-column codicon ${className}` : undefined
            }
        };
    }
    updateBreakpoints() {
        if (this.areBreakpointsAffected()) {
            const breakpoints = this.createBreakpoints();
            this.ignoreBreakpointsChangeEvent = true;
            try {
                this.breakpoints.setBreakpoints(this.uri, breakpoints);
            }
            finally {
                this.ignoreBreakpointsChangeEvent = false;
            }
        }
    }
    areBreakpointsAffected() {
        if (this.ignoreDecorationsChangedEvent || !this.editor.getControl().getModel()) {
            return false;
        }
        for (const decoration of this.breakpointDecorations) {
            const range = this.editor.getControl().getModel()?.getDecorationRange(decoration);
            const oldRange = this.breakpointRanges.get(decoration)[0];
            if (!range || !range.equalsRange(oldRange)) {
                return true;
            }
        }
        return false;
    }
    createBreakpoints() {
        const { uri } = this;
        const positions = new Set();
        const breakpoints = [];
        for (const decoration of this.breakpointDecorations) {
            const range = this.editor.getControl().getModel()?.getDecorationRange(decoration);
            if (range) {
                const line = range.startLineNumber;
                const column = range.startColumn;
                const oldBreakpoint = this.breakpointRanges.get(decoration)?.[1];
                if (oldBreakpoint) {
                    const isLineBreakpoint = oldBreakpoint.origin.raw.line !== undefined && oldBreakpoint.origin.raw.column === undefined;
                    const position = isLineBreakpoint ? `${line}` : `${line}:${column}`;
                    if (!positions.has(position)) {
                        const change = isLineBreakpoint ? { line } : { line, column };
                        const breakpoint = breakpoint_marker_1.SourceBreakpoint.create(uri, change, oldBreakpoint.origin);
                        breakpoints.push(breakpoint);
                        positions.add(position);
                    }
                }
            }
        }
        return breakpoints;
    }
    get position() {
        return this.editor.getControl().getPosition();
    }
    getBreakpoint(position = this.position) {
        return this.getInlineBreakpoint(position) || this.getLineBreakpoints(position)[0];
    }
    getInlineBreakpoint(position = this.position) {
        return this.breakpoints.getBreakpoints(this.uri).find(candidate => candidate.line === position.lineNumber && candidate.column === position.column);
    }
    getLineBreakpoints(position = this.position) {
        return this.breakpoints.getBreakpoints(this.uri).filter(candidate => candidate.line === position.lineNumber);
    }
    addBreakpoint(raw) {
        this.breakpoints.addBreakpoint(breakpoint_marker_1.SourceBreakpoint.create(this.uri, raw));
    }
    toggleBreakpoint(position = this.position) {
        const { lineNumber } = position;
        const breakpoints = this.getLineBreakpoints(position);
        if (breakpoints.length) {
            for (const breakpoint of breakpoints) {
                breakpoint.remove();
            }
        }
        else {
            this.addBreakpoint({ line: lineNumber });
        }
    }
    addInlineBreakpoint() {
        const { position: { lineNumber: line, column } } = this;
        this.addBreakpoint({ line, column });
    }
    acceptBreakpoint() {
        const { position, values } = this.breakpointWidget;
        if (position && values) {
            const breakpoint = position.column > 0 ? this.getInlineBreakpoint(position) : this.getLineBreakpoints(position)[0];
            if (breakpoint) {
                this.breakpoints.updateBreakpoint(breakpoint, values);
            }
            else {
                const { lineNumber } = position;
                const column = position.column > 0 ? position.column : undefined;
                this.addBreakpoint({ line: lineNumber, column, ...values });
            }
            this.breakpointWidget.hide();
        }
    }
    handleMouseDown(event) {
        if (event.target && event.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) {
            if (!(0, browser_1.isContextMenuEvent)(event.event.browserEvent)) {
                this.toggleBreakpoint(event.target.position);
            }
        }
        this.hintBreakpoint(event);
    }
    handleMouseMove(event) {
        this.showHover(event);
        this.hintBreakpoint(event);
    }
    handleMouseLeave(event) {
        this.hideHover(event);
        this.deltaHintDecorations([]);
    }
    hintBreakpoint(event) {
        const hintDecorations = this.createHintDecorations(event);
        this.deltaHintDecorations(hintDecorations);
    }
    deltaHintDecorations(hintDecorations) {
        this.hintDecorations = this.deltaDecorations(this.hintDecorations, hintDecorations);
    }
    createHintDecorations(event) {
        if (event.target && event.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN && event.target.position) {
            const lineNumber = event.target.position.lineNumber;
            if (this.getLineBreakpoints(event.target.position).length) {
                return [];
            }
            return [{
                    range: new monaco.Range(lineNumber, 1, lineNumber, 1),
                    options: DebugEditorModel_1.BREAKPOINT_HINT_DECORATION
                }];
        }
        return [];
    }
    closeBreakpointIfAffected({ uri, removed }) {
        if (!uri.isEqual(this.uri)) {
            return;
        }
        const position = this.breakpointWidget.position;
        if (!position) {
            return;
        }
        for (const breakpoint of removed) {
            if (breakpoint.line === position.lineNumber) {
                this.breakpointWidget.hide();
                break;
            }
        }
    }
    showHover(mouseEvent) {
        const targetType = mouseEvent.target.type;
        const stopKey = core_1.isOSX ? 'metaKey' : 'ctrlKey';
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if (targetType === monaco.editor.MouseTargetType.CONTENT_WIDGET && mouseEvent.target.detail === this.hover.getId() && !mouseEvent.event[stopKey]) {
            // mouse moved on top of debug hover widget
            return;
        }
        if (targetType === monaco.editor.MouseTargetType.CONTENT_TEXT) {
            this.hover.show({
                selection: mouseEvent.target.range,
                immediate: false
            });
        }
        else {
            this.hover.hide({ immediate: false });
        }
    }
    hideHover({ event }) {
        const rect = this.hover.getDomNode().getBoundingClientRect();
        if (event.posx < rect.left || event.posx > rect.right || event.posy < rect.top || event.posy > rect.bottom) {
            this.hover.hide({ immediate: false });
        }
    }
    deltaDecorations(oldDecorations, newDecorations) {
        return this.editor.getControl().deltaDecorations(oldDecorations, newDecorations);
    }
    static { this.STICKINESS = monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges; }
    static { this.BREAKPOINT_HINT_DECORATION = {
        glyphMarginClassName: 'codicon-debug-hint',
        stickiness: DebugEditorModel_1.STICKINESS
    }; }
    static { this.TOP_STACK_FRAME_MARGIN = {
        glyphMarginClassName: 'codicon-debug-stackframe',
        stickiness: DebugEditorModel_1.STICKINESS
    }; }
    static { this.FOCUSED_STACK_FRAME_MARGIN = {
        glyphMarginClassName: 'codicon-debug-stackframe-focused',
        stickiness: DebugEditorModel_1.STICKINESS
    }; }
    static { this.TOP_STACK_FRAME_DECORATION = {
        isWholeLine: true,
        className: 'theia-debug-top-stack-frame-line',
        stickiness: DebugEditorModel_1.STICKINESS
    }; }
    static { this.TOP_STACK_FRAME_INLINE_DECORATION = {
        beforeContentClassName: 'theia-debug-top-stack-frame-column'
    }; }
    static { this.FOCUSED_STACK_FRAME_DECORATION = {
        isWholeLine: true,
        className: 'theia-debug-focused-stack-frame-line',
        stickiness: DebugEditorModel_1.STICKINESS
    }; }
};
exports.DebugEditorModel = DebugEditorModel;
tslib_1.__decorate([
    (0, inversify_1.inject)(debug_hover_widget_1.DebugHoverWidget),
    tslib_1.__metadata("design:type", debug_hover_widget_1.DebugHoverWidget)
], DebugEditorModel.prototype, "hover", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(debug_editor_1.DebugEditor),
    tslib_1.__metadata("design:type", Object)
], DebugEditorModel.prototype, "editor", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(breakpoint_manager_1.BreakpointManager),
    tslib_1.__metadata("design:type", breakpoint_manager_1.BreakpointManager)
], DebugEditorModel.prototype, "breakpoints", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(debug_session_manager_1.DebugSessionManager),
    tslib_1.__metadata("design:type", debug_session_manager_1.DebugSessionManager)
], DebugEditorModel.prototype, "sessions", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_1.ContextMenuRenderer),
    tslib_1.__metadata("design:type", browser_1.ContextMenuRenderer)
], DebugEditorModel.prototype, "contextMenu", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(debug_breakpoint_widget_1.DebugBreakpointWidget),
    tslib_1.__metadata("design:type", debug_breakpoint_widget_1.DebugBreakpointWidget)
], DebugEditorModel.prototype, "breakpointWidget", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(debug_exception_widget_1.DebugExceptionWidget),
    tslib_1.__metadata("design:type", debug_exception_widget_1.DebugExceptionWidget)
], DebugEditorModel.prototype, "exceptionWidget", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(debug_inline_value_decorator_1.DebugInlineValueDecorator),
    tslib_1.__metadata("design:type", debug_inline_value_decorator_1.DebugInlineValueDecorator)
], DebugEditorModel.prototype, "inlineValueDecorator", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(debug_session_manager_1.DebugSessionManager),
    tslib_1.__metadata("design:type", debug_session_manager_1.DebugSessionManager)
], DebugEditorModel.prototype, "sessionManager", void 0);
tslib_1.__decorate([
    (0, inversify_1.postConstruct)(),
    tslib_1.__metadata("design:type", Function),
    tslib_1.__metadata("design:paramtypes", []),
    tslib_1.__metadata("design:returntype", void 0)
], DebugEditorModel.prototype, "init", null);
exports.DebugEditorModel = DebugEditorModel = DebugEditorModel_1 = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], DebugEditorModel);
//# sourceMappingURL=debug-editor-model.js.map