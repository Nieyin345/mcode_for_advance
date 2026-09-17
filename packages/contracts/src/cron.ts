/**
 * 定时表达式 —— 自动化的「到点了就跑」用的那一小门语言。
 *
 * ## 为什么自己写,不引一个 cron 库
 *
 * 要的东西只有两件:**这个表达式能不能解析**(界面上存盘前拦一道)、**这一刻命中不命中**
 * (主进程每分钟问一次)。而"跑"这件事本来就不归它管 —— 桌面应用没开就是没开,没有
 * 守护进程去补跑(见下面「错过的时间点不会补跑」)。为两件纯计算引一个依赖,代价是
 * 供应链上多一个包、以及一份我们控制不了的语义(那些库多半还带时区/夏令时/秒级字段
 * 的一堆选项,而这里一个都用不上)。
 *
 * 放 contracts 而不是主进程,是因为**两端都要读它**:主进程判"这一刻要不要起",
 * 检查器判"这个表达式能不能存"。各写一份的话,迟早出现"界面上收下了、跑起来永远不响"。
 *
 * ## 5 段,分钟级
 *
 * ```
 * ┌ 分钟 0-59
 * │ ┌ 小时 0-23
 * │ │ ┌ 日 1-31
 * │ │ │ ┌ 月 1-12
 * │ │ │ │ ┌ 星期 0-6(0 = 周日;7 也收,当周日)
 * * * * * *
 * ```
 *
 * 只有 5 段(没有秒)。这一条是**故意的**:桌面应用最小有意义的分辨率就是一分钟,而
 * 秒级字段会让人把 `* * * * * *` 当成"每分钟",实际是每秒 —— 那种错不报错,只是账单上
 * 多出来几十倍次数的运行。
 *
 * 每一段支持:`*`、`a`、`a-b`、`a,b,c`,以及**步长**(在一个 `*` 或区间后面接 `/n`,
 * 例如"每 5 分钟"是 `* / 5` 去掉空格之后的写法)。
 *
 * ## 日与星期的"或"规则
 *
 * 两个字段都**不是** `*` 时,按标准 cron 的语义是**或**:`0 9 1 * 1` = "每月 1 号**或**
 * 每周一"的 9 点。只写一个(另一个是 `*`)时就是单纯的与。这条规则反直觉,但它是几十年
 * 里所有人写 `0 0 1 * 1` 时期待的东西;自己改成"与"会让一份从别处抄来的表达式换一个意思。
 *
 * ## 错过的时间点不会补跑
 *
 * 应用关着的时候没有进程在数时间,所以 08:00 那条在 08:30 打开应用时**不会**补跑。这是
 * 桌面应用的诚实语义(与手机上的本地通知一致),也是一条**必须在参数说明里写出来**的
 * 事:偷偷补跑会让"我早上不在电脑前"变成"下午被一串补跑淹没"。
 */

/* ── 形状 ─ */

/** 一段的取值范围与"是不是随便"。 */
export interface CronField {
  /** 命中的值(升序、去重)。 */
  values: number[];
  /** 这一段是不是从 `*` 起的(纯 `*` 与带步长的都算)—— 判"日/星期谁参与或运算"要看它。 */
  any: boolean;
}

export interface CronSpec {
  /** 原样的表达式。回显、日志里说"是哪一条"都用它。 */
  text: string;
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
}

export type CronParse = { ok: true; spec: CronSpec } | { ok: false; error: string };

/** 五段的取值范围与中文名,顺序与写法一致。`min`/`max` 都是闭区间。 */
const FIELDS: ReadonlyArray<{ name: string; min: number; max: number }> = [
  { name: "分钟", min: 0, max: 59 },
  { name: "小时", min: 0, max: 23 },
  { name: "日", min: 1, max: 31 },
  { name: "月", min: 1, max: 12 },
  { name: "星期", min: 0, max: 7 },
];

/* ─ 解析 ── */

/**
 * 解析一个 5 段表达式。
 *
 * **报错要能照着改**:说清是哪一段(用中文名,不写"第 2 个字段")、错在哪、允许的范围是
 * 什么。表达式是**手打**进去的,而"这个表达式不合法"是一句没用的话 —— 用户下一步就是
 * 要找一个数字为什么不对。
 */
export function parseCron(text: string): CronParse {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: "定时的表达式是空的 —— 例如 `0 9 * * 1-5` 表示工作日九点" };
  }
  const parts = trimmed.split(/\s+/);
  if (parts.length !== 5) {
    return {
      ok: false,
      error: `定时的表达式要 5 段(分钟 小时 日 月 星期),这里给了 ${parts.length} 段 —— 例如 \`0 9 * * 1-5\``,
    };
  }

  const fields: CronField[] = [];
  for (let i = 0; i < 5; i += 1) {
    const field = FIELDS[i] as { name: string; min: number; max: number };
    const one = parseField(parts[i] as string, field);
    if (!one.ok) return one;
    // `7` 和 `0` 都是周日(见文件头)。在这一处收口,后面 `cronMatches` 就只看 0-6。
    fields.push(i === 4 ? { ...one.field, values: [...new Set(one.field.values.map((v) => (v === 7 ? 0 : v)))].sort((a, b) => a - b) } : one.field);
  }

  return {
    ok: true,
    spec: {
      text: trimmed,
      minute: fields[0] as CronField,
      hour: fields[1] as CronField,
      dayOfMonth: fields[2] as CronField,
      month: fields[3] as CronField,
      dayOfWeek: fields[4] as CronField,
    },
  };
}

type FieldParse = { ok: true; field: CronField } | { ok: false; error: string };
type NumberParse = { ok: true; value: number } | { ok: false; error: string };

/** 一段的解析。`any` 是为**日/星期那两个字段的或运算**准备的(见文件头)。 */
function parseField(raw: string, field: { name: string; min: number; max: number }): FieldParse {
  const where = `${field.name}那一段「${raw}」`;
  const values = new Set<number>();
  let any = false;

  for (const part of raw.split(",")) {
    const token = part.trim();
    if (token.length === 0) {
      return { ok: false, error: `${where}里有一个空的项(多半是多打了一个逗号)` };
    }

    // 步长:`*/n` / `a-b/n` / `a/n`。只能是正整数 —— `*/0` 是除零,负数没有意义。
    let body = token;
    let step = 1;
    const slash = token.indexOf("/");
    if (slash >= 0) {
      body = token.slice(0, slash).trim();
      const stepText = token.slice(slash + 1).trim();
      if (!/^\d+$/.test(stepText) || Number(stepText) < 1) {
        return { ok: false, error: `${where}的步长「${stepText}」要是一个正整数(例如 \`*/5\`)` };
      }
      step = Number(stepText);
    }

    let from: number;
    let to: number;
    if (body === "*") {
      from = field.min;
      to = field.max;
      if (step === 1) any = true;
    } else {
      const dash = body.indexOf("-");
      if (dash >= 0) {
        const low = parseNumber(body.slice(0, dash).trim(), field, where, raw);
        if (!low.ok) return low;
        const high = parseNumber(body.slice(dash + 1).trim(), field, where, raw);
        if (!high.ok) return high;
        from = low.value;
        to = high.value;
      } else {
        const one = parseNumber(body, field, where, raw);
        if (!one.ok) return one;
        // 没有 `-` 也没有步长 = 就是这一个值;带了步长(`a/n`)按 cron 的习惯是
        // "从 a 到这一段的最大值,每 n 个"(`0/15` = 0,15,30,45)。
        from = one.value;
        to = step === 1 ? one.value : field.max;
      }
      if (from > to) {
        return { ok: false, error: `${where}的区间是倒着的(起点 ${from} 比终点 ${to} 大)` };
      }
    }

    for (let v = from; v <= to; v += step) values.add(v);
  }

  if (values.size === 0) return { ok: false, error: `${where}一个值都没有命中` };
  return { ok: true, field: { values: [...values].sort((a, b) => a - b), any } };
}

/** 一个数字,连同范围检查。范围消息里带上允许区间 —— 用户下一步就是要照着改。 */
function parseNumber(
  text: string,
  field: { name: string; min: number; max: number },
  where: string,
  whole: string,
): NumberParse {
  if (!/^\d+$/.test(text)) {
    return { ok: false, error: `${where}里的「${text}」不是数字(整条是 \`${whole}\`)` };
  }
  const value = Number(text);
  if (value < field.min || value > field.max) {
    return {
      ok: false,
      error: `${where}取 ${value},超出范围(${field.name}只能是 ${field.min}-${field.max === 7 ? 6 : field.max})`,
    };
  }
  return { ok: true, value };
}

/* ── 匹配 ── */

/**
 * 这一刻是否命中。
 *
 * 用**本地时间**(`Date` 的 `getMinutes()` 那一套)—— 用户写 `0 9 * * *` 想的是他自己表上
 * 的九点,而不是 UTC 的九点。所以喂进来的 `date` 用 `new Date()` 就够了;测试里造时刻要用
 * **本地**构造形式(`new Date(2026, 8, 16, 9, 0)`),用 `Date.parse("…Z")` 会在非零时区上
 * 差几小时 —— 而"有时候不响"是最难查的一类。
 */
export function cronMatches(spec: CronSpec, date: Date): boolean {
  if (!spec.minute.values.includes(date.getMinutes())) return false;
  if (!spec.hour.values.includes(date.getHours())) return false;
  if (!spec.month.values.includes(date.getMonth() + 1)) return false;

  const domMatch = spec.dayOfMonth.any ? true : spec.dayOfMonth.values.includes(date.getDate());
  // 解析时已经把 7 收成了 0,所以这里只看 `getDay()` 的 0-6。
  const dowMatch = spec.dayOfWeek.any ? true : spec.dayOfWeek.values.includes(date.getDay());

  // 两个字段都限定了 = 或;只有一个限定了 = 与(见文件头那一段)。
  return spec.dayOfMonth.any || spec.dayOfWeek.any ? domMatch && dowMatch : domMatch || dowMatch;
}

/** 人话版的说明,给界面上的提示用。 */
export function describeCron(spec: CronSpec): string {
  const hours = spec.hour.any ? "每小时" : `${spec.hour.values.join("、")} 点`;
  const minutes = spec.minute.any
    ? "每分钟"
    : spec.minute.values.length === 1
      ? `第 ${spec.minute.values[0]} 分`
      : `${spec.minute.values.join("、")} 分`;
  return `${hours}的${minutes}`;
}