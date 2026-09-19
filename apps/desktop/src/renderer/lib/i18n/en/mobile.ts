/**
 * Phone shell (web) + the desktop "connect your phone" dialog.
 * Mirrors `zh/mobile.ts` — see that file's header for the reuse policy.
 */
export const en = {
  /* ── files screen ── */
  "mobile.files.up": "Up one level",
  "mobile.files.readOnly": "Read-only",

  /* ── file / text viewer ── */
  "mobile.file.back": "Back",
  "mobile.file.cannotPreview": "Cannot preview this file",
  "mobile.viewer.staleSnapshot":
    "This turn has no pre-edit snapshot (older session); showing the file's current contents",
  "mobile.viewer.readFailed": "Cannot read the file (it may have been deleted)",

  /* ── git: status glyphs ──
     One character each, so the badge column stays narrow on a phone. */
  "mobile.git.status.modified": "M",
  "mobile.git.status.added": "A",
  "mobile.git.status.deleted": "D",
  "mobile.git.status.renamed": "R",
  "mobile.git.status.copied": "C",
  "mobile.git.status.unmerged": "U",
  "mobile.git.status.ignored": "I",
  /* Locale-independent glyphs — see the zh file's note. */
  "mobile.git.status.untracked": "?",
  "mobile.git.status.unmodified": "",

  /* ── git: actions & feedback ── */
  "mobile.git.commitMsgRequired": "Enter a commit message",
  "mobile.git.committed": "Committed",
  "mobile.git.pushed": "Pushed to remote",
  "mobile.git.pulled": "Pull complete",
  "mobile.git.pushDone": "Push complete",
  "mobile.git.synced": "Sync complete",
  "mobile.git.conflicts": "The pull left {n} conflicted file(s) — resolve them first",
  "mobile.git.noGenModel":
    "No commit-message model configured — pick one in Settings → Git on the desktop",
  "mobile.git.generate": "Generate commit message with AI",
  "mobile.git.commitPlaceholder": "Commit message…",
  "mobile.git.aheadTitle": "{n} commit(s) ahead of remote",
  "mobile.git.behindTitle": "{n} commit(s) behind remote",
  "mobile.git.pullHint": "Pull remote changes",
  "mobile.git.pushHint": "Push local commits to remote",
  "mobile.git.syncHint": "Pull remote changes, then push local commits",
  "mobile.git.discovering": "Looking for repositories…",
  "mobile.git.noRepos": "No Git repository found under this project",
  "mobile.git.noUnstaged": "No unstaged changes",
  "mobile.git.noStaged": "No staged changes",
  "mobile.git.noDiff": "(no diff)",
  "mobile.git.cancelNewBranch": "Cancel new branch",
  "mobile.git.copyError": "Copy error message",
  "mobile.git.dismissError": "Dismiss error",

  /* ── session drawer ── */
  "mobile.drawer.openList": "Open session list",
  "mobile.drawer.closeList": "Close session list",
  "mobile.drawer.searchThreads": "Search threads",
  "mobile.drawer.noMatch": "No matching threads",
  "mobile.drawer.noProjects":
    "No projects yet. Add one on the desktop and its sessions show up here.",
  "mobile.drawer.moreCount": "({n} more)",
  "mobile.drawer.confirmDelete": "Tap again to confirm delete",
  "mobile.drawer.closeActions": "Close action menu",
  "mobile.drawer.cancelRename": "Cancel rename",
  "mobile.drawer.moreActions": "More actions",
  "mobile.drawer.archivedActions": "Archived item actions",

  /* ── settings sheet ── */
  "mobile.settings.close": "Close settings",
  "mobile.settings.connection": "Connection",
  "mobile.settings.connectedTo": "Connected to {origin}",
  "mobile.settings.unknownServer": "unknown server",
  "mobile.settings.confirmUnpair": "Confirm unpair",
  "mobile.settings.unpair": "Unpair from this computer",

  /* ── pairing screen ── */
  "mobile.pair.deviceAndroid": "Android phone",
  "mobile.pair.deviceBrowser": "Browser device",
  "mobile.pair.codeRequired": "Enter the code shown on the desktop",
  "mobile.pair.title": "Connect to Mcode",
  "mobile.pair.hint":
    "Find the 6-digit code in the desktop's \"Connect phone\" dialog and enter it to get started.",
  "mobile.pair.noPairInfo":
    "This link is missing pairing info. Scan the QR code in the desktop's \"Connect phone\" dialog with your phone camera and open it again.",
  "mobile.pair.deviceName": "Device name (optional)",
  "mobile.pair.deviceNamePlaceholder": "My phone",
  "mobile.pair.pairing": "Pairing…",
  "mobile.pair.submit": "Pair",
  "mobile.pair.expiry": "Code valid for 5 minutes · Server: {origin}",
  "mobile.pair.unknown": "unknown",

  /* ── relay (VPS forwarding) ── */
  "mobile.relay.connected": "Connected",
  "mobile.relay.connecting": "Connecting…",
  "mobile.relay.disconnect": "Disconnect",
  "mobile.relay.deploying": "Deploying…",
  "mobile.relay.copyLink": "Copy link",
  "mobile.relay.intro":
    "Forward through your own server (VPS) so the phone can connect from any network.",
  "mobile.relay.prereqPrefix": "The server needs SSH access and either ",
  "mobile.relay.prereqOr": " or ",
  "mobile.relay.prereqSuffix": " installed.",
  "mobile.relay.host": "Server IP / domain",
  "mobile.relay.hostPlaceholder": "1.2.3.4 or vps.example.com",
  "mobile.relay.port": "SSH port",
  "mobile.relay.passwordPlaceholder": "SSH password",
  "mobile.relay.publicPort": "Public port (the one the phone reaches)",
  "mobile.relay.forwarder": "Forwarder: {type}",
  "mobile.relay.qrAlt": "Remote pairing QR code",
  "mobile.relay.stepsTitle": "Remote pairing steps:",
  "mobile.relay.step1": "Send the link above to your phone",
  "mobile.relay.step2": "Open it in the phone's browser",
  "mobile.relay.step3": "Enter the code above to finish pairing",
} as const;
