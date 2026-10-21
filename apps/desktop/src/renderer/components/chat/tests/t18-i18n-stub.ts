export const useI18n = () => ({
  t: (key: string, params?: { n?: number }) => params?.n === undefined ? key : `${key} ${params.n}`,
});
