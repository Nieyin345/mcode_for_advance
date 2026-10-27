"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PluginHostEnvironmentVariable = exports.ServerPluginRunner = exports.PluginServer = exports.pluginServerJsonRpcPath = exports.HostedPluginServer = exports.PluginDeployerHandler = exports.HostedPluginClient = exports.MetadataProcessor = exports.IconContribution = exports.PluginDeployerEntryType = exports.PluginDeployerParticipant = exports.PluginDeployer = exports.PluginDeployerFileHandler = exports.PluginDeployerDirectoryHandler = exports.PluginDeployerResolver = exports.PluginScanner = exports.PluginViewType = exports.CustomEditorPriority = exports.PluginPackage = exports.hostedServicePath = exports.PluginType = exports.PLUGIN_HOST_FRONTEND = exports.PLUGIN_HOST_BACKEND = exports.toPluginUrl = exports.getPluginId = exports.PluginIdentifiers = void 0;
const plugin_identifiers_1 = require("./plugin-identifiers");
Object.defineProperty(exports, "PluginIdentifiers", { enumerable: true, get: function () { return plugin_identifiers_1.PluginIdentifiers; } });
const plugin_model_1 = require("@theia/plugin-utils/lib/common/plugin-model");
Object.defineProperty(exports, "getPluginId", { enumerable: true, get: function () { return plugin_model_1.getPluginId; } });
Object.defineProperty(exports, "toPluginUrl", { enumerable: true, get: function () { return plugin_model_1.toPluginUrl; } });
const manifest_types_1 = require("@theia/plugin-utils/lib/common/manifest-types");
Object.defineProperty(exports, "PLUGIN_HOST_BACKEND", { enumerable: true, get: function () { return manifest_types_1.PLUGIN_HOST_BACKEND; } });
Object.defineProperty(exports, "PLUGIN_HOST_FRONTEND", { enumerable: true, get: function () { return manifest_types_1.PLUGIN_HOST_FRONTEND; } });
Object.defineProperty(exports, "PluginType", { enumerable: true, get: function () { return manifest_types_1.PluginType; } });
const contribution_types_1 = require("@theia/plugin-utils/lib/common/contribution-types");
Object.defineProperty(exports, "CustomEditorPriority", { enumerable: true, get: function () { return contribution_types_1.CustomEditorPriority; } });
Object.defineProperty(exports, "PluginViewType", { enumerable: true, get: function () { return contribution_types_1.PluginViewType; } });
exports.hostedServicePath = '/services/hostedPlugin';
var PluginPackage;
(function (PluginPackage) {
    PluginPackage.toPluginUrl = plugin_model_1.toPluginUrl;
})(PluginPackage || (exports.PluginPackage = PluginPackage = {}));
exports.PluginScanner = Symbol('PluginScanner');
/**
 * A plugin resolver is handling how to resolve a plugin link into a local resource.
 */
exports.PluginDeployerResolver = Symbol('PluginDeployerResolver');
exports.PluginDeployerDirectoryHandler = Symbol('PluginDeployerDirectoryHandler');
exports.PluginDeployerFileHandler = Symbol('PluginDeployerFileHandler');
exports.PluginDeployer = Symbol('PluginDeployer');
exports.PluginDeployerParticipant = Symbol('PluginDeployerParticipant');
var PluginDeployerEntryType;
(function (PluginDeployerEntryType) {
    PluginDeployerEntryType[PluginDeployerEntryType["FRONTEND"] = 0] = "FRONTEND";
    PluginDeployerEntryType[PluginDeployerEntryType["BACKEND"] = 1] = "BACKEND";
    PluginDeployerEntryType[PluginDeployerEntryType["HEADLESS"] = 2] = "HEADLESS"; // Deployed in the Theia Node server outside the context of a frontend/backend connection
})(PluginDeployerEntryType || (exports.PluginDeployerEntryType = PluginDeployerEntryType = {}));
var IconContribution;
(function (IconContribution) {
    function isIconDefinition(defaults) {
        return 'fontCharacter' in defaults;
    }
    IconContribution.isIconDefinition = isIconDefinition;
})(IconContribution || (exports.IconContribution = IconContribution = {}));
exports.MetadataProcessor = Symbol('MetadataProcessor');
exports.HostedPluginClient = Symbol('HostedPluginClient');
exports.PluginDeployerHandler = Symbol('PluginDeployerHandler');
exports.HostedPluginServer = Symbol('HostedPluginServer');
exports.pluginServerJsonRpcPath = '/services/plugin-ext';
exports.PluginServer = Symbol('PluginServer');
exports.ServerPluginRunner = Symbol('ServerPluginRunner');
exports.PluginHostEnvironmentVariable = Symbol('PluginHostEnvironmentVariable');
//# sourceMappingURL=plugin-protocol.js.map