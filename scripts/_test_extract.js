// Quick test for extractAttributeAndObject() casing behavior

function toSentenceCase(str) {
  if (!str) return str;
  const s = String(str).trim();
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

function toTitleCase(str) {
  if (!str) return str;
  return String(str).replace(/\S+/g, (word, offset) => {
    if (/^[a-z]+[A-Z0-9]/.test(word) || /^[A-Z]{2,}$/.test(word)) return word;
    if (offset > 0 && word.length < 3 && /^[a-z]+$/i.test(word)) return word.toLowerCase();
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  });
}

function extractAttributeAndObject(text) {
  const t = String(text || "").trim().replace(/[?!]+$/g, "");
  const tagMatch = t.match(/\b([A-Z]{1,4}[- ]?\d{2,5}[A-Z]?)\b/i);
  const objectTag = tagMatch ? tagMatch[1] : "";
  let attrPart = t
    .replace(/^(what(s|\s+is|'s)?|qual\s*([eéoa]\s+)?|show(\s+me)?|get|read|ler|obter|tell\s+me|navigate\s+to(\s+the)?|ir\s+para|retrieve|fetch|buscar)\s+/i, "")
    .replace(/\b(the|o|a|os|as)\s+/gi, "")
    .replace(/\b(of|from|da|do|de|para|on)\s+(the\s+)?(pump|bomba|motor|valve|válvula|equipment|objeto|object|equipamento)?\s*[A-Z]{0,4}[- ]?\d{0,5}[A-Z]?\s*$/i, "")
    .replace(/\b(attribute|atributo)\b\s*/gi, "")
    .trim();
  attrPart = toSentenceCase(attrPart);
  return { objectTag, attributeName: attrPart };
}

const tests = [
  "What's the Shaft Power of P-101?",
  "what's the shaft power of P-101?",
  "get shaft power of pump P-101",
  "Qual a Potência do P-101?",
  "show me the temperature of P-101",
  "What is the Design Pressure of B-6506?",
];

for (const t of tests) {
  const r = extractAttributeAndObject(t);
  console.log(`Input: "${t}"\n  => objectTag: "${r.objectTag}", attributeName: "${r.attributeName}"\n`);
}
