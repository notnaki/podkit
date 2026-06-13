export function enableRls(table: string): string {
  return `ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY;`;
}

export function ownedBy(table: string, column: string): string {
  return `CREATE POLICY "${table}_owned_by" ON "${table}" USING ("${column}" = current_setting('podkit.user_id')::uuid);`;
}

export function inOrg(table: string, column: string): string {
  return `CREATE POLICY "${table}_in_org" ON "${table}" USING ("${column}" = current_setting('podkit.org_id')::uuid);`;
}

export function isAgent(table: string): string {
  return `CREATE POLICY "${table}_is_agent" ON "${table}" USING (current_setting('podkit.is_agent')::boolean = true);`;
}

export function customPolicy(table: string, name: string, using: string): string {
  return `CREATE POLICY "${name}" ON "${table}" USING (${using});`;
}
