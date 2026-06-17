import type { ReactNode } from "react";

// Root layout — wraps every route. Presentational; receives the route's
// loader data plus the page element as `children`.
export default function RootLayout({ children }: { data: unknown; children: ReactNode }) {
  return (
    <div data-layout="root">
      <nav>site nav</nav>
      {children}
    </div>
  );
}
