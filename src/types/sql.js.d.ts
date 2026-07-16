declare module "sql.js" {
  export interface QueryExecResult {
    columns: string[];
    values: (string | number | null | Uint8Array)[][];
  }

  export interface Database {
    run(sql: string, params?: (string | number | null)[]): void;
    exec(sql: string, params?: (string | number | null)[]): QueryExecResult[];
    export(): Uint8Array;
    close(): void;
  }

  export interface SqlJsStatic {
    Database: {
      new (): Database;
      new (data: ArrayLike<number> | Buffer | null): Database;
    };
  }

  export default function initSqlJs(config?: Record<string, unknown>): Promise<SqlJsStatic>;
}
