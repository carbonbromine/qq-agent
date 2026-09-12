# AI Asset Observatory

The `Observatory` page is a read-only inventory of data currently available to
the Agent runtime.

## Asset groups

- Stickers: local cached QQ favorites and AI-collected images, including notes,
  tags, source and usage counts.
- Slang: entries in `data/slang.json`, when that file exists.
- People: the experimental unified QQ identity index when its master switch is
  active.
- Memory: per-chat people, impression and handoff counts.

Sticker metadata never exposes temporary QQ image URLs. Thumbnails are fetched
through an authenticated same-origin endpoint with SSRF validation and an 8 MiB
response limit. Opening the page reads the local sticker cache. Expired
AI-collected images refresh their temporary URL from the original message on
demand; only the manual refresh button reloads the complete QQ favorites list.

## Slang status

The current Linux Agent does not yet inject or update a slang library. The
observatory therefore distinguishes:

- `not connected`: no `data/slang.json`;
- `stored, not connected`: the file exists and can be inspected, but the Agent
  does not use it;
- `active`: reserved for a future runtime integration.

The old Bridge slang file is never imported implicitly.

## API

```text
GET /api/assets/overview
GET /api/assets/stickers?query=&offset=0&limit=100&refresh=0
GET /api/assets/stickers/image?id=<sticker-id>
GET /api/assets/slang?query=&status=&offset=0&limit=200
GET /api/assets/identities?limit=500
GET /api/assets/memory
```

All endpoints use the normal authenticated console boundary.
