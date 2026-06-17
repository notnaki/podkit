// Demonstrates server streaming of a React <Suspense> boundary. The shell (and
// the fallback) flush first; the slow part streams in once its promise settles.
// renderPageToStream emits the hydration data tail AFTER all boundaries flush.
import { Suspense, use } from "react";

export function loader() {
  return { title: "Suspense demo" };
}

let pending: Promise<string> | null = null;
function slow(): Promise<string> {
  if (!pending) {
    pending = new Promise((resolve) => setTimeout(() => resolve("loaded late"), 20));
  }
  return pending;
}

function Slow() {
  const value = use(slow());
  return <p>{value}</p>;
}

export default function SuspensePage({ data }: { data: { title: string } }) {
  return (
    <main>
      <h1>{data.title}</h1>
      <Suspense fallback={<span>loading…</span>}>
        <Slow />
      </Suspense>
    </main>
  );
}
