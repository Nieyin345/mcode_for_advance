"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NotebookCellListView = void 0;
exports.observeCellHeight = observeCellHeight;
exports.NotebookCellDivider = NotebookCellDivider;
const jsx_runtime_1 = require("@theia/core/shared/react/jsx-runtime");
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
const React = require("@theia/core/shared/react");
const common_1 = require("../../common");
const browser_1 = require("@theia/core/lib/browser");
const core_1 = require("@theia/core");
const notebook_actions_contribution_1 = require("../contributions/notebook-actions-contribution");
const notebook_cell_actions_contribution_1 = require("../contributions/notebook-cell-actions-contribution");
function observeCellHeight(ref, cell) {
    if (ref) {
        cell.cellHeight = ref?.getBoundingClientRect().height ?? 0;
        new ResizeObserver(entries => cell.cellHeight = ref?.getBoundingClientRect().height ?? 0).observe(ref);
    }
}
class NotebookCellListView extends React.Component {
    constructor(props) {
        super(props);
        this.toDispose = new core_1.DisposableCollection();
        this.cellListRef = React.createRef();
        this.state = { selectedCell: props.notebookViewModel.selectedCell, dragOverIndicator: undefined, scrollIntoView: true };
        this.toDispose.push(props.notebookModel.onDidAddOrRemoveCell(e => {
            if (e.newCellIds && e.newCellIds.length > 0) {
                this.setState({
                    ...this.state,
                    selectedCell: props.notebookViewModel.selectedCell,
                    scrollIntoView: true
                });
            }
            else {
                this.setState({
                    ...this.state,
                    selectedCell: props.notebookViewModel.selectedCell,
                    scrollIntoView: false
                });
            }
        }));
        this.toDispose.push(props.notebookModel.onDidChangeContent(events => {
            if (events.some(e => e.kind === common_1.NotebookCellsChangeType.Move)) {
                // When a cell has been moved, we need to rerender the whole component
                this.forceUpdate();
            }
        }));
        this.toDispose.push(props.notebookViewModel.onDidChangeSelectedCell(e => {
            this.setState({
                ...this.state,
                selectedCell: e.cell,
                scrollIntoView: e.scrollIntoView
            });
        }));
        this.toDispose.push((0, browser_1.onDomEvent)(document, 'focusin', () => {
            (0, browser_1.animationFrame)().then(() => {
                if (!this.cellListRef.current) {
                    return;
                }
                let hasCellFocus = false;
                let hasFocus = false;
                if (this.cellListRef.current.contains(document.activeElement)) {
                    if (this.props.notebookViewModel.selectedCell) {
                        hasCellFocus = true;
                    }
                    hasFocus = true;
                }
                this.props.notebookContext.changeCellFocus(hasCellFocus);
                this.props.notebookContext.changeCellListFocus(hasFocus);
            });
        }));
    }
    componentWillUnmount() {
        this.toDispose.dispose();
    }
    render() {
        return (0, jsx_runtime_1.jsxs)("ul", { className: 'theia-notebook-cell-list', ref: this.cellListRef, onDragStart: e => this.onDragStart(e), children: [this.props.notebookModel.getVisibleCells()
                    .map((cell, index) => {
                    const cellViewModel = this.props.notebookViewModel.cellViewModels.get(cell.handle);
                    return (0, jsx_runtime_1.jsxs)(React.Fragment, { children: [(0, jsx_runtime_1.jsx)(NotebookCellDivider, { menuRegistry: this.props.menuRegistry, isVisible: () => this.isEnabled(), onAddNewCell: handler => this.onAddNewCell(handler, index), onDrop: e => this.onDrop(e, index), onDragOver: e => this.onDragOver(e, cell, 'top') }), (0, jsx_runtime_1.jsx)(CellDropIndicator, { visible: this.shouldRenderDragOverIndicator(cell, 'top') }), (0, jsx_runtime_1.jsxs)("li", { className: 'theia-notebook-cell' + (this.state.selectedCell === cell ? ' focused' : '') + (this.isEnabled() ? ' draggable' : ''), onDragEnd: e => {
                                    NotebookCellListView.dragGhost?.remove();
                                    this.setState({ ...this.state, dragOverIndicator: undefined });
                                }, onDragOver: e => this.onDragOver(e, cell), onDrop: e => this.onDrop(e, index), draggable: true, tabIndex: -1, "data-cell-handle": cell.handle, ref: ref => {
                                    if (ref && cell === this.state.selectedCell && this.state.scrollIntoView) {
                                        ref.scrollIntoView({ block: 'nearest' });
                                        if (cell.cellKind === common_1.CellKind.Markup && !cellViewModel?.editing) {
                                            ref.focus();
                                        }
                                    }
                                }, onClick: e => {
                                    this.setState({ ...this.state, selectedCell: cell });
                                    this.props.notebookViewModel.setSelectedCell(cell, false);
                                }, children: [(0, jsx_runtime_1.jsxs)("div", { className: 'theia-notebook-cell-sidebar', children: [(0, jsx_runtime_1.jsx)("div", { className: 'theia-notebook-cell-marker' + (this.state.selectedCell === cell ? ' theia-notebook-cell-marker-selected' : '') }), this.renderCellSidebar(cell)] }), (0, jsx_runtime_1.jsx)("div", { className: 'theia-notebook-cell-content', children: this.renderCellContent(cell, index) }), this.state.selectedCell === cell &&
                                        this.props.toolbarRenderer.renderCellToolbar(notebook_cell_actions_contribution_1.NotebookCellActionContribution.ACTION_MENU, cell, {
                                            contextMenuArgs: () => [cell], commandArgs: () => [this.props.notebookModel, cell]
                                        })] }), (0, jsx_runtime_1.jsx)(CellDropIndicator, { visible: this.shouldRenderDragOverIndicator(cell, 'bottom') })] }, 'cell-' + cell.handle);
                }), (0, jsx_runtime_1.jsx)(NotebookCellDivider, { menuRegistry: this.props.menuRegistry, isVisible: () => this.isEnabled(), onAddNewCell: handler => this.onAddNewCell(handler, this.props.notebookModel.cells.length), onDrop: e => this.onDrop(e, this.props.notebookModel.cells.length - 1), onDragOver: e => this.onDragOver(e, this.props.notebookModel.cells[this.props.notebookModel.cells.length - 1], 'bottom') })] });
    }
    renderCellContent(cell, index) {
        const renderer = this.props.renderers.get(cell.cellKind);
        if (!renderer) {
            throw new Error(`No renderer found for cell type ${cell.cellKind}`);
        }
        return renderer.render(this.props.notebookModel, cell, index);
    }
    renderCellSidebar(cell) {
        const renderer = this.props.renderers.get(cell.cellKind);
        if (!renderer) {
            throw new Error(`No renderer found for cell type ${cell.cellKind}`);
        }
        return renderer.renderSidebar(this.props.notebookModel, cell);
    }
    onDragStart(event) {
        event.stopPropagation();
        if (!this.isEnabled()) {
            event.preventDefault();
            return;
        }
        const cellHandle = event.target.getAttribute('data-cell-handle');
        if (!cellHandle) {
            throw new Error('Cell handle not found in element for cell drag event');
        }
        const index = this.props.notebookModel.getCellIndexByHandle(parseInt(cellHandle));
        const cell = this.props.notebookModel.cells[index];
        NotebookCellListView.dragGhost = document.createElement('div');
        NotebookCellListView.dragGhost.classList.add('theia-notebook-drag-ghost-image');
        NotebookCellListView.dragGhost.appendChild(this.props.renderers.get(cell.cellKind)?.renderDragImage(cell) ?? document.createElement('div'));
        document.body.appendChild(NotebookCellListView.dragGhost);
        event.dataTransfer.setDragImage(NotebookCellListView.dragGhost, -10, 0);
        event.dataTransfer.setData('text/theia-notebook-cell-index', index.toString());
        event.dataTransfer.setData('text/plain', this.props.notebookModel.cells[index].source);
    }
    onDragOver(event, cell, position) {
        if (!this.isEnabled()) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        // show indicator
        this.setState({ ...this.state, dragOverIndicator: { cell, position: position ?? event.nativeEvent.offsetY < event.currentTarget.clientHeight / 2 ? 'top' : 'bottom' } });
    }
    isEnabled() {
        return !Boolean(this.props.notebookModel.readOnly);
    }
    onDrop(event, dropElementIndex) {
        if (!this.isEnabled()) {
            this.setState({ dragOverIndicator: undefined });
            return;
        }
        const index = parseInt(event.dataTransfer.getData('text/theia-notebook-cell-index'));
        const isTargetBelow = index < dropElementIndex;
        let newIdx = this.state.dragOverIndicator?.position === 'top' ? dropElementIndex : dropElementIndex + 1;
        newIdx = isTargetBelow ? newIdx - 1 : newIdx;
        if (index !== undefined && index !== dropElementIndex) {
            this.props.notebookModel.applyEdits([{
                    editType: 6 /* CellEditType.Move */,
                    length: 1,
                    index,
                    newIdx
                }], true);
        }
        this.setState({ ...this.state, dragOverIndicator: undefined });
    }
    onAddNewCell(handler, index) {
        if (this.isEnabled()) {
            this.props.commandRegistry.executeCommand(notebook_actions_contribution_1.NotebookCommands.CHANGE_SELECTED_CELL.id, index - 1);
            handler(this.props.notebookModel, index);
        }
    }
    shouldRenderDragOverIndicator(cell, position) {
        return this.isEnabled() &&
            this.state.dragOverIndicator !== undefined &&
            this.state.dragOverIndicator.cell === cell &&
            this.state.dragOverIndicator.position === position;
    }
}
exports.NotebookCellListView = NotebookCellListView;
function NotebookCellDivider({ isVisible, onAddNewCell, onDrop, onDragOver, menuRegistry }) {
    const [hover, setHover] = React.useState(false);
    const menuPath = notebook_actions_contribution_1.NotebookMenus.NOTEBOOK_MAIN_TOOLBAR_CELL_ADD_GROUP; // we contribute into this menu, so it will exist
    const menuItems = menuRegistry.getMenu(menuPath).children.filter(item => core_1.CommandMenu.is(item)).map(item => item);
    const renderItem = (item) => {
        const execute = (...args) => {
            if (core_1.CommandMenu.is(item)) {
                item.run([...menuPath, item.id], ...args);
            }
        };
        return (0, jsx_runtime_1.jsxs)("button", { className: 'theia-notebook-add-cell-button', onClick: () => onAddNewCell(execute), title: core_1.nls.localizeByDefault(`Add ${item.label} Cell`), children: [(0, jsx_runtime_1.jsx)("div", { className: item.icon + ' theia-notebook-add-cell-button-icon' }), (0, jsx_runtime_1.jsx)("div", { className: 'theia-notebook-add-cell-button-text', children: item.label })] }, item.id);
    };
    return (0, jsx_runtime_1.jsx)("li", { className: 'theia-notebook-cell-divider', onMouseEnter: () => setHover(true), onMouseLeave: () => setHover(false), onDrop: onDrop, onDragOver: onDragOver, children: hover && isVisible() && (0, jsx_runtime_1.jsx)("div", { className: 'theia-notebook-add-cell-buttons', children: menuItems.map((item) => renderItem(item)) }) });
}
function CellDropIndicator(props) {
    return (0, jsx_runtime_1.jsx)("div", { className: 'theia-notebook-cell-drop-indicator', style: { visibility: props.visible ? 'visible' : 'hidden' } });
}
//# sourceMappingURL=notebook-cell-list-view.js.map