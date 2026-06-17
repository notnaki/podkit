// A statically prerendered, param-less route. `prerender = true` makes buildApp
// render it to HTML at build time; the prod server serves that HTML directly.
export const prerender = true;

export function loader() {
  return { title: "Static Page" };
}

export default function StaticPage({ data }: { data: { title: string } }) {
  return <h1>{data.title}</h1>;
}
