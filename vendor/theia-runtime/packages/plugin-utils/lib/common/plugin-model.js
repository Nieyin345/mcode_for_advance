"use strict";
// *****************************************************************************
// Copyright (C) 2026 Maksim Kachurin and others.
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
exports.getPluginId = getPluginId;
exports.encodePluginAssetPath = encodePluginAssetPath;
exports.toPluginUrl = toPluginUrl;
exports.toPluginUri = toPluginUri;
exports.pickEngineType = pickEngineType;
exports.applyTrustExtraction = applyTrustExtraction;
exports.buildEntryPointForTheia = buildEntryPointForTheia;
exports.buildEntryPointForVsCode = buildEntryPointForVsCode;
exports.buildModelForTheia = buildModelForTheia;
exports.buildModelForVsCode = buildModelForVsCode;
exports.buildModel = buildModel;
exports.buildLifecycle = buildLifecycle;
const constants_1 = require("./constants");
function getPluginId(plugin) {
    return `${plugin.publisher ?? constants_1.UNPUBLISHED}_${plugin.name}`.replace(/\W/g, '_');
}
/**
 * Builds `<id>/<segments...>` for a plugin asset. Path separators stay literal `/`; each segment
 * is `encodeURIComponent`'d so plain static file servers (browser-only) resolve assets without
 * needing Express `:path(*)` decoding. `.` is dropped and `..` is resolved within the plugin root
 * (leading `..` is ignored).
 */
function toPluginAssetPath(pck, relativePath) {
    const segments = [];
    for (const segment of relativePath.replace(/\\/g, '/').split('/')) {
        if (!segment || segment === '.') {
            continue;
        }
        if (segment === '..') {
            // Drop parent segment when present; ignore leading `..` so URLs never contain
            // literal `..` (encodeURIComponent does not encode dots).
            segments.pop();
            continue;
        }
        segments.push(encodeURIComponent(segment));
    }
    return `${getPluginId(pck)}/${segments.join('/')}`;
}
/**
 * Re-encodes an already decoded plugin asset path - what `URI.path` hands back - so it can be
 * appended to a URL unchanged. Encoding per segment rather than as a whole keeps `/` literal, which
 * plain static file servers need, and preserves names containing `#`, `?` or `%`.
 */
function encodePluginAssetPath(decodedPath) {
    return decodedPath.split('/').map(encodeURIComponent).join('/');
}
/** Builds a static-friendly plugin asset URL: `hostedPlugin/<id>/<segments...>`. */
function toPluginUrl(pck, relativePath) {
    return `${constants_1.PLUGINS_BASE_PATH}/${toPluginAssetPath(pck, relativePath)}`;
}
/**
 * Like {@link toPluginUrl}, but as a `PLUGINS_SCHEME` URI for the assets read through the
 * `FileService` (color themes, icon themes, icon fonts). A bare relative path has no scheme for it
 * to resolve.
 */
function toPluginUri(pck, relativePath) {
    return `${constants_1.PLUGINS_SCHEME}:/${toPluginAssetPath(pck, relativePath)}`;
}
/**
 * Explicit `theiaPlugin` engine takes priority over `vscode`.
 */
function pickEngineType(manifest) {
    if (manifest.engines?.theiaPlugin !== undefined) {
        return 'theiaPlugin';
    }
    if (manifest.engines?.vscode !== undefined) {
        return 'vscode';
    }
    throw new Error(`No vscode or theiaPlugin engine in ${manifest.name}`);
}
function applyTrustExtraction(manifest, result) {
    const untrustedWorkspacesSupport = manifest.capabilities?.untrustedWorkspaces?.supported;
    if (untrustedWorkspacesSupport !== undefined) {
        result.untrustedWorkspacesSupport = untrustedWorkspacesSupport;
    }
}
/** Minimal `pathToFileURL(...).href` without importing Node's `url` (keeps this module worker-safe). */
function pathToFileUrlHref(absolutePath) {
    const normalized = absolutePath.replace(/\\/g, '/');
    if (/^[a-zA-Z]:\//.test(normalized)) {
        return `file:///${normalized}`;
    }
    return `file://${normalized.startsWith('/') ? normalized : `/${normalized}`}`;
}
function buildEntryPointForTheia(manifest) {
    const result = {
        frontend: manifest.theiaPlugin?.frontend,
        backend: manifest.theiaPlugin?.backend
    };
    if (manifest.theiaPlugin?.headless) {
        result.headless = manifest.theiaPlugin.headless;
    }
    return result;
}
function buildEntryPointForVsCode(manifest, options) {
    const entryPoint = {};
    const preferFrontend = options?.uiKind === 'web'
        && manifest.extensionKind?.length === 1
        && manifest.extensionKind[0] === 'ui';
    if (manifest.browser && (!manifest.main || preferFrontend)) {
        entryPoint.frontend = manifest.browser;
    }
    else {
        entryPoint.backend = manifest.main;
    }
    if (manifest.theiaPlugin?.headless) {
        entryPoint.headless = manifest.theiaPlugin.headless;
    }
    return entryPoint;
}
function buildModelForTheia(manifest) {
    const publisher = manifest.publisher ?? constants_1.UNPUBLISHED;
    const packageUri = manifest.packageUri ?? pathToFileUrlHref(manifest.packagePath);
    return {
        packagePath: manifest.packagePath,
        packageUri,
        id: `${publisher.toLowerCase()}.${manifest.name.toLowerCase()}`,
        name: manifest.name,
        publisher,
        version: manifest.version,
        displayName: manifest.displayName ?? manifest.name,
        description: manifest.description ?? '',
        l10n: manifest.l10n,
        engine: {
            type: 'theiaPlugin',
            version: manifest.engines?.theiaPlugin ?? '*'
        },
        entryPoint: buildEntryPointForTheia(manifest),
    };
}
function buildModelForVsCode(manifest, options) {
    const publisher = manifest.publisher ?? constants_1.UNPUBLISHED;
    const packageUri = manifest.packageUri ?? pathToFileUrlHref(manifest.packagePath);
    return {
        packagePath: manifest.packagePath,
        packageUri,
        id: `${publisher.toLowerCase()}.${manifest.name.toLowerCase()}`,
        name: manifest.name,
        publisher,
        version: manifest.version,
        displayName: manifest.displayName ?? manifest.name,
        description: manifest.description ?? '',
        l10n: manifest.l10n,
        engine: {
            type: 'vscode',
            version: manifest.engines?.vscode ?? '*'
        },
        entryPoint: buildEntryPointForVsCode(manifest, options),
        iconUrl: manifest.icon ? toPluginUrl(manifest, manifest.icon) : undefined,
    };
}
function buildModel(manifest, engineType, options) {
    return engineType === 'theiaPlugin' ? buildModelForTheia(manifest) : buildModelForVsCode(manifest, options);
}
function buildLifecycle(manifest, engineType) {
    const frontendModuleName = getPluginId(manifest);
    if (engineType === 'theiaPlugin') {
        return {
            startMethod: constants_1.THEIA_PLUGIN_START_METHOD,
            stopMethod: constants_1.THEIA_PLUGIN_STOP_METHOD,
            frontendModuleName,
        };
    }
    return {
        startMethod: constants_1.VSCODE_EXTENSION_ACTIVATE,
        stopMethod: constants_1.VSCODE_EXTENSION_DEACTIVATE,
        frontendModuleName,
        frontendInitPath: constants_1.VSCODE_FRONTEND_INIT
    };
}
//# sourceMappingURL=plugin-model.js.map