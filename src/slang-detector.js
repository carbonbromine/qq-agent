const STOP_WORDS = new Set([
  '一个', '一些', '一样', '不是', '不能', '不会', '不用', '为什么', '什么',
  '什么意思', '怎么', '这样', '这个', '那个', '这里', '那里', '然后', '但是',
  '就是', '还是', '已经', '可以', '可能', '感觉', '觉得', '知道', '现在',
  '今天', '明天', '昨天', '时候', '东西', '事情', '问题', '大家', '自己',
  '真的', '确实', '应该', '没有', '还有', '比较', '如果', '因为', '所以',
  '我们', '你们', '他们', '一下', '看看', '哈哈', '哈哈哈', '好的', '谢谢'
]);

const SENSITIVE_PATTERNS = [
  /\b(?:https?|ftp):\/\//i,
  /\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/,
  /\b1[3-9]\d{9}\b/,
  /\b[1-9]\d{4,14}\b/,
  /(?:token|password|passwd|secret|api[_ -]?key)\s*[:=]/i,
  /(?:^|[\s"'`])(?:\/(?:home|Users|etc|var|mnt)\/|[A-Za-z]:\\)/
];

function compact(value, max = 200) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/\[CQ:[^\]]*]/gi, ' ')
    .replace(/\[引用[^\]]*]/g, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/@\S+/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

export function normalizeSlangTerm(value) {
  return compact(value, 40)
    .replace(/^[\s"'“”‘’「」『』《》【】()[\]{}，。！？!?、:：;；~～…·]+/, '')
    .replace(/[\s"'“”‘’「」『』《》【】()[\]{}，。！？!?、:：;；~～…·]+$/, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function validTerm(term, ignoredNames) {
  const normalized = normalizeSlangTerm(term);
  if (!normalized || normalized.length < 2 || normalized.length > 32) return false;
  if (STOP_WORDS.has(normalized) || ignoredNames.has(normalized)) return false;
  if (/^\d+$/.test(normalized) || /^[\p{P}\p{S}\s]+$/u.test(normalized)) return false;
  if (SENSITIVE_PATTERNS.some((pattern) => pattern.test(normalized))) return false;
  return true;
}

function addCandidate(out, raw, score, reason, ignoredNames) {
  const displayTerm = compact(raw, 32);
  const normalizedTerm = normalizeSlangTerm(displayTerm);
  if (!validTerm(displayTerm, ignoredNames)) return;
  const existing = out.get(normalizedTerm);
  if (!existing || existing.score < score) {
    out.set(normalizedTerm, {
      normalizedTerm,
      displayTerm,
      score,
      reason
    });
  }
}

/**
 * Zero-token candidate generation. It deliberately favors recall over precision:
 * persistence thresholds and two explicit administrator approvals provide the
 * precision boundary.
 */
export function extractSlangCandidates(message, { ignoredNames = [] } = {}) {
  const text = compact(message?.text, 240);
  if (!text || text.startsWith('/') || text === '[图片]') return [];
  if (SENSITIVE_PATTERNS.some((pattern) => pattern.test(text))) return [];
  const names = new Set(
    (Array.isArray(ignoredNames) ? ignoredNames : [ignoredNames])
      .map(normalizeSlangTerm)
      .filter(Boolean)
  );
  names.add(normalizeSlangTerm(message?.senderName));
  const out = new Map();

  const explicit = /(?:^|[\s，。！？：；])([A-Za-z][A-Za-z0-9_-]{1,19}|[\p{Script=Han}]{2,12})(?:是(?:什么|啥)|什么意思|啥意思|怎么理解)/gu;
  for (const match of text.matchAll(explicit)) {
    addCandidate(out, match[1], 1, 'meaning-question', names);
  }

  const quoted = /[“「『《"]([^”」』》"]{2,20})[”」』》"]/gu;
  for (const match of text.matchAll(quoted)) {
    addCandidate(out, match[1], 0.78, 'quoted-expression', names);
  }

  const latin = /\b[A-Za-z][A-Za-z0-9_-]{1,19}\b/g;
  for (const match of text.matchAll(latin)) {
    if (/^(?:http|https|www|com|cn|qq|jpg|png|gif|webp)$/i.test(match[0])) continue;
    addCandidate(out, match[0], 0.72, 'latin-expression', names);
  }

  const compactUtterance = text.replace(/[，。！？!?、:：;；~～…·\s]/g, '');
  if (
    compactUtterance.length >= 2
    && compactUtterance.length <= 12
    && !/^\d+$/.test(compactUtterance)
  ) {
    addCandidate(out, compactUtterance, 0.58, 'short-utterance', names);
  }

  try {
    const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' });
    for (const segment of segmenter.segment(text)) {
      const token = String(segment.segment || '').trim();
      if (!segment.isWordLike || token.length < 2 || token.length > 12) continue;
      if (/^[\p{Script=Han}]{2,12}$/u.test(token)) {
        addCandidate(out, token, 0.35, 'repeated-word', names);
      }
    }
  } catch {
    for (const token of text.match(/[\p{Script=Han}]{2,8}/gu) || []) {
      addCandidate(out, token, 0.3, 'repeated-phrase', names);
    }
  }

  return [...out.values()]
    .sort((a, b) => b.score - a.score || a.displayTerm.localeCompare(b.displayTerm, 'zh-CN'))
    .slice(0, 20);
}
