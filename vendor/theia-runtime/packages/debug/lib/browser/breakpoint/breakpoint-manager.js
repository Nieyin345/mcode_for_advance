"use strict";
// *****************************************************************************
// Copyright (C) 2018 TypeFox and others.
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
var BreakpointManager_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.BreakpointManager = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("@theia/core/shared/inversify");
const common_1 = require("@theia/core/lib/common");
const browser_1 = require("@theia/core/lib/browser");
const uri_1 = require("@theia/core/lib/common/uri");
const breakpoint_marker_1 = require("./breakpoint-marker");
const debug_source_breakpoint_1 = require("../model/debug-source-breakpoint");
const debug_function_breakpoint_1 = require("../model/debug-function-breakpoint");
const debug_instruction_breakpoint_1 = require("../model/debug-instruction-breakpoint");
const debug_exception_breakpoint_1 = require("../view/debug-exception-breakpoint");
const debug_data_breakpoint_1 = require("../model/debug-data-breakpoint");
const file_service_1 = require("@theia/filesystem/lib/browser/file-service");
let BreakpointManager = class BreakpointManager {
    constructor() {
        // ── Source breakpoints, keyed by URI string ──
        this.sourceBreakpoints = new Map();
        // ── Events ──
        this.onDidChangeMarkersEmitter = new common_1.Emitter();
        this.onDidChangeBreakpointsEmitter = new common_1.Emitter();
        this.onDidChangeBreakpoints = this.onDidChangeBreakpointsEmitter.event;
        this.onDidChangeFunctionBreakpointsEmitter = new common_1.Emitter();
        this.onDidChangeFunctionBreakpoints = this.onDidChangeFunctionBreakpointsEmitter.event;
        this.onDidChangeInstructionBreakpointsEmitter = new common_1.Emitter();
        this.onDidChangeInstructionBreakpoints = this.onDidChangeInstructionBreakpointsEmitter.event;
        this.onDidChangeDataBreakpointsEmitter = new common_1.Emitter();
        this.onDidChangeDataBreakpoints = this.onDidChangeDataBreakpointsEmitter.event;
        // ── Enable / disable ──
        this._breakpointsEnabled = true;
        // ── Exception breakpoints ──
        this.exceptionBreakpoints = new Array();
        // ── Function breakpoints ──
        this.functionBreakpoints = [];
        // ── Instruction breakpoints ──
        this.instructionBreakpoints = [];
        // ── Data breakpoints ──
        this.dataBreakpoints = [];
    }
    static { BreakpointManager_1 = this; }
    static { this.EXCEPTION_URI = new uri_1.default('debug:exception://'); }
    static { this.FUNCTION_URI = new uri_1.default('debug:function://'); }
    static { this.INSTRUCTION_URI = new uri_1.default('debug:instruction://'); }
    static { this.DATA_URI = new uri_1.default('debug:data://'); }
    /**
     * Fires when any breakpoint type changes (source, function, instruction, data, or exception).
     * The URI identifies the affected resource or the synthetic URI for non-source breakpoint types
     * (e.g. {@link BreakpointManager.FUNCTION_URI}).
     */
    get onDidChangeMarkers() {
        return this.onDidChangeMarkersEmitter.event;
    }
    fireOnDidChangeMarkers(uri) {
        this.onDidChangeMarkersEmitter.fire(uri);
    }
    // ── Initialization ──
    init() {
        this.fileService.onDidFilesChange(event => {
            if (event.gotDeleted()) {
                for (const uriString of this.sourceBreakpoints.keys()) {
                    const uri = new uri_1.default(uriString);
                    if (event.contains(uri, 2 /* FileChangeType.DELETED */)) {
                        this.sourceBreakpoints.delete(uriString);
                        this.fireOnDidChangeMarkers(uri);
                    }
                }
            }
        });
    }
    // ── Source breakpoint storage ──
    getBreakpoints(uri) {
        if (uri) {
            return this.sourceBreakpoints.get(uri.toString()) ?? [];
        }
        const result = [];
        for (const bps of this.sourceBreakpoints.values()) {
            result.push(...bps);
        }
        return result;
    }
    getUris() {
        return this.sourceBreakpoints.keys();
    }
    hasBreakpoints() {
        return this.sourceBreakpoints.size > 0 || this.functionBreakpoints.length > 0 || this.instructionBreakpoints.length > 0;
    }
    /**
     * Replace the source breakpoints for a URI. Incoming `breakpoints` are
     * plain `SourceBreakpoint` data; existing `DebugSourceBreakpoint` wrappers
     * are preserved by ID so that session data survives position changes.
     */
    setBreakpoints(uri, breakpoints) {
        const current = this.getBreakpoints(uri);
        const currentById = new Map(current.map(bp => [bp.id, bp]));
        const sorted = breakpoints
            .slice()
            .sort((a, b) => (a.raw.line - b.raw.line) || ((a.raw.column || 0) - (b.raw.column || 0)));
        const seen = new Set();
        const newBps = [];
        for (const bp of sorted) {
            const posKey = `${bp.raw.line}:${bp.raw.column ?? 0}`;
            if (seen.has(posKey)) {
                continue;
            }
            seen.add(posKey);
            // Prefer matching by ID (preserves identity across position changes).
            const existing = currentById.get(bp.id);
            if (existing) {
                existing.origin.raw = bp.raw;
                existing.origin.enabled = bp.enabled;
                newBps.push(existing);
            }
            else {
                newBps.push(this.toDebugSourceBreakpoint(bp));
            }
        }
        this.applySourceBreakpoints(uri, newBps, current);
    }
    addBreakpoint(breakpoint) {
        const uri = new uri_1.default(breakpoint.uri);
        const current = this.getBreakpoints(uri);
        // Check for positional duplicate.
        const duplicate = current.find(c => c.line === breakpoint.raw.line && c.column === breakpoint.raw.column);
        if (duplicate) {
            return duplicate;
        }
        const bp = this.toDebugSourceBreakpoint(breakpoint);
        const newBps = [...current, bp];
        this.applySourceBreakpoints(uri, newBps, current);
        return bp;
    }
    removeBreakpoint(breakpoint) {
        const current = this.getBreakpoints(breakpoint.uri);
        const index = current.indexOf(breakpoint);
        if (index === -1) {
            return;
        }
        const retained = [...current.slice(0, index), ...current.slice(index + 1)];
        this.applySourceBreakpoints(breakpoint.uri, retained, current);
    }
    /**
     * Diff `oldBps` → `newBps`, store, fire markers and typed events.
     * Both arrays must be for the same URI.
     */
    applySourceBreakpoints(uri, newBps, oldBps) {
        const oldById = new Map(oldBps.map(bp => [bp.id, bp]));
        const added = [];
        const changed = [];
        let didChange = false;
        for (const bp of newBps) {
            const old = oldById.get(bp.id);
            if (!old) {
                added.push(bp);
                didChange = true;
            }
            else {
                changed.push(bp);
                // Identity match: the wrapper was mutated in place, or the same
                // object was passed back (editor model position update).
                // Either way we must re-fire to keep decorations in sync.
                didChange = true;
                oldById.delete(bp.id);
            }
        }
        const removed = Array.from(oldById.values());
        didChange ||= removed.length > 0;
        if (!didChange) {
            return;
        }
        if (newBps.length > 0) {
            this.sourceBreakpoints.set(uri.toString(), [...newBps]);
        }
        else {
            this.sourceBreakpoints.delete(uri.toString());
        }
        this.fireOnDidChangeMarkers(uri);
        this.onDidChangeBreakpointsEmitter.fire({ uri, added, removed, changed });
    }
    removeBreakpoints() {
        for (const uriString of [...this.sourceBreakpoints.keys()]) {
            const uri = new uri_1.default(uriString);
            const old = this.sourceBreakpoints.get(uriString) ?? [];
            this.sourceBreakpoints.delete(uriString);
            this.fireOnDidChangeMarkers(uri);
            if (old.length) {
                this.onDidChangeBreakpointsEmitter.fire({ uri, added: [], removed: old, changed: [] });
            }
        }
        this.setFunctionBreakpoints([]);
        this.setInstructionBreakpoints([]);
        this.setDataBreakpoints([]);
    }
    // ── Query helpers ──
    getLineBreakpoints(uri, line) {
        return this.getBreakpoints(uri).filter(bp => bp.line === line);
    }
    getInlineBreakpoint(uri, line, column) {
        return this.getBreakpoints(uri).find(bp => bp.line === line && bp.column === column);
    }
    getBreakpointById(id) {
        for (const bp of this.allBreakpoints()) {
            if (bp.id === id) {
                return bp;
            }
        }
    }
    *allBreakpoints() {
        for (const bps of this.sourceBreakpoints.values()) {
            yield* bps;
        }
        yield* this.functionBreakpoints;
        yield* this.instructionBreakpoints;
        yield* this.exceptionBreakpoints;
        yield* this.dataBreakpoints;
    }
    // ── Session data ──
    updateSessionData(sessionId, sessionCapabilities, bps) {
        const bpCapabilities = this.toBpCapabilities(sessionCapabilities);
        const updatedUris = new Map();
        for (const bp of this.allBreakpoints()) {
            if (!bps) {
                if (bp.update(sessionId, undefined)) {
                    common_1.MapUtils.addOrInsertWith(updatedUris, bp.uri.toString(), bp);
                }
            }
            else {
                const dataForBp = bps.get(bp.id);
                if (!dataForBp) {
                    continue;
                }
                bp.update(sessionId, { ...bpCapabilities, ...dataForBp });
                common_1.MapUtils.addOrInsertWith(updatedUris, bp.uri.toString(), bp);
            }
        }
        for (const changed of updatedUris.values()) {
            this.fireTypedBreakpointEvent(changed[0].uri, [], changed, []);
        }
    }
    toBpCapabilities(capabilities) {
        return {
            supportsConditionalBreakpoints: !!capabilities.supportsConditionalBreakpoints,
            supportsHitConditionalBreakpoints: !!capabilities.supportsHitConditionalBreakpoints,
            supportsLogPoints: !!capabilities.supportsLogPoints,
            supportsFunctionBreakpoints: !!capabilities.supportsFunctionBreakpoints,
            supportsDataBreakpoints: !!capabilities.supportsDataBreakpoints,
            supportsInstructionBreakpoints: !!capabilities.supportsInstructionBreakpoints,
        };
    }
    // ── Breakpoint construction ──
    toDebugSourceBreakpoint(source) {
        return debug_source_breakpoint_1.DebugSourceBreakpoint.create(source, this.getBreakpointOptions());
    }
    getBreakpointOptions() {
        if (!this._breakpointOptions) {
            this._breakpointOptions = {
                labelProvider: this.labelProvider,
                openerService: this.openerService,
                commandService: this.commandService,
                breakpoints: this
            };
        }
        return this._breakpointOptions;
    }
    get breakpointsEnabled() {
        return this._breakpointsEnabled;
    }
    set breakpointsEnabled(breakpointsEnabled) {
        if (this._breakpointsEnabled !== breakpointsEnabled) {
            this._breakpointsEnabled = breakpointsEnabled;
            for (const uri of this.getUris()) {
                this.fireOnDidChangeMarkers(new uri_1.default(uri));
            }
            this.fireOnDidChangeMarkers(BreakpointManager_1.FUNCTION_URI);
            this.fireOnDidChangeMarkers(BreakpointManager_1.INSTRUCTION_URI);
            this.fireOnDidChangeMarkers(BreakpointManager_1.DATA_URI);
            this.fireOnDidChangeMarkers(BreakpointManager_1.EXCEPTION_URI);
        }
    }
    enableAllBreakpoints(enabled) {
        for (const uriString of this.getUris()) {
            let didChange = false;
            const uri = new uri_1.default(uriString);
            const bps = this.getBreakpoints(uri);
            for (const bp of bps) {
                didChange ||= this.doEnableBreakpoint(bp, enabled);
            }
            if (didChange) {
                this.fireOnDidChangeMarkers(uri);
                this.onDidChangeBreakpointsEmitter.fire({ uri, added: [], removed: [], changed: [...bps] });
            }
        }
        let didChangeFunction = false;
        for (const breakpoint of this.functionBreakpoints) {
            if (breakpoint.origin.enabled !== enabled) {
                breakpoint.origin.enabled = enabled;
                didChangeFunction = true;
            }
        }
        if (didChangeFunction) {
            this.fireOnDidChangeMarkers(BreakpointManager_1.FUNCTION_URI);
            this.onDidChangeFunctionBreakpointsEmitter.fire({
                uri: BreakpointManager_1.FUNCTION_URI, added: [], removed: [], changed: [...this.functionBreakpoints]
            });
        }
        let didChangeInstruction = false;
        for (const breakpoint of this.instructionBreakpoints) {
            if (breakpoint.origin.enabled !== enabled) {
                breakpoint.origin.enabled = enabled;
                didChangeInstruction = true;
            }
        }
        if (didChangeInstruction) {
            this.fireOnDidChangeMarkers(BreakpointManager_1.INSTRUCTION_URI);
            this.onDidChangeInstructionBreakpointsEmitter.fire({
                uri: BreakpointManager_1.INSTRUCTION_URI, added: [], removed: [], changed: [...this.instructionBreakpoints]
            });
        }
        let didChangeData = false;
        for (const breakpoint of this.dataBreakpoints) {
            if (breakpoint.origin.enabled !== enabled) {
                breakpoint.origin.enabled = enabled;
                didChangeData = true;
            }
        }
        if (didChangeData) {
            this.fireOnDidChangeMarkers(BreakpointManager_1.DATA_URI);
            this.onDidChangeDataBreakpointsEmitter.fire({
                uri: BreakpointManager_1.DATA_URI, added: [], removed: [], changed: [...this.dataBreakpoints]
            });
        }
    }
    enableBreakpoint(breakpoint, enabled) {
        const didChange = this.doEnableBreakpoint(breakpoint, enabled);
        if (didChange) {
            this.fireBreakpointChanged(breakpoint);
        }
    }
    doEnableBreakpoint(breakpoint, enabled) {
        if (breakpoint.origin.enabled !== enabled) {
            breakpoint.origin.enabled = enabled;
            return true;
        }
        return false;
    }
    // ── Generic update / fire ──
    updateBreakpoint(bp, update) {
        bp.origin.raw = { ...bp.origin.raw, ...update };
        this.fireBreakpointChanged(bp);
    }
    fireBreakpointChanged(breakpoint) {
        this.fireOnDidChangeMarkers(breakpoint.uri);
        this.fireTypedBreakpointEvent(breakpoint.uri, [], [breakpoint], []);
    }
    fireTypedBreakpointEvent(uri, added, changed, removed) {
        // All breakpoints in a single call are the same type (grouped by URI).
        const sample = added[0] ?? changed[0] ?? removed[0];
        if (!sample) {
            return;
        }
        if (sample instanceof debug_source_breakpoint_1.DebugSourceBreakpoint) {
            this.onDidChangeBreakpointsEmitter.fire({ uri, added, changed, removed });
        }
        else if (sample instanceof debug_function_breakpoint_1.DebugFunctionBreakpoint) {
            this.onDidChangeFunctionBreakpointsEmitter.fire({ uri, added, changed, removed });
        }
        else if (sample instanceof debug_instruction_breakpoint_1.DebugInstructionBreakpoint) {
            this.onDidChangeInstructionBreakpointsEmitter.fire({ uri, added, changed, removed });
        }
        else if (sample instanceof debug_data_breakpoint_1.DebugDataBreakpoint) {
            this.onDidChangeDataBreakpointsEmitter.fire({ uri, added, changed, removed });
        }
    }
    // ── Bulk remove by ID (plugin API) ──
    removeBreakpointsById(ids) {
        const toRemove = new Set(ids);
        // Source breakpoints
        for (const [uriString, bps] of this.sourceBreakpoints.entries()) {
            const retained = bps.filter(bp => !toRemove.has(bp.id));
            if (retained.length !== bps.length) {
                const removed = bps.filter(bp => toRemove.has(bp.id));
                const uri = new uri_1.default(uriString);
                if (retained.length > 0) {
                    this.sourceBreakpoints.set(uriString, retained);
                }
                else {
                    this.sourceBreakpoints.delete(uriString);
                }
                this.fireOnDidChangeMarkers(uri);
                this.onDidChangeBreakpointsEmitter.fire({ uri, removed, added: [], changed: [] });
            }
        }
        // Function breakpoints
        const functionRemoved = [];
        this.functionBreakpoints = this.functionBreakpoints.filter(bp => {
            if (toRemove.has(bp.id)) {
                functionRemoved.push(bp);
                return false;
            }
            return true;
        });
        if (functionRemoved.length) {
            this.fireOnDidChangeMarkers(BreakpointManager_1.FUNCTION_URI);
            this.onDidChangeFunctionBreakpointsEmitter.fire({ uri: BreakpointManager_1.FUNCTION_URI, removed: functionRemoved, added: [], changed: [] });
        }
        // Instruction breakpoints
        const instructionRemoved = [];
        this.instructionBreakpoints = this.instructionBreakpoints.filter(bp => {
            if (toRemove.has(bp.id)) {
                instructionRemoved.push(bp);
                return false;
            }
            return true;
        });
        if (instructionRemoved.length) {
            this.fireOnDidChangeMarkers(BreakpointManager_1.INSTRUCTION_URI);
            this.onDidChangeInstructionBreakpointsEmitter.fire({ uri: BreakpointManager_1.INSTRUCTION_URI, removed: instructionRemoved, added: [], changed: [] });
        }
        // Data breakpoints
        const dataRemoved = [];
        this.dataBreakpoints = this.dataBreakpoints.filter(bp => {
            if (toRemove.has(bp.id)) {
                dataRemoved.push(bp);
                return false;
            }
            return true;
        });
        if (dataRemoved.length) {
            this.fireOnDidChangeMarkers(BreakpointManager_1.DATA_URI);
            this.onDidChangeDataBreakpointsEmitter.fire({ uri: BreakpointManager_1.DATA_URI, removed: dataRemoved, added: [], changed: [] });
        }
    }
    getExceptionBreakpoint(filter) {
        return this.exceptionBreakpoints.find(candidate => breakpoint_marker_1.ExceptionBreakpoint.matches(candidate.origin.raw, filter));
    }
    getExceptionBreakpoints() {
        return this.exceptionBreakpoints;
    }
    addExceptionBreakpoints(filters, sessionId) {
        for (const filter of filters) {
            let bp = this.exceptionBreakpoints.find(candidate => breakpoint_marker_1.ExceptionBreakpoint.matches(candidate.origin.raw, filter));
            if (!bp) {
                bp = debug_exception_breakpoint_1.DebugExceptionBreakpoint.create(breakpoint_marker_1.ExceptionBreakpoint.create(filter), this.getBreakpointOptions());
                this.exceptionBreakpoints.push(bp);
            }
            bp.setSessionEnablement(sessionId, true);
            this.doUpdateExceptionBreakpointVisibility(sessionId);
        }
        this.fireOnDidChangeMarkers(BreakpointManager_1.EXCEPTION_URI);
    }
    updateExceptionBreakpointVisibility(sessionId) {
        this.doUpdateExceptionBreakpointVisibility(sessionId);
        this.fireOnDidChangeMarkers(BreakpointManager_1.EXCEPTION_URI);
    }
    clearExceptionSessionEnablement(sessionId) {
        for (const bp of this.exceptionBreakpoints) {
            bp.setSessionEnablement(sessionId, false);
        }
        this.fireOnDidChangeMarkers(BreakpointManager_1.EXCEPTION_URI);
    }
    doUpdateExceptionBreakpointVisibility(sessionId) {
        for (const bp of this.exceptionBreakpoints) {
            bp.setPersistentVisibility(bp.isEnabledForSession(sessionId));
        }
    }
    getFunctionBreakpoints() {
        return this.functionBreakpoints;
    }
    setFunctionBreakpoints(functionBreakpoints) {
        const oldBreakpoints = new Map(this.functionBreakpoints.map(b => [b.id, b]));
        this.functionBreakpoints = functionBreakpoints.map(bp => {
            const existing = oldBreakpoints.get(bp.id);
            if (existing) {
                return existing;
            }
            return debug_function_breakpoint_1.DebugFunctionBreakpoint.create(bp, this.getBreakpointOptions());
        });
        this.fireOnDidChangeMarkers(BreakpointManager_1.FUNCTION_URI);
        const added = [];
        const removed = [];
        const changed = [];
        const ids = new Set();
        for (const newBreakpoint of this.functionBreakpoints) {
            ids.add(newBreakpoint.id);
            if (oldBreakpoints.has(newBreakpoint.id)) {
                changed.push(newBreakpoint);
            }
            else {
                added.push(newBreakpoint);
            }
        }
        for (const [id, breakpoint] of oldBreakpoints.entries()) {
            if (!ids.has(id)) {
                removed.push(breakpoint);
            }
        }
        this.onDidChangeFunctionBreakpointsEmitter.fire({ uri: BreakpointManager_1.FUNCTION_URI, added, removed, changed });
    }
    addFunctionBreakpoint(bp) {
        const duplicate = this.functionBreakpoints.find(c => c.origin.raw.name === bp.raw.name);
        if (duplicate) {
            return;
        }
        const newBp = debug_function_breakpoint_1.DebugFunctionBreakpoint.create(bp, this.getBreakpointOptions());
        this.functionBreakpoints = [...this.functionBreakpoints, newBp];
        this.fireOnDidChangeMarkers(newBp.uri);
        this.onDidChangeFunctionBreakpointsEmitter.fire({ uri: newBp.uri, added: [newBp], changed: [], removed: [] });
    }
    updateFunctionBreakpoint(bp, update) {
        if (!this.functionBreakpoints.includes(bp)) {
            return;
        }
        const removed = [];
        if ('name' in update && !update.name) {
            throw new Error('Name field of function breakpoint must be populated.');
        }
        else if ('name' in update) {
            this.functionBreakpoints = this.functionBreakpoints.filter(candidate => {
                if (candidate !== bp && candidate.origin.raw.name === update.name) {
                    removed.push(candidate);
                    return false;
                }
                return true;
            });
        }
        bp.origin.raw = { ...bp.origin.raw, ...update };
        this.fireOnDidChangeMarkers(bp.uri);
        this.onDidChangeFunctionBreakpointsEmitter.fire({ uri: bp.uri, changed: [bp], removed, added: [] });
    }
    removeFunctionBreakpoint(breakpoint) {
        const index = this.functionBreakpoints.indexOf(breakpoint);
        if (index === -1) {
            return;
        }
        const removed = this.functionBreakpoints.splice(index, 1);
        this.fireOnDidChangeMarkers(breakpoint.uri);
        this.onDidChangeFunctionBreakpointsEmitter.fire({ uri: breakpoint.uri, removed, added: [], changed: [] });
    }
    getInstructionBreakpoints() {
        return this.instructionBreakpoints;
    }
    setInstructionBreakpoints(newBreakpoints) {
        const oldBreakpoints = new Map(this.instructionBreakpoints.map(bp => [bp.id, bp]));
        const currentBreakpoints = newBreakpoints.map(bp => {
            const existing = oldBreakpoints.get(bp.id);
            if (existing) {
                return existing;
            }
            return debug_instruction_breakpoint_1.DebugInstructionBreakpoint.create(bp, this.getBreakpointOptions());
        });
        const added = [];
        const changed = [];
        for (const breakpoint of currentBreakpoints) {
            const old = oldBreakpoints.get(breakpoint.id);
            if (old) {
                changed.push(old);
            }
            else {
                added.push(breakpoint);
            }
            oldBreakpoints.delete(breakpoint.id);
        }
        const removed = Array.from(oldBreakpoints.values());
        this.instructionBreakpoints = currentBreakpoints;
        this.fireOnDidChangeMarkers(BreakpointManager_1.INSTRUCTION_URI);
        this.onDidChangeInstructionBreakpointsEmitter.fire({ uri: BreakpointManager_1.INSTRUCTION_URI, added, removed, changed });
    }
    addInstructionBreakpoint(address, offset, condition, hitCondition) {
        const duplicate = this.instructionBreakpoints.find(c => c.origin.raw.instructionReference === address && (c.origin.raw.offset ?? 0) === (offset ?? 0));
        if (duplicate) {
            return;
        }
        const newBp = debug_instruction_breakpoint_1.DebugInstructionBreakpoint.create(breakpoint_marker_1.InstructionBreakpoint.create({
            instructionReference: address,
            offset,
            condition,
            hitCondition,
        }), this.getBreakpointOptions());
        this.instructionBreakpoints = [...this.instructionBreakpoints, newBp];
        this.fireOnDidChangeMarkers(BreakpointManager_1.INSTRUCTION_URI);
        this.onDidChangeInstructionBreakpointsEmitter.fire({ uri: BreakpointManager_1.INSTRUCTION_URI, added: [newBp], removed: [], changed: [] });
    }
    removeInstructionBreakpoint(breakpoint) {
        const index = this.instructionBreakpoints.indexOf(breakpoint);
        if (index === -1) {
            return;
        }
        const removed = this.instructionBreakpoints.splice(index, 1);
        this.fireOnDidChangeMarkers(breakpoint.uri);
        this.onDidChangeInstructionBreakpointsEmitter.fire({ uri: breakpoint.uri, removed, added: [], changed: [] });
    }
    removeInstructionBreakpointAt(address) {
        const match = this.instructionBreakpoints.find(candidate => candidate.origin.raw.instructionReference === address);
        if (match) {
            this.removeInstructionBreakpoint(match);
        }
    }
    clearInstructionBreakpoints() {
        this.setInstructionBreakpoints([]);
    }
    getDataBreakpoints() {
        return this.dataBreakpoints;
    }
    setDataBreakpoints(breakpoints) {
        const oldBreakpoints = new Map(this.dataBreakpoints.map(bp => [bp.id, bp]));
        const newBreakpoints = breakpoints.map(bp => {
            const existing = oldBreakpoints.get(bp.id);
            if (existing) {
                return existing;
            }
            return debug_data_breakpoint_1.DebugDataBreakpoint.create(bp, this.getBreakpointOptions());
        });
        const added = [];
        const changed = [];
        for (const bp of newBreakpoints) {
            if (oldBreakpoints.has(bp.id)) {
                changed.push(bp);
            }
            else {
                added.push(bp);
            }
            oldBreakpoints.delete(bp.id);
        }
        const removed = Array.from(oldBreakpoints.values());
        this.dataBreakpoints = newBreakpoints;
        this.fireOnDidChangeMarkers(BreakpointManager_1.DATA_URI);
        this.onDidChangeDataBreakpointsEmitter.fire({ uri: BreakpointManager_1.DATA_URI, added, removed, changed });
    }
    addDataBreakpoint(breakpoint) {
        const duplicate = this.dataBreakpoints.find(c => c.origin.raw.dataId === breakpoint.raw.dataId);
        if (duplicate) {
            return;
        }
        const newBp = debug_data_breakpoint_1.DebugDataBreakpoint.create(breakpoint, this.getBreakpointOptions());
        this.dataBreakpoints = [...this.dataBreakpoints, newBp];
        this.fireOnDidChangeMarkers(BreakpointManager_1.DATA_URI);
        this.onDidChangeDataBreakpointsEmitter.fire({ uri: BreakpointManager_1.DATA_URI, added: [newBp], removed: [], changed: [] });
    }
    updateDataBreakpoint(bp, options) {
        if (!this.dataBreakpoints.includes(bp)) {
            return;
        }
        if (options.raw) {
            Object.assign(bp.origin.raw, options.raw);
        }
        if (options.enabled !== undefined) {
            bp.origin.enabled = options.enabled;
        }
        this.fireBreakpointChanged(bp);
    }
    removeDataBreakpoint(bp) {
        const index = this.dataBreakpoints.indexOf(bp);
        if (index < 0) {
            return;
        }
        const removed = this.dataBreakpoints.splice(index, 1);
        this.fireOnDidChangeMarkers(BreakpointManager_1.DATA_URI);
        this.onDidChangeDataBreakpointsEmitter.fire({ uri: BreakpointManager_1.DATA_URI, added: [], removed, changed: [] });
    }
    // ── Persistence ──
    async load() {
        const data = await this.storage.getData('breakpoints', {
            breakpointsEnabled: true,
            breakpoints: {}
        });
        this._breakpointsEnabled = data.breakpointsEnabled;
        // eslint-disable-next-line guard-for-in
        for (const uri in data.breakpoints) {
            this.setBreakpoints(new uri_1.default(uri), data.breakpoints[uri]);
        }
        if (data.functionBreakpoints) {
            this.setFunctionBreakpoints(data.functionBreakpoints);
        }
        if (data.exceptionBreakpoints) {
            this.exceptionBreakpoints = data.exceptionBreakpoints.map(bp => debug_exception_breakpoint_1.DebugExceptionBreakpoint.create(bp, this.getBreakpointOptions()));
            this.fireOnDidChangeMarkers(BreakpointManager_1.EXCEPTION_URI);
        }
        if (data.instructionBreakpoints) {
            this.setInstructionBreakpoints(data.instructionBreakpoints);
        }
        if (data.dataBreakpoints) {
            this.setDataBreakpoints(data.dataBreakpoints);
        }
    }
    save() {
        const data = {
            breakpointsEnabled: this._breakpointsEnabled,
            breakpoints: {}
        };
        for (const uri of this.getUris()) {
            data.breakpoints[uri] = (this.sourceBreakpoints.get(uri) ?? []).map(bp => bp.origin);
        }
        if (this.functionBreakpoints.length) {
            data.functionBreakpoints = this.functionBreakpoints.map(({ origin }) => origin);
        }
        if (this.exceptionBreakpoints.length) {
            data.exceptionBreakpoints = this.exceptionBreakpoints.filter(candidate => candidate.isPersistentlyVisible()).map(({ origin }) => origin);
        }
        if (this.instructionBreakpoints.length) {
            data.instructionBreakpoints = this.instructionBreakpoints.map(({ origin }) => origin);
        }
        const dataBreakpointsToStore = this.dataBreakpoints.filter(candidate => candidate.origin.info.canPersist);
        if (dataBreakpointsToStore.length) {
            data.dataBreakpoints = dataBreakpointsToStore.map(({ origin }) => origin);
        }
        this.storage.setData('breakpoints', data);
    }
};
exports.BreakpointManager = BreakpointManager;
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_1.StorageService),
    tslib_1.__metadata("design:type", Object)
], BreakpointManager.prototype, "storage", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_1.LabelProvider),
    tslib_1.__metadata("design:type", browser_1.LabelProvider)
], BreakpointManager.prototype, "labelProvider", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_1.OpenerService),
    tslib_1.__metadata("design:type", Object)
], BreakpointManager.prototype, "openerService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(common_1.CommandService),
    tslib_1.__metadata("design:type", Object)
], BreakpointManager.prototype, "commandService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(file_service_1.FileService),
    tslib_1.__metadata("design:type", file_service_1.FileService)
], BreakpointManager.prototype, "fileService", void 0);
tslib_1.__decorate([
    (0, inversify_1.postConstruct)(),
    tslib_1.__metadata("design:type", Function),
    tslib_1.__metadata("design:paramtypes", []),
    tslib_1.__metadata("design:returntype", void 0)
], BreakpointManager.prototype, "init", null);
exports.BreakpointManager = BreakpointManager = BreakpointManager_1 = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], BreakpointManager);
//# sourceMappingURL=breakpoint-manager.js.map