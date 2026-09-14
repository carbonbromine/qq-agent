# AI Asset Management

The `Observatory` page manages shared language and media assets. Graduated
feature data uses the owning feature's dedicated page. All reads and writes use
the authenticated console boundary.

## Asset groups

- Stickers: local cached QQ favorites and AI-collected images, including notes,
  tags, source and usage counts.
- Slang: entries in `data/slang.json`, when that file exists.
- People and memory APIs remain available to the dedicated `旧印象` page; they
  are not shown as generic Observatory tabs.

Each asset tab provides create, edit, and delete controls:

- Stickers accept PNG, JPEG, GIF, or WebP files up to 8 MiB, or a remote image
  URL fetched through the existing SSRF-safe downloader. Uploaded images are
  copied into `data/sticker-assets/`.
- Sticker edits update the AI-facing name, note, tags, and usage guidance.
  Deleting a QQ favorite hides it from the AI library without deleting the
  original QQ favorite; deleting an AI/manual item removes its local record and
  managed image file.
- Slang entries support content, meaning, usage, example, risk, and review
  status. Writes are atomic and retain existing evidence fields.
- The `旧印象` page supports an explicit display name, source chat, friend flag, and safe
  profile note. Manual overrides survive identity rebuilds. Deletion creates a
  tombstone so archived messages do not immediately recreate the identity;
  adding the same QQ number again explicitly restores it.
- The same page supports adding a single impression, replacing one person's complete
  impression list, and deleting that person's memory file.

Sticker metadata never exposes temporary QQ image URLs. Thumbnails are fetched
through an authenticated same-origin endpoint with SSRF validation and an 8 MiB
response limit. Opening the page reads the local sticker cache. Expired
AI-collected images refresh their temporary URL from the original message on
demand; only the manual refresh button reloads the complete QQ favorites list.

## Slang status

The optional slang corpus pilot can discover terms, run administrator-approved
research and add approved results to the candidate library. The observatory
distinguishes:

- `not connected`: no `data/slang.json`;
- `stored, not connected`: the file exists while the pilot is disabled;
- `active`: local discovery is enabled and confirmed entries may be injected
  into their permitted chat scope.

The old Bridge slang file is never imported implicitly.
Research workflow details are documented in
[Slang Corpus Pilot](SLANG_PILOT.md).

## API

```text
GET /api/assets/overview
GET /api/assets/stickers?query=&offset=0&limit=100&refresh=0
POST /api/assets/stickers
PUT /api/assets/stickers/<sticker-id>
DELETE /api/assets/stickers/<sticker-id>
GET /api/assets/stickers/image?id=<sticker-id>
GET /api/assets/slang?query=&status=&offset=0&limit=200
POST /api/assets/slang
PUT /api/assets/slang/<slang-id>
DELETE /api/assets/slang/<slang-id>
GET /api/assets/identities?limit=500&query=
POST /api/assets/identities
PUT /api/assets/identities/<uin>
DELETE /api/assets/identities/<uin>
GET /api/assets/memory?query=
POST /api/assets/memory
PUT /api/assets/memory
DELETE /api/assets/memory

GET  /api/slang-pilot/status
GET  /api/slang-pilot/discoveries?state=&query=&limit=
GET  /api/slang-pilot/discoveries/<id>
POST /api/slang-pilot/discoveries/<id>/research-decision
POST /api/slang-pilot/discoveries/<id>/admission-decision
POST /api/slang-pilot/discoveries/<id>/retry
```

Delete requests require `{"confirm":true}`. No asset mutation invokes a model or
consumes model tokens.
