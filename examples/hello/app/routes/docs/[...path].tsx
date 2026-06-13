export function loader({ params }: { params: Record<string, string> }) {
  return { path: params.path };
}
export default function Docs({ data }: { data: { path: string } }) {
  return <main>{`docs: ${data.path}`}</main>;
}
