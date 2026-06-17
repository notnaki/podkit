import type { ReactNode } from "react";

// Nested layout — wraps routes under blog/, inside the root layout.
export default function BlogLayout({ children }: { data: unknown; children: ReactNode }) {
  return <section data-layout="blog">{children}</section>;
}
