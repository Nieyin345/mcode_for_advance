/**
 * `@main/relay/forwarder.py?raw` 的替身。
 *
 * 真那个是 Vite 的构建期 `?raw` 内联(`RelayManager.ts` import 它),纯 node 解析不了。
 * run.sh 那边用 `--loader:.py=text` 处理这个后缀,所以这一份**只在脚本自己也想要
 * 一段哨兵文本时**才用得上 —— 本套不用它,留在这里是为了让"谁动了这个 import"一眼
 * 看得见。
 *
 * ⚠️ 不要以为换了桩就验不到真实内容:本套反过来钉住**真文件确实被读进来了**
 * (见 main.ts 的 `真 forwarder.py 字符串被内联进来了` 那条,它比对的是磁盘上的
 * `forwarder.py` 与中继 SFTP 上传的字节)。
 */
export default "PROBE_FORWARDER_PY";
