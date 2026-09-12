import { parse } from 'node-html-parser';

const DETAIL_URL =
  'https://h5.qzone.qq.com/proxy/domain/taotao.qq.com/cgi-bin/emotion_cgi_msgdetail_v6';
const REPLY_URL =
  'https://h5.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_re_feeds';

function compact(value, max = 1000) {
  return String(value ?? '').replace(/\0/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function cookieMap(text) {
  const out = {};
  for (const part of String(text || '').split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    out[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return out;
}

function gtk(key) {
  let hash = 5381;
  for (const char of String(key || '')) hash += (hash << 5) + char.charCodeAt(0);
  return String(hash & 0x7fffffff);
}

function parseJsonp(text) {
  const source = String(text || '').trim();
  try {
    return JSON.parse(source);
  } catch { /* JSONP / frameElement callback */ }
  const markers = ['frameElement.callback(', '_preloadCallback(', '_Callback(', 'callback(', 'back('];
  for (const marker of markers) {
    const markerAt = source.lastIndexOf(marker);
    if (markerAt < 0) continue;
    const start = source.indexOf('{', markerAt + marker.length);
    if (start < 0) continue;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = start; index < source.length; index++) {
      const char = source[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') quoted = true;
      else if (char === '{') depth += 1;
      else if (char === '}' && --depth === 0) {
        return JSON.parse(source.slice(start, index + 1));
      }
    }
  }
  throw new Error('Qzone 返回内容不是有效 JSON/JSONP');
}

function removeNativeMention(value) {
  let targetUin = '';
  let targetName = '';
  const text = String(value || '').replace(
    /@\{uin:(\d+),nick:([^,}]*),[^}]*\}/g,
    (_all, uin, name) => {
      targetUin ||= String(uin);
      targetName ||= String(name);
      return '';
    }
  );
  return {
    targetUin,
    targetName: compact(targetName, 80),
    text: compact(text.replace(/\[em\][\s\S]*?\[\/em\]/g, ''), 800)
  };
}

export function qzonePostKey(post) {
  return `${String(post?.uin || '')}:${String(post?.tid || post?.key || '')}`;
}

export function qzoneCommentKey(post, comment) {
  return [
    qzonePostKey(post),
    String(comment?.parentTid || 'root'),
    String(comment?.commentId || comment?.tid || ''),
    String(comment?.uin || '')
  ].join(':');
}

export function estimateQzoneTokens(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  let tokens = 0;
  for (const char of text) {
    const code = char.codePointAt(0);
    tokens += code > 0x2ff ? 1 : 0.25;
  }
  return Math.ceil(tokens);
}

function commentFromRaw(raw, parentTid = '') {
  const parsed = removeNativeMention(raw?.content);
  const tid = String(raw?.tid ?? raw?.id ?? '');
  return {
    commentId: String(
      raw?.commentid ?? raw?.comment_id ?? raw?.cid ?? raw?.commentId ?? tid
    ),
    tid,
    parentTid: String(parentTid || ''),
    uin: String(raw?.uin || ''),
    nickname: compact(raw?.name || raw?.nickname || '', 80),
    content: parsed.text,
    targetUin: parsed.targetUin,
    targetName: parsed.targetName,
    time: Number(raw?.create_time ?? raw?.createTime ?? 0) || 0
  };
}

export function parseQzoneRawComments(commentList = []) {
  const comments = [];
  for (const raw of Array.isArray(commentList) ? commentList : []) {
    const root = commentFromRaw(raw);
    if (root.commentId && root.uin) comments.push(root);
    for (const child of Array.isArray(raw?.list_3) ? raw.list_3 : []) {
      const reply = commentFromRaw(child, root.tid || root.commentId);
      if (reply.commentId && reply.uin) comments.push(reply);
    }
  }
  return comments;
}

function parsedCommentContent(item) {
  const content = item.querySelector('.comments-content');
  if (!content) return '';
  const fragment = parse(content.innerHTML);
  for (const node of fragment.querySelectorAll('.comments-op, .nickname')) node.remove();
  return compact(fragment.textContent.replace(/^[\s:：]+/, ''), 800);
}

export function parseQzoneFeed(feed) {
  const html = String(feed?.html || '');
  const root = parse(html);
  const comments = root.querySelectorAll('li.comments-item').map((item) => {
    let parent = item.parentNode;
    let parentTid = '';
    while (parent) {
      if (parent.classList?.contains('mod-comments-sub')) {
        let owner = parent.parentNode;
        while (owner && owner.tagName !== 'LI') owner = owner.parentNode;
        parentTid = String(owner?.getAttribute?.('data-tid') || '');
        break;
      }
      parent = parent.parentNode;
    }
    return {
      commentId: String(item.getAttribute('data-commentid') || item.getAttribute('data-tid') || ''),
      tid: String(item.getAttribute('data-tid') || ''),
      parentTid,
      uin: String(item.getAttribute('data-uin') || ''),
      nickname: compact(item.getAttribute('data-nick') || '', 80),
      content: parsedCommentContent(item),
      targetUin: '',
      targetName: '',
      time: 0
    };
  }).filter((comment) => comment.commentId && comment.uin);
  const images = root.querySelectorAll('.img-box img')
    .map((image) => String(image.getAttribute('src') || '').replace(/&amp;/g, '&'))
    .filter((url) => /^https?:\/\//i.test(url) && !/qzonestyle\.gtimg\.cn/i.test(url));
  const like = root.querySelector('.qz_like_btn_v3');
  return {
    tid: String(feed?.key || ''),
    uin: String(feed?.uin || ''),
    nickname: compact(feed?.nickname || '', 80),
    time: Number(feed?.time) || 0,
    appid: Number(feed?.appid) || 0,
    content: compact(root.querySelector('.f-info')?.textContent || '', 1200),
    images: [...new Set(images)].slice(0, 9),
    comments,
    isLiked: String(like?.getAttribute('data-islike') || '') === '1',
    likeCount: Number(like?.getAttribute('data-likecnt')) || 0
  };
}

export class QzoneWebClient {
  constructor(onebot, { fetchImpl = fetch } = {}) {
    this.onebot = onebot;
    this.fetch = fetchImpl;
  }

  async #context() {
    const result = await this.onebot.call(
      'get_cookies',
      { domain: 'user.qzone.qq.com' },
      10000
    );
    const cookies = String(result?.cookies || result?.cookie || '');
    const values = cookieMap(cookies);
    const key = values.p_skey || values.skey || '';
    if (!cookies || !key) throw new Error('无法取得有效的 Qzone Cookie');
    return {
      cookies,
      selfUin: String(this.onebot.selfId || ''),
      gtk: gtk(key)
    };
  }

  async #request(url, options = {}) {
    const response = await this.fetch(url, {
      ...options,
      redirect: 'error',
      signal: options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(20000)])
        : AbortSignal.timeout(20000)
    });
    if (!response.ok) throw new Error(`Qzone HTTP ${response.status}`);
    const data = parseJsonp(await response.text());
    for (const key of ['subcode', 'code', 'ret']) {
      if (data[key] == null || Number(data[key]) === 0) continue;
      throw new Error(
        `Qzone API ${key}=${data[key]}: ${compact(data.message || data.msg || '', 300)}`
      );
    }
    return data;
  }

  async getPostDetail(ownerUin, tid, signal) {
    const ctx = await this.#context();
    const owner = String(ownerUin || '');
    const postId = String(tid || '');
    if (!/^\d+$/.test(owner) || !postId) throw new Error('动态作者或 tid 无效');
    const url = `${DETAIL_URL}?${new URLSearchParams({
      tid: postId,
      uin: owner,
      t1_source: '1',
      not_trunc_con: '1',
      need_right: '1',
      not_adapt_outpic: '1',
      g_tk: ctx.gtk
    })}`;
    const raw = await this.#request(url, {
      headers: {
        cookie: ctx.cookies,
        referer: `https://user.qzone.qq.com/${owner}`,
        'user-agent': 'Mozilla/5.0'
      },
      signal
    });
    return {
      tid: String(raw.tid || postId),
      uin: String(raw.uin || owner),
      nickname: compact(raw.name || '', 80),
      content: compact(raw.content || '', 1200),
      time: Number(raw.created_time ?? raw.createTime ?? 0) || 0,
      comments: parseQzoneRawComments(raw.commentlist),
      commentCount: Number(raw.cmtnum) || 0
    };
  }

  async replyComment({ ownerUin, tid, comment, rootComment, content, signal }) {
    const ctx = await this.#context();
    const owner = String(ownerUin || '');
    const postId = String(tid || '');
    const root = rootComment || comment;
    if (!/^\d+$/.test(owner) || !postId || !root?.commentId || !root?.uin) {
      throw new Error('回复评论参数不完整');
    }
    if (!ctx.selfUin) throw new Error('无法确认当前登录 QQ');
    const nativeName = compact(comment?.nickname, 80).replace(/[{},]/g, '');
    const replyText = comment?.parentTid
      ? `@{uin:${comment.uin},nick:${nativeName},who:1,auto:1}${content}`
      : String(content || '');
    const url = `${REPLY_URL}?${new URLSearchParams({ g_tk: ctx.gtk })}`;
    const raw = await this.#request(url, {
      method: 'POST',
      headers: {
        cookie: ctx.cookies,
        'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
        referer: 'https://user.qzone.qq.com/',
        origin: 'https://user.qzone.qq.com',
        'user-agent': 'Mozilla/5.0'
      },
      body: new URLSearchParams({
        topicId: `${owner}_${postId}__1`,
        uin: ctx.selfUin,
        hostUin: owner,
        feedsType: '100',
        inCharset: 'utf-8',
        outCharset: 'utf-8',
        plat: 'qzone',
        source: 'ic',
        platformid: '52',
        format: 'fs',
        ref: 'feeds',
        content: replyText,
        commentId: String(root.tid || root.commentId),
        commentUin: String(root.uin),
        richval: '',
        richtype: '',
        private: '0',
        paramstr: '2',
        qzreferrer: `https://user.qzone.qq.com/${ctx.selfUin}/main`
      }).toString(),
      signal
    });
    const commentId = raw.commentid ?? raw.commentId;
    return { commentId: commentId == null ? '' : String(commentId) };
  }
}
