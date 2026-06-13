export type Role = "viewer" | "member" | "admin" | "owner";

const ROLE_RANK: Record<Role, number> = {
  viewer: 0,
  member: 1,
  admin: 2,
  owner: 3,
};

export function roleAtLeast(role: Role, min: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

export interface Membership {
  userId: string;
  orgId: string;
  role: Role;
}

export function can(
  membership: Membership,
  action: "read" | "write" | "manage"
): boolean {
  switch (action) {
    case "read":
      return true;
    case "write":
      return roleAtLeast(membership.role, "member");
    case "manage":
      return roleAtLeast(membership.role, "admin");
  }
}
