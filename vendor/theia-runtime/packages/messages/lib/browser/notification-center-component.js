"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NotificationCenterComponent = void 0;
const jsx_runtime_1 = require("@theia/core/shared/react/jsx-runtime");
// *****************************************************************************
// Copyright (C) 2019 TypeFox and others.
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
const core_1 = require("@theia/core");
const notification_component_1 = require("./notification-component");
const browser_1 = require("@theia/core/lib/browser");
const nls_1 = require("@theia/core/lib/common/nls");
const PerfectScrollbar = require('react-perfect-scrollbar');
class NotificationCenterComponent extends React.Component {
    constructor(props) {
        super(props);
        this.toDisposeOnUnmount = new core_1.DisposableCollection();
        this.onHide = () => {
            this.props.manager.hideCenter();
        };
        this.onClearAll = () => {
            this.props.manager.clearAll();
        };
        this.state = {
            notifications: [],
            visibilityState: 'hidden'
        };
    }
    async componentDidMount() {
        this.toDisposeOnUnmount.push(this.props.manager.onUpdated(({ notifications, visibilityState }) => {
            this.setState({
                notifications: notifications,
                visibilityState
            });
        }));
    }
    componentWillUnmount() {
        this.toDisposeOnUnmount.dispose();
    }
    render() {
        const empty = this.state.notifications.length === 0;
        const title = empty
            ? nls_1.nls.localizeByDefault('No New Notifications')
            : nls_1.nls.localizeByDefault('Notifications');
        return ((0, jsx_runtime_1.jsxs)("div", { className: `theia-notifications-container theia-notification-center ${this.state.visibilityState === 'center' ? 'open' : 'closed'}`, children: [(0, jsx_runtime_1.jsxs)("div", { className: 'theia-notification-center-header', children: [(0, jsx_runtime_1.jsx)("div", { className: 'theia-notification-center-header-title', children: title }), (0, jsx_runtime_1.jsx)("div", { className: 'theia-notification-center-header-actions', children: (0, jsx_runtime_1.jsxs)("ul", { className: 'theia-notification-actions', children: [(0, jsx_runtime_1.jsx)("li", { className: (0, browser_1.codicon)('clear-all', true), title: nls_1.nls.localizeByDefault('Clear All Notifications'), onClick: this.onClearAll }), (0, jsx_runtime_1.jsx)("li", { className: (0, browser_1.codicon)('chevron-down', true), title: nls_1.nls.localizeByDefault('Hide Notifications'), onClick: this.onHide })] }) })] }), (0, jsx_runtime_1.jsx)(PerfectScrollbar, { className: 'theia-notification-list-scroll-container', children: (0, jsx_runtime_1.jsx)("div", { className: 'theia-notification-list', children: this.state.notifications.map(notification => (0, jsx_runtime_1.jsx)(notification_component_1.NotificationComponent, { notification: notification, manager: this.props.manager, contextMenuRenderer: this.props.contextMenuRenderer }, notification.messageId)) }) })] }));
    }
}
exports.NotificationCenterComponent = NotificationCenterComponent;
//# sourceMappingURL=notification-center-component.js.map