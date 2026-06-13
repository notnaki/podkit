export interface SessionIdentity {
  userId: string;
  orgId?: string;
  isAgent: boolean;
}

export async function applySessionGuc(
  client: { raw(sql: string, params?: unknown[]): Promise<unknown[]> },
  identity: SessionIdentity
): Promise<void> {
  await client.raw("SELECT set_config('podkit.user_id', $1, false)", [identity.userId]);
  await client.raw("SELECT set_config('podkit.org_id', $1, false)", [identity.orgId ?? ""]);
  await client.raw("SELECT set_config('podkit.is_agent', $1, false)", [String(identity.isAgent)]);
}
