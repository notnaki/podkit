export function loader({ params }: { params: Record<string, string> }) {
  return { slug: params.slug };
}
export default function Post({ data }: { data: { slug: string } }) {
  return <article>{`post: ${data.slug}`}</article>;
}
