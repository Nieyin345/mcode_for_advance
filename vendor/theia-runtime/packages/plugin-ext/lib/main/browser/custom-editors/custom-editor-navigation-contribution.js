"use strict";
// *****************************************************************************
// Copyright (C) 2025 EclipseSource and others.
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
exports.CustomEditorNavigationContribution = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("@theia/core/shared/inversify");
const browser_1 = require("@theia/core/lib/browser");
const navigation_location_service_1 = require("@theia/editor/lib/browser/navigation/navigation-location-service");
const navigation_location_1 = require("@theia/editor/lib/browser/navigation/navigation-location");
const custom_editor_widget_1 = require("./custom-editor-widget");
let CustomEditorNavigationContribution = class CustomEditorNavigationContribution {
    onStart() {
        this.shell.onDidChangeActiveWidget(({ newValue }) => {
            if (newValue instanceof custom_editor_widget_1.CustomEditorWidget && newValue.resource) {
                this.locationService.navigate(service => service.register(navigation_location_1.NavigationLocation.create(newValue.resource, { line: 0, character: 0 })));
            }
        });
    }
};
exports.CustomEditorNavigationContribution = CustomEditorNavigationContribution;
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_1.ApplicationShell),
    tslib_1.__metadata("design:type", browser_1.ApplicationShell)
], CustomEditorNavigationContribution.prototype, "shell", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(navigation_location_service_1.NavigationLocationService),
    tslib_1.__metadata("design:type", navigation_location_service_1.NavigationLocationService)
], CustomEditorNavigationContribution.prototype, "locationService", void 0);
exports.CustomEditorNavigationContribution = CustomEditorNavigationContribution = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], CustomEditorNavigationContribution);
//# sourceMappingURL=custom-editor-navigation-contribution.js.map