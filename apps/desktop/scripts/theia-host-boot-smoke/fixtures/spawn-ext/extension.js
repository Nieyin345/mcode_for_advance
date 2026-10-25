// Positive control for the permission report: this file really does require
// `child_process`. It also gives the boot suite a command with a real return
// value, so the end-to-end assertion can check a value crossing the pipe
// (not just "no throw").
"use strict";
const vscode = require("vscode");
const cp = require("child_process");

function targetLanguageLocation() {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return undefined;
  return new vscode.Location(
    vscode.Uri.joinPath(folder.uri, "f035-language-target.txt"),
    new vscode.Range(0, 1, 0, 5)
  );
}

function activate(context) {
  const seen={created:0,changed:0,deleted:0};
  const nativeWatcher=vscode.workspace.createFileSystemWatcher("**/*.txt");
  context.subscriptions.push(nativeWatcher);
  context.subscriptions.push(
    nativeWatcher.onDidCreate(()=>seen.created++),
    nativeWatcher.onDidChange(()=>seen.changed++),
    nativeWatcher.onDidDelete(()=>seen.deleted++),
    vscode.commands.registerCommand("mcodeSmoke.watchEvents",()=>({...seen})),
    vscode.commands.registerCommand("mcodeSmoke.setDiagnostics",()=>{
      const folder=vscode.workspace.workspaceFolders?.[0];
      if(!folder)return false;
      const diagnostics=vscode.languages.createDiagnosticCollection("mcode-smoke");
      context.subscriptions.push(diagnostics);
      const uri=vscode.Uri.joinPath(folder.uri,"f032-roundtrip.txt");
      diagnostics.set(uri,[new vscode.Diagnostic(
        new vscode.Range(0,0,0,6),"Mcode extension diagnostic",vscode.DiagnosticSeverity.Warning
      )]);
      return true;
    }),
  );
  const status=vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left,5);
  status.text="Mcode F032";
  status.name="Mcode extension test status";
  status.command="mcodeSmoke.spawnEcho";
  status.show();
  context.subscriptions.push(status);
  context.subscriptions.push(
    vscode.languages.registerHoverProvider({language:"plaintext"},{
      provideHover:()=>new vscode.Hover("Mcode native hover provider")
    }),
    vscode.languages.registerCompletionItemProvider({language:"plaintext"},{
      provideCompletionItems:()=>[new vscode.CompletionItem("mcodeNativeCompletion",vscode.CompletionItemKind.Text)]
    }),
    vscode.languages.registerDefinitionProvider({language:"plaintext"},{
      provideDefinition:()=>{
        const location=targetLanguageLocation();
        return location?[location,new vscode.Location(
          vscode.Uri.parse("https://example.invalid/untrusted.ts"),
          new vscode.Range(0,0,0,1)
        )]:[];
      }
    }),
    vscode.languages.registerReferenceProvider({language:"plaintext"},{
      provideReferences:(_document,_position,context)=>context.includeDeclaration?[targetLanguageLocation()]:[]
    }),
    vscode.languages.registerImplementationProvider({language:"plaintext"},{
      provideImplementation:()=>targetLanguageLocation()
    }),
    vscode.languages.registerTypeDefinitionProvider({language:"plaintext"},{
      provideTypeDefinition:()=>targetLanguageLocation()
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("mcodeSmoke.spawnEcho", async () => {
      return {
        // proving the host gives extensions a real Node runtime: `execSync` runs
        // and its stdout comes back
        echo: cp.execSync("node -e \"process.stdout.write('pong')\"", { encoding: "utf8" }),
        greeting: vscode.workspace.getConfiguration("mcodeSmoke").get("greeting"),
        appName: vscode.env.appName,
        // the command id the extension was asked to run
        active: vscode.window.activeTextEditor
          ? vscode.window.activeTextEditor.document.getText()
          : null,
      };
    }),
    // declared in package.json but NOT registered here on purpose:
    // the boot suite uses it to prove "declared" != "registered".
    vscode.commands.registerCommand("mcodeSmoke.undeclared", () => "undeclared-fn"),
    vscode.commands.registerCommand("mcodeSmoke.editActive", async (replacement) => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return false;
      return editor.edit(builder => builder.replace(new vscode.Range(0, 0, 0, 6), replacement));
    }),
    vscode.commands.registerCommand("mcodeSmoke.stateWrite", async () => {
      const globalBefore=context.globalState.get("number",0);
      const workspaceBefore=context.workspaceState.get("number",0);
      await context.globalState.update("number",globalBefore+1);
      await context.workspaceState.update("number",workspaceBefore+1);
      return {globalBefore,workspaceBefore,globalAfter:context.globalState.get("number"),
        workspaceAfter:context.workspaceState.get("number")};
    }),
    vscode.commands.registerCommand("mcodeSmoke.webview", async () => {
      const panel=vscode.window.createWebviewPanel("mcode-smoke.panel","Mcode inline Webview",vscode.ViewColumn.One,{
        enableScripts:true
      });
      panel.webview.html="<h1>Mcode isolated Webview</h1><script>document.body.dataset.loaded='yes'</script>";
      panel.webview.onDidReceiveMessage(msg=>{context.globalState.update("webviewReply",msg);});
      const delivered=await panel.webview.postMessage({kind:"from-extension"});
      return {delivered};
    }),
    vscode.commands.registerCommand("mcodeSmoke.webviewReply",async () => context.globalState.get("webviewReply",null)),
    vscode.commands.registerCommand("mcodeSmoke.nativeTerminal", async () => {
      const terminal=vscode.window.createTerminal({name:"Mcode native test"});
      terminal.sendText("echo Mcode terminal",true);
      const pid=await terminal.processId;
      terminal.dispose();
      return {state:"terminal-requested",pid};
    }),
    vscode.commands.registerCommand("mcodeSmoke.stateRead", async () => ({
      global:context.globalState.get("number",0),workspace:context.workspaceState.get("number",0)
    })),
    vscode.commands.registerCommand("mcodeSmoke.configRoundtrip", async () => {
      const config=vscode.workspace.getConfiguration("mcodeSmoke");
      const before=config.get("greeting");
      await config.update("greeting","mcode-persisted");
      return {before,after:vscode.workspace.getConfiguration("mcodeSmoke").get("greeting")};
    }),
    vscode.commands.registerCommand("mcodeSmoke.workspaceFs", async () => {
      const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
      if (!folder) return { noWorkspace: true };
      const target = vscode.Uri.joinPath(folder.uri, "f032-roundtrip.txt");
      await vscode.workspace.fs.writeFile(target, Buffer.from("native-workspace"));
      const data = await vscode.workspace.fs.readFile(target);
      const st = await vscode.workspace.fs.stat(target);
      const names = (await vscode.workspace.fs.readDirectory(folder.uri)).map(x => x[0]);
      const found=await vscode.workspace.findFiles("**/*.txt");
      return {root:folder.uri.fsPath,content:Buffer.from(data).toString("utf8"),
        size:st.size,names:names.includes("f032-roundtrip.txt"),
        search:found.some(uri=>uri.fsPath.endsWith("f032-roundtrip.txt"))};
    }),
    vscode.commands.registerCommand("mcodeSmoke.fsEscape", async () => {
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder) return "no-workspace";
      try {
        await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder.uri, "..", "outside.txt"));
        return "BAD_ESCAPE";
      }catch {return "blocked";}
    }),
    vscode.commands.registerCommand("mcodeSmoke.quickPick", async () => {
      const picked=await vscode.window.showQuickPick([
        {label:"Alpha",description:"First option"},{label:"Beta",description:"Second option"}
      ],{title:"Choose a workspace action"});
      return picked?.label ?? null;
    }),
    vscode.commands.registerCommand("mcodeSmoke.inputBox", async () => {
      return vscode.window.showInputBox({prompt:"Enter a name",placeHolder:"Your name"});
    }),
    vscode.commands.registerCommand("mcodeSmoke.askChoice", async () => {
      return vscode.window.showInformationMessage("Apply this extension action?", { modal: true, detail: "Mcode native prompt" }, "Apply", "Ignore");
    }),
    vscode.commands.registerCommand("mcodeSmoke.notifyWarning", async () => {
      return vscode.window.showWarningMessage("Mcode extension warning");
    }),
    vscode.commands.registerCommand("mcodeSmoke.overlapEdit", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return false;
      return editor.edit(builder => {
        builder.replace(new vscode.Range(0, 0, 0, 5), "first");
        builder.replace(new vscode.Range(0, 2, 0, 6), "second");
      });
    }),
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
