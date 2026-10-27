"use strict";
var ScmTreeWidget_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.ScmInlineAction = exports.ScmInlineActions = exports.ScmResourceFolderElement = exports.ScmResourceGroupElement = exports.ScmResourceComponent = exports.ScmElement = exports.ScmTreeWidget = void 0;
const tslib_1 = require("tslib");
const jsx_runtime_1 = require("@theia/core/shared/react/jsx-runtime");
// *****************************************************************************
// Copyright (C) 2020 Arm and others.
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
/* eslint-disable no-null/no-null, @typescript-eslint/no-explicit-any */
const React = require("@theia/core/shared/react");
const inversify_1 = require("@theia/core/shared/inversify");
const uri_1 = require("@theia/core/lib/common/uri");
const os_1 = require("@theia/core/lib/common/os");
const disposable_1 = require("@theia/core/lib/common/disposable");
const tree_1 = require("@theia/core/lib/browser/tree");
const tree_view_welcome_widget_1 = require("@theia/core/lib/browser/tree/tree-view-welcome-widget");
const scm_tree_model_1 = require("./scm-tree-model");
const menu_1 = require("@theia/core/lib/common/menu");
const browser_1 = require("@theia/core/lib/browser");
const scm_context_key_service_1 = require("./scm-context-key-service");
const browser_2 = require("@theia/editor/lib/browser");
const icon_theme_service_1 = require("@theia/core/lib/browser/icon-theme-service");
const color_registry_1 = require("@theia/core/lib/browser/color-registry");
const decorations_service_1 = require("@theia/core/lib/browser/decorations-service");
const scm_service_1 = require("./scm-service");
const files_1 = require("@theia/filesystem/lib/common/files");
const theming_1 = require("@theia/core/lib/browser/theming");
const core_1 = require("@theia/core");
let ScmTreeWidget = class ScmTreeWidget extends tree_view_welcome_widget_1.TreeViewWelcomeWidget {
    static { ScmTreeWidget_1 = this; }
    static { this.ID = 'scm-resource-widget'; }
    static { this.RESOURCE_GROUP_CONTEXT_MENU = ['RESOURCE_GROUP_CONTEXT_MENU']; }
    static { this.RESOURCE_GROUP_INLINE_MENU = ['RESOURCE_GROUP_CONTEXT_MENU', 'inline']; }
    static { this.RESOURCE_FOLDER_CONTEXT_MENU = ['RESOURCE_FOLDER_CONTEXT_MENU']; }
    static { this.RESOURCE_FOLDER_INLINE_MENU = ['RESOURCE_FOLDER_CONTEXT_MENU', 'inline']; }
    static { this.RESOURCE_CONTEXT_MENU = ['RESOURCE_CONTEXT_MENU']; }
    static { this.RESOURCE_INLINE_MENU = ['RESOURCE_CONTEXT_MENU', 'inline']; }
    constructor(props, treeModel, contextMenuRenderer) {
        super(props, treeModel, contextMenuRenderer);
        this.id = ScmTreeWidget_1.ID;
        this.addClass('groups-outer-container');
    }
    init() {
        super.init();
        this.toDispose.push(this.themeService.onDidColorThemeChange(() => this.update()));
        this.toDispose.push(this.scmService.onDidChangeSelectedRepository(() => this.update()));
        this.toDispose.push(this.contextService.onDidChange(e => {
            if (e.affects(new Set(['isWorkspaceTrusted']))) {
                this.update();
            }
        }));
    }
    shouldShowWelcomeView() {
        return this.scmService.selectedRepository === undefined
            || !this.contextService.match('isWorkspaceTrusted');
    }
    set viewMode(id) {
        // Close the search box because the structure of the tree will change dramatically
        // and the search results will be out of date.
        this.searchBox.hide();
        this.model.viewMode = id;
    }
    get viewMode() {
        return this.model.viewMode;
    }
    /**
     * Render the node given the tree node and node properties.
     * @param node the tree node.
     * @param props the node properties.
     */
    renderNode(node, props) {
        if (!tree_1.TreeNode.isVisible(node)) {
            return undefined;
        }
        const attributes = this.createNodeAttributes(node, props);
        const label = this.labelProvider.getName(node);
        const searchHighlights = this.searchHighlights?.get(node.id);
        // The group nodes should not be subject to highlighting.
        const caption = (searchHighlights && !scm_tree_model_1.ScmFileChangeGroupNode.is(node)) ? this.toReactNode(label, searchHighlights) : label;
        if (scm_tree_model_1.ScmFileChangeGroupNode.is(node)) {
            const content = (0, jsx_runtime_1.jsx)(ScmResourceGroupElement, { model: this.model, treeNode: node, renderExpansionToggle: () => this.renderExpansionToggle(node, props), contextMenuRenderer: this.contextMenuRenderer, menus: this.menus, contextKeys: this.contextKeys, labelProvider: this.labelProvider, corePreferences: this.corePreferences, caption: caption }, `${node.groupId}`);
            return React.createElement('div', attributes, content);
        }
        if (scm_tree_model_1.ScmFileChangeFolderNode.is(node)) {
            const content = (0, jsx_runtime_1.jsx)(ScmResourceFolderElement, { model: this.model, treeNode: node, sourceUri: node.sourceUri, renderExpansionToggle: () => this.renderExpansionToggle(node, props), contextMenuRenderer: this.contextMenuRenderer, menus: this.menus, contextKeys: this.contextKeys, labelProvider: this.labelProvider, corePreferences: this.corePreferences, caption: caption }, String(node.sourceUri));
            return React.createElement('div', attributes, content);
        }
        if (scm_tree_model_1.ScmFileChangeNode.is(node)) {
            const parentPath = (node.parent && scm_tree_model_1.ScmFileChangeFolderNode.is(node.parent))
                ? new uri_1.default(node.parent.sourceUri) : new uri_1.default(this.model.rootUri);
            const content = (0, jsx_runtime_1.jsx)(ScmResourceComponent, { model: this.model, treeNode: node, contextMenuRenderer: this.contextMenuRenderer, menus: this.menus, contextKeys: this.contextKeys, labelProvider: this.labelProvider, corePreferences: this.corePreferences, caption: caption, ...this.props,
                parentPath,
                sourceUri: node.sourceUri,
                decoration: this.decorationsService.getDecoration(new uri_1.default(node.sourceUri), true)[0],
                colors: this.colors,
                isLightTheme: this.isCurrentThemeLight(),
                renderExpansionToggle: () => this.renderExpansionToggle(node, props) }, node.sourceUri);
            return React.createElement('div', attributes, content);
        }
        return super.renderNode(node, props);
    }
    createContainerAttributes() {
        if (this.model.canTabToWidget()) {
            return {
                ...super.createContainerAttributes(),
                tabIndex: 0
            };
        }
        return super.createContainerAttributes();
    }
    /**
     * The ARROW_LEFT key controls both the movement around the file tree and also
     * the movement through the change chunks within a file.
     *
     * If the selected tree node is a folder then the ARROW_LEFT key behaves exactly
     * as it does in explorer.  It collapses the tree node if the folder is expanded and
     * it moves the selection up to the parent folder if the folder is collapsed (no-op if no parent folder, as
     * group headers are not selectable).  This behavior is the default behavior implemented
     * in the TreeWidget super class.
     *
     * If the selected tree node is a file then the ARROW_LEFT key moves up through the
     * change chunks within each file.  If the selected chunk is the first chunk in the file
     * then the file selection is moved to the previous file (no-op if no previous file).
     *
     * Note that when cursoring through change chunks, the ARROW_LEFT key cannot be used to
     * move up through the parent folders of the file tree.  If users want to do this, using
     * keys only, then they must press ARROW_UP repeatedly until the selected node is the folder
     * node and then press ARROW_LEFT.
     */
    async handleLeft(event) {
        if (this.model.selectedNodes.length === 1) {
            const selectedNode = this.model.selectedNodes[0];
            if (scm_tree_model_1.ScmFileChangeNode.is(selectedNode)) {
                const selectedResource = this.model.getResourceFromNode(selectedNode);
                if (!selectedResource) {
                    return super.handleLeft(event);
                }
                const widget = await this.openResource(selectedResource);
                if (widget) {
                    const diffNavigator = this.diffNavigatorProvider(widget.editor);
                    if (diffNavigator.hasPrevious()) {
                        diffNavigator.previous();
                    }
                    else {
                        const previousNode = this.moveToPreviousFileNode();
                        if (previousNode) {
                            const previousResource = this.model.getResourceFromNode(previousNode);
                            if (previousResource) {
                                this.openResource(previousResource);
                            }
                        }
                    }
                    return;
                }
            }
        }
        return super.handleLeft(event);
    }
    /**
     * The ARROW_RIGHT key controls both the movement around the file tree and also
     * the movement through the change chunks within a file.
     *
     * If the selected tree node is a folder then the ARROW_RIGHT key behaves exactly
     * as it does in explorer.  It expands the tree node if the folder is collapsed and
     * it moves the selection to the first child node if the folder is expanded.
     * This behavior is the default behavior implemented
     * in the TreeWidget super class.
     *
     * If the selected tree node is a file then the ARROW_RIGHT key moves down through the
     * change chunks within each file.  If the selected chunk is the last chunk in the file
     * then the file selection is moved to the next file (no-op if no next file).
     */
    async handleRight(event) {
        if (this.model.selectedNodes.length === 0) {
            const firstNode = this.getFirstSelectableNode();
            // Selects the first visible resource as none are selected.
            if (!firstNode) {
                return;
            }
            this.model.selectNode(firstNode);
            return;
        }
        if (this.model.selectedNodes.length === 1) {
            const selectedNode = this.model.selectedNodes[0];
            if (scm_tree_model_1.ScmFileChangeNode.is(selectedNode)) {
                const selectedResource = this.model.getResourceFromNode(selectedNode);
                if (!selectedResource) {
                    return super.handleRight(event);
                }
                const widget = await this.openResource(selectedResource);
                if (widget) {
                    const diffNavigator = this.diffNavigatorProvider(widget.editor);
                    if (diffNavigator.hasNext()) {
                        diffNavigator.next();
                    }
                    else {
                        const nextNode = this.moveToNextFileNode();
                        if (nextNode) {
                            const nextResource = this.model.getResourceFromNode(nextNode);
                            if (nextResource) {
                                this.openResource(nextResource);
                            }
                        }
                    }
                }
                return;
            }
        }
        return super.handleRight(event);
    }
    handleEnter(event) {
        if (this.model.selectedNodes.length === 1) {
            const selectedNode = this.model.selectedNodes[0];
            if (scm_tree_model_1.ScmFileChangeNode.is(selectedNode)) {
                const selectedResource = this.model.getResourceFromNode(selectedNode);
                if (selectedResource) {
                    this.openResource(selectedResource);
                }
                return;
            }
        }
        super.handleEnter(event);
    }
    async goToPreviousChange() {
        if (this.model.selectedNodes.length === 1) {
            const selectedNode = this.model.selectedNodes[0];
            if (scm_tree_model_1.ScmFileChangeNode.is(selectedNode)) {
                if (scm_tree_model_1.ScmFileChangeNode.is(selectedNode)) {
                    const selectedResource = this.model.getResourceFromNode(selectedNode);
                    if (!selectedResource) {
                        return;
                    }
                    const widget = await this.openResource(selectedResource);
                    if (widget) {
                        const diffNavigator = this.diffNavigatorProvider(widget.editor);
                        if (diffNavigator.hasPrevious()) {
                            diffNavigator.previous();
                        }
                        else {
                            const previousNode = this.moveToPreviousFileNode();
                            if (previousNode) {
                                const previousResource = this.model.getResourceFromNode(previousNode);
                                if (previousResource) {
                                    this.openResource(previousResource);
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    async goToNextChange() {
        if (this.model.selectedNodes.length === 0) {
            const firstNode = this.getFirstSelectableNode();
            // Selects the first visible resource as none are selected.
            if (!firstNode) {
                return;
            }
            this.model.selectNode(firstNode);
            return;
        }
        if (this.model.selectedNodes.length === 1) {
            const selectedNode = this.model.selectedNodes[0];
            if (scm_tree_model_1.ScmFileChangeNode.is(selectedNode)) {
                const selectedResource = this.model.getResourceFromNode(selectedNode);
                if (!selectedResource) {
                    return;
                }
                const widget = await this.openResource(selectedResource);
                if (widget) {
                    const diffNavigator = this.diffNavigatorProvider(widget.editor);
                    if (diffNavigator.hasNext()) {
                        diffNavigator.next();
                    }
                    else {
                        const nextNode = this.moveToNextFileNode();
                        if (nextNode) {
                            const nextResource = this.model.getResourceFromNode(nextNode);
                            if (nextResource) {
                                this.openResource(nextResource);
                            }
                        }
                    }
                }
            }
        }
    }
    selectNodeByUri(uri) {
        // Use the URI as-is without coercing the scheme.
        // Only URIs whose scheme matches the SCM resource sourceUri scheme (typically 'file')
        // will find a matching node. Diff editors for staged changes (git: scheme) won't match,
        // which is correct VS Code behavior. See https://github.com/eclipse-theia/theia/issues/16412
        const uriString = uri.toString();
        // Iterate backwards (last group first) to match VS Code behavior.
        const groups = this.model.groups;
        for (let i = groups.length - 1; i >= 0; i--) {
            const id = `${groups[i].id}:${uriString}`;
            const node = this.model.getNode(id);
            if (tree_1.SelectableTreeNode.is(node)) {
                this.model.selectNode(node);
                return;
            }
        }
    }
    getFirstSelectableNode() {
        if (this.model.root) {
            const root = this.model.root;
            const groupNode = root.children[0];
            return groupNode.children[0];
        }
    }
    moveToPreviousFileNode() {
        let previousNode = this.model.getPrevSelectableNode();
        while (previousNode) {
            if (scm_tree_model_1.ScmFileChangeNode.is(previousNode)) {
                this.model.selectNode(previousNode);
                return previousNode;
            }
            previousNode = this.model.getPrevSelectableNode(previousNode);
        }
        ;
    }
    moveToNextFileNode() {
        let nextNode = this.model.getNextSelectableNode();
        while (nextNode) {
            if (scm_tree_model_1.ScmFileChangeNode.is(nextNode)) {
                this.model.selectNode(nextNode);
                return nextNode;
            }
            nextNode = this.model.getNextSelectableNode(nextNode);
        }
        ;
    }
    async openResource(resource) {
        try {
            await resource.open();
        }
        catch (e) {
            this.logger.error('Failed to open a SCM resource', e);
            return undefined;
        }
        let standaloneEditor;
        const resourcePath = resource.sourceUri.path.toString();
        for (const widget of this.editorManager.all) {
            const resourceUri = widget.editor.document.uri;
            const editorResourcePath = new uri_1.default(resourceUri).path.toString();
            if (resourcePath === editorResourcePath) {
                if (widget.editor.uri.scheme === browser_1.DiffUris.DIFF_SCHEME) {
                    // prefer diff editor
                    return widget;
                }
                else {
                    standaloneEditor = widget;
                }
            }
            if (widget.editor.uri.scheme === browser_1.DiffUris.DIFF_SCHEME
                && resourceUri === resource.sourceUri.toString()) {
                return widget;
            }
        }
        // fallback to standalone editor
        return standaloneEditor;
    }
    getPaddingLeft(node, props) {
        if (this.viewMode === 'list') {
            if (props.depth === 1) {
                return this.props.expansionTogglePadding;
            }
        }
        return super.getPaddingLeft(node, props);
    }
    getDepthPadding(depth) {
        return super.getDepthPadding(depth) + 5;
    }
    isCurrentThemeLight() {
        const type = this.themeService.getCurrentTheme().type;
        return type.toLocaleLowerCase().includes('light');
    }
    needsExpansionTogglePadding(node) {
        const theme = this.iconThemeService.getDefinition(this.iconThemeService.current);
        if (theme && (theme.hidesExplorerArrows || (theme.hasFileIcons && !theme.hasFolderIcons))) {
            return false;
        }
        return super.needsExpansionTogglePadding(node);
    }
};
exports.ScmTreeWidget = ScmTreeWidget;
tslib_1.__decorate([
    (0, inversify_1.inject)(menu_1.MenuModelRegistry),
    tslib_1.__metadata("design:type", menu_1.MenuModelRegistry)
], ScmTreeWidget.prototype, "menus", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(scm_context_key_service_1.ScmContextKeyService),
    tslib_1.__metadata("design:type", scm_context_key_service_1.ScmContextKeyService)
], ScmTreeWidget.prototype, "contextKeys", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_2.EditorManager),
    tslib_1.__metadata("design:type", browser_2.EditorManager)
], ScmTreeWidget.prototype, "editorManager", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_2.DiffNavigatorProvider),
    tslib_1.__metadata("design:type", Function)
], ScmTreeWidget.prototype, "diffNavigatorProvider", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(icon_theme_service_1.IconThemeService),
    tslib_1.__metadata("design:type", icon_theme_service_1.IconThemeService)
], ScmTreeWidget.prototype, "iconThemeService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(decorations_service_1.DecorationsService),
    tslib_1.__metadata("design:type", Object)
], ScmTreeWidget.prototype, "decorationsService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(color_registry_1.ColorRegistry),
    tslib_1.__metadata("design:type", color_registry_1.ColorRegistry)
], ScmTreeWidget.prototype, "colors", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(theming_1.ThemeService),
    tslib_1.__metadata("design:type", theming_1.ThemeService)
], ScmTreeWidget.prototype, "themeService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.ILogger),
    (0, inversify_1.named)('scm:ScmTreeWidget'),
    tslib_1.__metadata("design:type", Object)
], ScmTreeWidget.prototype, "logger", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(scm_service_1.ScmService),
    tslib_1.__metadata("design:type", scm_service_1.ScmService)
], ScmTreeWidget.prototype, "scmService", void 0);
tslib_1.__decorate([
    (0, inversify_1.postConstruct)(),
    tslib_1.__metadata("design:type", Function),
    tslib_1.__metadata("design:paramtypes", []),
    tslib_1.__metadata("design:returntype", void 0)
], ScmTreeWidget.prototype, "init", null);
exports.ScmTreeWidget = ScmTreeWidget = ScmTreeWidget_1 = tslib_1.__decorate([
    (0, inversify_1.injectable)(),
    tslib_1.__param(0, (0, inversify_1.inject)(tree_1.TreeProps)),
    tslib_1.__param(1, (0, inversify_1.inject)(tree_1.TreeModel)),
    tslib_1.__param(2, (0, inversify_1.inject)(browser_1.ContextMenuRenderer)),
    tslib_1.__metadata("design:paramtypes", [Object, scm_tree_model_1.ScmTreeModel,
        browser_1.ContextMenuRenderer])
], ScmTreeWidget);
(function (ScmTreeWidget) {
    let Styles;
    (function (Styles) {
        Styles.NO_SELECT = 'no-select';
    })(Styles = ScmTreeWidget.Styles || (ScmTreeWidget.Styles = {}));
})(ScmTreeWidget || (exports.ScmTreeWidget = ScmTreeWidget = {}));
class ScmElement extends React.Component {
    constructor(props) {
        super(props);
        this.toDisposeOnUnmount = new disposable_1.DisposableCollection();
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
        this.renderContextMenu = (event) => {
            event.preventDefault();
            const { treeNode: node, contextMenuRenderer } = this.props;
            this.props.model.execInNodeContext(node, () => {
                contextMenuRenderer.render({
                    menuPath: this.contextMenuPath,
                    anchor: event.nativeEvent,
                    args: this.contextMenuArgs,
                    context: event.currentTarget
                });
            });
        };
        this.state = {
            hover: false
        };
        const setState = this.setState.bind(this);
        this.setState = newState => {
            if (!this.toDisposeOnUnmount.disposed) {
                setState(newState);
            }
        };
    }
    componentDidMount() {
        this.toDisposeOnUnmount.push(disposable_1.Disposable.create(() => { }));
    }
    componentWillUnmount() {
        this.toDisposeOnUnmount.dispose();
    }
}
exports.ScmElement = ScmElement;
class ScmResourceComponent extends ScmElement {
    constructor() {
        super(...arguments);
        this.open = () => {
            const resource = this.props.model.getResourceFromNode(this.props.treeNode);
            if (resource) {
                resource.open();
            }
        };
        this.contextMenuPath = ScmTreeWidget.RESOURCE_CONTEXT_MENU;
        /**
         * Handle the single clicking of nodes present in the widget.
         */
        this.handleClick = (event) => {
            if (!this.hasCtrlCmdOrShiftMask(event)) {
                // Determine the behavior based on the preference value.
                const isSingle = this.props.corePreferences && this.props.corePreferences['workbench.list.openMode'] === 'singleClick';
                if (isSingle) {
                    this.open();
                }
            }
        };
        /**
         * Handle the double clicking of nodes present in the widget.
         */
        this.handleDoubleClick = () => {
            // Determine the behavior based on the preference value.
            const isDouble = this.props.corePreferences && this.props.corePreferences['workbench.list.openMode'] === 'doubleClick';
            // Nodes should only be opened through double clicking if the correct preference is set.
            if (isDouble) {
                this.open();
            }
        };
    }
    render() {
        const { hover } = this.state;
        const { model, treeNode, colors, parentPath, sourceUri, decoration, labelProvider, menus, contextKeys, caption, isLightTheme } = this.props;
        const resourceUri = new uri_1.default(sourceUri);
        const decorationIcon = treeNode.decorations;
        const themedIcon = isLightTheme ? decorationIcon?.icon : decorationIcon?.iconDark;
        const classNames = themedIcon ? ['decoration-icon', themedIcon] : ['decoration-icon', 'status'];
        const icon = labelProvider.getIcon(resourceUri);
        const color = decoration && decoration.colorId && !themedIcon ? `var(${colors.toCssVariableName(decoration.colorId)})` : '';
        const letter = decoration && decoration.letter && !themedIcon ? decoration.letter : '';
        const tooltip = decoration && decoration.tooltip || '';
        const textDecoration = treeNode.decorations?.strikeThrough === true ? 'line-through' : 'normal';
        const relativePath = parentPath.relative(resourceUri.parent);
        const path = relativePath ? relativePath.fsPath() : labelProvider.getLongName(resourceUri.parent);
        const title = tooltip.length !== 0
            ? `${resourceUri.path.fsPath()} • ${tooltip}`
            : resourceUri.path.fsPath();
        return (0, jsx_runtime_1.jsxs)("div", { className: `scmItem ${tree_1.TREE_NODE_SEGMENT_CLASS} ${tree_1.TREE_NODE_SEGMENT_GROW_CLASS}`, onContextMenu: this.renderContextMenu, onMouseEnter: this.showHover, onMouseLeave: this.hideHover, ref: this.detectHover, title: title, onClick: this.handleClick, onDoubleClick: this.handleDoubleClick, children: [(0, jsx_runtime_1.jsx)("span", { className: icon + ' file-icon' }), this.props.renderExpansionToggle(), (0, jsx_runtime_1.jsxs)("div", { className: `noWrapInfo ${tree_1.TREE_NODE_SEGMENT_GROW_CLASS}`, children: [(0, jsx_runtime_1.jsx)("span", { className: 'name', style: { textDecoration }, children: caption }), (0, jsx_runtime_1.jsx)("span", { className: 'path', style: { textDecoration }, children: path })] }), (0, jsx_runtime_1.jsx)(ScmInlineActions, { hover,
                    menu: menus.getMenu(ScmTreeWidget.RESOURCE_INLINE_MENU),
                    menuPath: ScmTreeWidget.RESOURCE_INLINE_MENU,
                    args: this.contextMenuArgs,
                    contextKeys,
                    model,
                    treeNode, children: (0, jsx_runtime_1.jsx)("div", { title: tooltip, className: classNames.join(' '), style: { color }, children: letter }) })] }, sourceUri);
    }
    get contextMenuArgs() {
        if (!this.props.model.selectedNodes.some(node => scm_tree_model_1.ScmFileChangeNode.is(node) && node === this.props.treeNode)) {
            // Clicked node is not in selection, so ignore selection and action on just clicked node
            return this.singleNodeArgs;
        }
        else {
            return this.props.model.getSelectionArgs(this.props.model.selectedNodes);
        }
    }
    get singleNodeArgs() {
        const selectedResource = this.props.model.getResourceFromNode(this.props.treeNode);
        if (selectedResource) {
            return [selectedResource];
        }
        else {
            // Repository status not yet available. Empty args disables the action.
            return [];
        }
    }
    hasCtrlCmdOrShiftMask(event) {
        const { metaKey, ctrlKey, shiftKey } = event;
        return (os_1.isOSX && metaKey) || ctrlKey || shiftKey;
    }
}
exports.ScmResourceComponent = ScmResourceComponent;
class ScmResourceGroupElement extends ScmElement {
    constructor() {
        super(...arguments);
        this.contextMenuPath = ScmTreeWidget.RESOURCE_GROUP_CONTEXT_MENU;
    }
    render() {
        const { hover } = this.state;
        const { model, treeNode, menus, contextKeys, caption } = this.props;
        return (0, jsx_runtime_1.jsxs)("div", { className: `theia-header scm-theia-header ${tree_1.TREE_NODE_SEGMENT_GROW_CLASS}`, onContextMenu: this.renderContextMenu, onMouseEnter: this.showHover, onMouseLeave: this.hideHover, ref: this.detectHover, children: [this.props.renderExpansionToggle(), (0, jsx_runtime_1.jsx)("div", { className: `noWrapInfo ${tree_1.TREE_NODE_SEGMENT_GROW_CLASS}`, children: caption }), (0, jsx_runtime_1.jsx)(ScmInlineActions, { hover,
                    args: this.contextMenuArgs,
                    menu: menus.getMenu(ScmTreeWidget.RESOURCE_GROUP_INLINE_MENU),
                    menuPath: ScmTreeWidget.RESOURCE_GROUP_INLINE_MENU,
                    contextKeys,
                    model,
                    treeNode, children: this.renderChangeCount() })] });
    }
    renderChangeCount() {
        const group = this.props.model.getResourceGroupFromNode(this.props.treeNode);
        return (0, jsx_runtime_1.jsx)("div", { className: 'notification-count-container scm-change-count', children: (0, jsx_runtime_1.jsx)("span", { className: 'notification-count', children: group ? group.resources.length : 0 }) });
    }
    get contextMenuArgs() {
        const group = this.props.model.getResourceGroupFromNode(this.props.treeNode);
        if (group) {
            return [group];
        }
        else {
            // Repository status not yet available. Empty args disables the action.
            return [];
        }
    }
}
exports.ScmResourceGroupElement = ScmResourceGroupElement;
class ScmResourceFolderElement extends ScmElement {
    constructor() {
        super(...arguments);
        this.contextMenuPath = ScmTreeWidget.RESOURCE_FOLDER_CONTEXT_MENU;
    }
    render() {
        const { hover } = this.state;
        const { model, treeNode, sourceUri, labelProvider, menus, contextKeys, caption } = this.props;
        const sourceFileStat = files_1.FileStat.dir(sourceUri);
        const icon = labelProvider.getIcon(sourceFileStat);
        const title = new uri_1.default(sourceUri).path.fsPath();
        return (0, jsx_runtime_1.jsxs)("div", { className: `scmItem  ${tree_1.TREE_NODE_SEGMENT_CLASS} ${tree_1.TREE_NODE_SEGMENT_GROW_CLASS} ${ScmTreeWidget.Styles.NO_SELECT}`, title: title, onContextMenu: this.renderContextMenu, onMouseEnter: this.showHover, onMouseLeave: this.hideHover, ref: this.detectHover, children: [this.props.renderExpansionToggle(), (0, jsx_runtime_1.jsx)("span", { className: icon + ' file-icon' }), (0, jsx_runtime_1.jsx)("div", { className: `noWrapInfo ${tree_1.TREE_NODE_SEGMENT_GROW_CLASS}`, children: (0, jsx_runtime_1.jsx)("span", { className: 'name', children: caption }) }), (0, jsx_runtime_1.jsx)(ScmInlineActions, { hover,
                    menu: menus.getMenu(ScmTreeWidget.RESOURCE_FOLDER_INLINE_MENU),
                    menuPath: ScmTreeWidget.RESOURCE_FOLDER_INLINE_MENU,
                    args: this.contextMenuArgs,
                    contextKeys,
                    model,
                    treeNode })] }, sourceUri);
    }
    get contextMenuArgs() {
        if (!this.props.model.selectedNodes.some(node => scm_tree_model_1.ScmFileChangeFolderNode.is(node) && node.sourceUri === this.props.sourceUri)) {
            // Clicked node is not in selection, so ignore selection and action on just clicked node
            return this.singleNodeArgs;
        }
        else {
            return this.props.model.getSelectionArgs(this.props.model.selectedNodes);
        }
    }
    get singleNodeArgs() {
        return this.props.model.getResourcesFromFolderNode(this.props.treeNode);
    }
}
exports.ScmResourceFolderElement = ScmResourceFolderElement;
class ScmInlineActions extends React.Component {
    render() {
        const { hover, menu, menuPath, args, model, treeNode, contextKeys, children } = this.props;
        return (0, jsx_runtime_1.jsxs)("div", { className: 'theia-scm-inline-actions-container', children: [(0, jsx_runtime_1.jsx)("div", { className: 'theia-scm-inline-actions', children: hover && menu?.children
                        .map((node, index) => menu_1.CommandMenu.is(node) &&
                        (0, jsx_runtime_1.jsx)(ScmInlineAction, { node, menuPath, args, model, treeNode, contextKeys }, index)) }), children] });
    }
}
exports.ScmInlineActions = ScmInlineActions;
class ScmInlineAction extends React.Component {
    constructor() {
        super(...arguments);
        this.execute = (event) => {
            event.stopPropagation();
            const { node, menuPath, args } = this.props;
            node.run(menuPath, ...args);
        };
    }
    render() {
        const { node, menuPath, model, treeNode, args, contextKeys } = this.props;
        let isActive = false;
        model.execInNodeContext(treeNode, () => {
            isActive = node.isVisible(menuPath, contextKeys, undefined, ...args);
        });
        if (!isActive) {
            return false;
        }
        return (0, jsx_runtime_1.jsx)("div", { className: 'theia-scm-inline-action', children: (0, jsx_runtime_1.jsx)("a", { className: `${node.icon} ${browser_1.ACTION_ITEM}`, title: node.label, onClick: this.execute }) });
    }
}
exports.ScmInlineAction = ScmInlineAction;
//# sourceMappingURL=scm-tree-widget.js.map