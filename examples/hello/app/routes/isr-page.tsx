// A prerendered route with an ISR (revalidate) window. The prod server serves
// the cached HTML immediately and re-renders in the background once the cache
// is older than `revalidate` seconds (0 = revalidate on the next request after
// the initial build render). The module-level counter makes each re-render
// produce observably different output.
export const prerender = true;
export const revalidate = 0;

let hits = 0;

export function loader() {
  hits += 1;
  return { hits };
}

export default function IsrPage({ data }: { data: { hits: number } }) {
  return <p>isr hits: {data.hits}</p>;
}
