/** Optional upstream dependency without bundled declarations in this checkout. */
declare module "bidi-js" {
  export interface Bidi {
    getEmbeddingLevels(text: string, baseDirection?: string): { levels: number[] };
    getReorderedIndices(text: string, embeddingLevels: { levels: number[] }): number[];
    getMirroredCharacter(ch: string): string | undefined;
    getReorderedString(text: string, embeddingLevels: unknown): string;
    getReorderSegments(text: string, embeddingLevels: unknown): Array<[number, number]>;
  }
  export default function bidiFactory(): Bidi;
}
