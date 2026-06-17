import { useState } from "react";
import { randomUUID } from "node:crypto";

// node:crypto is server-only — it runs in the loader and must NOT end up in the
// client bundle. The strip transform drops the loader (and this now-unused
// import) from the client build; the component below is what hydrates.
export function loader() {
  return { id: randomUUID(), start: 3 };
}

export default function Counter({ data }: { data: { id: string; start: number } }) {
  const [n, setN] = useState(data.start);
  return (
    <main>
      <p>id:{data.id}</p>
      <button type="button" onClick={() => setN((c) => c + 1)}>{`count:${n}`}</button>
    </main>
  );
}
