"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CapabilityAwareContext = exports.GenericCapabilitySelections = exports.CAPABILITY_TYPE_PROMPT_MAP = exports.GenericCapabilitiesContribution = exports.GENERIC_CAPABILITIES_VARIABLE_PREFIX = exports.GENERIC_CAPABILITIES_PROMPT_PREFIX = exports.GENERIC_CAPABILITIES_VARIABLES_PROMPT_ID = exports.GENERIC_CAPABILITIES_AGENT_DELEGATION_PROMPT_ID = exports.GENERIC_CAPABILITIES_PROMPT_FRAGMENTS_PROMPT_ID = exports.GENERIC_CAPABILITIES_FUNCTIONS_PROMPT_ID = exports.GENERIC_CAPABILITIES_MCP_FUNCTIONS_PROMPT_ID = exports.GENERIC_CAPABILITIES_SKILLS_PROMPT_ID = void 0;
exports.parseCapabilitiesFromTemplate = parseCapabilitiesFromTemplate;
exports.parseCapabilityArgument = parseCapabilityArgument;
/** Prompt fragment IDs for each generic capability type */
exports.GENERIC_CAPABILITIES_SKILLS_PROMPT_ID = 'generic-capabilities-skills';
exports.GENERIC_CAPABILITIES_MCP_FUNCTIONS_PROMPT_ID = 'generic-capabilities-mcp-functions';
exports.GENERIC_CAPABILITIES_FUNCTIONS_PROMPT_ID = 'generic-capabilities-functions';
exports.GENERIC_CAPABILITIES_PROMPT_FRAGMENTS_PROMPT_ID = 'generic-capabilities-prompt-fragments';
exports.GENERIC_CAPABILITIES_AGENT_DELEGATION_PROMPT_ID = 'generic-capabilities-agent-delegation';
exports.GENERIC_CAPABILITIES_VARIABLES_PROMPT_ID = 'generic-capabilities-variables';
/** Prefix used by internal prompt fragments for generic capabilities */
exports.GENERIC_CAPABILITIES_PROMPT_PREFIX = 'generic-capabilities-';
/** Prefix used by internal variables for generic capability selections */
exports.GENERIC_CAPABILITIES_VARIABLE_PREFIX = 'selected_';
exports.GenericCapabilitiesContribution = Symbol('GenericCapabilitiesContribution');
/**
 * Static mapping of capability types to their corresponding prompt fragment IDs.
 * This is the single source of truth for the enumeration of capability types,
 * reducing DRY violations across the codebase.
 */
exports.CAPABILITY_TYPE_PROMPT_MAP = [
    { type: 'skills', promptId: exports.GENERIC_CAPABILITIES_SKILLS_PROMPT_ID },
    { type: 'mcpFunctions', promptId: exports.GENERIC_CAPABILITIES_MCP_FUNCTIONS_PROMPT_ID },
    { type: 'functions', promptId: exports.GENERIC_CAPABILITIES_FUNCTIONS_PROMPT_ID },
    { type: 'promptFragments', promptId: exports.GENERIC_CAPABILITIES_PROMPT_FRAGMENTS_PROMPT_ID },
    { type: 'agentDelegation', promptId: exports.GENERIC_CAPABILITIES_AGENT_DELEGATION_PROMPT_ID },
    { type: 'variables', promptId: exports.GENERIC_CAPABILITIES_VARIABLES_PROMPT_ID },
];
var GenericCapabilitySelections;
(function (GenericCapabilitySelections) {
    /**
     * Checks if the selections object has any non-empty arrays.
     */
    function hasSelections(selections) {
        if (!selections) {
            return false;
        }
        return exports.CAPABILITY_TYPE_PROMPT_MAP.some(({ type }) => (selections[type]?.length ?? 0) > 0);
    }
    GenericCapabilitySelections.hasSelections = hasSelections;
})(GenericCapabilitySelections || (exports.GenericCapabilitySelections = GenericCapabilitySelections = {}));
/**
 * An extended variable resolution context that includes capability override information.
 *
 * This context is used during prompt template resolution to determine which capability
 * fragments should be enabled or disabled, allowing dynamic customization of agent behavior.
 */
var CapabilityAwareContext;
(function (CapabilityAwareContext) {
    function is(candidate) {
        return typeof candidate === 'object' && !!candidate
            && ('capabilityOverrides' in candidate || 'genericCapabilitySelections' in candidate);
    }
    CapabilityAwareContext.is = is;
})(CapabilityAwareContext || (exports.CapabilityAwareContext = CapabilityAwareContext = {}));
/**
 * Parses capability variables from a prompt template string.
 *
 * Capability variables have the format:
 * - `{{capability:fragment-id}}` (defaults to off)
 * - `{{capability:fragment-id default on}}` or `{{capability:fragment-id default off}}`
 * - `{{{capability:fragment-id}}}` (defaults to off)
 * - `{{{capability:fragment-id default on}}}` or `{{{capability:fragment-id default off}}}`
 *
 * @param template The prompt template string to parse
 * @returns Array of parsed capabilities in the order they appear in the template
 */
function parseCapabilitiesFromTemplate(template) {
    const seenFragmentIds = new Set();
    const capabilities = [];
    const regex = /\{{2,3}\s*capability:([^\s}]+)(?:\s+default\s+(on|off))?\s*\}{2,3}/gi;
    let match = regex.exec(template);
    while (match) {
        const fragmentId = match[1];
        if (!seenFragmentIds.has(fragmentId)) {
            seenFragmentIds.add(fragmentId);
            capabilities.push({
                fragmentId,
                defaultEnabled: match[2]?.toLowerCase() === 'on'
            });
        }
        match = regex.exec(template);
    }
    return capabilities;
}
/**
 * Parses a capability argument string.
 * Expected formats:
 * - "fragment-id" (defaults to off)
 * - "fragment-id default on" or "fragment-id default off"
 * @param arg The argument string to parse
 * @returns Object with fragmentId and defaultEnabled, or undefined if parsing failed
 */
function parseCapabilityArgument(arg) {
    const match = arg.trim().match(/^(.+?)(?:\s+default\s+(on|off))?$/i);
    if (!match || !match[1].trim()) {
        return undefined;
    }
    return {
        fragmentId: match[1].trim(),
        defaultEnabled: match[2]?.toLowerCase() === 'on'
    };
}
//# sourceMappingURL=capability-utils.js.map