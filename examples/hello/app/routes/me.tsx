export function loader({ auth }: { auth?: { userId: string; isAgent: boolean } | null }) {
  return { userId: auth?.userId ?? null };
}
export default function Me({ data }: { data: { userId: string | null } }) {
  return <main>{`me: ${String(data.userId)}`}</main>;
}
