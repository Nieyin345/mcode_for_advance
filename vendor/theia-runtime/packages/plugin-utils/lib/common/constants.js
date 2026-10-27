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
exports.PLUGIN_COPY_IGNORE = exports.VSCODE_EXTENSION_DEACTIVATE = exports.VSCODE_EXTENSION_ACTIVATE = exports.THEIA_PLUGIN_STOP_METHOD = exports.THEIA_PLUGIN_START_METHOD = exports.VSCODE_FRONTEND_INIT = exports.VSCODE_BUILTIN_NAME_PREFIX = exports.LIST_JSON = exports.DEFAULT_PLUGINS_DIR = exports.UNPUBLISHED = exports.PLUGINS_SCHEME = exports.PLUGINS_BASE_PATH = void 0;
exports.PLUGINS_BASE_PATH = 'hostedPlugin';
/**
 * URI scheme for plugin assets read through the `FileService`. Browser-only serves them over HTTP
 * from `PLUGINS_BASE_PATH` instead.
 */
exports.PLUGINS_SCHEME = 'theia-plugin';
exports.UNPUBLISHED = '<unpublished>';
exports.DEFAULT_PLUGINS_DIR = 'plugins';
exports.LIST_JSON = 'list.json';
exports.VSCODE_BUILTIN_NAME_PREFIX = '@theia/vscode-builtin-';
exports.VSCODE_FRONTEND_INIT = 'plugin-vscode-init-fe.js';
exports.THEIA_PLUGIN_START_METHOD = 'start';
exports.THEIA_PLUGIN_STOP_METHOD = 'stop';
exports.VSCODE_EXTENSION_ACTIVATE = 'activate';
exports.VSCODE_EXTENSION_DEACTIVATE = 'deactivate';
exports.PLUGIN_COPY_IGNORE = /[/\\](\.git|node_modules)([/\\]|$)/;
//# sourceMappingURL=constants.js.map