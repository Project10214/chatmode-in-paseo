/* Chat On Steroids (MIT), copyright (c) 2026 Chat On Steroids contributors.
 * Complete-message receiver adaptation of unescapeFallbackMarkdown from
 * pinned e40562640361ca8f74158b2262ca8c555b00abed. No browser stream state.
 * See vendor/cos/provenance.json. Format conversion is not a receipt or final proof.
 */
const MAX_FORMULA_LINES=400;
function unescapeFallbackMarkdown(markdown) {
  const lines = markdown.split('\n');
  const out = [];
  let fence = null;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && !line.slice(line.indexOf(marker) + marker.length).trim()) fence = null;
      out.push(line); continue;
    }
    if (marker && !(marker[0] === '`' && line.slice(line.indexOf(marker) + marker.length).includes('`'))) { fence = marker; out.push(line); continue; }
    if (line.trim() === '\\[') {
      let close = -1;
      for (let at = index + 1; at < lines.length && at <= index + MAX_FORMULA_LINES; at++) if (lines[at].trim() === '\\]') { close = at; break; }
      if (close > index) { for (; index <= close; index++) out.push(lines[index]); index--; continue; }
    }
    let text = '';
    for (let at = 0; at < line.length;) {
      const char = line[at];
      if (char === '\\' && line[at + 1] === '(') {
        const close = line.indexOf('\\)', at + 2);
        if (close >= 0) { text += line.slice(at, close + 2); at = close + 2; continue; }
      }
      if (char === '\\' && /[!-\/:-@[-`{-~]/.test(line[at + 1] || '')) { text += line[at + 1]; at += 2; continue; }
      if (char === '`') {
        const run = /^`+/.exec(line.slice(at))[0];
        const close = new RegExp(`(?<!\`)${run}(?!\`)`).exec(line.slice(at + run.length));
        if (close) { const end = at + run.length + close.index + run.length; text += line.slice(at, end); at = end; continue; }
        text += run; at += run.length; continue;
      }
      text += char; at++;
    }
    out.push(text);
  }
  return out.join('\n');
}

export function decodePublicProse({text,format}={}){
  if(typeof text!=='string'||text.length>256000)
    throw Object.assign(new Error('MESSAGE_TEXT_INVALID'),{code:'MESSAGE_TEXT_INVALID'});
  if(!['text','dil'].includes(format))
    throw Object.assign(new Error('MESSAGE_FORMAT_UNSUPPORTED'),{code:'MESSAGE_FORMAT_UNSUPPORTED'});
  return format==='dil'?unescapeFallbackMarkdown(text):text;
}
