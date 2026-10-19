declare module 'node:sqlite' {
  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): { all(...args: unknown[]): Record<string, unknown>[]; get(...args: unknown[]): Record<string, unknown> | undefined; run(...args: unknown[]): unknown };
    close(): void;
  }
}
