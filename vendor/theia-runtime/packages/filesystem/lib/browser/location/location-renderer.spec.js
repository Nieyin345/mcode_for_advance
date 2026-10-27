"use strict";
// *****************************************************************************
// Copyright (C) 2026 STMicroelectronics and others.
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
const jsdom_1 = require("@theia/core/lib/browser/test/jsdom");
let disableJSDOM = (0, jsdom_1.enableJSDOM)();
const uri_1 = require("@theia/core/lib/common/uri");
const chai_1 = require("chai");
const location_renderer_1 = require("./location-renderer");
disableJSDOM();
class TestableLocationListRenderer extends location_renderer_1.LocationListRenderer {
    // Expose protected methods for testing
    testLooksLikeFilePath(value) {
        return this.looksLikeFilePath(value);
    }
    testToFileURI(filePath) {
        return this.toFileURI(filePath);
    }
    testTryRenderFirstMatch(inputElement, children) {
        this.tryRenderFirstMatch(inputElement, children);
    }
    testRenderSelectInput() {
        return this.renderSelectInput();
    }
    testTrySetNewLocation(newLocation) {
        this.trySetNewLocation(newLocation);
    }
}
function createMockService() {
    return {
        location: undefined,
        drives: () => Promise.resolve([])
    };
}
/**
 * A `LocationService` that tracks how often its `location` setter is invoked,
 * so tests can distinguish "navigation skipped" from "re-navigated to the same location".
 */
function createTrackingService(initial) {
    const state = { current: initial, count: 0 };
    return {
        get location() {
            return state.current;
        },
        set location(uri) {
            state.current = uri;
            state.count++;
        },
        get locationSetCount() {
            return state.count;
        },
        drives: () => Promise.resolve([])
    };
}
function createRenderer() {
    const host = document.createElement('div');
    const service = createMockService();
    const renderer = new TestableLocationListRenderer({ model: service, host });
    return renderer;
}
describe('LocationListRenderer', () => {
    let renderer;
    before(() => {
        disableJSDOM = (0, jsdom_1.enableJSDOM)();
    });
    after(() => {
        disableJSDOM();
    });
    beforeEach(() => {
        renderer = createRenderer();
    });
    afterEach(() => {
        renderer.dispose();
    });
    describe('looksLikeFilePath', () => {
        it('should recognize Unix absolute paths', () => {
            (0, chai_1.expect)(renderer.testLooksLikeFilePath('/home/user/folder')).to.be.true;
            (0, chai_1.expect)(renderer.testLooksLikeFilePath('/usr/local/bin')).to.be.true;
            (0, chai_1.expect)(renderer.testLooksLikeFilePath('/')).to.be.true;
        });
        it('should recognize tilde paths', () => {
            (0, chai_1.expect)(renderer.testLooksLikeFilePath('~/Documents')).to.be.true;
            (0, chai_1.expect)(renderer.testLooksLikeFilePath('~/projects/theia')).to.be.true;
        });
        it('should recognize Windows drive letter paths with backslashes', () => {
            (0, chai_1.expect)(renderer.testLooksLikeFilePath('C:\\')).to.be.true;
            (0, chai_1.expect)(renderer.testLooksLikeFilePath('C:\\Users\\folder')).to.be.true;
            (0, chai_1.expect)(renderer.testLooksLikeFilePath('D:\\Projects')).to.be.true;
        });
        it('should recognize Windows drive letter paths with forward slashes', () => {
            (0, chai_1.expect)(renderer.testLooksLikeFilePath('C:/')).to.be.true;
            (0, chai_1.expect)(renderer.testLooksLikeFilePath('C:/Users/folder')).to.be.true;
            (0, chai_1.expect)(renderer.testLooksLikeFilePath('d:/projects')).to.be.true;
        });
        it('should reject non-path strings', () => {
            (0, chai_1.expect)(renderer.testLooksLikeFilePath('hello')).to.be.false;
            (0, chai_1.expect)(renderer.testLooksLikeFilePath('file:///foo')).to.be.false;
            (0, chai_1.expect)(renderer.testLooksLikeFilePath('http://example.com')).to.be.false;
            (0, chai_1.expect)(renderer.testLooksLikeFilePath('')).to.be.false;
            (0, chai_1.expect)(renderer.testLooksLikeFilePath('relative/path')).to.be.false;
        });
    });
    describe('tryRenderFirstMatch', () => {
        function createTextInput(host, value) {
            const input = document.createElement('input');
            input.className = 'theia-select theia-LocationTextInput';
            input.value = value;
            input.selectionStart = value.length;
            host.appendChild(input);
            return input;
        }
        it('should autocomplete Unix paths preserving format', () => {
            const host = document.createElement('div');
            const service = createMockService();
            const r = new TestableLocationListRenderer({ model: service, host });
            const input = createTextInput(host, '/home/user/Do');
            const children = ['/home/user/Documents/', '/home/user/Downloads/'];
            r.testTryRenderFirstMatch(input, children);
            (0, chai_1.expect)(input.value).to.equal('/home/user/Documents/');
            (0, chai_1.expect)(input.selectionStart).to.equal('/home/user/Do'.length);
            (0, chai_1.expect)(input.selectionEnd).to.equal('/home/user/Documents/'.length);
            r.dispose();
        });
        it('should autocomplete Windows-style paths in native format', () => {
            const host = document.createElement('div');
            const service = createMockService();
            const r = new TestableLocationListRenderer({ model: service, host });
            const input = createTextInput(host, 'C:\\Users\\user\\Do');
            // Children from the cache are already stored as native filesystem paths
            const children = ['C:\\Users\\user\\Documents\\', 'C:\\Users\\user\\Downloads\\'];
            r.testTryRenderFirstMatch(input, children);
            (0, chai_1.expect)(input.value).to.equal('C:\\Users\\user\\Documents\\');
            (0, chai_1.expect)(input.selectionStart).to.equal('C:\\Users\\user\\Do'.length);
            (0, chai_1.expect)(input.selectionEnd).to.equal('C:\\Users\\user\\Documents\\'.length);
            r.dispose();
        });
        it('should not modify input when no children match', () => {
            const host = document.createElement('div');
            const service = createMockService();
            const r = new TestableLocationListRenderer({ model: service, host });
            const input = createTextInput(host, '/home/user/xyz');
            const children = ['/home/user/Documents/', '/home/user/Downloads/'];
            r.testTryRenderFirstMatch(input, children);
            (0, chai_1.expect)(input.value).to.equal('/home/user/xyz');
            r.dispose();
        });
    });
    describe('renderSelectInput', () => {
        it('should render select with value matching the current service location', () => {
            const host = document.createElement('div');
            const service = createMockService();
            const location = uri_1.default.fromFilePath('/home/user/folder');
            service.location = location;
            const r = new TestableLocationListRenderer({ model: service, host });
            const selectElement = r.testRenderSelectInput();
            (0, chai_1.expect)(selectElement.props.value).to.equal(location.toString());
            r.dispose();
        });
        it('should update select value when service location changes across drives', () => {
            const host = document.createElement('div');
            const service = createMockService();
            service.location = uri_1.default.fromFilePath('/d:/Projects/theia');
            const r = new TestableLocationListRenderer({ model: service, host });
            // Simulate the model navigating to a different drive
            const newLocation = uri_1.default.fromFilePath('/c:/Users');
            service.location = newLocation;
            const selectElement = r.testRenderSelectInput();
            (0, chai_1.expect)(selectElement.props.value).to.equal(newLocation.toString());
            r.dispose();
        });
    });
    describe('trySetNewLocation', () => {
        it('should not navigate when the target equals the current location', () => {
            const host = document.createElement('div');
            const service = createTrackingService(uri_1.default.fromFilePath('/home'));
            const r = new TestableLocationListRenderer({ model: service, host });
            r.testTrySetNewLocation(uri_1.default.fromFilePath('/home'));
            // The location setter must not be invoked, otherwise a duplicate entry is added to the history.
            (0, chai_1.expect)(service.locationSetCount).to.equal(0);
            (0, chai_1.expect)(service.location?.path.toString()).to.equal('/home');
            r.dispose();
        });
        it('should navigate when the target differs from the current location', () => {
            const host = document.createElement('div');
            const service = createTrackingService(uri_1.default.fromFilePath('/home'));
            const r = new TestableLocationListRenderer({ model: service, host });
            r.testTrySetNewLocation(uri_1.default.fromFilePath('/work'));
            (0, chai_1.expect)(service.locationSetCount).to.equal(1);
            (0, chai_1.expect)(service.location?.path.toString()).to.equal('/work');
            r.dispose();
        });
        it('should navigate when there is no current location yet', () => {
            const host = document.createElement('div');
            const service = createTrackingService(undefined);
            const r = new TestableLocationListRenderer({ model: service, host });
            r.testTrySetNewLocation(uri_1.default.fromFilePath('/home'));
            (0, chai_1.expect)(service.location?.path.toString()).to.equal('/home');
            r.dispose();
        });
        it('should navigate to a previously visited location after it was left by other means', () => {
            const host = document.createElement('div');
            const service = createTrackingService(uri_1.default.fromFilePath('/home'));
            const r = new TestableLocationListRenderer({ model: service, host });
            // Navigate to '/home' via the location input (no-op, already there).
            r.testTrySetNewLocation(uri_1.default.fromFilePath('/home'));
            // Simulate leaving '/home' through another mechanism, e.g. the "Navigate Up" button,
            // which sets the model location directly without going through `trySetNewLocation`.
            service.location = uri_1.default.fromFilePath('/');
            // Navigating back to '/home' via the location input must work and not be silently blocked.
            r.testTrySetNewLocation(uri_1.default.fromFilePath('/home'));
            (0, chai_1.expect)(service.location?.path.toString()).to.equal('/home');
            r.dispose();
        });
    });
    describe('toFileURI', () => {
        it('should convert Unix absolute paths to file URIs', () => {
            const uri = renderer.testToFileURI('/home/user/folder');
            (0, chai_1.expect)(uri.scheme).to.equal('file');
            (0, chai_1.expect)(uri.path.toString()).to.equal('/home/user/folder');
        });
        it('should convert Windows paths with backslashes to file URIs', () => {
            const uri = renderer.testToFileURI('C:\\Users\\folder');
            (0, chai_1.expect)(uri.scheme).to.equal('file');
            // vscode-uri normalizes drive letters to lowercase
            (0, chai_1.expect)(uri.path.toString()).to.equal('/c:/Users/folder');
        });
        it('should convert Windows paths with forward slashes to file URIs', () => {
            const uri = renderer.testToFileURI('C:/Users/folder');
            (0, chai_1.expect)(uri.scheme).to.equal('file');
            (0, chai_1.expect)(uri.path.toString()).to.equal('/c:/Users/folder');
        });
        it('should handle Windows drive root', () => {
            const uri = renderer.testToFileURI('C:\\');
            (0, chai_1.expect)(uri.scheme).to.equal('file');
            (0, chai_1.expect)(uri.path.toString()).to.equal('/c:/');
        });
        it('should produce a URI that differs from naive URI parsing for Windows paths', () => {
            // new URI('C:\\Users') incorrectly treats 'C' as the scheme
            const naiveUri = new uri_1.default('C:\\Users');
            (0, chai_1.expect)(naiveUri.scheme).to.equal('C');
            // URI.fromFilePath correctly creates a file:// URI
            const correctUri = renderer.testToFileURI('C:\\Users');
            (0, chai_1.expect)(correctUri.scheme).to.equal('file');
        });
    });
});
//# sourceMappingURL=location-renderer.spec.js.map