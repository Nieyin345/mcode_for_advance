"use strict";
/********************************************************************************
 * Copyright (C) 2022 TypeFox and others.
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.NodeRequestService = void 0;
const proxy_1 = require("./proxy");
class NodeRequestService {
    async getProxyUrl(url) {
        return this.proxyUrl;
    }
    async configure(config) {
        if (config.proxyUrl !== undefined) {
            this.proxyUrl = config.proxyUrl;
        }
        if (config.strictSSL !== undefined) {
            this.strictSSL = config.strictSSL;
        }
        if (config.proxyAuthorization !== undefined) {
            this.authorization = config.proxyAuthorization;
        }
    }
    async processOptions(options) {
        const { strictSSL } = this;
        options.strictSSL = options.strictSSL ?? strictSSL;
        if (!options.dispatcher) {
            options.dispatcher = (0, proxy_1.getProxyAgent)(options.url || '', process.env, {
                proxyUrl: await this.getProxyUrl(options.url),
                strictSSL: options.strictSSL
            });
        }
        const authorization = options.proxyAuthorization || this.authorization;
        if (authorization) {
            options.headers = {
                ...(options.headers || {}),
                'Proxy-Authorization': authorization
            };
        }
        return options;
    }
    async request(options, token) {
        options = await this.processOptions(options);
        const headers = { ...(options.headers || {}) };
        if (options.user && options.password) {
            headers['Authorization'] = 'Basic ' + Buffer.from(options.user + ':' + options.password).toString('base64');
        }
        const signals = [];
        if (options.timeout) {
            signals.push(AbortSignal.timeout(options.timeout));
        }
        let tokenAbortController;
        let cancellationListener;
        if (token) {
            tokenAbortController = new AbortController();
            signals.push(tokenAbortController.signal);
            cancellationListener = token.onCancellationRequested(() => {
                tokenAbortController.abort();
            });
        }
        const signal = signals.length > 0
            ? (signals.length === 1 ? signals[0] : AbortSignal.any(signals))
            : undefined;
        const fetchOptions = {
            method: options.type || 'GET',
            headers,
            redirect: options.followRedirects === 0 ? 'manual' : 'follow',
            signal,
        };
        if (options.dispatcher) {
            fetchOptions.dispatcher = options.dispatcher;
        }
        if (options.data) {
            fetchOptions.body = options.data;
        }
        try {
            const response = await fetch(options.url, fetchOptions);
            const arrayBuffer = await response.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);
            const responseHeaders = {};
            response.headers.forEach((value, key) => {
                responseHeaders[key] = value;
            });
            return {
                url: options.url,
                res: {
                    headers: responseHeaders,
                    statusCode: response.status
                },
                buffer
            };
        }
        finally {
            if (cancellationListener) {
                cancellationListener.dispose();
            }
        }
    }
    async resolveProxy(url) {
        return undefined;
    }
}
exports.NodeRequestService = NodeRequestService;
//# sourceMappingURL=node-request-service.js.map