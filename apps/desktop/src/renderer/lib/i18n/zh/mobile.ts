/**
 * Phone shell (web) + the desktop "connect your phone" dialog.
 * Keys: `mobile.*`. zh is the source of truth for `MessageId`.
 *
 * The mobile tree (`components/mobile/`, `AppMobile.tsx`) was written with
 * inline Chinese and shipped that way — switching to English left the whole
 * shell (files, git, drawer, settings, pairing, relay) in Chinese. Strings
 * that already have a home elsewhere are REUSED (`common.*`, `layout.*`,
 * `ide.git.*`, `ide.files.*`, `ide.search.*`, `browser.*`,
 * `settings.appearance.*`) rather than duplicated here; only wording that is
 * genuinely the phone shell's own lives in this file.
 *
 * `RemoteConnectPanel` is included even though it is desktop-mounted (inside
 * `layout/MobileConnectDialog.tsx`) — it is the same hardcoded-Chinese
 * problem, and the panel only ever appears in that one dialog.
 */
export const zh = {
  /* ── files screen ── */
  "mobile.files.up": "上一级",
  "mobile.files.readOnly": "只读浏览",

  /* ── file / text viewer ── */
  "mobile.file.back": "返回",
  "mobile.file.cannotPreview": "无法预览此文件",
  "mobile.viewer.staleSnapshot":
    "该轮次缺少修改前快照（旧版本会话），以下为文件当前内容",
  "mobile.viewer.readFailed": "无法读取文件（可能已被删除）",

  /* ── git: status glyphs ──
     Single-character badges in the file list. Kept as one character each so
     the row stays narrow on a phone; the column header carries the meaning. */
  "mobile.git.status.modified": "改",
  "mobile.git.status.added": "增",
  "mobile.git.status.deleted": "删",
  "mobile.git.status.renamed": "重",
  "mobile.git.status.copied": "复",
  "mobile.git.status.unmerged": "冲",
  "mobile.git.status.ignored": "略",
  /* Not words — locale-independent glyphs. They live here anyway so the badge
     table stays a plain `Record<GitStatusCode, MessageId>` with no special
     cases at the render site (the repo's other status tables do the same). */
  "mobile.git.status.untracked": "?",
  "mobile.git.status.unmodified": "",

  /* ── git: actions & feedback ── */
  "mobile.git.commitMsgRequired": "请输入提交信息",
  "mobile.git.committed": "已提交",
  "mobile.git.pushed": "已推送至远端",
  "mobile.git.pulled": "拉取完成",
  "mobile.git.pushDone": "推送完成",
  "mobile.git.synced": "同步完成",
  "mobile.git.conflicts": "拉取后产生 {n} 个冲突文件，请先解决冲突",
  "mobile.git.noGenModel": "未配置提交信息生成模型，请在桌面端 设置 → Git 中选择",
  "mobile.git.generate": "AI 生成提交信息",
  "mobile.git.commitPlaceholder": "提交信息…",
  "mobile.git.aheadTitle": "领先远端 {n} 个提交",
  "mobile.git.behindTitle": "落后远端 {n} 个提交",
  "mobile.git.pullHint": "拉取远端更新",
  "mobile.git.pushHint": "推送本地提交到远端",
  "mobile.git.syncHint": "拉取远端更新后推送本地提交",
  "mobile.git.discovering": "正在发现仓库…",
  "mobile.git.noRepos": "此项目下未发现 Git 仓库",
  "mobile.git.noUnstaged": "没有未暂存的更改",
  "mobile.git.noStaged": "没有已暂存的更改",
  "mobile.git.noDiff": "(无差异)",
  "mobile.git.cancelNewBranch": "取消新建分支",
  "mobile.git.copyError": "复制错误信息",
  "mobile.git.dismissError": "关闭错误提示",

  /* ── session drawer ── */
  "mobile.drawer.openList": "打开会话列表",
  "mobile.drawer.closeList": "关闭会话列表",
  "mobile.drawer.searchThreads": "搜索线程",
  "mobile.drawer.noMatch": "没有匹配的线程",
  "mobile.drawer.noProjects": "暂无项目。项目在电脑端添加后，这里会显示它的会话。",
  "mobile.drawer.moreCount": "（还有 {n} 条）",
  "mobile.drawer.confirmDelete": "再次点击确认删除",
  "mobile.drawer.closeActions": "关闭操作菜单",
  "mobile.drawer.cancelRename": "取消重命名",
  "mobile.drawer.moreActions": "更多操作",
  "mobile.drawer.archivedActions": "归档项操作",

  /* ── settings sheet ── */
  "mobile.settings.close": "关闭设置",
  "mobile.settings.connection": "连接",
  "mobile.settings.connectedTo": "已连接至 {origin}",
  "mobile.settings.unknownServer": "未知服务器",
  "mobile.settings.confirmUnpair": "确认解除配对",
  "mobile.settings.unpair": "解除与这台电脑的配对",

  /* ── pairing screen ── */
  "mobile.pair.deviceAndroid": "Android 手机",
  "mobile.pair.deviceBrowser": "浏览器设备",
  "mobile.pair.codeRequired": "请输入电脑端显示的验证码",
  "mobile.pair.title": "连接 Mcode",
  "mobile.pair.hint": "在电脑端「连接手机」弹窗中查看 6 位验证码,输入后即可开始使用。",
  "mobile.pair.noPairInfo":
    "此链接缺少配对信息。请用手机相机扫描电脑端「连接手机」弹窗中的二维码后重新打开。",
  "mobile.pair.deviceName": "设备名称(可选)",
  "mobile.pair.deviceNamePlaceholder": "我的手机",
  "mobile.pair.pairing": "配对中…",
  "mobile.pair.submit": "完成配对",
  "mobile.pair.expiry": "配对码有效期 5 分钟 · 服务器:{origin}",
  "mobile.pair.unknown": "未知",
  "mobile.pair.loginHint": "输入在电脑端「连接手机」里设置的账号和密码。",
  "mobile.pair.noLoginHint":
    "想直接用账号密码登录:在电脑端「连接手机」弹窗里设置账号密码后,刷新本页。",
  "mobile.pair.username": "账号",
  "mobile.pair.password": "密码",
  "mobile.pair.showPassword": "显示密码",
  "mobile.pair.hidePassword": "隐藏密码",
  "mobile.pair.login": "登录",
  "mobile.pair.loggingIn": "登录中…",
  "mobile.pair.loginRequired": "请输入账号和密码",
  "mobile.pair.useCode": "验证码配对",
  "mobile.pair.usePassword": "账号密码",

  /* ── relay (VPS forwarding) ── */
  "mobile.relay.connected": "已连接",
  "mobile.relay.connecting": "连接中…",
  "mobile.relay.disconnect": "断开",
  "mobile.relay.deploying": "部署中…",
  "mobile.relay.copyLink": "复制链接",
  "mobile.relay.intro": "通过你自己的服务器（VPS）转发，手机可在任意网络访问。",
  "mobile.relay.prereqPrefix": "服务器需有 SSH 访问权限，且安装了 ",
  "mobile.relay.prereqOr": " 或 ",
  "mobile.relay.prereqSuffix": "。",
  "mobile.relay.host": "服务器 IP / 域名",
  "mobile.relay.hostPlaceholder": "1.2.3.4 或 vps.example.com",
  "mobile.relay.port": "SSH 端口",
  "mobile.relay.hostKeyFingerprint": "SSH 主机密钥指纹（SHA256，必填）",
  "mobile.relay.hostKeyHint": "请从 VPS 控制台等可信渠道独立核对指纹；不要直接信任本次网络连接给出的值。旧配置须重新填写。",
  "mobile.relay.passwordPlaceholder": "SSH 登录密码",
  "mobile.relay.publicPort": "公网端口（手机访问的端口）",
  "mobile.relay.forwarder": "转发服务：{type}",
  "mobile.relay.qrAlt": "远程配对二维码",
  "mobile.relay.stepsTitle": "远程配对步骤：",
  "mobile.relay.step1": "将上面的链接发送到手机",
  "mobile.relay.step2": "在手机浏览器中打开",
  "mobile.relay.step3": "输入上面的验证码完成配对",
  /* 生成远程配对码失败 / 「启动时自动开启」写库失败 —— 两处都是静默 catch,
     失败时用户看不到任何东西(码永远"生成中…"、开关拨过去却没落库)。 */
  "mobile.relay.pairingFailed": "生成配对码失败",
  "mobile.relay.autoStartFailed": "保存「启动时自动开启」失败",
} as const;
