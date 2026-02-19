function normalizeForComparison(value) {
  return String(value ?? "")
    .replace(/\r\n/g, "\n")
    .trim();
}

export function shouldRenderFinalOutputAfterStreaming({ streamedText, finalText } = {}) {
  const normalizedFinal = normalizeForComparison(finalText);
  if (!normalizedFinal) {
    return false;
  }

  const normalizedStreamed = normalizeForComparison(streamedText);
  if (!normalizedStreamed) {
    return true;
  }

  if (normalizedStreamed === normalizedFinal) {
    return false;
  }

  return !normalizedStreamed.endsWith(normalizedFinal);
}
