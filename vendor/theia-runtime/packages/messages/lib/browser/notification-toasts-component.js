"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NotificationToastsComponent = void 0;
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
class NotificationToastsComponent extends React.Component {
    constructor(props) {
        super(props);
        this.toDisposeOnUnmount = new core_1.DisposableCollection();
        this.state = {
            toasts: [],
            visibilityState: 'hidden'
        };
    }
    async componentDidMount() {
        this.toDisposeOnUnmount.push(this.props.manager.onUpdated(({ toasts, visibilityState }) => {
            visibilityState = this.props.corePreferences['workbench.silentNotifications'] ? 'hidden' : visibilityState;
            this.setState({
                toasts: toasts.slice(-3),
                visibilityState
            });
        }));
    }
    componentWillUnmount() {
        this.toDisposeOnUnmount.dispose();
    }
    render() {
        return ((0, jsx_runtime_1.jsx)("div", { className: `theia-notifications-container theia-notification-toasts ${this.state.visibilityState === 'toasts' ? 'open' : 'closed'}`, children: (0, jsx_runtime_1.jsx)("div", { className: 'theia-notification-list', children: this.state.toasts.map(notification => (0, jsx_runtime_1.jsx)(notification_component_1.NotificationComponent, { notification: notification, manager: this.props.manager, contextMenuRenderer: this.props.contextMenuRenderer }, notification.messageId)) }) }));
    }
}
exports.NotificationToastsComponent = NotificationToastsComponent;
//# sourceMappingURL=notification-toasts-component.js.map