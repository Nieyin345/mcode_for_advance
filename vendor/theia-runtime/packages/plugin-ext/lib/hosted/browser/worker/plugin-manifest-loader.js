"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadManifest = loadManifest;
/* eslint-disable @typescript-eslint/no-explicit-any */
const plugin_protocol_1 = require("../../../common/plugin-protocol");
const endpoint_1 = require("@theia/core/lib/browser/endpoint");
const package_nls_1 = require("@theia/plugin-utils/lib/common/package-nls");
const plugin_manifest_1 = require("@theia/plugin-utils/lib/common/plugin-manifest");
function getUri(pluginModel, relativePath) {
    const ownURI = new endpoint_1.Endpoint().getRestUrl();
    return ownURI.parent.resolve(plugin_protocol_1.PluginPackage.toPluginUrl(pluginModel, relativePath));
}
function readPluginFile(pluginModel, relativePath) {
    return readContents(getUri(pluginModel, relativePath).toString());
}
function readContents(uri) {
    return new Promise((resolve, reject) => {
        const request = new XMLHttpRequest();
        request.onreadystatechange = function () {
            if (this.readyState === XMLHttpRequest.DONE) {
                if (this.status === 200) {
                    resolve(this.response);
                }
                else if (this.status === 404) {
                    reject('NotFound');
                }
                else {
                    reject(new Error('Could not fetch plugin resource'));
                }
            }
        };
        request.open('GET', uri, true);
        request.send();
    });
}
async function readPluginJson(pluginModel, relativePath) {
    const content = await readPluginFile(pluginModel, relativePath);
    return JSON.parse(content);
}
async function loadManifest(pluginModel) {
    const [manifest, translations] = await Promise.all([
        readPluginJson(pluginModel, 'package.json').then(raw => (0, plugin_manifest_1.prepareLoadedManifest)(raw, { updateActivationEvents: false })),
        loadTranslations(pluginModel)
    ]);
    return manifest && translations && Object.keys(translations).length ?
        (0, package_nls_1.localizeWithResolver)(manifest, key => translations[key]) :
        manifest;
}
async function loadTranslations(pluginModel) {
    try {
        return await readPluginJson(pluginModel, 'package.nls.json');
    }
    catch (e) {
        if (e !== 'NotFound') {
            throw e;
        }
        return {};
    }
}
//# sourceMappingURL=plugin-manifest-loader.js.map