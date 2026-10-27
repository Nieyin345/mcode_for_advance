"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.McpServersConfigurationCategory = void 0;
const tslib_1 = require("tslib");
const jsx_runtime_1 = require("@theia/core/shared/react/jsx-runtime");
// *****************************************************************************
// Copyright (C) 2026 EclipseSource and others.
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
const ai_core_1 = require("@theia/ai-core");
const agent_plugin_ui_bridge_1 = require("@theia/ai-core/lib/browser/agent-plugin-ui-bridge");
const prompt_variable_contribution_1 = require("@theia/ai-core/lib/browser/prompt-variable-contribution");
const core_1 = require("@theia/core");
const browser_1 = require("@theia/core/lib/browser");
const common_1 = require("@theia/core/lib/common");
const inversify_1 = require("@theia/core/shared/inversify");
const ai_configuration_category_1 = require("@theia/ai-core-ui/lib/browser/ai-configuration/ai-configuration-category");
const collection_category_renderer_1 = require("@theia/ai-core-ui/lib/browser/ai-configuration/renderers/collection-category-renderer");
const ai_configuration_primitives_1 = require("@theia/ai-core-ui/lib/browser/ai-configuration/components/ai-configuration-primitives");
const ai_configuration_origin_badge_1 = require("@theia/ai-core-ui/lib/browser/ai-configuration/components/ai-configuration-origin-badge");
const ai_configuration_item_row_1 = require("@theia/ai-core-ui/lib/browser/ai-configuration/components/ai-configuration-item-row");
const ai_settings_row_1 = require("@theia/ai-core-ui/lib/browser/ai-configuration/components/ai-settings-row");
const ai_settings_row_service_1 = require("@theia/ai-core-ui/lib/browser/ai-configuration/components/ai-settings-row-service");
const ai_configuration_controls_1 = require("@theia/ai-core-ui/lib/browser/ai-configuration/components/ai-configuration-controls");
const mcp_preferences_1 = require("../common/mcp-preferences");
const mcp_server_manager_1 = require("../common/mcp-server-manager");
const mcp_registry_ui_bridge_1 = require("./mcp-registry-ui-bridge");
const mcp_server_editor_1 = require("./mcp-server-editor");
const mcp_server_preference_validator_1 = require("../common/mcp-server-preference-validator");
/**
 * The MCP Servers category (in `@theia/ai-mcp`): a `collection` porting the MCP server surface
 * onto the shared primitives. Servers are the tree children (status dot from {@link MCPServerStatus});
 * the per-server configuration and tool list are rendered as the item detail.
 */
let McpServersConfigurationCategory = class McpServersConfigurationCategory extends collection_category_renderer_1.CollectionCategoryRenderer {
    constructor() {
        super(...arguments);
        this.id = ai_configuration_category_1.AiConfigurationCategoryId.MCP_SERVERS;
        this.label = core_1.nls.localizeByDefault('MCP Servers');
        this.iconClass = (0, browser_1.codicon)('mcp');
        this.order = ai_configuration_category_1.AiConfigurationCategoryOrder.MCP_SERVERS;
        this.kind = 'collection';
        this.onDidChangeEmitter = new core_1.Emitter();
        this.onDidChange = this.onDidChangeEmitter.event;
        this.toDispose = new common_1.DisposableCollection(this.onDidChangeEmitter);
        this.servers = [];
        this.oauthCredentialStates = {};
    }
    get renderer() {
        return this;
    }
    getOwnedPreferenceIds() {
        return [mcp_preferences_1.MCP_SERVERS_PREF, mcp_preferences_1.MCP_USE_WORKSPACE_AS_ROOT_PREF];
    }
    get search() {
        return this;
    }
    init() {
        this.toDispose.push(this.mcpFrontendNotificationService.onDidUpdateMCPServers(() => this.loadServers()));
        if (this.agentPluginBridge) {
            // An install changes which plugin names resolve, so the provenance labels must re-render.
            this.toDispose.push(this.agentPluginBridge.onDidChange(() => this.onDidChangeEmitter.fire()));
        }
        this.loadServers();
    }
    dispose() {
        this.toDispose.dispose();
    }
    async loadServers() {
        const serverNames = (await this.mcpFrontendService.getServerNames()).sort((a, b) => a.localeCompare(b));
        const descriptions = await Promise.all(serverNames.map(name => this.mcpFrontendService.getServerDescription(name)));
        this.servers = descriptions.filter((description) => description !== undefined);
        this.oauthCredentialStates = Object.fromEntries(await Promise.all(this.servers.map(async (server) => [
            server.name,
            (0, mcp_server_manager_1.isRemoteMCPServerDescription)(server) && server.oauth
                ? await this.mcpFrontendService.hasStoredOAuthCredentials(server.name)
                : false
        ])));
        this.onDidChangeEmitter.fire();
    }
    get categoryId() {
        return this.id;
    }
    getTreeChildren() {
        return this.servers.map(server => ({
            id: server.name,
            label: server.name,
            iconClass: this.iconClass,
            description: this.getServerSummary(server),
            // Provenance belongs in the list too, not just on the detail page: it is how you tell a server you
            // configured by hand from one installed from the registry without opening each of them.
            origins: this.getServerOrigins(server),
            status: this.getServerStatus(server)
        }));
    }
    /**
     * The registry entry and/or the Agent Plugin a server came from. Both, when it carries both: a
     * plugin-contributed server can also be linked to a registry approval of its own, and the two lead to
     * different places. Empty for a server the user configured by hand, which is the common case.
     */
    getServerOrigins(server) {
        const origins = [];
        const registryId = server.registryMetadata?.serverId;
        const bridge = this.registryBridge;
        if (registryId) {
            // Stated even without `@theia/ai-registry`, which is what would open it: the server did come
            // from the registry, and the preference it was written into says so whether or not we can link.
            origins.push(ai_configuration_origin_badge_1.AiConfigurationOrigin.registry(registryId, bridge && (() => bridge.openRegistry(registryId))));
        }
        const plugin = this.getOwningPlugin(server);
        if (plugin) {
            origins.push(ai_configuration_origin_badge_1.AiConfigurationOrigin.agentPlugin(plugin, () => this.agentPluginBridge?.revealPlugin(plugin.pluginId)));
        }
        return origins.length > 0 ? origins : undefined;
    }
    /**
     * The Agent Plugin that contributed a server, or `undefined` when the server is the user's own, when the
     * owning plugin is not installed - a bare identifier is not worth an affordance - or when no bridge is
     * bound, i.e. in a product without `@theia/ai-registry`.
     */
    getOwningPlugin(server) {
        const pluginId = server.registryMetadata?.pluginId;
        return pluginId ? this.agentPluginBridge?.getPlugin(pluginId) : undefined;
    }
    /** Overview subtitle: the server type (Local/Remote) and, once known, its tool count — not the raw command/URL. */
    getServerSummary(server) {
        const type = (0, mcp_server_manager_1.isLocalMCPServerDescription)(server)
            ? core_1.nls.localizeByDefault('Local')
            : (0, mcp_server_manager_1.isRemoteMCPServerDescription)(server)
                ? core_1.nls.localizeByDefault('Remote')
                : undefined;
        const toolCount = server.tools?.length ?? 0;
        const tools = toolCount > 0 ? core_1.nls.localizeByDefault('{0} tools', toolCount) : undefined;
        return [type, tools].filter(entry => entry !== undefined).join(' · ') || undefined;
    }
    getServerStatus(server) {
        const status = server.status;
        switch (status) {
            case mcp_server_manager_1.MCPServerStatus.Running:
            case mcp_server_manager_1.MCPServerStatus.Connected:
                return { kind: 'on', label: status };
            case mcp_server_manager_1.MCPServerStatus.Starting:
            case mcp_server_manager_1.MCPServerStatus.Connecting:
            case mcp_server_manager_1.MCPServerStatus.AuthenticationRequired:
                return { kind: 'warn', label: status };
            case mcp_server_manager_1.MCPServerStatus.Errored:
                return { kind: 'error', label: mcp_server_manager_1.MCPServerStatus.Errored, tooltip: server.error ?? status };
            default:
                return { kind: 'off', label: status ?? mcp_server_manager_1.MCPServerStatus.NotRunning };
        }
    }
    renderCategorySettings(ctx) {
        return (0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)(ai_configuration_primitives_1.AiConfigurationSection, { title: core_1.nls.localizeByDefault('Settings'), children: (0, jsx_runtime_1.jsx)(ai_settings_row_1.AiSettingsRow, { service: this.settingsRowService, preferenceId: mcp_preferences_1.MCP_USE_WORKSPACE_AS_ROOT_PREF, scope: ctx.scope, control: this.settingsRowService.controlFor(mcp_preferences_1.MCP_USE_WORKSPACE_AS_ROOT_PREF), onDidChange: ctx.update }) }), this.registryBridge && (0, jsx_runtime_1.jsx)("div", { className: 'mcp-header-actions', children: (0, jsx_runtime_1.jsxs)("button", { className: 'theia-button secondary', title: core_1.nls.localize('theia/ai/mcpConfiguration/browseAIRegistryTooltip', 'Open the Extensions view to browse AI registry entries'), onClick: () => this.registryBridge?.openRegistry(), children: [(0, jsx_runtime_1.jsx)("i", { className: (0, browser_1.codicon)('link-external') }), core_1.nls.localize('theia/ai/mcpConfiguration/browseAIRegistry', 'Browse AI registry')] }) })] });
    }
    getAddAction() {
        return {
            label: core_1.nls.localizeByDefault('Add MCP Server'),
            iconClass: (0, browser_1.codicon)('add'),
            run: () => { this.serverEditor.openAddServer(); }
        };
    }
    get overviewListTitle() {
        return core_1.nls.localize('theia/ai/mcpConfiguration/serversListTitle', 'Servers');
    }
    getEmptyMessage() {
        return core_1.nls.localize('theia/ai/mcpConfiguration/noServersConfigured', 'No MCP servers configured');
    }
    renderItemHeader(item) {
        const server = this.servers.find(candidate => candidate.name === item.id);
        if (!server) {
            return undefined;
        }
        // Use the shared detail header (icon + title), matching the other detail pages. The origin badges sit
        // next to the title; the status badge is grouped with the lifecycle/delete controls on the right.
        return (0, jsx_runtime_1.jsx)(ai_configuration_primitives_1.AiConfigurationItemDetailHeader, { title: server.name, iconClass: this.iconClass, subtitle: this.getServerSummary(server), origins: this.getServerOrigins(server), status: this.getServerStatus(server), actions: this.renderServerActions(server) });
    }
    renderItemSections(item, ctx) {
        const server = this.servers.find(candidate => candidate.name === item.id);
        if (!server) {
            return undefined;
        }
        return (0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)(ai_configuration_primitives_1.AiConfigurationSection, { className: 'mcp-config-form', children: this.renderConfigForm(server) }), this.renderToolsSection(server, ctx)] });
    }
    /** Lifecycle (start/stop/sign-in/sign-out), registry-origin link and delete controls for the header action slot. */
    renderServerActions(server) {
        const isStoppable = server.status === mcp_server_manager_1.MCPServerStatus.Running
            || server.status === mcp_server_manager_1.MCPServerStatus.Connected
            || server.status === mcp_server_manager_1.MCPServerStatus.AuthenticationRequired;
        const isStarting = server.status === mcp_server_manager_1.MCPServerStatus.Starting || server.status === mcp_server_manager_1.MCPServerStatus.Connecting;
        const isStartable = server.status === mcp_server_manager_1.MCPServerStatus.NotRunning
            || server.status === mcp_server_manager_1.MCPServerStatus.NotConnected
            || server.status === mcp_server_manager_1.MCPServerStatus.AuthenticationRequired
            || server.status === mcp_server_manager_1.MCPServerStatus.Errored;
        const isRemote = (0, mcp_server_manager_1.isRemoteMCPServerDescription)(server);
        const isOAuthEnabled = isRemote && !!server.oauth;
        const startIcon = isRemote ? 'plug' : 'play';
        const stopIcon = isRemote ? 'debug-disconnect' : 'debug-stop';
        const startLabel = isRemote ? core_1.nls.localizeByDefault('Connect') : core_1.nls.localizeByDefault('Start Server');
        const startingLabel = isRemote ? core_1.nls.localizeByDefault('Connecting...') : core_1.nls.localizeByDefault('Starting...');
        const stopLabel = isRemote ? core_1.nls.localizeByDefault('Disconnect') : core_1.nls.localizeByDefault('Stop Server');
        return (0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [isStartable && (0, jsx_runtime_1.jsx)("button", { className: `mcp-action-button ${(0, browser_1.codicon)(startIcon)}`, onClick: () => this.handleStartServer(server), title: startLabel }), isStarting && (0, jsx_runtime_1.jsx)("button", { className: `mcp-action-button ${(0, browser_1.codicon)('loading')} theia-animation-spin`, disabled: true, title: startingLabel }), isStoppable && (0, jsx_runtime_1.jsx)("button", { className: `mcp-action-button ${(0, browser_1.codicon)(stopIcon)}`, onClick: () => this.handleStopServer(server.name), title: stopLabel }), isOAuthEnabled && isStartable &&
                    (0, jsx_runtime_1.jsx)("button", { className: `mcp-action-button ${(0, browser_1.codicon)('sign-in')}`, onClick: () => this.handleSignInServer(server.name), title: core_1.nls.localizeByDefault('Sign In') }), isOAuthEnabled && this.oauthCredentialStates[server.name] && (0, jsx_runtime_1.jsx)("button", { className: `mcp-action-button ${(0, browser_1.codicon)('sign-out')}`, onClick: () => this.handleSignOutServer(server.name), title: core_1.nls.localizeByDefault('Sign Out') }), (0, jsx_runtime_1.jsx)("button", { className: `mcp-action-button mcp-delete-button ${(0, browser_1.codicon)('trash')}`, onClick: () => this.handleDeleteServer(server.name), title: core_1.nls.localize('theia/ai/mcpConfiguration/deleteServer', 'Delete Server') })] });
    }
    /**
     * The per-server configuration, edited in place. Each field patches the server's form representation and
     * re-persists it via {@link MCPServerEditor.save} — the same write path (and stale-key cleanup) the Add
     * dialog uses — so there is no separate Edit dialog. The server type is shown read-only: changing it means
     * deleting and re-adding the server, which the Add dialog handles cleanly.
     */
    renderConfigForm(server) {
        const local = (0, mcp_server_manager_1.isLocalMCPServerDescription)(server);
        const remote = (0, mcp_server_manager_1.isRemoteMCPServerDescription)(server);
        const oauth = remote ? server.oauth : undefined;
        return (0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [this.renderFieldRow(core_1.nls.localizeByDefault('Server Type'), (0, jsx_runtime_1.jsx)("span", { className: 'mcp-field-static', children: this.getServerTypeLabel(server) })), local && this.renderTextField(core_1.nls.localizeByDefault('Command'), server.command, false, false, value => this.updateServer(server, { command: value }), server.command.trim() ? undefined : core_1.nls.localize('theia/ai/mcpConfiguration/form/commandRequired', 'Command is required for local servers')), local && this.renderArrayField(core_1.nls.localizeByDefault('Arguments'), server.args ?? [], core_1.nls.localize('theia/ai/mcpConfiguration/addArgument', 'Add argument…'), values => this.updateServer(server, { args: values })), local && this.renderKeyValueField(core_1.nls.localize('theia/ai/mcpConfiguration/environmentVariables', 'Environment Variables'), server.env ?? {}, lines => this.updateServer(server, { env: lines })), local && this.renderPluginPathsSection(server), remote && this.renderTextField(core_1.nls.localize('theia/ai/mcpConfiguration/serverUrl', 'Server URL'), server.serverUrl, false, false, value => this.updateServer(server, { serverUrl: value }), server.serverUrl.trim() ? undefined : core_1.nls.localize('theia/ai/mcpConfiguration/form/serverUrlRequired', 'Server URL is required for remote servers')), remote && !oauth && this.renderTextField(core_1.nls.localize('theia/ai/mcpConfiguration/serverAuthTokenHeader', 'Auth Header Name'), server.serverAuthTokenHeader ?? '', false, false, value => this.updateServer(server, { serverAuthTokenHeader: value })), remote && !oauth && this.renderTextField(core_1.nls.localize('theia/ai/mcpConfiguration/serverAuthToken', 'Auth Token'), server.serverAuthToken ?? '', false, true, value => this.updateServer(server, { serverAuthToken: value })), remote && this.renderKeyValueField(core_1.nls.localizeByDefault('Headers'), server.headers ?? {}, lines => this.updateServer(server, { headers: lines })), oauth && this.renderOAuthFields(server, oauth), this.renderToggleField(core_1.nls.localize('theia/ai/mcpConfiguration/autostart', 'Autostart'), server.autostart ?? false, value => this.updateServer(server, { autostart: value })), this.renderToggleField(core_1.nls.localize('theia/ai/mcpConfiguration/deferLoading', 'Defer tool loading'), server.deferLoading ?? false, value => this.updateServer(server, { deferLoading: value }))] });
    }
    renderOAuthFields(server, oauth) {
        return (0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [this.renderTextField(core_1.nls.localize('theia/ai/mcpConfiguration/oauthClientId', 'OAuth Client ID'), oauth.clientId ?? '', false, false, value => this.updateServer(server, { oauthClientId: value })), this.renderTextField(core_1.nls.localize('theia/ai/mcpConfiguration/oauthClientSecret', 'OAuth Client Secret'), oauth.clientSecret ?? '', false, true, value => this.updateServer(server, { oauthClientSecret: value })), this.renderArrayField(core_1.nls.localize('theia/ai/mcpConfiguration/oauthScopes', 'OAuth Scopes'), oauth.scopes ?? [], core_1.nls.localize('theia/ai/mcpConfiguration/addScope', 'Add scope…'), values => this.updateServer(server, { oauthScopes: values.join(' ') })), this.renderTextField(core_1.nls.localize('theia/ai/mcpConfiguration/oauthAuthorizationServer', 'Authorization Server'), oauth.authorizationServer ?? '', false, false, value => this.updateServer(server, { oauthAuthorizationServer: value }), oauth.authorizationServer && !(0, mcp_server_preference_validator_1.isHttpOrHttpsUrl)(oauth.authorizationServer)
                    ? core_1.nls.localize('theia/ai/mcpConfiguration/form/oauthAuthorizationServerInvalid', 'OAuth Authorization Server must be a valid http(s) URL')
                    : undefined), this.renderTextField(core_1.nls.localize('theia/ai/mcpConfiguration/oauthResource', 'OAuth Resource'), oauth.resource ?? '', false, false, value => this.updateServer(server, { oauthResource: value }), oauth.resource && !(0, mcp_server_preference_validator_1.isHttpOrHttpsUrl)(oauth.resource)
                    ? core_1.nls.localize('theia/ai/mcpConfiguration/form/oauthResourceInvalid', 'OAuth Resource must be a valid http(s) URL')
                    : undefined)] });
    }
    /** Patches the server's editable form and re-saves it (reusing the dialog's persistence path). */
    updateServer(server, patch) {
        const form = this.serverEditor.toFormData(server);
        if (!form) {
            return;
        }
        this.serverEditor.save({ ...form, ...patch }).catch(error => this.messageService.error(core_1.nls.localize('theia/ai/mcpConfiguration/saveServerError', 'Failed to save MCP server configuration: {0}', String(error))));
    }
    getServerTypeLabel(server) {
        if ((0, mcp_server_manager_1.isLocalMCPServerDescription)(server)) {
            return core_1.nls.localizeByDefault('Local');
        }
        if ((0, mcp_server_manager_1.isRemoteMCPServerDescription)(server)) {
            return server.oauth ? core_1.nls.localize('theia/ai/mcpConfiguration/typeRemoteOAuth', 'Remote (OAuth)') : core_1.nls.localizeByDefault('Remote');
        }
        return core_1.nls.localizeByDefault('Unknown');
    }
    /**
     * Read-only on purpose: all three are derived from where `@theia/ai-registry` installed the Agent
     * Plugin, so there is nothing for the user to author. Shown rather than hidden because they decide
     * where the process runs and what `PLUGIN_ROOT` and `PLUGIN_DATA` point at.
     */
    renderPluginPathsSection(server) {
        if (!(0, mcp_server_manager_1.isLocalMCPServerDescription)(server)) {
            return undefined;
        }
        return (0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [this.renderReadOnlyPath(core_1.nls.localizeByDefault('Working Directory'), server.cwd), this.renderReadOnlyPath(core_1.nls.localize('theia/ai/mcpConfiguration/pluginRoot', 'Plugin Root'), server.pluginRoot, 'PLUGIN_ROOT'), this.renderReadOnlyPath(core_1.nls.localize('theia/ai/mcpConfiguration/pluginData', 'Plugin Data'), server.pluginData, 'PLUGIN_DATA')] });
    }
    /** @param variable the environment variable the value is exported as, when it is one. */
    renderReadOnlyPath(label, value, variable) {
        if (!value) {
            return undefined;
        }
        return this.renderFieldRow(label, (0, jsx_runtime_1.jsxs)("code", { className: 'mcp-property-readonly', title: value, children: [value, variable && (0, jsx_runtime_1.jsx)("span", { className: 'mcp-property-variable', children: variable })] }));
    }
    renderFieldRow(label, control) {
        return (0, jsx_runtime_1.jsxs)("div", { className: 'mcp-property-row', children: [(0, jsx_runtime_1.jsxs)("span", { className: 'mcp-property-label', children: [label, ":"] }), (0, jsx_runtime_1.jsx)("div", { className: 'mcp-property-value mcp-field-control', children: control })] });
    }
    renderTextField(label, value, monospace, password, onCommit, error) {
        return this.renderFieldRow(label, (0, jsx_runtime_1.jsx)(ai_configuration_controls_1.AiTextInput, { value: value, ariaLabel: label, monospace: monospace, password: password, invalid: !!error, errorMessage: error, onCommit: onCommit }));
    }
    renderArrayField(label, values, addPlaceholder, onChange) {
        return this.renderFieldRow(label, (0, jsx_runtime_1.jsx)(ai_configuration_controls_1.AiArrayInput, { values: values, ariaLabel: label, addPlaceholder: addPlaceholder, onChange: onChange }));
    }
    renderKeyValueField(label, entries, onChange) {
        const lines = Object.entries(entries).map(([key, value]) => `${key}=${value}`);
        return this.renderFieldRow(label, (0, jsx_runtime_1.jsx)(ai_configuration_controls_1.AiArrayInput, { values: lines, ariaLabel: label, addPlaceholder: core_1.nls.localize('theia/ai/mcpConfiguration/addKeyValue', 'Add KEY=value…'), onChange: next => onChange(next.join('\n')) }));
    }
    renderToggleField(label, checked, onChange) {
        return this.renderFieldRow(label, (0, jsx_runtime_1.jsx)(ai_configuration_controls_1.AiToggleSwitch, { checked: checked, ariaLabel: label, onChange: onChange }));
    }
    /**
     * The server's tools, shown (once available) as a plain, non-collapsible list matching the Variables list,
     * each row offering a per-tool copy action and linking to the Tools page. The "copy all" variants stay in
     * a small toolbar in the header.
     */
    renderToolsSection(server, ctx) {
        if (!server.tools || server.tools.length === 0) {
            return undefined;
        }
        const tools = server.tools;
        const copy = (text, info) => {
            navigator.clipboard.writeText(text);
            this.messageService.info(info);
        };
        return (0, jsx_runtime_1.jsx)(ai_configuration_primitives_1.AiConfigurationSection, { title: core_1.nls.localizeByDefault('Tools'), actions: (0, jsx_runtime_1.jsxs)("div", { className: 'mcp-tools-actions', children: [(0, jsx_runtime_1.jsx)("button", { className: 'mcp-copy-tool-button', title: core_1.nls.localize('theia/ai/mcpConfiguration/copyAllList', 'Copy all (list of all tools)'), onClick: () => copy(tools.map(tool => `~{mcp_${server.name}_${tool.name}}`).join('\n'), core_1.nls.localize('theia/ai/mcpConfiguration/copiedAllList', 'Copied all tools to clipboard (list of all tools)')), children: (0, jsx_runtime_1.jsx)("i", { className: (0, browser_1.codicon)('versions') }) }), (0, jsx_runtime_1.jsx)("button", { className: 'mcp-copy-tool-button', title: core_1.nls.localize('theia/ai/mcpConfiguration/copyForPromptTemplate', 'Copy all for prompt template (single prompt fragment with all tools)'), onClick: () => copy(`{{${prompt_variable_contribution_1.PROMPT_VARIABLE.name}:${this.mcpFrontendService.getPromptTemplateId(server.name)}}}`, core_1.nls.localize('theia/ai/mcpConfiguration/copiedForPromptTemplate', 'Copied all tools to clipboard for prompt template (single prompt fragment with all tools)')), children: (0, jsx_runtime_1.jsx)("i", { className: (0, browser_1.codicon)('bracket') }) }), (0, jsx_runtime_1.jsx)("button", { className: 'mcp-copy-tool-button', title: core_1.nls.localize('theia/ai/mcpConfiguration/copyAllSingle', 'Copy all for chat (single prompt fragment with all tools)'), onClick: () => copy(`#${prompt_variable_contribution_1.PROMPT_VARIABLE.name}:${this.mcpFrontendService.getPromptTemplateId(server.name)}`, core_1.nls.localize('theia/ai/mcpConfiguration/copiedAllSingle', 'Copied all tools to clipboard (single prompt fragment with all tools)')), children: (0, jsx_runtime_1.jsx)("i", { className: (0, browser_1.codicon)('copy') }) })] }), children: (0, jsx_runtime_1.jsx)("div", { className: 'ai-configuration-item-list', children: tools.map(tool => {
                    const token = `~{mcp_${server.name}_${tool.name}}`;
                    return (0, jsx_runtime_1.jsx)(ai_configuration_item_row_1.AiConfigurationItemRow, { label: tool.name, description: tool.description, 
                        // The registry prefixes an MCP tool with its server, which is how the Tools page lists it.
                        onActivateLabel: () => ctx.navigate(ai_configuration_category_1.AiConfigurationTools.selectionFor(`mcp_${server.name}_${tool.name}`)), labelTooltip: core_1.nls.localize('theia/ai/mcpConfiguration/showToolSettings', 'Show tool'), trailing: (0, jsx_runtime_1.jsx)("button", { className: 'mcp-copy-tool-button', title: core_1.nls.localize('theia/ai/mcpConfiguration/copyForPrompt', 'Copy tool (for chat or prompt template)'), onClick: () => copy(token, core_1.nls.localize('theia/ai/mcpConfiguration/copiedForPrompt', 'Copied {0} to clipboard (for chat or prompt template)', token)), children: (0, jsx_runtime_1.jsx)("i", { className: (0, browser_1.codicon)('copy') }) }) }, tool.name);
                }) }) });
    }
    async handleStartServer(server) {
        try {
            if (server.status === mcp_server_manager_1.MCPServerStatus.AuthenticationRequired) {
                await this.mcpFrontendService.stopServer(server.name);
            }
            await this.mcpFrontendService.startServerInteractive(server.name);
        }
        catch (error) {
            this.logger.error(`Failed to start MCP server "${server.name}"`, error);
            this.messageService.warn(core_1.nls.localize('theia/ai/mcpConfiguration/startServerFailed', 'Failed to start MCP server "{0}".', server.name));
        }
    }
    async handleStopServer(serverName) {
        try {
            await this.mcpFrontendService.stopServer(serverName);
        }
        catch (error) {
            this.logger.error(`Failed to stop MCP server "${serverName}"`, error);
            this.messageService.warn(core_1.nls.localize('theia/ai/mcpConfiguration/stopServerFailed', 'Failed to stop MCP server "{0}".', serverName));
        }
    }
    async handleSignInServer(serverName) {
        try {
            const signedIn = await this.mcpFrontendService.signIn(serverName);
            if (signedIn) {
                this.messageService.info(core_1.nls.localize('theia/ai/mcpConfiguration/signInServerSucceeded', 'Signed in to MCP server "{0}".', serverName));
            }
            else {
                this.messageService.warn(core_1.nls.localize('theia/ai/mcpConfiguration/signInServerNotCompleted', 'Sign-in to MCP server "{0}" was not completed.', serverName));
            }
        }
        catch (error) {
            this.logger.error(`Failed to sign in to MCP server "${serverName}"`, error);
            this.messageService.warn(core_1.nls.localize('theia/ai/mcpConfiguration/signInServerFailed', 'Failed to sign in to MCP server "{0}".', serverName));
        }
    }
    async handleSignOutServer(serverName) {
        const dialog = new browser_1.ConfirmDialog({
            title: core_1.nls.localize('theia/ai/mcpConfiguration/signOutServerDialogTitle', 'Sign Out from MCP Server'),
            msg: core_1.nls.localize('theia/ai/mcpConfiguration/signOutServerDialogMsg', 'Are you sure you want to sign out from the server "{0}"? This deletes the stored OAuth tokens for this server.', serverName),
            ok: core_1.nls.localizeByDefault('Sign Out'),
            cancel: core_1.nls.localizeByDefault('Cancel')
        });
        if ((await dialog.open()) === true) {
            try {
                await this.mcpFrontendService.signOut(serverName);
            }
            catch (error) {
                this.logger.error(`Failed to sign out from MCP server "${serverName}"`, error);
                this.messageService.warn(core_1.nls.localize('theia/ai/mcpConfiguration/signOutServerFailed', 'Failed to sign out from MCP server "{0}".', serverName));
            }
        }
    }
    async handleDeleteServer(serverName) {
        const dialog = new browser_1.ConfirmDialog({
            title: core_1.nls.localize('theia/ai/mcpConfiguration/deleteServerDialogTitle', 'Delete MCP Server'),
            msg: core_1.nls.localize('theia/ai/mcpConfiguration/deleteServerDialogMsg', 'Are you sure you want to delete the server "{0}"?', serverName),
            ok: core_1.nls.localizeByDefault('Delete'),
            cancel: core_1.nls.localizeByDefault('Cancel')
        });
        if (await dialog.open()) {
            try {
                const currentServers = this.aiConfigurationService.get(mcp_preferences_1.MCP_SERVERS_PREF, {}) ?? {};
                const newServers = { ...currentServers };
                delete newServers[serverName];
                await this.aiConfigurationService.set(mcp_preferences_1.MCP_SERVERS_PREF, newServers, core_1.PreferenceScope.User);
            }
            catch (error) {
                this.messageService.error(core_1.nls.localize('theia/ai/mcpConfiguration/deleteServerError', 'Failed to delete MCP server: {0}', String(error)));
            }
        }
    }
    getSearchItems() {
        const serverTypeLabel = core_1.nls.localize('theia/ai/mcpConfiguration/serverTypeLabel', 'MCP server');
        const toolTypeLabel = core_1.nls.localizeByDefault('Tool');
        const items = [];
        for (const server of this.servers) {
            items.push({
                label: server.name,
                typeLabel: serverTypeLabel,
                categoryId: this.id,
                target: { categoryId: this.id, itemId: server.name },
                keywords: server.tools?.map(tool => tool.name).join(' ') ?? ''
            });
            for (const tool of server.tools ?? []) {
                items.push({
                    label: tool.name,
                    typeLabel: toolTypeLabel,
                    categoryId: this.id,
                    target: { categoryId: this.id, itemId: server.name },
                    keywords: `${server.name} ${tool.description ?? ''}`
                });
            }
        }
        return items;
    }
};
exports.McpServersConfigurationCategory = McpServersConfigurationCategory;
tslib_1.__decorate([
    (0, inversify_1.inject)(mcp_server_manager_1.MCPFrontendService),
    tslib_1.__metadata("design:type", Object)
], McpServersConfigurationCategory.prototype, "mcpFrontendService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(mcp_server_manager_1.MCPFrontendNotificationService),
    tslib_1.__metadata("design:type", Object)
], McpServersConfigurationCategory.prototype, "mcpFrontendNotificationService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.ILogger),
    (0, inversify_1.named)('ai-mcp:McpServersConfigurationCategory'),
    tslib_1.__metadata("design:type", Object)
], McpServersConfigurationCategory.prototype, "logger", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.MessageService),
    tslib_1.__metadata("design:type", core_1.MessageService)
], McpServersConfigurationCategory.prototype, "messageService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(ai_core_1.AiConfigurationService),
    tslib_1.__metadata("design:type", Object)
], McpServersConfigurationCategory.prototype, "aiConfigurationService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(mcp_server_editor_1.MCPServerEditor),
    tslib_1.__metadata("design:type", Object)
], McpServersConfigurationCategory.prototype, "serverEditor", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(ai_settings_row_service_1.AiSettingsRowService),
    tslib_1.__metadata("design:type", ai_settings_row_service_1.AiSettingsRowService)
], McpServersConfigurationCategory.prototype, "settingsRowService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(mcp_registry_ui_bridge_1.MCPRegistryUiBridge),
    (0, inversify_1.optional)(),
    tslib_1.__metadata("design:type", Object)
], McpServersConfigurationCategory.prototype, "registryBridge", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(agent_plugin_ui_bridge_1.AgentPluginUiBridge),
    (0, inversify_1.optional)(),
    tslib_1.__metadata("design:type", Object)
], McpServersConfigurationCategory.prototype, "agentPluginBridge", void 0);
tslib_1.__decorate([
    (0, inversify_1.postConstruct)(),
    tslib_1.__metadata("design:type", Function),
    tslib_1.__metadata("design:paramtypes", []),
    tslib_1.__metadata("design:returntype", void 0)
], McpServersConfigurationCategory.prototype, "init", null);
exports.McpServersConfigurationCategory = McpServersConfigurationCategory = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], McpServersConfigurationCategory);
//# sourceMappingURL=mcp-servers-configuration-category.js.map