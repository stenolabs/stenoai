// Animated audio-level bars in var(--recording) red (mirrors AudioWave in the real app)
export function RecordingWave() {
  const delays = [0, 0.15, 0.3, 0.1, 0.25, 0.05, 0.2];
  return (
    <span aria-hidden="true" style={{ display: "inline-flex", alignItems: "center", height: 14, gap: 2 }}>
      {delays.map((d, i) => (
        <span
          key={i}
          style={{
            display: "inline-block",
            width: 2,
            height: "60%",
            minHeight: 2,
            background: "var(--recording)",
            borderRadius: 2,
            transformOrigin: "50% 100%",
            animation: `dockWave 1.1s ease-in-out ${d}s infinite`,
          }}
        />
      ))}
    </span>
  );
}
