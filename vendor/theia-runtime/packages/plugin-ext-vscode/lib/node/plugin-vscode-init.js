"use strict";
// *****************************************************************************
// Copyright (C) 2018-2019 Red Hat, Inc.
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
exports.doInitialization = void 0;
exports.findPlugin = findPlugin;
/* eslint-disable @typescript-eslint/no-explicit-any */
const node_module_1 = require("node:module");
const paths_1 = require("@theia/core/lib/common/paths");
const plugin_ext_1 = require("@theia/plugin-ext");
const plugin_vscode_types_1 = require("../common/plugin-vscode-types");
process.env['VSCODE_PID'] = process.env['THEIA_PARENT_PID'];
const pluginsApiImpl = new Map();
const plugins = new Array();
let defaultApi;
let isLoadOverride = false;
let pluginApiFactory;
const doInitialization = (apiFactory, plugin) => {
    pluginsApiImpl.set(plugin.model.id, createVSCodeAPI(apiFactory, plugin));
    plugins.push(plugin);
    pluginApiFactory = apiFactory;
    if (!isLoadOverride) {
        overrideInternalLoad();
        isLoadOverride = true;
    }
};
exports.doInitialization = doInitialization;
function createVSCodeAPI(apiFactory, plugin) {
    const vscode = apiFactory(plugin);
    // override the version for vscode to be a VSCode version
    vscode.version = process.env['VSCODE_API_VERSION'] || plugin_vscode_types_1.VSCODE_DEFAULT_API_VERSION;
    return vscode;
}
function overrideInternalLoad() {
    const module = require('module');
    const vscodeModuleName = 'vscode';
    // save original load method
    const internalLoad = module._load;
    // if we try to resolve theia module, return the filename entry to use cache.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    module._load = function (request, parent, isMain) {
        if (request !== vscodeModuleName) {
            return internalLoad.apply(this, arguments);
        }
        const plugin = findPlugin(plugins, parent.filename);
        if (plugin) {
            const apiImpl = pluginsApiImpl.get(plugin.model.id);
            return apiImpl;
        }
        if (!defaultApi) {
            console.warn(`Could not identify plugin for 'Theia' require call from ${parent.filename}`);
            defaultApi = createVSCodeAPI(pluginApiFactory, plugin_ext_1.emptyPlugin);
        }
        return defaultApi;
    };
    registerESMLoaderHook();
}
/**
 * Locate the plugin whose folder contains the given file.
 *
 * Matches on folder boundaries, so sibling plugins whose folder names share
 * a prefix (e.g. `acme.foo` vs. `acme.foo-extras`) are not mismatched.
 */
function findPlugin(pluginList, filePath) {
    return pluginList.find(plugin => (0, paths_1.isEqualOrParent)(filePath, plugin.pluginFolder));
}
/**
 * Register an ESM loader hook so that `import 'vscode'` from an ESM plugin
 * resolves through the same `module._load` patch above.
 *
 * The hook emits a unique synthetic CommonJS module per importing parent.
 * The synthetic source:
 *   - looks up the plugin API via `Module._load('vscode', { filename: <parent path> })`,
 *     reusing the existing `findPlugin(parent.filename)` lookup, and
 *   - copies the API's top-level namespace into `exports.<name> = __api.<name>` so
 *     `cjs-module-lexer` exposes them as ESM named exports (required by VS Code
 *     extensions that do e.g. `import { commands, window } from 'vscode'`).
 *
 * Making the synthetic URL unique per importing parent gives each ESM plugin its
 * own Node module-cache entry, so each plugin receives ITS OWN API rather than
 * the first plugin's API being captured forever.
 */
function registerESMLoaderHook() {
    const sampleApi = plugins.length > 0 ? pluginsApiImpl.get(plugins[0].model.id) : undefined;
    const apiKeys = sampleApi ? Object.keys(sampleApi) : [];
    const loaderSource = `
import { fileURLToPath } from 'node:url';
const SHIM_URL_PREFIX = 'theia-vscode-shim:///vscode.cjs?parent=';
const API_KEYS = ${JSON.stringify(apiKeys)};

export async function resolve(specifier, context, nextResolve) {
    if (specifier === 'vscode' && context.parentURL && context.parentURL.startsWith('file:')) {
        return {
            shortCircuit: true,
            url: SHIM_URL_PREFIX + encodeURIComponent(context.parentURL),
            format: 'commonjs'
        };
    }
    return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
    if (url.startsWith(SHIM_URL_PREFIX)) {
        const parentURL = decodeURIComponent(url.slice(SHIM_URL_PREFIX.length));
        let parentPath = '';
        if (parentURL.startsWith('file:')) {
            try { parentPath = fileURLToPath(parentURL); } catch { parentPath = ''; }
        }
        const namedExports = API_KEYS
            .map(k => 'exports[' + JSON.stringify(k) + '] = __api[' + JSON.stringify(k) + '];')
            .join('\\n');
        const source =
            "const Module = require('module');\\n" +
            "const __api = Module._load('vscode', { filename: " + JSON.stringify(parentPath) + " }, false);\\n" +
            namedExports;
        return { format: 'commonjs', shortCircuit: true, source };
    }
    return nextLoad(url, context);
}
`;
    try {
        const dataUrl = 'data:text/javascript;base64,' + Buffer.from(loaderSource, 'utf8').toString('base64');
        (0, node_module_1.register)(dataUrl);
    }
    catch (e) {
        console.error('Failed to register VS Code ESM loader hook; ESM plugins will not load:', e);
    }
}
//# sourceMappingURL=plugin-vscode-init.js.map