interface LazyJourney {
  readonly name: string;
  readonly launch: unknown;
  readonly steps: unknown[];
  readonly expect: "pass" | "fail";
  readonly failBecause?: (evidence: Array<{ status: string; step: string }>) => boolean;
}

const loaders: Record<string, () => { default: unknown }> = {
  "mcode-conversation-required-deploy": () =>
    require("./electron-required-session.js") as { default: unknown },
};

export const journeyNames = Object.keys(loaders);
export const journeys: LazyJourney[] = journeyNames.map((name) => {
  let materialized: LazyJourney | null = null;
  const materialize = (): LazyJourney => {
    if (materialized === null) {
      const mod = loaders[name]!();
      const exported = (mod as { [k: string]: unknown }).default ?? Object.values(mod)[0];
      if (!exported || typeof exported !== "object") throw new Error("W18 U1: " + name + " 没有导出旅程对象");
      materialized = exported as LazyJourney;
      if (materialized.name !== name) throw new Error("W18 U1: 注册表旅程名不一致：" + materialized.name);
    }
    return materialized;
  };
  return {
    get name() { return name; },
    get launch() { return materialize().launch; },
    get steps() { return materialize().steps; },
    get expect() { return materialize().expect; },
    get failBecause() { return materialize().failBecause; },
  } as LazyJourney;
});
