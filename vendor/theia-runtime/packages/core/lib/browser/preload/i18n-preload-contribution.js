"use strict";
// *****************************************************************************
// Copyright (C) 2023 TypeFox and others.
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
exports.I18nPreloadContribution = void 0;
const tslib_1 = require("tslib");
const frontend_application_config_provider_1 = require("../frontend-application-config-provider");
const nls_1 = require("../../common/nls");
const inversify_1 = require("inversify");
const localization_server_1 = require("../../common/i18n/localization-server");
const contribution_provider_1 = require("../../common/contribution-provider");
const text_replacement_contribution_1 = require("./text-replacement-contribution");
let I18nPreloadContribution = class I18nPreloadContribution {
    async initialize() {
        const defaultLocale = frontend_application_config_provider_1.FrontendApplicationConfigProvider.get().defaultLocale;
        if (defaultLocale && !nls_1.nls.locale) {
            Object.assign(nls_1.nls, {
                locale: defaultLocale
            });
        }
        let locale = nls_1.nls.locale ?? nls_1.nls.defaultLocale;
        if (nls_1.nls.locale) {
            const localization = await this.localizationServer.loadLocalization(locale);
            if (localization.languagePack) {
                nls_1.nls.localization = localization;
            }
            else if (locale !== nls_1.nls.defaultLocale) {
                // In case the localization that we've loaded doesn't localize Theia completely (languagePack is false)
                // We simply reset the locale to the default again
                Object.assign(nls_1.nls, {
                    locale: defaultLocale || undefined
                });
                locale = defaultLocale;
            }
        }
        const replacements = this.getReplacements(locale);
        if (Object.keys(replacements).length > 0) {
            nls_1.nls.localization ??= { translations: {}, languageId: locale };
            nls_1.nls.localization.replacements = replacements;
        }
    }
    getReplacements(locale) {
        const replacements = {};
        for (const contribution of this.replacementContributions.getContributions()) {
            Object.assign(replacements, contribution.getReplacement(locale));
        }
        return replacements;
    }
};
exports.I18nPreloadContribution = I18nPreloadContribution;
tslib_1.__decorate([
    (0, inversify_1.inject)(localization_server_1.LocalizationServer),
    tslib_1.__metadata("design:type", Object)
], I18nPreloadContribution.prototype, "localizationServer", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(contribution_provider_1.ContributionProvider),
    (0, inversify_1.named)(text_replacement_contribution_1.TextReplacementContribution),
    tslib_1.__metadata("design:type", Object)
], I18nPreloadContribution.prototype, "replacementContributions", void 0);
exports.I18nPreloadContribution = I18nPreloadContribution = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], I18nPreloadContribution);
//# sourceMappingURL=i18n-preload-contribution.js.map