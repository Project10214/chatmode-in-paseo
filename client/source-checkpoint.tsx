// Internal ordered marker. Never render it as assistant prose or completion.
// Register explicitly so valid internal rows do not become unavailable cards.
export function SourceCheckpoint() { return null; }
