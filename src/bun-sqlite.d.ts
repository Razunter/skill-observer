declare module "bun:sqlite" {
  type Binding = number | string | null;

  interface Statement<Row, Params extends Binding[]> {
    get(...params: Params): Row | null;
    all(...params: Params): Row[];
    run(...params: Params): { changes: number; lastInsertRowid: number | bigint };
  }

  interface Transaction<T> {
    (): T;
    deferred(): T;
  }

  export class Database {
    constructor(file: string, options?: { readonly?: boolean; create?: boolean });
    readonly inTransaction: boolean;
    query<Row = unknown, Params extends Binding[] = Binding[]>(sql: string): Statement<Row, Params>;
    run(sql: string): void;
    transaction<T>(call: () => T): Transaction<T>;
    close(throwOnError?: boolean): void;
  }
}
