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
exports.getProxyAgent = getProxyAgent;
const undici_1 = require("undici");
function getSystemProxyURI(requestURL, env) {
    if (requestURL.protocol === 'http:') {
        return env.HTTP_PROXY || env.http_proxy;
    }
    else if (requestURL.protocol === 'https:') {
        return env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy;
    }
    return undefined;
}
function getProxyAgent(rawRequestURL, env, options = {}) {
    let requestURL;
    try {
        requestURL = new URL(rawRequestURL);
    }
    catch {
        return undefined;
    }
    const proxyURL = options.proxyUrl || getSystemProxyURI(requestURL, env);
    if (!proxyURL) {
        if (options.strictSSL === false) {
            return new undici_1.Agent({
                connect: { rejectUnauthorized: false }
            });
        }
        return undefined;
    }
    let proxyEndpoint;
    try {
        proxyEndpoint = new URL(proxyURL);
    }
    catch {
        return undefined;
    }
    if (!/^https?:$/.test(proxyEndpoint.protocol)) {
        return undefined;
    }
    const proxyAgentOptions = {
        uri: proxyURL,
        token: proxyEndpoint.username
            ? `Basic ${Buffer.from(`${decodeURIComponent(proxyEndpoint.username)}:${decodeURIComponent(proxyEndpoint.password)}`).toString('base64')}`
            : undefined,
    };
    if (options.strictSSL === false) {
        proxyAgentOptions.requestTls = { rejectUnauthorized: false };
    }
    return new undici_1.ProxyAgent(proxyAgentOptions);
}
//# sourceMappingURL=proxy.js.map