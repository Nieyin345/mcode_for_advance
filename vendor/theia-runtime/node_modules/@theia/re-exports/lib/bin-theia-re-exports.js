"use strict";
// *****************************************************************************
// Copyright (C) 2021 Ericsson and others.
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
const fs = require("fs");
const mustache = require("mustache");
const os = require("os");
const path = require("path");
const semver = require("semver");
const yargs = require("yargs");
const utility_1 = require("./utility");
const package_re_exports_1 = require("./package-re-exports");
yargs
    .command('generate [packageName]', 'Generate Theia re-exports', cli => cli
    .positional('packageName', {
    type: 'string',
    describe: 'Name of the package to generate the re-exports for'
}), async ({ packageName }) => {
    if (!packageName) {
        packageName = JSON.parse(await readFile(path.resolve('package.json'))).name;
    }
    const packageReExports = await package_re_exports_1.PackageReExports.FromPackage(packageName);
    const writer = new FileWriter(findEol(await readFile(packageReExports.resolvePath('package.json'))));
    await Promise.all(packageReExports.all.map(async (reExport) => {
        const reExportPath = packageReExports.resolvePath(reExport.reExportDir, reExport.moduleName, 'index');
        await writer.write(`${reExportPath}.js`, `module.exports = require('${reExport.internalImport}');\n`);
        if (reExport.reExportStyle === '*') {
            const content = `export * from '${reExport.internalImport}';\n`;
            await writer.write(`${reExportPath}.d.ts`, content);
        }
        else if (reExport.reExportStyle === '=') {
            const content = `import ${reExport.exportNamespace} = require('${reExport.internalImport}');\nexport = ${reExport.exportNamespace};\n`;
            await writer.write(`${reExportPath}.d.ts`, content);
        }
        else {
            console.warn('unexpected re-export');
        }
    }));
})
    .command('template inputFile [packageName]', 'Evaluate mustache templates', cli => cli
    .positional('inputFile', {
    type: 'string',
    describe: 'File to evaluate defined using mustache template syntax',
    demandOption: true
})
    .positional('packageName', {
    type: 'string',
    describe: 'Name of the package to generate the re-exports for'
}), async ({ inputFile, packageName }) => {
    if (!packageName) {
        packageName = JSON.parse(await readFile(path.resolve('package.json'))).name;
    }
    const template = await readFile(inputFile);
    const packageReExports = await package_re_exports_1.PackageReExports.FromPackage(packageName);
    const eol = findEol(await readFile(packageReExports.resolvePath('package.json')));
    // Organize `ReExport`s by `reExportsDir` then by `packageName`:
    const reExportsDirectories = {};
    for (const reExport of packageReExports.all) {
        let reExportsPackages = reExportsDirectories[reExport.reExportDir];
        if (!reExportsPackages) {
            reExportsPackages = reExportsDirectories[reExport.reExportDir] = {};
        }
        let reExports = reExportsPackages[reExport.packageName];
        if (!reExports) {
            reExports = reExportsPackages[reExport.packageName] = [];
        }
        reExports.push(reExport);
    }
    // Map the organized `ReExport`s into a view object for mustache:
    const reExportsView = {
        reExportsDirectories: Object.entries(reExportsDirectories).map(([directory, reExportsPackages]) => ({
            directory,
            // eslint-disable-next-line @typescript-eslint/no-shadow
            packages: Object.entries(reExportsPackages).map(([packageName, reExports]) => ({
                packageName,
                npmUrl: getNpmUrl(packageName, reExports[0].versionRange),
                versionRange: reExports[0].versionRange,
                modules: reExports.map(reExport => ({
                    moduleName: reExport.moduleName,
                }))
            }))
        }))
    };
    // `console.log` replaces CRLF with LF which is problematic on Windows
    process.stdout.write(convertEol(eol, mustache.render(template, reExportsView)));
})
    .parse();
function getNpmUrl(moduleName, versionRange) {
    const [packageName] = (0, utility_1.parseModule)(moduleName);
    let url = `https://www.npmjs.com/package/${packageName}`;
    // Is the range a fixed version?
    const version = versionRange && semver.valid(versionRange);
    if (version) {
        url += `/v/${version}`;
    }
    return url;
}
async function readFile(filePath) {
    return fs.promises.readFile(filePath, 'utf8');
}
function findEol(content) {
    const match = content.match(/\r\n?|\n/);
    return (match ? match[0] : os.EOL);
}
function convertEol(eol, content) {
    switch (eol) {
        case '\r\n': return content.replace(/(?<!\r)\n|\r(?!\n)/g, '\r\n');
        case '\n': return content.replace(/\r\n?/g, '\n');
        case '\r': return content.replace(/\r?\n/g, '\r');
    }
}
class FileWriter {
    constructor(eol) {
        this.eol = eol;
    }
    async write(filePath, content) {
        const dirPath = path.dirname(filePath);
        await fs.promises.mkdir(dirPath, { recursive: true });
        await fs.promises.writeFile(filePath, convertEol(this.eol, content));
    }
}
//# sourceMappingURL=bin-theia-re-exports.js.map