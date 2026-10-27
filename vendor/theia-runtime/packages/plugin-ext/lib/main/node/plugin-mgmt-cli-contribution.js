"use strict";
// *****************************************************************************
// Copyright (C) 2023 STMicroelectronics and others.
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
var PluginMgmtCliContribution_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.PluginMgmtCliContribution = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("@theia/core/shared/inversify");
const plugin_deployer_handler_impl_1 = require("../../hosted/node/plugin-deployer-handler-impl");
const common_1 = require("../../common");
let PluginMgmtCliContribution = class PluginMgmtCliContribution {
    static { PluginMgmtCliContribution_1 = this; }
    static { this.LIST_PLUGINS = 'list-plugins'; }
    static { this.SHOW_VERSIONS = '--show-versions'; }
    static { this.SHOW_BUILTINS = '--show-builtins'; }
    configure(conf) {
        conf.command([PluginMgmtCliContribution_1.LIST_PLUGINS, 'list-extensions'], 'List the installed plugins', yargs => yargs.option(PluginMgmtCliContribution_1.SHOW_VERSIONS, {
            description: 'List the versions of the installed plugins',
            type: 'boolean',
            default: false,
        }).option(PluginMgmtCliContribution_1.SHOW_BUILTINS, {
            description: 'List the built-in plugins',
            type: 'boolean',
            default: false,
        }), async (yargs) => {
            const showVersions = yargs[PluginMgmtCliContribution_1.SHOW_VERSIONS];
            const deployedIds = await this.deployerHandler.getDeployedBackendPlugins();
            const pluginType = yargs[PluginMgmtCliContribution_1.SHOW_BUILTINS] ? common_1.PluginType.System : common_1.PluginType.User;
            process.stdout.write('installed plugins:\n');
            deployedIds.filter(plugin => plugin.type === pluginType).forEach(plugin => {
                if (showVersions) {
                    process.stdout.write(`${plugin.metadata.model.id}@${plugin.metadata.model.version}\n`);
                }
                else {
                    process.stdout.write(`${plugin.metadata.model.id}\n`);
                }
            });
        });
    }
    setArguments(args) {
    }
};
exports.PluginMgmtCliContribution = PluginMgmtCliContribution;
tslib_1.__decorate([
    (0, inversify_1.inject)(plugin_deployer_handler_impl_1.PluginDeployerHandlerImpl),
    tslib_1.__metadata("design:type", plugin_deployer_handler_impl_1.PluginDeployerHandlerImpl)
], PluginMgmtCliContribution.prototype, "deployerHandler", void 0);
exports.PluginMgmtCliContribution = PluginMgmtCliContribution = PluginMgmtCliContribution_1 = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], PluginMgmtCliContribution);
//# sourceMappingURL=plugin-mgmt-cli-contribution.js.map