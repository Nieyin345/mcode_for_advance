"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MCPServerEditDialog = exports.DEFAULT_MCP_SERVER_FORM_DATA = void 0;
const jsx_runtime_1 = require("@theia/core/shared/react/jsx-runtime");
const core_1 = require("@theia/core");
const react_dialog_1 = require("@theia/core/lib/browser/dialogs/react-dialog");
const select_component_1 = require("@theia/core/lib/browser/widgets/select-component");
const mcp_server_preference_validator_1 = require("../common/mcp-server-preference-validator");
exports.DEFAULT_MCP_SERVER_FORM_DATA = {
    name: '',
    serverType: 'local',
    command: '',
    args: [],
    env: '',
    serverUrl: '',
    serverAuthToken: '',
    serverAuthTokenHeader: '',
    headers: '',
    oauthClientId: '',
    oauthClientSecret: '',
    oauthScopes: '',
    oauthAuthorizationServer: '',
    oauthResource: '',
    autostart: true,
    deferLoading: false
};
/**
 * Dialog for adding or editing an MCP server. Kept in a separate module from
 * `MCPServerEditor` so importing the editor doesn't pull in the DOM-touching
 * `ReactDialog` chain - important for unit tests that load the editor's types.
 */
class MCPServerEditDialog extends react_dialog_1.ReactDialog {
    constructor(props, initialData, existingServerNames, isEditing, redirectUrlProvider) {
        super(props);
        this.oauthRedirectUrlRequested = false;
        this.redirectUrlCopied = false;
        this.handleFormChange = (field, value) => {
            this.formData = { ...this.formData, [field]: value };
            if (field === 'serverType') {
                // serverType toggles which fields are shown - needs a re-render.
                this.update();
            }
            else {
                // Inputs are uncontrolled (defaultValue/defaultChecked) so the DOM keeps the typed
                // value without a React re-render. Skipping the re-render on every keystroke avoids
                // the cursor-jump caused by Lumino's async update path with controlled inputs
                // (GH-17414); we only refresh validation + accept-button state.
                this.validate();
            }
        };
        this.handleCopyRedirectUrl = () => {
            if (!this.oauthRedirectUrl) {
                return;
            }
            navigator.clipboard.writeText(this.oauthRedirectUrl);
            this.redirectUrlCopied = true;
            this.update();
            setTimeout(() => {
                this.redirectUrlCopied = false;
                if (!this.isDisposed) {
                    this.update();
                }
            }, 1500);
        };
        this.formData = { ...initialData };
        this.existingServerNames = existingServerNames;
        this.isEditing = isEditing;
        this.redirectUrlProvider = redirectUrlProvider;
        this.appendCloseButton(core_1.nls.localizeByDefault('Cancel'));
        this.appendAcceptButton(isEditing
            ? core_1.nls.localize('theia/ai/mcpConfiguration/form/saveChanges', 'Save Changes')
            : core_1.nls.localizeByDefault('Add Server'));
    }
    get value() {
        return this.formData;
    }
    isValid() {
        const errors = [];
        if (!this.formData.name.trim()) {
            errors.push(core_1.nls.localize('theia/ai/mcpConfiguration/form/nameRequired', 'Server name is required'));
        }
        else if (!this.isEditing && this.existingServerNames.includes(this.formData.name.trim())) {
            errors.push(core_1.nls.localize('theia/ai/mcpConfiguration/form/nameExists', 'A server with this name already exists'));
        }
        if (this.formData.serverType === 'local') {
            if (!this.formData.command.trim()) {
                errors.push(core_1.nls.localize('theia/ai/mcpConfiguration/form/commandRequired', 'Command is required for local servers'));
            }
        }
        else if (!this.formData.serverUrl.trim()) {
            errors.push(core_1.nls.localize('theia/ai/mcpConfiguration/form/serverUrlRequired', 'Server URL is required for remote servers'));
        }
        else if (this.formData.serverType === 'remote-oauth') {
            const authorizationServer = this.formData.oauthAuthorizationServer.trim();
            if (authorizationServer && !(0, mcp_server_preference_validator_1.isHttpOrHttpsUrl)(authorizationServer)) {
                errors.push(core_1.nls.localize('theia/ai/mcpConfiguration/form/oauthAuthorizationServerInvalid', 'OAuth Authorization Server must be a valid http(s) URL'));
            }
            const resource = this.formData.oauthResource.trim();
            if (resource && !(0, mcp_server_preference_validator_1.isHttpOrHttpsUrl)(resource)) {
                errors.push(core_1.nls.localize('theia/ai/mcpConfiguration/form/oauthResourceInvalid', 'OAuth Resource must be a valid http(s) URL'));
            }
        }
        return errors.join('. ');
    }
    /**
     * Splits the arguments field, which is a single line and so can only express whitespace-separated
     * arguments. Entering an argument that itself contains a space is done with the list editor on the
     * server's detail page, which keeps each entry verbatim.
     */
    splitArguments(line) {
        const trimmed = line.trim();
        return trimmed ? trimmed.split(/\s+/) : [];
    }
    render() {
        return ((0, jsx_runtime_1.jsxs)("div", { className: "mcp-dialog-form", children: [(0, jsx_runtime_1.jsxs)("div", { className: "mcp-form-field", children: [(0, jsx_runtime_1.jsxs)("label", { children: [core_1.nls.localize('theia/ai/mcpConfiguration/form/serverName', 'Server Name'), ":"] }), (0, jsx_runtime_1.jsx)("input", { type: "text", className: "theia-input", defaultValue: this.formData.name, onChange: e => this.handleFormChange('name', e.target.value), placeholder: core_1.nls.localize('theia/ai/mcpConfiguration/form/serverNamePlaceholder', 'e.g., my-mcp-server'), disabled: this.isEditing, spellCheck: false })] }), (0, jsx_runtime_1.jsxs)("div", { className: "mcp-form-field", children: [(0, jsx_runtime_1.jsxs)("label", { children: [core_1.nls.localizeByDefault('Server Type'), ":"] }), (0, jsx_runtime_1.jsx)(select_component_1.SelectComponent, { className: "theia-select", defaultValue: this.formData.serverType, options: [
                                { value: 'local', label: core_1.nls.localize('theia/ai/mcpConfiguration/form/localServer', 'Local (Command)') },
                                { value: 'remote', label: core_1.nls.localize('theia/ai/mcpConfiguration/form/remoteServer', 'Remote (URL)') },
                                { value: 'remote-oauth', label: core_1.nls.localize('theia/ai/mcpConfiguration/form/remoteOAuthServer', 'Remote (OAuth)') }
                            ], onChange: option => this.handleFormChange('serverType', option.value) })] }), this.formData.serverType === 'local' ? this.renderLocalServerFields() : this.renderRemoteServerFields(), (0, jsx_runtime_1.jsx)("div", { className: "mcp-form-field mcp-form-checkbox", children: (0, jsx_runtime_1.jsxs)("label", { children: [(0, jsx_runtime_1.jsx)("input", { type: "checkbox", className: 'theia-input', defaultChecked: this.formData.autostart, onChange: e => this.handleFormChange('autostart', e.target.checked) }), core_1.nls.localize('theia/ai/mcpConfiguration/form/autostart', 'Autostart')] }) }), (0, jsx_runtime_1.jsx)("div", { className: "mcp-form-field mcp-form-checkbox", children: (0, jsx_runtime_1.jsxs)("label", { children: [(0, jsx_runtime_1.jsx)("input", { type: "checkbox", className: 'theia-input', defaultChecked: this.formData.deferLoading, onChange: e => this.handleFormChange('deferLoading', e.target.checked) }), core_1.nls.localize('theia/ai/mcpConfiguration/form/deferLoading', 'Defer tool loading (discover tools on demand via the provider tool search)')] }) })] }));
    }
    renderLocalServerFields() {
        return ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsxs)("div", { className: "mcp-form-field", children: [(0, jsx_runtime_1.jsxs)("label", { children: [core_1.nls.localizeByDefault('Command'), ":"] }), (0, jsx_runtime_1.jsx)("input", { type: "text", className: "theia-input", defaultValue: this.formData.command, onChange: e => this.handleFormChange('command', e.target.value), placeholder: core_1.nls.localize('theia/ai/mcpConfiguration/form/commandPlaceholder', 'e.g., npx or uvx'), spellCheck: false })] }), (0, jsx_runtime_1.jsxs)("div", { className: "mcp-form-field", children: [(0, jsx_runtime_1.jsxs)("label", { children: [core_1.nls.localizeByDefault('Arguments'), ":"] }), (0, jsx_runtime_1.jsx)("input", { type: "text", className: "theia-input", defaultValue: this.formData.args.join(' '), onChange: e => this.handleFormChange('args', this.splitArguments(e.target.value)), placeholder: core_1.nls.localize('theia/ai/mcpConfiguration/form/argsPlaceholder', 'Space-separated, e.g., -y @modelcontextprotocol/server-brave-search'), spellCheck: false })] }), (0, jsx_runtime_1.jsxs)("div", { className: "mcp-form-field", children: [(0, jsx_runtime_1.jsxs)("label", { children: [core_1.nls.localize('theia/ai/mcpConfiguration/environmentVariables', 'Environment Variables'), ":"] }), (0, jsx_runtime_1.jsx)("textarea", { className: "theia-input", defaultValue: this.formData.env, onChange: e => this.handleFormChange('env', e.target.value), placeholder: core_1.nls.localize('theia/ai/mcpConfiguration/form/envPlaceholder', 'KEY=value (one per line)'), rows: 3, spellCheck: false })] })] }));
    }
    /**
     * Kicks off resolving the OAuth redirect URL once. Resolved through the backend because only it
     * knows whether the Electron loopback callback server overrides the frontend's origin-based URL.
     */
    ensureOAuthRedirectUrl() {
        if (this.oauthRedirectUrlRequested || !this.redirectUrlProvider) {
            return;
        }
        this.oauthRedirectUrlRequested = true;
        this.redirectUrlProvider().then(url => {
            this.oauthRedirectUrl = url;
            this.update();
        }).catch(error => {
            console.warn('Failed to determine the MCP OAuth redirect URL; the redirect URL hint will not be shown.', error);
        });
    }
    renderRemoteServerFields() {
        if (this.formData.serverType === 'remote-oauth') {
            this.ensureOAuthRedirectUrl();
        }
        return ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsxs)("div", { className: "mcp-form-field", children: [(0, jsx_runtime_1.jsxs)("label", { children: [core_1.nls.localize('theia/ai/mcpConfiguration/serverUrl', 'Server URL'), ":"] }), (0, jsx_runtime_1.jsx)("input", { type: "text", className: "theia-input", defaultValue: this.formData.serverUrl, onChange: e => this.handleFormChange('serverUrl', e.target.value), placeholder: core_1.nls.localize('theia/ai/mcpConfiguration/form/serverUrlPlaceholder', 'e.g., https://mcp.example.com'), spellCheck: false })] }), this.formData.serverType === 'remote' && ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsxs)("div", { className: "mcp-form-field", children: [(0, jsx_runtime_1.jsxs)("label", { children: [core_1.nls.localize('theia/ai/mcpConfiguration/serverAuthToken', 'Auth Token'), ":"] }), (0, jsx_runtime_1.jsx)("input", { type: "password", className: "theia-input", defaultValue: this.formData.serverAuthToken, onChange: e => this.handleFormChange('serverAuthToken', e.target.value), placeholder: core_1.nls.localize('theia/ai/mcpConfiguration/form/authTokenPlaceholder', 'Optional authentication token'), spellCheck: false })] }), (0, jsx_runtime_1.jsxs)("div", { className: "mcp-form-field", children: [(0, jsx_runtime_1.jsxs)("label", { children: [core_1.nls.localize('theia/ai/mcpConfiguration/serverAuthTokenHeader', 'Auth Header Name'), ":"] }), (0, jsx_runtime_1.jsx)("input", { type: "text", className: "theia-input", defaultValue: this.formData.serverAuthTokenHeader, onChange: e => this.handleFormChange('serverAuthTokenHeader', e.target.value), placeholder: core_1.nls.localize('theia/ai/mcpConfiguration/form/authHeaderPlaceholder', 'Default: Authorization with Bearer'), spellCheck: false })] })] })), (0, jsx_runtime_1.jsxs)("div", { className: "mcp-form-field", children: [(0, jsx_runtime_1.jsxs)("label", { children: [core_1.nls.localizeByDefault('Headers'), ":"] }), (0, jsx_runtime_1.jsx)("textarea", { className: "theia-input", defaultValue: this.formData.headers, onChange: e => this.handleFormChange('headers', e.target.value), placeholder: core_1.nls.localize('theia/ai/mcpConfiguration/form/headersPlaceholder', 'Header-Name=value (one per line)'), rows: 3, spellCheck: false })] }), this.formData.serverType === 'remote-oauth' && ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)("div", { className: "mcp-form-section-title", children: core_1.nls.localize('theia/ai/mcpConfiguration/oauth', 'OAuth') }), (0, jsx_runtime_1.jsx)("div", { className: "mcp-form-description", children: core_1.nls.localize('theia/ai/mcpConfiguration/form/oauthPublicClientDescription', 'Theia uses public OAuth clients with PKCE by default. Provide a client secret only if the server requires a pre-registered confidential client.') }), (0, jsx_runtime_1.jsx)("div", { className: "mcp-form-description", children: core_1.nls.localize('theia/ai/mcpConfiguration/form/oauthSharedCredentialsDescription', 'Stored OAuth sessions are shared across workspaces that use the same server name and URL (or resource).') }), this.oauthRedirectUrl && ((0, jsx_runtime_1.jsxs)("div", { className: "mcp-form-field", children: [(0, jsx_runtime_1.jsxs)("label", { children: [core_1.nls.localize('theia/ai/mcpConfiguration/oauthRedirectUrl', 'Redirect URL'), ":"] }), (0, jsx_runtime_1.jsxs)("div", { className: "mcp-oauth-redirect-url-row", children: [(0, jsx_runtime_1.jsx)("span", { className: "mcp-form-static-value", children: this.oauthRedirectUrl }), (0, jsx_runtime_1.jsx)("button", { type: "button", className: "mcp-icon-button", title: core_1.nls.localizeByDefault('Copy'), onClick: this.handleCopyRedirectUrl, children: (0, jsx_runtime_1.jsx)("i", { className: this.redirectUrlCopied ? 'codicon codicon-check' : 'codicon codicon-copy' }) })] }), (0, jsx_runtime_1.jsx)("div", { className: "mcp-form-description", children: core_1.nls.localize('theia/ai/mcpConfiguration/form/oauthRedirectUrlDescription', 'Authorization callbacks are delivered to this URL. With a static client ID, register it as a redirect URI with your OAuth provider.') })] })), (0, jsx_runtime_1.jsxs)("div", { className: "mcp-form-field", children: [(0, jsx_runtime_1.jsxs)("label", { children: [core_1.nls.localize('theia/ai/mcpConfiguration/oauthClientId', 'OAuth Client ID'), ":"] }), (0, jsx_runtime_1.jsx)("input", { type: "text", className: "theia-input", defaultValue: this.formData.oauthClientId, onChange: e => this.handleFormChange('oauthClientId', e.target.value), placeholder: core_1.nls.localize('theia/ai/mcpConfiguration/form/oauthClientIdPlaceholder', 'Optional static client ID'), spellCheck: false })] }), (0, jsx_runtime_1.jsxs)("div", { className: "mcp-form-field", children: [(0, jsx_runtime_1.jsxs)("label", { children: [core_1.nls.localize('theia/ai/mcpConfiguration/oauthClientSecret', 'OAuth Client Secret'), ":"] }), (0, jsx_runtime_1.jsx)("input", { type: "password", className: "theia-input", defaultValue: this.formData.oauthClientSecret, onChange: e => this.handleFormChange('oauthClientSecret', e.target.value), placeholder: core_1.nls.localize('theia/ai/mcpConfiguration/form/oauthClientSecretPlaceholder', 'Only for servers requiring a confidential client'), spellCheck: false })] }), (0, jsx_runtime_1.jsxs)("div", { className: "mcp-form-field", children: [(0, jsx_runtime_1.jsxs)("label", { children: [core_1.nls.localize('theia/ai/mcpConfiguration/oauthScopes', 'OAuth Scopes'), ":"] }), (0, jsx_runtime_1.jsx)("input", { type: "text", className: "theia-input", defaultValue: this.formData.oauthScopes, onChange: e => this.handleFormChange('oauthScopes', e.target.value), placeholder: core_1.nls.localize('theia/ai/mcpConfiguration/form/oauthScopesPlaceholder', 'Space-separated scopes'), spellCheck: false })] }), (0, jsx_runtime_1.jsxs)("div", { className: "mcp-form-field", children: [(0, jsx_runtime_1.jsxs)("label", { children: [core_1.nls.localize('theia/ai/mcpConfiguration/oauthAuthorizationServer', 'Authorization Server'), ":"] }), (0, jsx_runtime_1.jsx)("input", { type: "text", className: "theia-input", defaultValue: this.formData.oauthAuthorizationServer, onChange: e => this.handleFormChange('oauthAuthorizationServer', e.target.value), placeholder: core_1.nls.localize('theia/ai/mcpConfiguration/form/oauthAuthorizationServerPlaceholder', 'Optional authorization server URL'), spellCheck: false })] }), (0, jsx_runtime_1.jsxs)("div", { className: "mcp-form-field", children: [(0, jsx_runtime_1.jsxs)("label", { children: [core_1.nls.localize('theia/ai/mcpConfiguration/oauthResource', 'OAuth Resource'), ":"] }), (0, jsx_runtime_1.jsx)("input", { type: "text", className: "theia-input", defaultValue: this.formData.oauthResource, onChange: e => this.handleFormChange('oauthResource', e.target.value), placeholder: core_1.nls.localize('theia/ai/mcpConfiguration/form/oauthResourcePlaceholder', 'Optional resource URI'), spellCheck: false })] })] }))] }));
    }
}
exports.MCPServerEditDialog = MCPServerEditDialog;
//# sourceMappingURL=mcp-server-edit-dialog.js.map