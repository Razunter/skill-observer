declare module "bun" {
  export const YAML: { parse(text: string): unknown };
}
