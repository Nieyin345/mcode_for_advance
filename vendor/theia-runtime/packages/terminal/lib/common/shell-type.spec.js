"use strict";
// *****************************************************************************
// Copyright (C) 2025 STMicroelectronics and others.
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
const chai_1 = require("chai");
const core_1 = require("@theia/core");
const shell_type_1 = require("./shell-type");
// Save original environment state
const originalIsWindows = core_1.OS.backend.isWindows;
// Helper functions to set test environment
function setWindowsEnvironment() {
    Object.defineProperty(core_1.OS.backend, 'isWindows', { value: true });
}
function setUnixEnvironment() {
    Object.defineProperty(core_1.OS.backend, 'isWindows', { value: false });
}
afterEach(() => {
    // Restore original OS.backend.isWindows value after each test
    Object.defineProperty(core_1.OS.backend, 'isWindows', { value: originalIsWindows });
});
describe('shell-type', () => {
    describe('cleanTerminalTitle', () => {
        it('should strip noglob prefix', () => {
            (0, chai_1.expect)((0, shell_type_1.cleanTerminalTitle)('noglob git log')).to.equal('git');
        });
        it('should strip nocorrect prefix', () => {
            (0, chai_1.expect)((0, shell_type_1.cleanTerminalTitle)('nocorrect git status')).to.equal('git');
        });
        it('should strip command prefix', () => {
            (0, chai_1.expect)((0, shell_type_1.cleanTerminalTitle)('command ls -la')).to.equal('ls');
        });
        it('should strip builtin prefix', () => {
            (0, chai_1.expect)((0, shell_type_1.cleanTerminalTitle)('builtin cd /tmp')).to.equal('cd');
        });
        it('should strip exec prefix', () => {
            (0, chai_1.expect)((0, shell_type_1.cleanTerminalTitle)('exec bash')).to.equal('bash');
        });
        it('should strip multiple prefixes', () => {
            (0, chai_1.expect)((0, shell_type_1.cleanTerminalTitle)('noglob command git push')).to.equal('git');
        });
        it('should extract basename from path-based commands', () => {
            (0, chai_1.expect)((0, shell_type_1.cleanTerminalTitle)('/usr/bin/git log')).to.equal('git');
        });
        it('should return command name for simple commands', () => {
            (0, chai_1.expect)((0, shell_type_1.cleanTerminalTitle)('git')).to.equal('git');
        });
        it('should return command name when arguments are present', () => {
            (0, chai_1.expect)((0, shell_type_1.cleanTerminalTitle)('npm install --save')).to.equal('npm');
        });
        it('should handle leading/trailing whitespace', () => {
            (0, chai_1.expect)((0, shell_type_1.cleanTerminalTitle)('  git log  ')).to.equal('git');
        });
        it('should return original title for empty string', () => {
            (0, chai_1.expect)((0, shell_type_1.cleanTerminalTitle)('')).to.equal('');
        });
        it('should return original title for whitespace-only string', () => {
            (0, chai_1.expect)((0, shell_type_1.cleanTerminalTitle)('   ')).to.equal('   ');
        });
        it('should handle zsh-style noglob with complex commands', () => {
            (0, chai_1.expect)((0, shell_type_1.cleanTerminalTitle)('noglob git log --oneline --graph')).to.equal('git');
        });
        describe('CWD/prompt detection (returns empty string)', () => {
            it('should return empty for absolute CWD path', () => {
                (0, chai_1.expect)((0, shell_type_1.cleanTerminalTitle)('/home/user/project')).to.equal('');
            });
            it('should return empty for home-relative CWD path', () => {
                (0, chai_1.expect)((0, shell_type_1.cleanTerminalTitle)('~/Git/theia')).to.equal('');
            });
            it('should return empty for user@host:path format', () => {
                (0, chai_1.expect)((0, shell_type_1.cleanTerminalTitle)('user@host:~/Git/theia')).to.equal('');
            });
            it('should return empty for user@host: path format with space', () => {
                (0, chai_1.expect)((0, shell_type_1.cleanTerminalTitle)('user@myhost: ~/Git/theia')).to.equal('');
            });
            it('should return empty for cwd-relative path', () => {
                (0, chai_1.expect)((0, shell_type_1.cleanTerminalTitle)('./some/dir')).to.equal('');
            });
        });
        it('should extract basename from path-based commands with arguments', () => {
            (0, chai_1.expect)((0, shell_type_1.cleanTerminalTitle)('/usr/bin/git log')).to.equal('git');
        });
    });
    describe('looksLikeHostPrompt', () => {
        it('should detect user@host:path format', () => {
            (0, chai_1.expect)((0, shell_type_1.looksLikeHostPrompt)('user@host:~/project')).to.be.true;
        });
        it('should detect user@host: path with space', () => {
            (0, chai_1.expect)((0, shell_type_1.looksLikeHostPrompt)('user@myhost: ~/Git/theia')).to.be.true;
        });
        it('should not detect plain commands', () => {
            (0, chai_1.expect)((0, shell_type_1.looksLikeHostPrompt)('git log')).to.be.false;
        });
        it('should not detect bare paths', () => {
            (0, chai_1.expect)((0, shell_type_1.looksLikeHostPrompt)('/home/user/project')).to.be.false;
        });
    });
    describe('looksLikePath', () => {
        it('should detect absolute paths', () => {
            (0, chai_1.expect)((0, shell_type_1.looksLikePath)('/home/user/project')).to.be.true;
        });
        it('should detect home-relative paths', () => {
            (0, chai_1.expect)((0, shell_type_1.looksLikePath)('~/Git/theia')).to.be.true;
        });
        it('should detect cwd-relative paths', () => {
            (0, chai_1.expect)((0, shell_type_1.looksLikePath)('./some/dir')).to.be.true;
        });
        it('should not detect plain commands', () => {
            (0, chai_1.expect)((0, shell_type_1.looksLikePath)('git log')).to.be.false;
        });
        it('should not detect simple command names', () => {
            (0, chai_1.expect)((0, shell_type_1.looksLikePath)('npm')).to.be.false;
        });
    });
    describe('guessShellTypeFromExecutable', () => {
        it('should return undefined for undefined input', () => {
            (0, chai_1.expect)((0, shell_type_1.guessShellTypeFromExecutable)(undefined)).to.be.undefined;
        });
        describe('Windows environment', () => {
            beforeEach(() => {
                setWindowsEnvironment();
            });
            it('should detect cmd.exe as Command Prompt', () => {
                (0, chai_1.expect)((0, shell_type_1.guessShellTypeFromExecutable)('C:/Windows/System32/cmd.exe')).to.equal("cmd" /* WindowsShellType.CommandPrompt */);
            });
            it('should detect relative cmd.exe path as Command Prompt', () => {
                (0, chai_1.expect)((0, shell_type_1.guessShellTypeFromExecutable)('cmd.exe')).to.equal("cmd" /* WindowsShellType.CommandPrompt */);
            });
            it('should detect bash.exe as Git Bash in Windows', () => {
                (0, chai_1.expect)((0, shell_type_1.guessShellTypeFromExecutable)('C:/Program Files/Git/bin/bash.exe')).to.equal("gitbash" /* WindowsShellType.GitBash */);
            });
            it('should detect wsl.exe as WSL', () => {
                (0, chai_1.expect)((0, shell_type_1.guessShellTypeFromExecutable)('C:/Windows/System32/wsl.exe')).to.equal("wsl" /* WindowsShellType.Wsl */);
            });
            it('should detect powershell.exe as PowerShell', () => {
                (0, chai_1.expect)((0, shell_type_1.guessShellTypeFromExecutable)('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe')).to.equal("pwsh" /* GeneralShellType.PowerShell */);
            });
            it('should detect pwsh.exe as PowerShell', () => {
                (0, chai_1.expect)((0, shell_type_1.guessShellTypeFromExecutable)('C:/Program Files/PowerShell/7/pwsh.exe')).to.equal("pwsh" /* GeneralShellType.PowerShell */);
            });
            it('should detect pwsh-preview.exe as PowerShell', () => {
                (0, chai_1.expect)((0, shell_type_1.guessShellTypeFromExecutable)('C:/Program Files/PowerShell/7-preview/pwsh-preview.exe')).to.equal("pwsh" /* GeneralShellType.PowerShell */);
            });
            it('should detect python.exe as Python', () => {
                (0, chai_1.expect)((0, shell_type_1.guessShellTypeFromExecutable)('C:/Python310/python.exe')).to.equal("python" /* GeneralShellType.Python */);
            });
            it('should detect py.exe as Python', () => {
                (0, chai_1.expect)((0, shell_type_1.guessShellTypeFromExecutable)('C:/Windows/py.exe')).to.equal("python" /* GeneralShellType.Python */);
            });
            it('should not detect unknown executable', () => {
                (0, chai_1.expect)((0, shell_type_1.guessShellTypeFromExecutable)('C:/Program Files/SomeApp/unknown.exe')).to.be.undefined;
            });
        });
        describe('Linux environment', () => {
            beforeEach(() => {
                setUnixEnvironment();
            });
            it('should detect bash', () => {
                (0, chai_1.expect)((0, shell_type_1.guessShellTypeFromExecutable)('/bin/bash')).to.equal("bash" /* GeneralShellType.Bash */);
            });
            it('should detect sh', () => {
                (0, chai_1.expect)((0, shell_type_1.guessShellTypeFromExecutable)('/bin/sh')).to.equal("sh" /* GeneralShellType.Sh */);
            });
            it('should detect zsh', () => {
                (0, chai_1.expect)((0, shell_type_1.guessShellTypeFromExecutable)('/usr/bin/zsh')).to.equal("zsh" /* GeneralShellType.Zsh */);
            });
            it('should detect fish', () => {
                (0, chai_1.expect)((0, shell_type_1.guessShellTypeFromExecutable)('/usr/bin/fish')).to.equal("fish" /* GeneralShellType.Fish */);
            });
            it('should detect csh', () => {
                (0, chai_1.expect)((0, shell_type_1.guessShellTypeFromExecutable)('/bin/csh')).to.equal("csh" /* GeneralShellType.Csh */);
            });
            it('should detect ksh', () => {
                (0, chai_1.expect)((0, shell_type_1.guessShellTypeFromExecutable)('/bin/ksh')).to.equal("ksh" /* GeneralShellType.Ksh */);
            });
            it('should detect node', () => {
                (0, chai_1.expect)((0, shell_type_1.guessShellTypeFromExecutable)('/usr/bin/node')).to.equal("node" /* GeneralShellType.Node */);
            });
            it('should detect julia', () => {
                (0, chai_1.expect)((0, shell_type_1.guessShellTypeFromExecutable)('/usr/local/bin/julia')).to.equal("julia" /* GeneralShellType.Julia */);
            });
            it('should detect nushell', () => {
                (0, chai_1.expect)((0, shell_type_1.guessShellTypeFromExecutable)('/usr/bin/nu')).to.equal("nu" /* GeneralShellType.NuShell */);
            });
            it('should detect pwsh', () => {
                (0, chai_1.expect)((0, shell_type_1.guessShellTypeFromExecutable)('/usr/bin/pwsh')).to.equal("pwsh" /* GeneralShellType.PowerShell */);
            });
            it('should not detect Windows-specific shells', () => {
                (0, chai_1.expect)((0, shell_type_1.guessShellTypeFromExecutable)('/usr/bin/cmd')).to.not.equal("cmd" /* WindowsShellType.CommandPrompt */);
            });
            it('should not detect unknown executable', () => {
                (0, chai_1.expect)((0, shell_type_1.guessShellTypeFromExecutable)('/usr/bin/unknown')).to.be.undefined;
            });
        });
        describe('macOS environment', () => {
            beforeEach(() => {
                setUnixEnvironment(); // macOS is a Unix-based OS
            });
            it('should detect bash', () => {
                (0, chai_1.expect)((0, shell_type_1.guessShellTypeFromExecutable)('/bin/bash')).to.equal("bash" /* GeneralShellType.Bash */);
            });
            it('should detect zsh (macOS default)', () => {
                (0, chai_1.expect)((0, shell_type_1.guessShellTypeFromExecutable)('/bin/zsh')).to.equal("zsh" /* GeneralShellType.Zsh */);
            });
            it('should detect fish from homebrew', () => {
                (0, chai_1.expect)((0, shell_type_1.guessShellTypeFromExecutable)('/usr/local/bin/fish')).to.equal("fish" /* GeneralShellType.Fish */);
            });
            it('should detect python from homebrew', () => {
                (0, chai_1.expect)((0, shell_type_1.guessShellTypeFromExecutable)('/usr/local/bin/python')).to.equal("python" /* GeneralShellType.Python */);
            });
            it('should detect python3', () => {
                (0, chai_1.expect)((0, shell_type_1.guessShellTypeFromExecutable)('/usr/bin/python3')).to.equal("python" /* GeneralShellType.Python */);
            });
            it('should detect node from homebrew', () => {
                (0, chai_1.expect)((0, shell_type_1.guessShellTypeFromExecutable)('/usr/local/bin/node')).to.equal("node" /* GeneralShellType.Node */);
            });
            it('should not detect Windows-specific shells', () => {
                (0, chai_1.expect)((0, shell_type_1.guessShellTypeFromExecutable)('/usr/bin/cmd')).to.not.equal("cmd" /* WindowsShellType.CommandPrompt */);
            });
            it('should not detect unknown executable', () => {
                (0, chai_1.expect)((0, shell_type_1.guessShellTypeFromExecutable)('/Applications/Unknown.app/Contents/MacOS/Unknown')).to.be.undefined;
            });
        });
        describe('Edge cases', () => {
            it('should handle empty string', () => {
                (0, chai_1.expect)((0, shell_type_1.guessShellTypeFromExecutable)('')).to.be.undefined;
            });
            it('should handle executable with spaces in Windows', () => {
                setWindowsEnvironment();
                (0, chai_1.expect)((0, shell_type_1.guessShellTypeFromExecutable)('C:/Program Files/PowerShell/7/pwsh.exe')).to.equal("pwsh" /* GeneralShellType.PowerShell */);
            });
            it('should ignore case in Unix paths (which is not standard but handles user input errors)', () => {
                setUnixEnvironment();
                (0, chai_1.expect)((0, shell_type_1.guessShellTypeFromExecutable)('/usr/bin/BASH')).to.be.undefined;
            });
        });
    });
});
//# sourceMappingURL=shell-type.spec.js.map