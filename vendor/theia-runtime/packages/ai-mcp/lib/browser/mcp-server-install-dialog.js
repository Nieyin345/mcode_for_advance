"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MCPServerInstallDialog = exports.MCPServerInstallDialogFactory = void 0;
const jsx_runtime_1 = require("@theia/core/shared/react/jsx-runtime");
const core_1 = require("@theia/core");
const react_dialog_1 = require("@theia/core/lib/browser/dialogs/react-dialog");
/**
 * Factory for the {@link MCPServerInstallDialog}. Injected so the registry install actions
 * and the `install-mcp` URL handler construct the dialog through dependency injection
 * rather than importing it directly, and so adopters can rebind the dialog if needed.
 */
exports.MCPServerInstallDialogFactory = Symbol('MCPServerInstallDialogFactory');
/**
 * Lightweight install confirmation dialog. Distinct from `MCPServerDialog` because the
 * user can't rename a server picked from the registry and the rest of the config comes
 * from the registry entry - we only need to collect the truly user-supplied parameters
 * (autostart and, when relevant, an auth token).
 */
class MCPServerInstallDialog extends react_dialog_1.ReactDialog {
    constructor(options, redirectUrlProvider) {
        super({
            title: core_1.nls.localize('theia/ai-mcp/installDialog/title', 'Install MCP Server'),
            maxWidth: 460
        });
        this.options = options;
        this.redirectUrlProvider = redirectUrlProvider;
        this.serverAuthToken = '';
        this.oauthClientId = '';
        this.oauthClientSecret = '';
        this.oauthRedirectUrlRequested = false;
        this.redirectUrlCopied = false;
        this.handleAutostartChange = (e) => {
            this.autostart = e.target.checked;
            this.update();
        };
        this.handleAuthTokenChange = (e) => {
            this.serverAuthToken = e.target.value;
            this.update();
        };
        this.handleClientIdChange = (e) => {
            this.oauthClientId = e.target.value;
            this.update();
        };
        this.handleClientSecretChange = (e) => {
            this.oauthClientSecret = e.target.value;
            this.update();
        };
        this.handleCopyRedirectUrl = () => {
            if (!this.oauthRedirectUrl) {
                return;
            }
            // `writeText` returns a promise; on rejection (e.g. permissions denied, non-secure
            // context) we reset the "copied" indicator so the UI doesn't falsely confirm success.
            navigator.clipboard.writeText(this.oauthRedirectUrl).then(() => {
                if (this.isDisposed) {
                    return;
                }
                this.redirectUrlCopied = true;
                this.update();
                const handle = setTimeout(() => {
                    this.redirectUrlCopied = false;
                    if (!this.isDisposed) {
                        this.update();
                    }
                }, 1500);
                this.toDispose.push(core_1.Disposable.create(() => clearTimeout(handle)));
            }).catch(error => {
                console.warn('Failed to copy the MCP OAuth redirect URL to the clipboard.', error);
                if (this.isDisposed) {
                    return;
                }
                this.redirectUrlCopied = false;
                this.update();
            });
        };
        this.autostart = options.autostart ?? true;
        this.appendCloseButton(core_1.nls.localizeByDefault('Cancel'));
        this.appendAcceptButton(core_1.nls.localizeByDefault('Install'));
        // Kick off the OAuth redirect URL resolution lazily after construction (rather than from
        // `render()`, which must stay free of state-mutating side effects).
        if (this.options.requireOAuth) {
            this.ensureOAuthRedirectUrl();
        }
    }
    get value() {
        return {
            autostart: this.autostart,
            ...(this.options.requireAuthToken && this.serverAuthToken.trim()
                ? { serverAuthToken: this.serverAuthToken.trim() }
                : {}),
            ...(this.options.requireOAuth && this.oauthClientId.trim()
                ? { oauthClientId: this.oauthClientId.trim() }
                : {}),
            ...(this.options.requireOAuth && this.oauthClientSecret.trim()
                ? { oauthClientSecret: this.oauthClientSecret.trim() }
                : {})
        };
    }
    /**
     * Guard the credential fields: when the server requires them, empty values must block the
     * install. Otherwise the registry-supplied placeholders (e.g. `<github-pat-or-app-token>`,
     * `<clientId>`) would survive into settings.json and the server would fail later with an
     * opaque error.
     */
    isValid(_value, _mode) {
        if (this.options.requireAuthToken && !this.serverAuthToken.trim()) {
            return core_1.nls.localize('theia/ai-mcp/installDialog/authTokenRequired', 'An auth token is required to install this server.');
        }
        if (this.options.requireOAuth && (!this.oauthClientId.trim() || !this.oauthClientSecret.trim())) {
            return core_1.nls.localize('theia/ai-mcp/installDialog/oauthCredentialsRequired', 'An OAuth client ID and client secret are required to install this server.');
        }
        return '';
    }
    /**
     * Resolves the OAuth redirect URL once (through the backend, which knows whether the Electron
     * loopback callback server overrides the frontend origin) so the user can register it with
     * their OAuth provider.
     */
    ensureOAuthRedirectUrl() {
        if (this.oauthRedirectUrlRequested || !this.redirectUrlProvider) {
            return;
        }
        this.oauthRedirectUrlRequested = true;
        this.redirectUrlProvider().then(url => {
            if (this.isDisposed) {
                return;
            }
            this.oauthRedirectUrl = url;
            this.update();
        }).catch(error => {
            console.warn('Failed to determine the MCP OAuth redirect URL; the redirect URL hint will not be shown.', error);
        });
    }
    renderTrustBanner() {
        const trust = this.options.trust;
        if (!trust) {
            return undefined;
        }
        switch (trust.status) {
            case 'verified':
                return ((0, jsx_runtime_1.jsxs)("div", { className: "mcp-install-trust-banner mcp-install-trust-banner--verified", children: [(0, jsx_runtime_1.jsx)("i", { className: "codicon codicon-verified-filled" }), (0, jsx_runtime_1.jsx)("span", { children: core_1.nls.localize('theia/ai-mcp/installDialog/trust/verified', 'Approved by your AI registry ({0}).', trust.serverId) })] }));
            case 'unverified':
                return ((0, jsx_runtime_1.jsxs)("div", { className: "mcp-install-trust-banner mcp-install-trust-banner--unverified", children: [(0, jsx_runtime_1.jsx)("i", { className: "codicon codicon-warning" }), (0, jsx_runtime_1.jsx)("span", { children: core_1.nls.localize('theia/ai-mcp/installDialog/trust/unverified', 'This server is not listed in your AI registry ({0}). Install at your own risk.', trust.serverId) })] }));
            case 'no-registry':
                return ((0, jsx_runtime_1.jsxs)("div", { className: "mcp-install-trust-banner mcp-install-trust-banner--unknown", children: [(0, jsx_runtime_1.jsx)("i", { className: "codicon codicon-info" }), (0, jsx_runtime_1.jsx)("span", { children: core_1.nls.localize('theia/ai-mcp/installDialog/trust/unknown', 'No AI registry is configured - trust cannot be verified.') })] }));
        }
    }
    /**
     * Renders the user-settable OAuth credentials (confidential client id + secret) and the
     * read-only redirect URL the user must register with their provider. The remaining OAuth
     * parameters (scopes, authorization server, resource) are fixed by the registry and are not
     * shown here.
     */
    renderOAuthFields() {
        return ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)("div", { className: "mcp-form-description", children: core_1.nls.localize('theia/ai-mcp/installDialog/oauthDescription', 'This server uses OAuth with a pre-registered confidential client. Provide the client ID and secret from your OAuth provider.') }), this.oauthRedirectUrl && ((0, jsx_runtime_1.jsxs)("div", { className: "mcp-form-field", children: [(0, jsx_runtime_1.jsxs)("label", { children: [core_1.nls.localize('theia/ai/mcpConfiguration/oauthRedirectUrl', 'Redirect URL'), ":"] }), (0, jsx_runtime_1.jsxs)("div", { className: "mcp-oauth-redirect-url-row", children: [(0, jsx_runtime_1.jsx)("span", { className: "mcp-form-static-value", children: this.oauthRedirectUrl }), (0, jsx_runtime_1.jsx)("button", { type: "button", className: "mcp-icon-button", title: core_1.nls.localizeByDefault('Copy'), onClick: this.handleCopyRedirectUrl, children: (0, jsx_runtime_1.jsx)("i", { className: this.redirectUrlCopied ? 'codicon codicon-check' : 'codicon codicon-copy' }) })] }), (0, jsx_runtime_1.jsx)("div", { className: "mcp-form-description", children: core_1.nls.localize('theia/ai/mcpConfiguration/form/oauthRedirectUrlDescription', 'Authorization callbacks are delivered to this URL. With a static client ID, register it as a redirect URI with your OAuth provider.') })] })), (0, jsx_runtime_1.jsxs)("div", { className: "mcp-form-field", children: [(0, jsx_runtime_1.jsxs)("label", { children: [core_1.nls.localize('theia/ai/mcpConfiguration/oauthClientId', 'OAuth Client ID'), ":"] }), (0, jsx_runtime_1.jsx)("input", { type: "text", className: "theia-input", value: this.oauthClientId, onChange: this.handleClientIdChange, placeholder: core_1.nls.localize('theia/ai-mcp/installDialog/oauthClientIdPlaceholder', 'Required by this server to connect'), spellCheck: false, 
                            // Only autofocus when the auth-token field above isn't present; otherwise two
                            // inputs would carry `autoFocus` and browser behaviour is undefined.
                            autoFocus: !this.options.requireAuthToken })] }), (0, jsx_runtime_1.jsxs)("div", { className: "mcp-form-field", children: [(0, jsx_runtime_1.jsxs)("label", { children: [core_1.nls.localize('theia/ai/mcpConfiguration/oauthClientSecret', 'OAuth Client Secret'), ":"] }), (0, jsx_runtime_1.jsx)("input", { type: "password", className: "theia-input", value: this.oauthClientSecret, onChange: this.handleClientSecretChange, placeholder: core_1.nls.localize('theia/ai-mcp/installDialog/oauthClientSecretPlaceholder', 'Required by this server to connect'), spellCheck: false })] })] }));
    }
    render() {
        return ((0, jsx_runtime_1.jsxs)("div", { className: "mcp-dialog-form", children: [this.renderTrustBanner(), (0, jsx_runtime_1.jsxs)("div", { className: "mcp-form-field", children: [(0, jsx_runtime_1.jsxs)("label", { children: [core_1.nls.localize('theia/ai/mcpConfiguration/form/serverName', 'Server Name'), ":"] }), (0, jsx_runtime_1.jsx)("span", { className: "mcp-form-static-value", children: this.options.name })] }), this.options.requireAuthToken && ((0, jsx_runtime_1.jsxs)("div", { className: "mcp-form-field", children: [(0, jsx_runtime_1.jsxs)("label", { children: [core_1.nls.localize('theia/ai/mcpConfiguration/serverAuthToken', 'Auth Token'), ":"] }), (0, jsx_runtime_1.jsx)("input", { type: "password", className: "theia-input", value: this.serverAuthToken, onChange: this.handleAuthTokenChange, placeholder: core_1.nls.localize('theia/ai-mcp/installDialog/authTokenPlaceholder', 'Required by this server to connect'), spellCheck: false, autoFocus: true })] })), this.options.requireOAuth && this.renderOAuthFields(), (0, jsx_runtime_1.jsx)("div", { className: "mcp-form-field mcp-form-checkbox", children: (0, jsx_runtime_1.jsxs)("label", { children: [(0, jsx_runtime_1.jsx)("input", { type: "checkbox", className: "theia-input", checked: this.autostart, onChange: this.handleAutostartChange }), core_1.nls.localize('theia/ai/mcpConfiguration/form/autostart', 'Autostart')] }) })] }));
    }
}
exports.MCPServerInstallDialog = MCPServerInstallDialog;
//# sourceMappingURL=mcp-server-install-dialog.js.map