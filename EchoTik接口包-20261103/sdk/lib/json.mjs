// JSON.parse loses precision for 19-digit TikTok product IDs. Quote integer
// values that exceed JavaScript's safe-integer range before parsing.
export function parseEchoTikJsonText(text) {
  const protectedText = text.replace(
    /("(?:[^"\\]|\\.)*"\s*:\s*)(-?(?:0|[1-9]\d{15,30}))(?=\s*[,}\]])/g,
    '$1"$2"',
  );
  return JSON.parse(protectedText);
}
