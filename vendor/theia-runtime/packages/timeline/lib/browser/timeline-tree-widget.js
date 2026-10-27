"use strict";
var TimelineTreeWidget_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.TimelineItemNode = exports.TimelineTreeWidget = exports.TIMELINE_ITEM_CONTEXT_MENU = void 0;
const tslib_1 = require("tslib");
const jsx_runtime_1 = require("@theia/core/shared/react/jsx-runtime");
// *****************************************************************************
// Copyright (C) 2020 RedHat and others.
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
const inversify_1 = require("@theia/core/shared/inversify");
const common_1 = require("@theia/core/lib/common");
const tree_1 = require("@theia/core/lib/browser/tree");
const browser_1 = require("@theia/core/lib/browser");
const timeline_tree_model_1 = require("./timeline-tree-model");
const timeline_service_1 = require("./timeline-service");
const timeline_context_key_service_1 = require("./timeline-context-key-service");
const React = require("@theia/core/shared/react");
const markdown_rendering_1 = require("@theia/core/lib/common/markdown-rendering");
const theme_1 = require("@theia/core/lib/common/theme");
exports.TIMELINE_ITEM_CONTEXT_MENU = ['timeline-item-context-menu'];
let TimelineTreeWidget = class TimelineTreeWidget extends tree_1.TreeWidget {
    static { TimelineTreeWidget_1 = this; }
    static { this.ID = 'timeline-tree-widget'; }
    static { this.PAGE_SIZE = 20; }
    constructor(props, model, contextMenuRenderer) {
        super(props, model, contextMenuRenderer);
        this.model = model;
        this.id = TimelineTreeWidget_1.ID;
        this.addClass('timeline-outer-container');
    }
    renderNode(node, props) {
        const attributes = this.createNodeAttributes(node, props);
        const content = (0, jsx_runtime_1.jsx)(TimelineItemNode, { timelineItem: node.timelineItem, commandRegistry: this.commandRegistry, contextKeys: this.contextKeys, contextMenuRenderer: this.contextMenuRenderer, hoverService: this.hoverService });
        return React.createElement('div', attributes, content);
    }
    handleEnter(event) {
        const node = this.model.getFocusedNode();
        const command = node?.timelineItem?.command;
        if (command) {
            this.commandRegistry.executeCommand(command.id, ...(command.arguments ? command.arguments : []));
        }
    }
    async handleLeft(event) {
        this.model.selectPrevNode();
    }
};
exports.TimelineTreeWidget = TimelineTreeWidget;
tslib_1.__decorate([
    (0, inversify_1.inject)(common_1.MenuModelRegistry),
    tslib_1.__metadata("design:type", common_1.MenuModelRegistry)
], TimelineTreeWidget.prototype, "menus", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(timeline_context_key_service_1.TimelineContextKeyService),
    tslib_1.__metadata("design:type", timeline_context_key_service_1.TimelineContextKeyService)
], TimelineTreeWidget.prototype, "contextKeys", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(timeline_service_1.TimelineService),
    tslib_1.__metadata("design:type", timeline_service_1.TimelineService)
], TimelineTreeWidget.prototype, "timelineService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(common_1.CommandRegistry),
    tslib_1.__metadata("design:type", common_1.CommandRegistry)
], TimelineTreeWidget.prototype, "commandRegistry", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_1.HoverService),
    tslib_1.__metadata("design:type", browser_1.HoverService)
], TimelineTreeWidget.prototype, "hoverService", void 0);
exports.TimelineTreeWidget = TimelineTreeWidget = TimelineTreeWidget_1 = tslib_1.__decorate([
    (0, inversify_1.injectable)(),
    tslib_1.__param(0, (0, inversify_1.inject)(tree_1.TreeProps)),
    tslib_1.__param(1, (0, inversify_1.inject)(timeline_tree_model_1.TimelineTreeModel)),
    tslib_1.__param(2, (0, inversify_1.inject)(browser_1.ContextMenuRenderer)),
    tslib_1.__metadata("design:paramtypes", [Object, timeline_tree_model_1.TimelineTreeModel,
        browser_1.ContextMenuRenderer])
], TimelineTreeWidget);
class TimelineItemNode extends React.Component {
    constructor() {
        super(...arguments);
        this.open = () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const command = this.props.timelineItem.command;
            if (command) {
                this.props.commandRegistry.executeCommand(command.id, ...command.arguments ? command.arguments : []);
            }
        };
        this.renderContextMenu = (event) => {
            event.preventDefault();
            event.stopPropagation();
            const { timelineItem, contextKeys, contextMenuRenderer } = this.props;
            const currentTimelineItem = contextKeys.timelineItem.get();
            contextKeys.timelineItem.set(timelineItem.contextValue);
            try {
                contextMenuRenderer.render({
                    menuPath: exports.TIMELINE_ITEM_CONTEXT_MENU,
                    anchor: event.nativeEvent,
                    args: [timelineItem],
                    context: event.currentTarget
                });
            }
            finally {
                contextKeys.timelineItem.set(currentTimelineItem);
            }
        };
    }
    render() {
        const { label, description, tooltip, accessibilityInformation, icon } = this.props.timelineItem;
        let iconString = '';
        if (icon) {
            if (typeof icon === 'string') {
                iconString = (0, browser_1.codicon)(icon);
            }
            else if ((0, theme_1.isThemeIcon)(icon)) {
                iconString = (0, browser_1.codicon)(icon.id);
            }
        }
        return (0, jsx_runtime_1.jsx)("div", { className: 'theia-TreeNodeContent', onContextMenu: this.renderContextMenu, onClick: this.open, onMouseEnter: e => this.requestHover(e, tooltip), "aria-label": accessibilityInformation?.label, role: accessibilityInformation?.role, children: (0, jsx_runtime_1.jsxs)("div", { className: `timeline-item noWrapInfo ${tree_1.TREE_NODE_SEGMENT_GROW_CLASS} no-select`, children: [(0, jsx_runtime_1.jsx)("span", { className: `${iconString} timeline-item-icon` }), (0, jsx_runtime_1.jsxs)("div", { className: 'noWrapInfo', children: [(0, jsx_runtime_1.jsx)("span", { className: 'timeline-item-label', children: label }), (0, jsx_runtime_1.jsx)("span", { className: `timeline-item-description ${tree_1.TREE_NODE_INFO_CLASS}`, children: description })] })] }) });
    }
    requestHover(e, content) {
        if (content) {
            this.props.hoverService.requestHover({
                content,
                target: e.currentTarget,
                position: 'right',
                interactive: markdown_rendering_1.MarkdownString.is(content),
            });
        }
    }
}
exports.TimelineItemNode = TimelineItemNode;
//# sourceMappingURL=timeline-tree-widget.js.map