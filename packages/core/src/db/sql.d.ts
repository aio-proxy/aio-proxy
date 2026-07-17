declare module "*.sql" {
  const sql: string;
  export default sql;
}

declare module "*.sql?raw" {
  const sql: string;
  export default sql;
}
