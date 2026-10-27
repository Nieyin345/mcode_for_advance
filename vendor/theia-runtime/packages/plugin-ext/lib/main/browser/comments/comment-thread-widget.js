"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CommentAction = exports.CommentActions = exports.CommentsInlineAction = exports.CommentEditContainer = exports.CommentBody = exports.ReviewComment = exports.CommentForm = exports.CommentThreadWidget = exports.COMMENT_TITLE = exports.COMMENT_CONTEXT = exports.COMMENT_THREAD_CONTEXT = void 0;
const jsx_runtime_1 = require("@theia/core/shared/react/jsx-runtime");
// *****************************************************************************
// Copyright (C) 2020 Red Hat, Inc. and others.
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
const monaco_editor_zone_widget_1 = require("@theia/monaco/lib/browser/monaco-editor-zone-widget");
const plugin_api_rpc_model_1 = require("../../../common/plugin-api-rpc-model");
const comment_glyph_widget_1 = require("./comment-glyph-widget");
const browser_1 = require("@theia/core/lib/browser");
const React = require("@theia/core/shared/react");
const browser_2 = require("@theia/editor/lib/browser");
const common_1 = require("@theia/core/lib/common");
const monaco = require("@theia/monaco-editor-core");
const client_1 = require("@theia/core/shared/react-dom/client");
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// some code copied and modified from https://github.com/microsoft/vscode/blob/1.49.3/src/vs/workbench/contrib/comments/browser/commentThreadWidget.ts
exports.COMMENT_THREAD_CONTEXT = ['comment_thread-context-menu'];
exports.COMMENT_CONTEXT = ['comment-context-menu'];
exports.COMMENT_TITLE = ['comment-title-menu'];
class CommentThreadWidget extends browser_1.BaseWidget {
    constructor(editor, _owner, _commentThread, commentService, menus, commentsContext, contextKeyService, commands) {
        super();
        this._owner = _owner;
        this._commentThread = _commentThread;
        this.commentService = commentService;
        this.menus = menus;
        this.commentsContext = commentsContext;
        this.contextKeyService = contextKeyService;
        this.commands = commands;
        this.commentFormRef = React.createRef();
        this.toDispose.push(this.zoneWidget = new monaco_editor_zone_widget_1.MonacoEditorZoneWidget(editor));
        this.containerNodeRoot = (0, client_1.createRoot)(this.zoneWidget.containerNode);
        this.toDispose.push(this.commentGlyphWidget = new comment_glyph_widget_1.CommentGlyphWidget(editor));
        this.toDispose.push(this._commentThread.onDidChangeCollapsibleState(state => {
            if (state === plugin_api_rpc_model_1.CommentThreadCollapsibleState.Expanded && !this.isExpanded) {
                const lineNumber = this._commentThread.range?.startLineNumber ?? 0;
                this.display({ afterLineNumber: lineNumber, afterColumn: 1, heightInLines: 2 });
                return;
            }
            if (state === plugin_api_rpc_model_1.CommentThreadCollapsibleState.Collapsed && this.isExpanded) {
                this.hide();
                return;
            }
        }));
        this.commentsContext.commentIsEmpty.set(true);
        this.toDispose.push(this.zoneWidget.editor.onMouseDown(e => this.onEditorMouseDown(e)));
        this.toDispose.push(this._commentThread.onDidChangeCanReply(_canReply => {
            const commentForm = this.commentFormRef.current;
            if (commentForm) {
                commentForm.update();
            }
        }));
        this.toDispose.push(this._commentThread.onDidChangeState(_state => {
            this.update();
        }));
        const contextMenu = this.menus.getMenu(exports.COMMENT_THREAD_CONTEXT);
        contextMenu?.children.forEach(node => {
            if (node.onDidChange) {
                this.toDispose.push(node.onDidChange(() => {
                    const commentForm = this.commentFormRef.current;
                    if (commentForm) {
                        commentForm.update();
                    }
                }));
            }
        });
    }
    getGlyphPosition() {
        return this.commentGlyphWidget.getPosition();
    }
    collapse() {
        this._commentThread.collapsibleState = plugin_api_rpc_model_1.CommentThreadCollapsibleState.Collapsed;
        if (this._commentThread.comments && this._commentThread.comments.length === 0) {
            this.deleteCommentThread();
        }
        this.hide();
    }
    deleteCommentThread() {
        this.dispose();
        this.commentService.disposeCommentThread(this.owner, this._commentThread.threadId);
    }
    dispose() {
        super.dispose();
        if (this.commentGlyphWidget) {
            this.commentGlyphWidget.dispose();
        }
    }
    toggleExpand(lineNumber) {
        if (this.isExpanded) {
            this._commentThread.collapsibleState = plugin_api_rpc_model_1.CommentThreadCollapsibleState.Collapsed;
            this.hide();
            if (!this._commentThread.comments || !this._commentThread.comments.length) {
                this.deleteCommentThread();
            }
        }
        else {
            this._commentThread.collapsibleState = plugin_api_rpc_model_1.CommentThreadCollapsibleState.Expanded;
            this.display({ afterLineNumber: lineNumber, afterColumn: 1, heightInLines: 2 });
        }
    }
    hide() {
        this.zoneWidget.hide();
        this.isExpanded = false;
        super.hide();
    }
    display(options) {
        this.isExpanded = true;
        if (this._commentThread.collapsibleState && this._commentThread.collapsibleState !== plugin_api_rpc_model_1.CommentThreadCollapsibleState.Expanded) {
            return;
        }
        this.commentGlyphWidget.setLineNumber(options.afterLineNumber);
        this._commentThread.collapsibleState = plugin_api_rpc_model_1.CommentThreadCollapsibleState.Expanded;
        this.zoneWidget.show(options);
        this.update();
    }
    onEditorMouseDown(e) {
        const range = e.target.range;
        if (!range) {
            return;
        }
        if (!e.event.leftButton) {
            return;
        }
        if (e.target.type !== browser_2.MouseTargetType.GUTTER_LINE_DECORATIONS) {
            return;
        }
        const data = e.target.detail;
        const gutterOffsetX = data.offsetX - data.glyphMarginWidth - data.lineNumbersWidth - data.glyphMarginLeft;
        // don't collide with folding and git decorations
        if (gutterOffsetX > 14) {
            return;
        }
        const mouseDownInfo = { lineNumber: range.startLineNumber };
        const { lineNumber } = mouseDownInfo;
        if (!range || range.startLineNumber !== lineNumber) {
            return;
        }
        if (e.target.type !== browser_2.MouseTargetType.GUTTER_LINE_DECORATIONS) {
            return;
        }
        if (!e.target.element) {
            return;
        }
        if (this.commentGlyphWidget && this.commentGlyphWidget.getPosition() !== lineNumber) {
            return;
        }
        if (e.target.element.className.indexOf('comment-thread') >= 0) {
            this.toggleExpand(lineNumber);
            return;
        }
        if (this._commentThread.collapsibleState === plugin_api_rpc_model_1.CommentThreadCollapsibleState.Collapsed) {
            this.display({ afterLineNumber: mouseDownInfo.lineNumber, heightInLines: 2 });
        }
        else {
            this.hide();
        }
    }
    get owner() {
        return this._owner;
    }
    get commentThread() {
        return this._commentThread;
    }
    getThreadLabel() {
        let label;
        label = this._commentThread.label;
        if (label === undefined) {
            if (this._commentThread.comments && this._commentThread.comments.length) {
                const onlyUnique = (value, index, self) => self.indexOf(value) === index;
                const participantsList = this._commentThread.comments.filter(onlyUnique).map(comment => `@${comment.userName}`).join(', ');
                const resolutionState = this._commentThread.state === plugin_api_rpc_model_1.CommentThreadState.Resolved ? '(Resolved)' : '(Unresolved)';
                label = `Participants: ${participantsList} ${resolutionState}`;
            }
            else {
                label = 'Start discussion';
            }
        }
        return label;
    }
    update() {
        if (!this.isExpanded) {
            return;
        }
        this.render();
        const headHeight = Math.ceil(this.zoneWidget.editor.getOption(monaco.editor.EditorOption.lineHeight) * 1.2);
        const lineHeight = this.zoneWidget.editor.getOption(monaco.editor.EditorOption.lineHeight);
        const arrowHeight = Math.round(lineHeight / 3);
        const frameThickness = Math.round(lineHeight / 9) * 2;
        const body = this.zoneWidget.containerNode.getElementsByClassName('body')[0];
        const computedLinesNumber = Math.ceil((headHeight + (body?.clientHeight ?? 0) + arrowHeight + frameThickness + 8 /** margin bottom to avoid margin collapse */)
            / lineHeight);
        this.zoneWidget.show({ afterLineNumber: this._commentThread.range?.startLineNumber ?? 0, heightInLines: computedLinesNumber });
    }
    render() {
        const headHeight = Math.ceil(this.zoneWidget.editor.getOption(monaco.editor.EditorOption.lineHeight) * 1.2);
        this.containerNodeRoot.render((0, jsx_runtime_1.jsxs)("div", { className: 'review-widget', children: [(0, jsx_runtime_1.jsxs)("div", { className: 'head', style: { height: headHeight, lineHeight: `${headHeight}px` }, children: [(0, jsx_runtime_1.jsx)("div", { className: 'review-title', children: (0, jsx_runtime_1.jsx)("span", { className: 'filename', children: this.getThreadLabel() }) }), (0, jsx_runtime_1.jsx)("div", { className: 'review-actions', children: (0, jsx_runtime_1.jsx)("div", { className: 'monaco-action-bar animated', children: (0, jsx_runtime_1.jsx)("ul", { className: 'actions-container', role: 'toolbar', children: (0, jsx_runtime_1.jsx)("li", { className: 'action-item', role: 'presentation', children: (0, jsx_runtime_1.jsx)("a", { className: 'action-label codicon expand-review-action codicon-chevron-up', role: 'button', tabIndex: 0, title: 'Collapse', onClick: () => this.collapse() }) }) }) }) })] }), (0, jsx_runtime_1.jsxs)("div", { className: 'body', children: [(0, jsx_runtime_1.jsx)("div", { className: 'comments-container', role: 'presentation', tabIndex: 0, children: this._commentThread.comments?.map((comment, index) => (0, jsx_runtime_1.jsx)(ReviewComment, { contextKeyService: this.contextKeyService, commentsContext: this.commentsContext, menus: this.menus, comment: comment, commentForm: this.commentFormRef, commands: this.commands, commentThread: this._commentThread }, index)) }), (0, jsx_runtime_1.jsx)(CommentForm, { contextKeyService: this.contextKeyService, commentsContext: this.commentsContext, commands: this.commands, commentThread: this._commentThread, menus: this.menus, widget: this, ref: this.commentFormRef })] })] }));
    }
}
exports.CommentThreadWidget = CommentThreadWidget;
class CommentForm extends React.Component {
    update() {
        this.setState(this.state);
    }
    componentDidMount() {
        // Wait for the widget to be rendered.
        setTimeout(() => {
            this.inputRef.current?.focus();
        }, 100);
    }
    componentWillUnmount() {
        this.toDisposeOnUnmount.dispose();
    }
    constructor(props) {
        super(props);
        this.inputRef = React.createRef();
        this.inputValue = '';
        this.getInput = () => this.inputValue;
        this.toDisposeOnUnmount = new common_1.DisposableCollection();
        this.clearInput = () => {
            const input = this.inputRef.current;
            if (input) {
                this.inputValue = '';
                input.value = this.inputValue;
                this.props.commentsContext.commentIsEmpty.set(true);
            }
        };
        this.expand = () => {
            this.setState({ expanded: true });
            // Wait for the widget to be rendered.
            setTimeout(() => {
                // Update the widget's height.
                this.props.widget.update();
                this.inputRef.current?.focus();
            }, 100);
        };
        this.collapse = () => {
            this.setState({ expanded: false });
            // Wait for the widget to be rendered.
            setTimeout(() => {
                // Update the widget's height.
                this.props.widget.update();
            }, 100);
        };
        this.onInput = (event) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const value = event.target.value;
            if (this.inputValue.length === 0 || value.length === 0) {
                this.props.commentsContext.commentIsEmpty.set(value.length === 0);
            }
            this.inputValue = value;
        };
        this.state = {
            expanded: false
        };
        const setState = this.setState.bind(this);
        this.setState = newState => {
            setState(newState);
        };
    }
    /**
     * Renders the comment form with textarea, actions, and reply button.
     *
     * @returns The rendered comment form
     */
    renderCommentForm() {
        const { commentThread, commentsContext, contextKeyService, menus } = this.props;
        const hasExistingComments = commentThread.comments && commentThread.comments.length > 0;
        // Determine when to show the expanded form:
        // - When state.expanded is true (user clicked the reply button)
        // - When there are no existing comments (new thread)
        const shouldShowExpanded = this.state.expanded || (commentThread.comments && commentThread.comments.length === 0);
        return commentThread.canReply ? ((0, jsx_runtime_1.jsxs)("div", { className: `comment-form${shouldShowExpanded ? ' expand' : ''}`, children: [(0, jsx_runtime_1.jsx)("div", { className: 'theia-comments-input-message-container', children: (0, jsx_runtime_1.jsx)("textarea", { className: 'theia-comments-input-message theia-input', spellCheck: false, placeholder: hasExistingComments ? 'Reply...' : 'Type a new comment', onInput: this.onInput, 
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        onBlur: (event) => {
                            if (event.target.value.length > 0) {
                                return;
                            }
                            if (event.relatedTarget && event.relatedTarget.className === 'comments-button comments-text-button theia-button') {
                                this.state = { expanded: false };
                                return;
                            }
                            this.collapse();
                        }, ref: this.inputRef }) }), (0, jsx_runtime_1.jsx)(CommentActions, { menu: menus.getMenu(exports.COMMENT_THREAD_CONTEXT), menuPath: [], contextKeyService: contextKeyService, commentsContext: commentsContext, commentThread: commentThread, getInput: this.getInput, clearInput: this.clearInput }), (0, jsx_runtime_1.jsx)("button", { className: 'review-thread-reply-button', title: 'Reply...', onClick: this.expand, children: "Reply..." })] })) : null;
    }
    /**
     * Renders the author information section.
     *
     * @param authorInfo The author information to display
     * @returns The rendered author information section
     */
    renderAuthorInfo(authorInfo) {
        return ((0, jsx_runtime_1.jsx)("div", { className: 'avatar-container', children: authorInfo.iconPath && ((0, jsx_runtime_1.jsx)("img", { className: 'avatar', src: authorInfo.iconPath.toString() })) }));
    }
    render() {
        const { commentThread } = this.props;
        if (!commentThread.canReply) {
            return null;
        }
        // If there's author info, wrap in a container with author info on the left
        if (isCommentAuthorInformation(commentThread.canReply)) {
            return ((0, jsx_runtime_1.jsxs)("div", { className: 'review-comment', children: [this.renderAuthorInfo(commentThread.canReply), (0, jsx_runtime_1.jsxs)("div", { className: 'review-comment-contents', children: [(0, jsx_runtime_1.jsx)("div", { className: 'comment-title monaco-mouse-cursor-text', children: (0, jsx_runtime_1.jsx)("strong", { className: 'author', children: commentThread.canReply.name }) }), this.renderCommentForm()] })] }));
        }
        // Otherwise, just return the comment form
        return ((0, jsx_runtime_1.jsx)("div", { className: 'review-comment', children: (0, jsx_runtime_1.jsx)("div", { className: 'review-comment-contents', children: this.renderCommentForm() }) }));
    }
}
exports.CommentForm = CommentForm;
function isCommentAuthorInformation(item) {
    return (0, common_1.isObject)(item) && 'name' in item;
}
class ReviewComment extends React.Component {
    constructor(props) {
        super(props);
        this.detectHover = (element) => {
            if (element) {
                window.requestAnimationFrame(() => {
                    const hover = element.matches(':hover');
                    this.setState({ hover });
                });
            }
        };
        this.showHover = () => this.setState({ hover: true });
        this.hideHover = () => this.setState({ hover: false });
        this.state = {
            hover: false
        };
        const setState = this.setState.bind(this);
        this.setState = newState => {
            setState(newState);
        };
    }
    render() {
        const { comment, commentForm, contextKeyService, commentsContext, menus, commands, commentThread } = this.props;
        const commentUniqueId = comment.uniqueIdInThread;
        const { hover } = this.state;
        commentsContext.comment.set(comment.contextValue);
        return (0, jsx_runtime_1.jsxs)("div", { className: 'review-comment', tabIndex: -1, "aria-label": `${comment.userName}, ${comment.body.value}`, ref: this.detectHover, onMouseEnter: this.showHover, onMouseLeave: this.hideHover, children: [(0, jsx_runtime_1.jsx)("div", { className: 'avatar-container', children: (0, jsx_runtime_1.jsx)("img", { className: 'avatar', src: comment.userIconPath }) }), (0, jsx_runtime_1.jsxs)("div", { className: 'review-comment-contents', children: [(0, jsx_runtime_1.jsxs)("div", { className: 'comment-title monaco-mouse-cursor-text', children: [(0, jsx_runtime_1.jsx)("strong", { className: 'author', children: comment.userName }), (0, jsx_runtime_1.jsx)("small", { className: 'timestamp', children: this.localeDate(comment.timestamp) }), (0, jsx_runtime_1.jsx)("span", { className: 'isPending', children: comment.label }), (0, jsx_runtime_1.jsx)("div", { className: 'theia-comments-inline-actions-container', children: (0, jsx_runtime_1.jsx)("div", { className: 'theia-comments-inline-actions', role: 'toolbar', children: hover && menus.getMenuNode(exports.COMMENT_TITLE) && menus.getMenu(exports.COMMENT_TITLE)?.children.map((node, index) => common_1.CommandMenu.is(node) &&
                                            (0, jsx_runtime_1.jsx)(CommentsInlineAction, { node, nodePath: [...exports.COMMENT_TITLE, node.id], commands, commentThread, commentUniqueId,
                                                contextKeyService, commentsContext }, index)) }) })] }), (0, jsx_runtime_1.jsx)(CommentBody, { value: comment.body.value, isVisible: comment.mode === undefined || comment.mode === plugin_api_rpc_model_1.CommentMode.Preview }), (0, jsx_runtime_1.jsx)(CommentEditContainer, { contextKeyService: contextKeyService, commentsContext: commentsContext, menus: menus, comment: comment, commentThread: commentThread, commentForm: commentForm, commands: commands })] })] });
    }
    localeDate(timestamp) {
        if (timestamp === undefined) {
            return '';
        }
        const date = new Date(timestamp);
        if (!isNaN(date.getTime())) {
            return date.toLocaleString();
        }
        return '';
    }
}
exports.ReviewComment = ReviewComment;
class CommentBody extends React.Component {
    render() {
        const { value, isVisible } = this.props;
        if (!isVisible) {
            return false;
        }
        return (0, jsx_runtime_1.jsx)("div", { className: 'comment-body monaco-mouse-cursor-text', children: (0, jsx_runtime_1.jsx)("div", { children: (0, jsx_runtime_1.jsx)("p", { children: value }) }) });
    }
}
exports.CommentBody = CommentBody;
class CommentEditContainer extends React.Component {
    constructor() {
        super(...arguments);
        this.inputRef = React.createRef();
    }
    componentDidUpdate(prevProps, prevState) {
        const commentFormState = this.props.commentForm.current?.state;
        const mode = this.props.comment.mode;
        if (this.dirtyCommentMode !== mode || (this.dirtyCommentFormState !== commentFormState?.expanded && !commentFormState?.expanded)) {
            const currentInput = this.inputRef.current;
            if (currentInput) {
                // Wait for the widget to be rendered.
                setTimeout(() => {
                    currentInput.focus();
                    currentInput.setSelectionRange(currentInput.value.length, currentInput.value.length);
                }, 50);
            }
        }
        this.dirtyCommentMode = mode;
        this.dirtyCommentFormState = commentFormState?.expanded;
    }
    render() {
        const { menus, comment, commands, commentThread, contextKeyService, commentsContext } = this.props;
        if (!(comment.mode === plugin_api_rpc_model_1.CommentMode.Editing)) {
            return false;
        }
        return (0, jsx_runtime_1.jsxs)("div", { className: 'edit-container', children: [(0, jsx_runtime_1.jsx)("div", { className: 'edit-textarea', children: (0, jsx_runtime_1.jsx)("div", { className: 'theia-comments-input-message-container', children: (0, jsx_runtime_1.jsx)("textarea", { className: 'theia-comments-input-message theia-input', spellCheck: false, defaultValue: comment.body.value, ref: this.inputRef }) }) }), (0, jsx_runtime_1.jsx)("div", { className: 'form-actions', children: menus.getMenu(exports.COMMENT_CONTEXT)?.children.map((node, index) => {
                        const onClick = () => {
                            commands.executeCommand(node.id, {
                                commentControlHandle: commentThread.controllerHandle,
                                commentThreadHandle: commentThread.commentThreadHandle,
                                commentUniqueId: comment.uniqueIdInThread,
                                text: this.inputRef.current ? this.inputRef.current.value : ''
                            });
                        };
                        return common_1.CommandMenu.is(node) &&
                            (0, jsx_runtime_1.jsx)(CommentAction, { node, nodePath: [...exports.COMMENT_CONTEXT, node.id], comment,
                                commands, onClick, contextKeyService, commentsContext, commentThread }, index);
                    }) })] });
    }
}
exports.CommentEditContainer = CommentEditContainer;
class CommentsInlineAction extends React.Component {
    render() {
        const { node, nodePath, commands, contextKeyService, commentThread, commentUniqueId } = this.props;
        if (node.isVisible(nodePath, contextKeyService, undefined, {
            thread: commentThread,
            commentUniqueId
        })) {
            return false;
        }
        return (0, jsx_runtime_1.jsx)("div", { className: 'theia-comments-inline-action', children: (0, jsx_runtime_1.jsx)("a", { className: node.icon, title: node.label, onClick: () => {
                    commands.executeCommand(node.id, {
                        thread: commentThread,
                        commentUniqueId: commentUniqueId
                    });
                } }) });
    }
}
exports.CommentsInlineAction = CommentsInlineAction;
class CommentActions extends React.Component {
    render() {
        const { contextKeyService, commentsContext, menuPath, menu, commentThread, getInput, clearInput } = this.props;
        return (0, jsx_runtime_1.jsx)("div", { className: 'form-actions', children: menu?.children.map((node, index) => common_1.CommandMenu.is(node) &&
                (0, jsx_runtime_1.jsx)(CommentAction, { nodePath: menuPath, node: node, onClick: () => {
                        node.run([...menuPath, menu.id], {
                            thread: commentThread,
                            text: getInput()
                        });
                        clearInput();
                    }, commentThread: commentThread, contextKeyService: contextKeyService, commentsContext: commentsContext }, index)) });
    }
}
exports.CommentActions = CommentActions;
class CommentAction extends React.Component {
    render() {
        const classNames = ['comments-button', 'comments-text-button', 'theia-button'];
        const { node, nodePath, contextKeyService, onClick, commentThread } = this.props;
        if (!node.isVisible(nodePath, contextKeyService, undefined, {
            thread: commentThread
        })) {
            return false;
        }
        const isEnabled = node.isEnabled(nodePath, {
            thread: commentThread
        });
        if (!isEnabled) {
            classNames.push(browser_1.DISABLED_CLASS);
        }
        return (0, jsx_runtime_1.jsx)("button", { className: classNames.join(' '), tabIndex: 0, role: 'button', onClick: () => {
                if (isEnabled) {
                    onClick();
                }
            }, children: node.label });
    }
}
exports.CommentAction = CommentAction;
//# sourceMappingURL=comment-thread-widget.js.map