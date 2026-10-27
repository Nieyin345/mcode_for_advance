"use strict";
/********************************************************************************
 * Copyright (C) 2026 EclipseSource GmbH.
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
const chai_1 = require("chai");
const http = require("http");
const node_request_service_1 = require("./node-request-service");
const common_request_service_1 = require("./common-request-service");
describe('NodeRequestService', () => {
    let service;
    let server;
    let serverPort;
    before(done => {
        service = new node_request_service_1.NodeRequestService();
        server = http.createServer((req, res) => {
            if (req.url === '/json') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ message: 'hello' }));
            }
            else if (req.url === '/text') {
                res.writeHead(200, { 'Content-Type': 'text/plain' });
                res.end('hello world');
            }
            else if (req.url === '/echo-headers') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(req.headers));
            }
            else if (req.url === '/echo-method') {
                res.writeHead(200, { 'Content-Type': 'text/plain' });
                res.end(req.method);
            }
            else if (req.url === '/echo-body') {
                const chunks = [];
                req.on('data', chunk => chunks.push(chunk));
                req.on('end', () => {
                    res.writeHead(200, { 'Content-Type': 'text/plain' });
                    res.end(Buffer.concat(chunks).toString());
                });
            }
            else if (req.url === '/status/404') {
                res.writeHead(404, { 'Content-Type': 'text/plain' });
                res.end('not found');
            }
            else if (req.url === '/status/500') {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('server error');
            }
            else if (req.url === '/slow') {
                setTimeout(() => {
                    res.writeHead(200, { 'Content-Type': 'text/plain' });
                    res.end('slow response');
                }, 5000);
            }
            else if (req.url === '/empty') {
                res.writeHead(204);
                res.end();
            }
            else if (req.url === '/redirect') {
                res.writeHead(302, { 'Location': '/text' });
                res.end();
            }
            else if (req.url === '/redirect-chain') {
                res.writeHead(302, { 'Location': '/redirect' });
                res.end();
            }
            else {
                res.writeHead(200, { 'Content-Type': 'text/plain' });
                res.end('ok');
            }
        });
        server.listen(0, () => {
            const addr = server.address();
            if (addr && typeof addr === 'object') {
                serverPort = addr.port;
            }
            done();
        });
    });
    after(done => {
        server.close(done);
    });
    function url(path) {
        return `http://localhost:${serverPort}${path}`;
    }
    it('should perform a basic GET request', async () => {
        const result = await service.request({ url: url('/text') });
        (0, chai_1.expect)(result.res.statusCode).to.equal(200);
        (0, chai_1.expect)(common_request_service_1.RequestContext.asText(result)).to.equal('hello world');
    });
    it('should parse JSON responses', async () => {
        const result = await service.request({ url: url('/json') });
        (0, chai_1.expect)(result.res.statusCode).to.equal(200);
        const json = common_request_service_1.RequestContext.asJson(result);
        (0, chai_1.expect)(json.message).to.equal('hello');
    });
    it('should handle non-200 status codes', async () => {
        const result = await service.request({ url: url('/status/404') });
        (0, chai_1.expect)(result.res.statusCode).to.equal(404);
    });
    it('should handle 500 status codes', async () => {
        const result = await service.request({ url: url('/status/500') });
        (0, chai_1.expect)(result.res.statusCode).to.equal(500);
    });
    it('should handle 204 No Content', async () => {
        const result = await service.request({ url: url('/empty') });
        (0, chai_1.expect)(result.res.statusCode).to.equal(204);
        (0, chai_1.expect)(common_request_service_1.RequestContext.asText(result)).to.equal('');
    });
    it('should send custom headers', async () => {
        const result = await service.request({
            url: url('/echo-headers'),
            headers: { 'X-Custom': 'test-value' }
        });
        const headers = common_request_service_1.RequestContext.asJson(result);
        (0, chai_1.expect)(headers['x-custom']).to.equal('test-value');
    });
    it('should use specified HTTP method', async () => {
        const result = await service.request({
            url: url('/echo-method'),
            type: 'POST'
        });
        (0, chai_1.expect)(common_request_service_1.RequestContext.asText(result)).to.equal('POST');
    });
    it('should send request body', async () => {
        const result = await service.request({
            url: url('/echo-body'),
            type: 'POST',
            data: 'test body content'
        });
        (0, chai_1.expect)(common_request_service_1.RequestContext.asText(result)).to.equal('test body content');
    });
    it('should timeout when request takes too long', async () => {
        try {
            await service.request({
                url: url('/slow'),
                timeout: 100
            });
            chai_1.expect.fail('Should have thrown a timeout error');
        }
        catch (e) {
            (0, chai_1.expect)(e).to.be.an.instanceOf(Error);
        }
    });
    it('should abort on cancellation', async () => {
        const listeners = [];
        const token = {
            isCancellationRequested: false,
            onCancellationRequested: (listener) => {
                listeners.push(listener);
            }
        };
        const promise = service.request({
            url: url('/slow'),
        }, token);
        // Trigger cancellation shortly after the request starts
        setTimeout(() => {
            listeners.forEach(l => l());
        }, 50);
        try {
            await promise;
            chai_1.expect.fail('Should have thrown an abort error');
        }
        catch (e) {
            (0, chai_1.expect)(e).to.be.an.instanceOf(Error);
        }
    });
    it('should include response headers', async () => {
        const result = await service.request({ url: url('/json') });
        (0, chai_1.expect)(result.res.headers['content-type']).to.equal('application/json');
    });
    it('should set the url on the result', async () => {
        const requestUrl = url('/text');
        const result = await service.request({ url: requestUrl });
        (0, chai_1.expect)(result.url).to.equal(requestUrl);
    });
    describe('configure', () => {
        it('should configure proxy settings', async () => {
            const configuredService = new node_request_service_1.NodeRequestService();
            await configuredService.configure({
                proxyUrl: 'http://proxy.example.com:8080',
                strictSSL: false,
                proxyAuthorization: 'Basic dGVzdDp0ZXN0'
            });
            // Just verify configuration doesn't throw
        });
        it('should inject Proxy-Authorization header when authorization is configured', async () => {
            const configuredService = new node_request_service_1.NodeRequestService();
            await configuredService.configure({
                proxyAuthorization: 'Basic dGVzdDp0ZXN0'
            });
            const result = await configuredService.request({ url: url('/echo-headers') });
            const headers = common_request_service_1.RequestContext.asJson(result);
            (0, chai_1.expect)(headers['proxy-authorization']).to.equal('Basic dGVzdDp0ZXN0');
        });
    });
    describe('redirect handling', () => {
        it('should follow redirects by default', async () => {
            const result = await service.request({ url: url('/redirect') });
            (0, chai_1.expect)(result.res.statusCode).to.equal(200);
            (0, chai_1.expect)(common_request_service_1.RequestContext.asText(result)).to.equal('hello world');
        });
        it('should not follow redirects when followRedirects is 0', async () => {
            const result = await service.request({ url: url('/redirect'), followRedirects: 0 });
            (0, chai_1.expect)(result.res.statusCode).to.equal(302);
            (0, chai_1.expect)(result.res.headers['location']).to.equal('/text');
        });
        it('should follow redirect chains by default', async () => {
            const result = await service.request({ url: url('/redirect-chain') });
            (0, chai_1.expect)(result.res.statusCode).to.equal(200);
            (0, chai_1.expect)(common_request_service_1.RequestContext.asText(result)).to.equal('hello world');
        });
    });
    describe('resolveProxy', () => {
        it('should return undefined by default', async () => {
            const proxy = await service.resolveProxy('https://example.com');
            (0, chai_1.expect)(proxy).to.be.undefined;
        });
    });
});
//# sourceMappingURL=node-request-service.spec.js.map