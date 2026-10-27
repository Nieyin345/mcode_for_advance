"use strict";
// *****************************************************************************
// Copyright (C) 2021 Ericsson and others.
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
exports.ElectronWindowPreferences = exports.ElectronWindowPreferenceContribution = exports.ElectronWindowConfiguration = exports.electronWindowPreferencesSchema = exports.PREF_WINDOW_TITLE_BAR_STYLE = exports.PREF_WINDOW_ZOOM_LEVEL = exports.ZoomLevel = void 0;
exports.createElectronWindowPreferences = createElectronWindowPreferences;
exports.bindWindowPreferences = bindWindowPreferences;
const nls_1 = require("../common/nls");
const common_1 = require("../common");
const preference_schema_1 = require("../common/preferences/preference-schema");
const preferences_1 = require("../common/preferences");
var ZoomLevel;
(function (ZoomLevel) {
    ZoomLevel.DEFAULT = 0;
    // copied from https://github.com/microsoft/vscode/blob/dda96b69bfc63f309e60cfc5f98cb863c46b32ac/src/vs/workbench/electron-sandbox/actions/windowActions.ts#L47-L48
    ZoomLevel.MIN = -8;
    ZoomLevel.MAX = 9;
    // amount to increment or decrement the window zoom level.
    ZoomLevel.VARIATION = 0.5;
    // Chromium's base for zoom factor calculation: zoomFactor = pow(ZOOM_BASE, zoomLevel)
    // See https://source.chromium.org/chromium/chromium/src/+/main:third_party/blink/common/page/page_zoom.cc
    ZoomLevel.ZOOM_BASE = 1.2;
})(ZoomLevel || (exports.ZoomLevel = ZoomLevel = {}));
exports.PREF_WINDOW_ZOOM_LEVEL = 'window.zoomLevel';
exports.PREF_WINDOW_TITLE_BAR_STYLE = 'window.titleBarStyle';
exports.electronWindowPreferencesSchema = {
    properties: {
        [exports.PREF_WINDOW_ZOOM_LEVEL]: {
            type: 'number',
            default: ZoomLevel.DEFAULT,
            minimum: ZoomLevel.MIN,
            maximum: ZoomLevel.MAX,
            scope: preferences_1.PreferenceScope.User,
            markdownDescription: nls_1.nls.localize('theia/core/window/zoomLevelPref', 'Adjust the default zoom level for all windows.\
                Each increment of `0.5` above `0` (e.g. `0.5`) or below (e.g. `-0.5`) represents zooming approximately `10%` larger or smaller.\
                You can also enter other decimal values to adjust the zoom level with a finer granularity.')
        },
        [exports.PREF_WINDOW_TITLE_BAR_STYLE]: {
            type: 'string',
            enum: ['native', 'custom'],
            default: common_1.isWindows ? 'custom' : 'native',
            scope: preferences_1.PreferenceScope.User,
            description: nls_1.nls.localizeByDefault('Adjust the appearance of the window title bar to be native by the OS or custom. Changes require a full restart to apply.'),
            included: !common_1.isOSX
        },
    }
};
class ElectronWindowConfiguration {
}
exports.ElectronWindowConfiguration = ElectronWindowConfiguration;
exports.ElectronWindowPreferenceContribution = Symbol('ElectronWindowPreferenceContribution');
exports.ElectronWindowPreferences = Symbol('ElectronWindowPreferences');
function createElectronWindowPreferences(preferences, schema = exports.electronWindowPreferencesSchema) {
    return (0, preferences_1.createPreferenceProxy)(preferences, schema);
}
function bindWindowPreferences(bind) {
    bind(exports.ElectronWindowPreferences).toDynamicValue(ctx => {
        const preferences = ctx.container.get(preferences_1.PreferenceService);
        const contribution = ctx.container.get(exports.ElectronWindowPreferenceContribution);
        return createElectronWindowPreferences(preferences, contribution.schema);
    }).inSingletonScope();
    bind(exports.ElectronWindowPreferenceContribution).toConstantValue({ schema: exports.electronWindowPreferencesSchema });
    bind(preference_schema_1.PreferenceContribution).toService(exports.ElectronWindowPreferenceContribution);
}
//# sourceMappingURL=electron-window-preferences.js.map