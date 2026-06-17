// Blue circle inside a black circle mark.
// ponytail: shared mark component replacing inline SVGs.

export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      {/* Outer black disc */}
      <circle cx="12" cy="12" r="11" fill="#0c0c0f" />
      {/* Hairline ring using border token color */}
      <circle cx="12" cy="12" r="11" stroke="#26262b" strokeWidth="0.5" fill="none" />
      {/* Inner blue disc */}
      <circle cx="12" cy="12" r="5.5" fill="#3551f3" />
    </svg>
  );
}
