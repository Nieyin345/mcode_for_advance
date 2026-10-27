"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DebugConfigurationSelect = void 0;
const jsx_runtime_1 = require("@theia/core/shared/react/jsx-runtime");
/********************************************************************************
 * Copyright (C) 2021 Ericsson and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the Eclipse Public License v. 2.0 which is available at
 * http://www.eclipse.org/legal/epl-2.0.
 *
 * This Source Code may also be made available under the following Secondary
 * Licenses when the conditions for such availability set forth in the Eclipse
 * Public License v. 2.0 are satisfied: GNU General Public License, version 2
 * with the GNU Classpath Exception which is available at
 * https://www.gnu.org/software/classpath/license.html.
 *
 * SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
 ********************************************************************************/
const uri_1 = require("@theia/core/lib/common/uri");
const React = require("@theia/core/shared/react");
const debug_session_options_1 = require("../debug-session-options");
const select_component_1 = require("@theia/core/lib/browser/widgets/select-component");
const nls_1 = require("@theia/core/lib/common/nls");
class DebugConfigurationSelect extends React.Component {
    static { this.SEPARATOR = '──────────'; }
    static { this.PICK = '__PICK__'; }
    static { this.NO_CONFIGURATION = '__NO_CONF__'; }
    static { this.ADD_CONFIGURATION = '__ADD_CONF__'; }
    static { this.CONFIG_MARKER = '__CONFIG__'; }
    constructor(props) {
        super(props);
        this.selectRef = React.createRef();
        this.setCurrentConfiguration = (option) => {
            const value = option.value;
            if (!value) {
                return false;
            }
            else if (value === DebugConfigurationSelect.ADD_CONFIGURATION) {
                setTimeout(() => this.manager.addConfiguration());
            }
            else if (value.startsWith(DebugConfigurationSelect.PICK)) {
                const providerIndex = parseInt(this.parsePickValue(value), 10);
                const provider = this.state.providers[providerIndex];
                if (provider) {
                    this.selectDynamicConfigFromQuickPick(provider);
                }
            }
            else {
                const data = JSON.parse(value);
                this.manager.current = data;
            }
        };
        /**
         * Refreshes the list of dynamic configuration providers shown in the dropdown.
         * This is lightweight - it only gets the provider labels without invoking the
         * providers.
         */
        this.refreshDebugConfigurations = () => {
            const providers = this.manager.getDynamicDebugConfigurationProviders();
            const value = this.currentValue;
            if (this.selectRef.current) {
                this.selectRef.current.value = value;
            }
            this.setState({ providers, currentValue: value });
        };
        this.manager = props.manager;
        this.quickInputService = props.quickInputService;
        this.state = {
            providers: [],
            currentValue: undefined
        };
        this.manager.onDidChangeDynamicConfigurations(() => {
            this.refreshDebugConfigurations();
        });
    }
    componentDidUpdate() {
        // synchronize the currentValue with the selectComponent value
        const currentValue = this.currentValue;
        if (this.state.currentValue !== currentValue) {
            if (this.selectRef.current) {
                this.selectRef.current.value = currentValue;
            }
            this.setState({ currentValue });
        }
    }
    componentDidMount() {
        this.refreshDebugConfigurations();
    }
    render() {
        return (0, jsx_runtime_1.jsx)(select_component_1.SelectComponent, { options: this.renderOptions(), defaultValue: this.state.currentValue, onChange: option => this.setCurrentConfiguration(option), ref: this.selectRef });
    }
    get currentValue() {
        const { current } = this.manager;
        const matchingOption = this.getCurrentOption(current);
        return matchingOption ? matchingOption.value : current ? JSON.stringify(current) : DebugConfigurationSelect.NO_CONFIGURATION;
    }
    getCurrentOption(current) {
        if (!current || !this.selectRef.current) {
            return;
        }
        const matchingOption = this.selectRef.current.options.find(option => option.userData === DebugConfigurationSelect.CONFIG_MARKER
            && this.matchesOption(JSON.parse(option.value), current));
        return matchingOption;
    }
    matchesOption(sessionOption, current) {
        const matchesNameAndWorkspace = sessionOption.name === current.name && sessionOption.workspaceFolderUri === current.workspaceFolderUri;
        return debug_session_options_1.DebugSessionOptions.isConfiguration(sessionOption) && debug_session_options_1.DebugSessionOptions.isConfiguration(current)
            ? matchesNameAndWorkspace && sessionOption.providerType === current.providerType
            : matchesNameAndWorkspace;
    }
    toPickValue(providerType) {
        return DebugConfigurationSelect.PICK + providerType;
    }
    parsePickValue(value) {
        return value.slice(DebugConfigurationSelect.PICK.length);
    }
    /**
     * Fetches the actual debug configurations for a provider (which may have multiple types).
     * This is called lazily when the user selects a provider from the dropdown,
     * triggering extension activation and provideDebugConfigurations call only for the
     * specified types, rather than activating all extensions.
     */
    async resolveDynamicConfigurationPicks(provider) {
        // Fetch configurations for all types under this provider's label
        const allPicks = [];
        for (const providerType of provider.types) {
            const configurationsOfProviderType = await this.manager.provideDynamicDebugConfigurationsByType(providerType);
            if (configurationsOfProviderType && configurationsOfProviderType.length > 0) {
                allPicks.push(...configurationsOfProviderType.map(options => ({
                    label: options.configuration.name,
                    configurationType: options.configuration.type,
                    request: options.configuration.request,
                    providerType: options.providerType,
                    description: this.toBaseName(options.workspaceFolderUri),
                    workspaceFolderUri: options.workspaceFolderUri
                })));
            }
        }
        return allPicks;
    }
    async selectDynamicConfigFromQuickPick(provider) {
        const picks = await this.resolveDynamicConfigurationPicks(provider);
        if (picks.length === 0) {
            this.quickInputService.showQuickPick([{ label: nls_1.nls.localizeByDefault('No Configurations') }], { placeholder: nls_1.nls.localizeByDefault('Select Launch Configuration') });
            return;
        }
        const selected = await this.quickInputService.showQuickPick(picks, {
            placeholder: nls_1.nls.localizeByDefault('Select Launch Configuration')
        });
        if (!selected) {
            return;
        }
        const selectedConfiguration = {
            name: selected.label,
            type: selected.configurationType,
            request: selected.request
        };
        this.manager.current = this.manager.find(selectedConfiguration, selected.workspaceFolderUri, selected.providerType);
    }
    renderOptions() {
        const options = [];
        // Add non dynamic debug configurations
        for (const config of this.manager.all) {
            const value = JSON.stringify(config);
            options.push({
                value,
                label: this.toName(config, this.props.isMultiRoot),
                userData: DebugConfigurationSelect.CONFIG_MARKER
            });
        }
        // Add recently used dynamic debug configurations
        const { recentDynamicOptions } = this.manager;
        if (recentDynamicOptions.length > 0) {
            if (options.length > 0) {
                options.push({
                    separator: true
                });
            }
            for (const dynamicOption of recentDynamicOptions) {
                const value = JSON.stringify(dynamicOption);
                options.push({
                    value,
                    label: this.toName(dynamicOption, this.props.isMultiRoot) + ' (' + dynamicOption.providerType + ')',
                    userData: DebugConfigurationSelect.CONFIG_MARKER
                });
            }
        }
        // Placing a 'No Configuration' entry enables proper functioning of the 'onChange' event, by
        // having an entry to switch from (E.g. a case where only one dynamic configuration type is available)
        if (options.length === 0) {
            const value = DebugConfigurationSelect.NO_CONFIGURATION;
            options.push({
                value,
                label: nls_1.nls.localizeByDefault('No Configurations')
            });
        }
        // Add dynamic configuration providers for quick pick selection (grouped by label)
        const providers = this.state.providers;
        if (providers.length > 0) {
            options.push({
                separator: true
            });
            providers.forEach((provider, index) => {
                const value = this.toPickValue(String(index));
                options.push({
                    value,
                    label: provider.label + '...'
                });
            });
        }
        options.push({
            separator: true
        });
        options.push({
            value: DebugConfigurationSelect.ADD_CONFIGURATION,
            label: nls_1.nls.localizeByDefault('Add Configuration...')
        });
        return options;
    }
    toName(options, multiRoot) {
        return this.props.labelProvider.getLabel(options, multiRoot);
    }
    toBaseName(uri) {
        return uri ? new uri_1.default(uri).path.base : '';
    }
}
exports.DebugConfigurationSelect = DebugConfigurationSelect;
//# sourceMappingURL=debug-configuration-select.js.map