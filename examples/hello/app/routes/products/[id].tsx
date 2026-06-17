// A DYNAMIC route that is prerendered at build time. `getStaticPaths` enumerates
// the concrete params to render to static HTML; the prod server serves those
// directly and falls back to SSR for ids not listed here.
export const prerender = true;

export function getStaticPaths() {
  return [{ id: "a" }, { id: "b" }];
}

export function loader({ params }: { params: Record<string, string> }) {
  return { id: params.id };
}

export default function Product({ data }: { data: { id: string } }) {
  return <h1>{`product: ${data.id}`}</h1>;
}
