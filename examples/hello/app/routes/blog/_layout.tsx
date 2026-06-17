import type { ReactNode } from "react";

// Nested layout — wraps routes under blog/, inside the root layout. Its own
// loader runs with the same context as the page; the result is the layout's
// `data` prop (independent of the page's loader data).
export function loader() {
  return { section: "Blog" };
}

export default function BlogLayout({
  data,
  children,
}: {
  data: { section: string };
  children: ReactNode;
}) {
  return (
    <section data-layout="blog">
      <h2>{data.section}</h2>
      {children}
    </section>
  );
}
