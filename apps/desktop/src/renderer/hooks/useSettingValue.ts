/**
 * 【MC-047】设置行的**读-改-存**生命周期 —— 一份实现,设置面板各处复用。
 *
 * ## 它补的是哪条洞
 *
 * 终端 Shell、浏览器截图目录、浏览器数据目录、登录开关……这些"一格设置 + 保存钮"
 * 的行从前各自手写 `useEffect(() => { void (async () => { const {value} = await
 * api.setting.get(...); setX(value); setLoaded(true); })(); }, [])` —— **没有 catch**。
 * 读取一次失败(IPC 暂不可用、主进程拒绝),`setLoaded(true)` 永远不执行,控件
 * `disabled={!loaded}` **永远灰**,而且屏幕上没有任何解释、没有重试入口,
 * 用户分不清"在加载"与"坏了"(硬规矩 3:坏东西显式报出来)。
 *
 * 这里把三态收成一份:loading(在读)/ ready(有值)/ error(读失败,显示原因+重试)。
 * 保存失败同样落在同一个 `error` 上(各行的 ErrorNote 已有出口);保存成功清掉。
 *
 * ## 语义要点
 *
 * - **陈旧请求不覆盖新状态**:用序号丢弃过期响应(与 `useRpc` 同一套);
 * - **读失败 ≠ 空值**:`value` 保持 `undefined`(未知),绝不把"读不出来"当"没设置"
 *   (否则一次失败 + 用户一保存 = 用空值覆盖真实设置);
 * - **未就绪不可写**:`ready=false` 时 `save` 直接拒绝(返回 false),控件据此禁用;
 * - `retry()` 重读 —— 失败横幅上的「重试」按钮接它。
 *
 * 写操作(mutation)**仍然显式调用** —— 本 hook 只把"读 + 状态机"收口,不自动保存
 * (CLAUDE.md 硬规矩 7:写操作留在事件处理器里,别藏进 hook 的 effect 重跑)。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@renderer/lib/api.js";

export interface SettingValueState {
  /** 当前值。`undefined` = 还没读到(加载中或读失败) —— **不是空串**。 */
  value: string | undefined;
  /** 加载中(首次或重试)。 */
  loading: boolean;
  /** 读或存最近一次失败的原因;成功后清 null。 */
  error: string | null;
  /** 读到值了(控件可以启用)。读失败后保持 false,直到 retry 成功。 */
  ready: boolean;
  saving: boolean;
  saved: boolean;
  /** 本地编辑(标记为未保存);会清掉"已保存"提示。 */
  setValue: (next: string) => void;
  /** 保存当前值(或显式传入的值)。未就绪时拒绝并返回 false。 */
  save: (next?: string) => Promise<boolean>;
  /** 读失败后的重试(重新拉取;成功则恢复 ready)。 */
  retry: () => void;
}

/**
 * @param key 设置键(见 contracts;一行一个)
 */
export function useSettingValue(key: string): SettingValueState {
  const [value, setValueState] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  // 序号:过期响应不得覆盖新状态(retry 连点、键变化时同理)。
  const request = useRef(0);
  // 已编辑但未保存的本地值覆盖(重试成功时**不**覆盖用户正在输入的草稿)。
  const dirty = useRef(false);

  const load = useCallback(() => {
    const own = ++request.current;
    setLoading(true);
    // 重试时不清 error —— 成功前横幅留着,失败时换新原因。
    void (async () => {
      try {
        const res = await api.setting.get({ key });
        if (own !== request.current) return;
        if (!dirty.current) setValueState(res.value ?? "");
        setError(null);
      } catch (err) {
        if (own !== request.current) return;
        // 读失败:value 保持 undefined(=未知),ready 不置位 —— 绝不假装空值。
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (own === request.current) setLoading(false);
      }
    })();
  }, [key]);

  useEffect(() => {
    dirty.current = false;
    setValueState(undefined);
    setSaved(false);
    load();
  }, [key, load]);

  const setValue = useCallback((next: string) => {
    dirty.current = true;
    setValueState(next);
    setSaved(false);
  }, []);

  const save = useCallback(
    async (next?: string) => {
      // 未就绪不可写 —— 值还没读出来,写下去等于用未知覆盖真实设置。
      if (saving) return false;
      if (next === undefined && value === undefined) return false;
      const payload = (next ?? value ?? "").trim();
      setSaving(true);
      setError(null);
      try {
        await api.setting.set({ key, value: payload });
        dirty.current = false;
        setValueState(payload);
        setSaved(true);
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return false;
      } finally {
        setSaving(false);
      }
    },
    [key, saving, value],
  );

  return {
    value,
    loading,
    error,
    ready: value !== undefined,
    saving,
    saved,
    setValue,
    save,
    retry: load,
  };
}
